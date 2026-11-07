// The inbox lists and deletes the push configs stored on a task, for the calling peer only.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { sha256 } from "../src/a2a.ts";
import { d1 } from "./d1.ts";

const BASE = "https://agent.example.com";

function setup() {
	const DB = d1(new URL("../migrations/", import.meta.url));
	const env: any = {
		DB, PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", AGENT_NAME: "Test Inbox", WAKE_PRESET: "generic",
	};
	const logs: string[] = [];
	const secrets: string[] = [];
	const orig = console.log;
	console.log = (...args: unknown[]) => {
		const line = args.map((a) => String(a)).join(" ");
		logs.push(line);
		if (secrets.some((secret) => secret && line.includes(secret))) return;
		orig(...args);
	};
	const call = async (token: string, method: string, params: unknown, headers: Record<string, string> = {}) => {
		const res = await worker.fetch(new Request(BASE + "/", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		}) as any, env, { waitUntil() {}, passThroughOnException() {} } as any);
		const text = await res.text();
		let data: any = text;
		try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
		return { status: res.status, data, text };
	};
	const owner = async (method: string, path: string, json?: unknown) => {
		const res = await worker.fetch(new Request(BASE + path, {
			method, headers: { authorization: "Bearer owner-secret", "content-type": "application/json" },
			body: json === undefined ? undefined : JSON.stringify(json),
		}) as any, env, { waitUntil() {}, passThroughOnException() {} } as any);
		return res.json() as Promise<any>;
	};
	return {
		DB, call, owner, logs, secrets,
		restore: () => { console.log = orig; },
	};
}

function hides(body: string, secret: string) {
	assert.equal(body.includes(secret), false);
}

test("list and delete return the caller's push config and hide it from other peers", async (t) => {
	const s = setup();
	t.after(s.restore);
	const ada = (await s.owner("POST", "/owner/peers", { label: "ada" })).token as string;
	const bob = (await s.owner("POST", "/owner/peers", { label: "bob" })).token as string;
	const token = `pt_${crypto.randomUUID()}`;
	s.secrets.push(token);
	const tokenHash = await sha256(token);
	const sent = await s.call(ada, "message/send", {
		message: { kind: "message", role: "user", messageId: crypto.randomUUID(), parts: [{ kind: "text", text: "hello" }] },
	});
	assert.equal(sent.status, 200);
	const taskId = sent.data.result.id as string;
	const set = await s.call(ada, "tasks/pushNotificationConfig/set", {
		taskId, pushNotificationConfig: { id: "cfg-1", url: "https://hooks.example.net/ada", token },
	});
	assert.equal(set.status, 200);
	assert.equal(set.data.result.taskId, taskId);
	assert.equal(await sha256(String(set.data.result.pushNotificationConfig.token)), tokenHash);

	const listed = await s.call(ada, "ListTaskPushNotificationConfig", { taskId });
	assert.equal(listed.status, 200);
	assert.equal(listed.data.result.nextPageToken, "");
	assert.equal(listed.data.result.configs.length, 1);
	assert.equal(listed.data.result.configs[0].id, "cfg-1");
	assert.equal(listed.data.result.configs[0].taskId, taskId);
	assert.equal(await sha256(String(listed.data.result.configs[0].token)), tokenHash);
	const plural = await s.call(ada, "ListTaskPushNotificationConfigs", { taskId });
	assert.equal(await sha256(String(plural.data.result.configs[0].token)), tokenHash);

	const as03 = await s.call(ada, "tasks/pushNotificationConfig/list", { id: taskId });
	assert.equal(Array.isArray(as03.data.result), true);
	assert.equal(as03.data.result.length, 1);
	assert.equal(as03.data.result[0].pushNotificationConfig.id, "cfg-1");
	assert.equal(await sha256(String(as03.data.result[0].pushNotificationConfig.token)), tokenHash);

	const missing = await s.call(bob, "ListTaskPushNotificationConfig", { taskId: "missing-task-id" });
	const foreign = await s.call(bob, "ListTaskPushNotificationConfig", { taskId });
	assert.deepEqual(foreign.data.error, { code: -32001, message: "Task not found" });
	assert.deepEqual(missing.data.error, foreign.data.error);
	hides(foreign.text, token);
	hides(missing.text, token);
	const foreignDel = await s.call(bob, "DeleteTaskPushNotificationConfig", { taskId, id: "cfg-1" });
	assert.deepEqual(foreignDel.data.error, { code: -32001, message: "Task not found" });
	hides(foreignDel.text, token);
	const foreign03 = await s.call(bob, "tasks/pushNotificationConfig/list", { id: taskId });
	assert.deepEqual(foreign03.data.error, { code: -32001, message: "Task not found" });
	hides(foreign03.text, token);

	const gone = await s.call(ada, "DeleteTaskPushNotificationConfig", { taskId, id: "cfg-1" });
	assert.deepEqual(gone.data.result, {});
	const again = await s.call(ada, "DeleteTaskPushNotificationConfig", { taskId, id: "cfg-1" });
	assert.deepEqual(again.data.result, {});
	const after = await s.call(ada, "ListTaskPushNotificationConfig", { taskId });
	assert.deepEqual(after.data.result, { configs: [], nextPageToken: "" });

	const noId = await s.call(ada, "DeleteTaskPushNotificationConfig", { taskId });
	assert.equal(noId.data.error?.code, -32602);
	assert.equal(noId.data.error?.message, "Invalid params: push notification config id");

	const bad = "page-token-secret-value";
	const rejected = await s.call(ada, "ListTaskPushNotificationConfig", { taskId, pageToken: bad });
	assert.equal(rejected.data.error?.message, "Invalid params: pageToken");
	hides(rejected.text, bad);
	hides(rejected.text, token);

	assert.equal(s.logs.some((line) => line.includes(token)), false);
});

test("1.0 list pages configs and 0.3 delete returns null", async (t) => {
	const s = setup();
	t.after(s.restore);
	const ada = (await s.owner("POST", "/owner/peers", { label: "ada" })).token as string;
	const token = `pt_${crypto.randomUUID()}`;
	s.secrets.push(token);
	const sent = await s.call(ada, "SendMessage", {
		message: { role: "ROLE_USER", messageId: crypto.randomUUID(), parts: [{ text: "hello" }] },
	});
	const taskId = sent.data.result.task.id as string;
	for (const id of ["c-1", "c-2", "c-3"]) {
		const cfgToken = id === "c-2" ? token : `other-${id}`;
		s.secrets.push(cfgToken);
		const set = await s.call(ada, "CreateTaskPushNotificationConfig", {
			taskId, pushNotificationConfig: { id, url: `https://hooks.example.net/${id}`, token: cfgToken },
		});
		assert.equal(set.data.error, undefined);
	}
	const seen: string[] = [];
	let pageToken = "";
	do {
		const page = await s.call(ada, "ListTaskPushNotificationConfigs", { taskId, pageSize: 1, ...(pageToken ? { pageToken } : {}) });
		assert.equal(page.data.result.configs.length, 1);
		seen.push(page.data.result.configs[0].id);
		if (page.data.result.configs[0].id === "c-2") assert.equal(await sha256(String(page.data.result.configs[0].token)), await sha256(token));
		pageToken = page.data.result.nextPageToken;
		if (!pageToken) assert.equal(pageToken, "");
	} while (pageToken);
	assert.deepEqual(seen, ["c-1", "c-2", "c-3"]);

	const del = await s.call(ada, "tasks/pushNotificationConfig/delete", { id: taskId, pushNotificationConfigId: "c-2" });
	assert.equal(del.data.result, null);
	const delAgain = await s.call(ada, "tasks/pushNotificationConfig/delete", { id: taskId, pushNotificationConfigId: "c-2" });
	assert.equal(delAgain.data.result, null);
	const left = await s.call(ada, "tasks/pushNotificationConfig/list", { id: taskId });
	assert.deepEqual(left.data.result.map((row: { pushNotificationConfig: { id: string } }) => row.pushNotificationConfig.id), ["c-1", "c-3"]);
	hides(left.text, token);
	hides(del.text, token);
	assert.equal(s.logs.some((line) => line.includes(token)), false);
});

test("push results identify callbacks without URLs, and forced replies preserve transitions", async (t) => {
	const s = setup();
	t.after(s.restore);
	const originalFetch = globalThis.fetch;
	t.after(() => { globalThis.fetch = originalFetch; });
	const attempted: string[] = [];
	globalThis.fetch = (async (url: any) => {
		attempted.push(String(url));
		return new Response(null, { status: String(url).includes("first") ? 401 : 200 });
	}) as typeof fetch;
	const ada = (await s.owner("POST", "/owner/peers", { label: "ada" })).token;
	const first = "https://hooks.example.net/private/first?token=first-secret";
	const second = "https://hooks.example.net/private/second?token=second-secret";
	const sent = await s.call(ada, "message/send", {
		message: { kind: "message", role: "user", messageId: crypto.randomUUID(), parts: [{ kind: "text", text: "hello" }] },
		configuration: { pushNotificationConfig: { id: "message", url: first } },
	});
	const { id: taskId, contextId } = sent.data.result;
	await s.call(ada, "tasks/pushNotificationConfig/set", { taskId, pushNotificationConfig: { id: "task", url: second } });
	const working = await s.owner("POST", `/owner/tasks/${taskId}/working`, {});
	assert.deepEqual(working.push.map((r: any) => [r.role, r.host, r.ok, r.info]), [
		["message push", "hooks.example.net", false, "HTTP 401"], ["task push config", "hooks.example.net", true, "HTTP 200"],
	]);
	assert.deepEqual(working.push.map((r: any) => r.fingerprint), [(await sha256(first)).slice(0, 12), (await sha256(second)).slice(0, 12)]);
	assert.doesNotMatch(JSON.stringify(working.push), /token=|first-secret|second-secret|private|https:/);
	const done = await s.owner("POST", `/owner/tasks/${taskId}/reply`, { text: "done", state: "completed" });
	assert.deepEqual(done.delivery.push, working.push);
	assert.equal(done.task.status.state, "completed");
	const blocked = await s.owner("POST", `/owner/tasks/${taskId}/reply`, { text: "question", state: "input-required" });
	assert.match(blocked.error, /already completed/);
	const forced = await s.owner("POST", `/owner/tasks/${taskId}/reply`, { text: "question", state: "input-required", force: true });
	assert.equal(forced.task.status.state, "input-required");
	const history = await s.owner("GET", `/owner/history/${contextId}?from=ada`);
	const transitions = history.filter((r: any) => r.event === "forced");
	assert.equal(transitions.length, 1);
	assert.deepEqual(transitions[0].data, { forced: true, previousState: "completed", state: "input-required" });
	assert.ok(history.every((r: any) => r.currentState.state === "input-required"));
	assert.deepEqual(history.at(-1).currentState, { state: "input-required", timestamp: forced.task.status.timestamp });
	assert.doesNotMatch(JSON.stringify(history), /first-secret|second-secret|private/);
	const count = attempted.length;
	const retry = await s.owner("POST", `/owner/tasks/${taskId}/reply`, { text: "question", state: "input-required", force: true });
	assert.equal(retry.idempotent, true);
	assert.equal(attempted.length, count);
	const after = await s.owner("GET", `/owner/history/${contextId}?n=1&from=ada`);
	assert.deepEqual(after[0].currentState, history.at(-1).currentState);
	globalThis.fetch = (async () => { throw new Error(`failed ${first}`); }) as typeof fetch;
	const failed = await s.owner("POST", `/owner/tasks/${taskId}/reply`, { text: "final", state: "completed" });
	assert.doesNotMatch(JSON.stringify(failed.delivery), /first-secret|second-secret|private/);
	assert.equal(failed.delivery.push[0].info, "push request failed");
});

test("limited outbound history reports the latest state for that peer only", async (t) => {
	const s = setup();
	t.after(s.restore);
	const contextId = "outbound-history";
	const taskId = "remote-task";
	await s.owner("POST", "/owner/history", { contextId, taskId, peer: "ada", state: "working", ts: "2026-11-07T01:00:00.000Z" });
	await s.owner("POST", "/owner/history", { contextId, taskId, peer: "bob", state: "failed", ts: "2026-11-07T01:01:00.000Z" });
	await s.owner("POST", "/owner/history", { contextId, taskId, peer: "ada", event: "note", text: "latest note without a state" });
	const rows = await s.owner("GET", `/owner/history/${contextId}?from=ada&n=1`);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].event, "note");
	assert.deepEqual(rows[0].currentState, { state: "working", timestamp: "2026-11-07T01:00:00.000Z" });
	assert.equal(rows[0].current_history_json, undefined);
	assert.equal(rows[0].current_status_json, undefined);
});
