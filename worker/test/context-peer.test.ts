// A context id is one conversation per peer. A client-supplied id this peer does not already hold
// starts that peer's own conversation, whether or not another peer already uses the same string.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { d1 } from "./d1.ts";

const BASE = "https://agent.example.com";

function setup() {
	const DB = d1(new URL("../migrations/", import.meta.url));
	const env: any = {
		DB, PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", AGENT_NAME: "Test Inbox", WAKE_PRESET: "generic",
		WAKE_DEBOUNCE_SECONDS: "3600", WAKE_WEBHOOK_URL: "https://hook.example.net/wake", WAKE_WEBHOOK_KEY: "hook-key",
	};
	const origFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response("ok")) as typeof fetch;
	const call = async (method: string, path: string, json?: unknown, auth = "Bearer owner-secret") => {
		const headers: Record<string, string> = { authorization: auth, "content-type": "application/json", "cf-connecting-ip": "198.51.100.7" };
		const pending: Promise<unknown>[] = [];
		const res = await worker.fetch(new Request(BASE + path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) }) as any,
			env, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as any);
		await Promise.allSettled(pending);
		const text = await res.text();
		let data: any = text;
		try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
		return { status: res.status, data, text };
	};
	const owner = (method: string, path: string, json?: unknown) => call(method, path, json);
	const send = (token: string, text: string, contextId?: string, method = "message/send") => call("POST", "/", {
		jsonrpc: "2.0", id: 1, method,
		params: { message: { kind: "message", role: "user", messageId: crypto.randomUUID(), ...(contextId ? { contextId } : {}), parts: [{ kind: "text", text }] } },
	}, `Bearer ${token}`);
	return { DB, owner, send, call, restore: () => { globalThis.fetch = origFetch; } };
}

/** The 0.3 task, or the 1.0 `{ task }` wrapper, minus fields that are new on every call. */
function opened(data: any) {
	const task = data?.result?.kind === "task" || data?.result?.status ? data.result : data?.result?.task;
	const history = Array.isArray(task?.history) ? task.history : [];
	return {
		contextId: task?.contextId,
		state: task?.status?.state,
		texts: history.map((m: { parts?: { text?: string }[] }) => (m.parts || []).map((p) => p.text || "").join("\n")),
		roles: history.map((m: { role?: string }) => m.role),
	};
}

function hides(body: string, secret: string) {
	assert.equal(body.includes(secret), false);
}

test("a foreign contextId opens the caller's own conversation and does not reveal the other one", async (t) => {
	const s = setup();
	t.after(s.restore);
	const ada = (await s.owner("POST", "/owner/peers", { label: "ada" })).data.token as string;
	const bob = (await s.owner("POST", "/owner/peers", { label: "bob" })).data.token as string;
	assert.match(ada, /^a2aow_/);
	assert.match(bob, /^a2aow_/);
	const pushToken = `pt_${crypto.randomUUID()}`;

	const first = await s.send(ada, "y-one", "ctx-y");
	assert.equal(first.status, 200);
	assert.equal(first.data.result.contextId, "ctx-y");
	const second = await s.send(ada, "y-two", "ctx-y");
	assert.equal(second.status, 200);
	assert.equal(second.data.result.contextId, "ctx-y");
	const adaTask = second.data.result.id as string;
	s.DB.db.prepare("UPDATE tasks SET push_configs_json = ? WHERE id = ?").run(JSON.stringify([{ id: "cfg-ada", url: "https://hooks.example.net/ada", token: pushToken, _version: "0.3" }]), adaTask);

	const history = (from?: string) => s.owner("GET", `/owner/history/ctx-y${from ? `?from=${from}` : ""}`);
	const beforeHist = await history("ada");
	assert.equal(beforeHist.status, 200);
	assert.deepEqual((beforeHist.data as { text: string; peer: string }[]).map((r) => [r.peer, r.text]), [["ada", "y-one"], ["ada", "y-two"]]);
	const wake = (peer: string) => s.DB.db.prepare("SELECT context_id, peer, last_sent_ms, pending_json, pending_since_ms FROM wakes WHERE context_id = 'ctx-y' AND peer = ?").get(peer) as {
		pending_json: string; peer: string; last_sent_ms: number; pending_since_ms: number;
	} | undefined;
	const beforeWake = wake("ada");
	assert.equal(beforeWake?.peer, "ada");
	const pending = JSON.parse(beforeWake!.pending_json);
	assert.equal(pending.from, "ada");
	assert.equal(pending.preview, "y-two");
	assert.equal(pending.taskIds.includes(adaTask), true);

	const listedForeign = await s.call("POST", "/", {
		jsonrpc: "2.0", id: 1, method: "ListTasks", params: { contextId: "ctx-y", pageSize: 50 },
	}, `Bearer ${bob}`);
	const listedFresh = await s.call("POST", "/", {
		jsonrpc: "2.0", id: 1, method: "ListTasks", params: { contextId: "ctx-never-seen", pageSize: 50 },
	}, `Bearer ${bob}`);
	assert.equal(listedForeign.status, 200);
	assert.equal(listedFresh.status, 200);
	assert.deepEqual(listedForeign.data.result, listedFresh.data.result);
	assert.deepEqual(listedForeign.data.result, { tasks: [], nextPageToken: "", pageSize: 50, totalSize: 0 });
	hides(listedForeign.text, "y-one");
	hides(listedForeign.text, "y-two");
	hides(listedForeign.text, pushToken);
	hides(listedForeign.text, ada);

	const foreign = await s.send(bob, "x-inject", "ctx-y");
	const fresh = await s.send(bob, "x-inject", "ctx-new");
	assert.equal(foreign.status, 200);
	assert.equal(fresh.status, 200);
	assert.equal(foreign.data.error, undefined);
	assert.equal(fresh.data.error, undefined);
	assert.deepEqual(opened(foreign.data), { contextId: "ctx-y", state: "submitted", texts: ["x-inject"], roles: ["user"] });
	assert.deepEqual(opened(fresh.data), { contextId: "ctx-new", state: "submitted", texts: ["x-inject"], roles: ["user"] });
	hides(foreign.text, "y-one");
	hides(foreign.text, "y-two");
	hides(foreign.text, pushToken);
	hides(foreign.text, ada);
	hides(foreign.text, bob);

	const foreignV1 = await s.send(bob, "x-inject-v1", "ctx-y", "SendMessage");
	assert.equal(foreignV1.status, 200);
	assert.equal(foreignV1.data.result.task.contextId, "ctx-y");
	assert.deepEqual((foreignV1.data.result.task.history || []).map((m: { parts: { text: string }[] }) => m.parts.map((p) => p.text).join("\n")), ["x-inject-v1"]);
	hides(foreignV1.text, "y-one");
	hides(foreignV1.text, pushToken);

	const adaRows = await history("ada");
	assert.deepEqual(adaRows.data, beforeHist.data);
	assert.deepEqual(wake("ada"), beforeWake);
	const db = s.DB.db;
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE context_id = 'ctx-y' AND peer = 'ada'").get() as { n: number }).n, 2);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE context_id = 'ctx-y' AND message_json LIKE '%y-one%'").get() as { n: number }).n, 1);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE task_id = ? AND message_json LIKE '%x-inject%'").get(adaTask) as { n: number }).n, 0);
	const bobWake = wake("bob");
	assert.equal(bobWake?.peer, "bob");
	assert.equal(JSON.parse(bobWake!.pending_json).from, "bob");
	assert.equal(JSON.parse(bobWake!.pending_json).preview, "x-inject-v1");
	assert.equal(JSON.parse(beforeWake!.pending_json).preview, "y-two");

	const owners = db.prepare("SELECT peer FROM conversation_owners WHERE context_id = 'ctx-y' ORDER BY peer").all() as { peer: string }[];
	assert.deepEqual(owners.map((r) => r.peer), ["ada", "bob"]);

	const steal = await s.call("POST", "/", {
		jsonrpc: "2.0", id: 1, method: "message/send",
		params: { message: { kind: "message", role: "user", messageId: crypto.randomUUID(), taskId: adaTask, contextId: "ctx-y", parts: [{ kind: "text", text: "steal" }] } },
	}, `Bearer ${bob}`);
	assert.deepEqual(steal.data.error, { code: -32001, message: "Task not found" });
	hides(steal.text, "y-one");
	hides(steal.text, pushToken);
	const got = await s.call("POST", "/", { jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: adaTask } }, `Bearer ${bob}`);
	assert.deepEqual(got.data.error, { code: -32001, message: "Task not found" });
	hides(got.text, pushToken);
	hides(got.text, "y-two");

	const follow = await s.send(ada, "y-three", "ctx-y");
	assert.equal(follow.status, 200);
	assert.equal(follow.data.result.contextId, "ctx-y");
	assert.deepEqual(((await history("ada")).data as { text: string; peer: string }[]).map((r) => r.text), ["y-one", "y-two", "y-three"]);
	assert.equal(((await history("ada")).data as { peer: string }[]).every((r) => r.peer === "ada"), true);
	const bobOnly = (await history("bob")).data as { text: string; peer: string }[];
	assert.deepEqual(bobOnly.map((r) => r.text), ["x-inject", "x-inject-v1"]);
	assert.equal(bobOnly.every((r) => r.peer === "bob"), true);
	const mixed = (await history()).data as { text: string; peer: string }[];
	assert.deepEqual(mixed.map((r) => r.peer), ["ada", "ada", "bob", "bob", "ada"]);
	const after = JSON.parse(wake("ada")!.pending_json);
	assert.equal(after.from, "ada");
	assert.equal(after.preview, "y-three");
	assert.equal(String(after.preview).includes("x-inject"), false);

	const adaInbox = await s.owner("GET", "/owner/inbox?context=ctx-y&from=ada&all=1");
	const bobInbox = await s.owner("GET", "/owner/inbox?context=ctx-y&from=bob&all=1");
	assert.equal((adaInbox.data as { from: string; text: string }[]).every((r) => r.from === "ada"), true);
	assert.equal((bobInbox.data as { from: string; text: string }[]).every((r) => r.from === "bob"), true);
	assert.equal((adaInbox.data as { text: string }[]).some((r) => r.text === "x-inject"), false);
	assert.equal((bobInbox.data as { text: string }[]).some((r) => r.text === "y-one"), false);

	const adaList = await s.call("POST", "/", { jsonrpc: "2.0", id: 1, method: "ListTasks", params: { contextId: "ctx-y" } }, `Bearer ${ada}`);
	const bobList = await s.call("POST", "/", { jsonrpc: "2.0", id: 1, method: "ListTasks", params: { contextId: "ctx-y" } }, `Bearer ${bob}`);
	assert.equal(adaList.data.result.totalSize, 3);
	assert.equal(bobList.data.result.totalSize, 2);
	assert.equal((adaList.data.result.tasks as { id: string }[]).some((t) => t.id === adaTask), true);
	assert.equal((bobList.data.result.tasks as { id: string }[]).some((t) => t.id === adaTask), false);
	hides(bobList.text, pushToken);
	hides(bobList.text, "y-one");

	const own = await s.send(bob, "x-own", "ctx-x");
	assert.equal(own.status, 200);
	assert.equal(own.data.result.contextId, "ctx-x");
	const again = await s.send(bob, "x-again", "ctx-x");
	assert.equal(again.status, 200);
	assert.equal(again.data.result.contextId, "ctx-x");
	const omitted = await s.send(bob, "x-omit");
	assert.equal(omitted.status, 200);
	assert.match(omitted.data.result.contextId, /^[0-9a-f-]{36}$/);
	assert.equal(omitted.data.result.contextId === "ctx-y", false);
	const bobHist = await s.owner("GET", "/owner/history/ctx-x?from=bob");
	assert.deepEqual((bobHist.data as { text: string }[]).map((r) => r.text), ["x-own", "x-again"]);
});

test("an outbound row on the same context id is not joined into the other peer's task", async (t) => {
	const s = setup();
	t.after(s.restore);
	const ada = (await s.owner("POST", "/owner/peers", { label: "ada" })).data.token as string;
	const bob = (await s.owner("POST", "/owner/peers", { label: "bob" })).data.token as string;
	const aliasText = "alias-outbound-secret";
	await s.send(ada, "y-one", "ctx-y");
	const db = s.DB.db;
	db.prepare("INSERT INTO outbound (task_id, context_id, peer, sent_at, updates_json) VALUES ('out-1', 'ctx-y', 'alias', '2026-01-01T00:00:00.000Z', '[]')").run();
	db.prepare("INSERT INTO history (context_id, ts, dir, peer, task_id, text) VALUES ('ctx-y', '2026-01-01T00:00:00.000Z', 'in', 'alias', 'out-1', ?)").run(aliasText);

	const sent = await s.send(bob, "from-bob", "ctx-y");
	assert.equal(sent.status, 200);
	assert.deepEqual(opened(sent.data).texts, ["from-bob"]);
	hides(sent.text, aliasText);
	const bobHist = await s.owner("GET", "/owner/history/ctx-y?from=bob");
	assert.equal((bobHist.data as { text: string }[]).some((r) => r.text === aliasText), false);
	const adaHist = await s.owner("GET", "/owner/history/ctx-y?from=ada");
	assert.equal((adaHist.data as { text: string }[]).some((r) => r.text === aliasText), false);
	assert.deepEqual((adaHist.data as { text: string }[]).map((r) => r.text), ["y-one"]);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE context_id = 'ctx-y' AND peer = 'ada'").get() as { n: number }).n, 1);
	assert.equal((db.prepare("SELECT text FROM history WHERE task_id = 'out-1'").get() as { text: string }).text, aliasText);
});

test("two peers can both open one unused contextId without sharing history or wakes", async (t) => {
	const s = setup();
	t.after(s.restore);
	const ada = (await s.owner("POST", "/owner/peers", { label: "ada" })).data.token as string;
	const bob = (await s.owner("POST", "/owner/peers", { label: "bob" })).data.token as string;
	let arrived = 0;
	let openGate = () => {};
	const gate = new Promise<void>((resolve) => { openGate = resolve; });
	const orig = s.DB.batch.bind(s.DB);
	s.DB.batch = async (stmts: { __sql?: string }[]) => {
		const claim = stmts.some((st) => typeof st.__sql === "string" && st.__sql.includes("INSERT INTO conversation_owners"));
		if (!claim || arrived >= 2) return orig(stmts);
		arrived++;
		if (arrived === 2) openGate();
		await gate;
		return orig(stmts);
	};
	const [left, right] = await Promise.all([
		s.send(ada, "from-ada", "ctx-race"),
		s.send(bob, "from-bob", "ctx-race"),
	]);
	assert.equal(arrived, 2);
	assert.equal(left.status, 200);
	assert.equal(right.status, 200);
	assert.equal(left.data.error, undefined);
	assert.equal(right.data.error, undefined);
	assert.equal(left.data.result.contextId, "ctx-race");
	assert.equal(right.data.result.contextId, "ctx-race");
	assert.deepEqual(opened(left.data).texts, ["from-ada"]);
	assert.deepEqual(opened(right.data).texts, ["from-bob"]);
	hides(left.text, "from-bob");
	hides(right.text, "from-ada");
	hides(left.text, bob);
	hides(right.text, ada);

	const db = s.DB.db;
	const owners = db.prepare("SELECT peer FROM conversation_owners WHERE context_id = 'ctx-race' ORDER BY peer").all() as { peer: string }[];
	assert.deepEqual(owners.map((r) => r.peer), ["ada", "bob"]);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE context_id = 'ctx-race'").get() as { n: number }).n, 2);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE context_id = 'ctx-race' AND peer = 'ada'").get() as { n: number }).n, 1);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE context_id = 'ctx-race' AND peer = 'bob'").get() as { n: number }).n, 1);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM history WHERE context_id = 'ctx-race' AND peer = 'ada' AND text = 'from-bob'").get() as { n: number }).n, 0);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM history WHERE context_id = 'ctx-race' AND peer = 'bob' AND text = 'from-ada'").get() as { n: number }).n, 0);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE context_id = 'ctx-race' AND message_json LIKE '%from-ada%' AND message_json LIKE '%from-bob%'").get() as { n: number }).n, 0);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM wakes WHERE context_id = 'ctx-race'").get() as { n: number }).n, 2);
	const wakeRow = (peer: string) => db.prepare("SELECT pending_json, last_sent_ms FROM wakes WHERE context_id = 'ctx-race' AND peer = ?").get(peer) as { pending_json: string | null; last_sent_ms: number };
	// The first message of a conversation is sent at once, so neither row is holding the other's text.
	assert.equal(wakeRow("ada").pending_json, null);
	assert.equal(wakeRow("bob").pending_json, null);
	assert.equal(wakeRow("ada").last_sent_ms > 0 && wakeRow("bob").last_sent_ms > 0, true);

	const followAda = await s.send(ada, "follow-ada", "ctx-race");
	const adaPendingJson = wakeRow("ada").pending_json;
	const followBob = await s.send(bob, "follow-bob", "ctx-race");
	assert.equal(followAda.data.result.contextId, "ctx-race");
	assert.equal(followBob.data.result.contextId, "ctx-race");
	assert.equal(wakeRow("ada").pending_json, adaPendingJson);
	const adaPending = JSON.parse(adaPendingJson || "null");
	const bobPending = JSON.parse(wakeRow("bob").pending_json || "null");
	assert.equal(adaPending.preview, "follow-ada");
	assert.equal(bobPending.preview, "follow-bob");
	assert.equal(adaPending.taskIds.includes(right.data.result.id), false);
	assert.equal(adaPending.taskIds.includes(followBob.data.result.id), false);
	assert.equal(bobPending.taskIds.includes(left.data.result.id), false);
	assert.equal(bobPending.taskIds.includes(followAda.data.result.id), false);
	const adaHist = await s.owner("GET", "/owner/history/ctx-race?from=ada");
	const bobHist = await s.owner("GET", "/owner/history/ctx-race?from=bob");
	assert.deepEqual((adaHist.data as { text: string; peer: string }[]).map((r) => r.text), ["from-ada", "follow-ada"]);
	assert.deepEqual((bobHist.data as { text: string; peer: string }[]).map((r) => r.text), ["from-bob", "follow-bob"]);
	assert.equal((adaHist.data as { peer: string }[]).every((r) => r.peer === "ada"), true);
	assert.equal((bobHist.data as { peer: string }[]).every((r) => r.peer === "bob"), true);
});
