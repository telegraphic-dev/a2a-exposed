// Wake routing: explicit wake and intent, legacy senders, dedup, batching, and shadow mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { sha256 } from "../src/a2a.ts";
import { d1 } from "./d1.ts";
import { decideRoute, isIdleWorkingPush, readRouteFields, routingMode, statusText } from "../src/wake-route.ts";
import { TOOLS } from "../src/mcp.ts";

const BASE = "https://agent.example.com";

test("routing rules are deterministic", () => {
	assert.equal(routingMode(undefined), "shadow");
	assert.equal(routingMode("nope"), "shadow");
	assert.equal(routingMode("enforce"), "enforce");
	assert.equal(statusText("  still   working \n"), "still working");
	assert.equal(isIdleWorkingPush("working", "", false), true);
	assert.equal(isIdleWorkingPush("TASK_STATE_WORKING", "  ", false), true);
	assert.equal(isIdleWorkingPush("working", "still going", false), false);
	assert.equal(isIdleWorkingPush("working", "", true), false);
	assert.equal(isIdleWorkingPush("completed", "", false), false);
	assert.deepEqual(readRouteFields(undefined, undefined), { ok: true, fields: { wake: null, intent: null } });
	assert.equal(readRouteFields({ "a2a.exposed/wake": "later" }, undefined).ok, false);
	assert.equal(readRouteFields({ "a2a.exposed/wake": "auto" }, { "a2a.exposed/wake": "never" }).ok, false);
	assert.deepEqual(readRouteFields(undefined, { "a2a.exposed/intent": "ack" }), { ok: true, fields: { wake: null, intent: "ack" } });

	const shadowAck = decideRoute({ mode: "shadow", wake: "auto", intent: "ack", duplicate: false, idle: false, unchanged: false });
	assert.equal(shadowAck.deliver, true);
	assert.equal(shadowAck.action, "shadow");
	assert.equal(shadowAck.proposed, "suppress");
	const enforceAck = decideRoute({ mode: "enforce", wake: null, intent: "ack", duplicate: false, idle: false, unchanged: false });
	assert.equal(enforceAck.deliver, false);
	assert.equal(enforceAck.action, "suppress");
	for (const intent of ["handoff", "blocker", "question"] as const) {
		const decision = decideRoute({ mode: "enforce", wake: "auto", intent, duplicate: false, idle: false, unchanged: false });
		assert.equal(decision.deliver, true, intent);
		assert.equal(decision.action, "wake", intent);
	}
	const changed = decideRoute({ mode: "enforce", wake: "auto", intent: "status", duplicate: false, idle: false, unchanged: false });
	assert.equal(changed.batch, true);
	assert.equal(changed.deliver, true);
	const idle = decideRoute({ mode: "enforce", wake: "auto", intent: "status", duplicate: false, idle: true, unchanged: false });
	assert.equal(idle.deliver, false);
	assert.equal(idle.decision, "status_idle");
	const same = decideRoute({ mode: "enforce", wake: "auto", intent: "status", duplicate: false, idle: false, unchanged: true });
	assert.equal(same.deliver, false);
	assert.equal(same.decision, "status_unchanged");
	const always = decideRoute({ mode: "enforce", wake: "always", intent: "ack", duplicate: false, idle: false, unchanged: false });
	assert.equal(always.deliver, true);
	assert.equal(always.decision, "always");
	const never = decideRoute({ mode: "shadow", wake: "never", intent: "handoff", duplicate: false, idle: false, unchanged: false });
	assert.equal(never.deliver, false);
	const legacy = decideRoute({ mode: "enforce", wake: null, intent: null, duplicate: false, idle: false, unchanged: false });
	assert.equal(legacy.decision, "legacy");
	assert.equal(legacy.deliver, true);
	const duplicate = decideRoute({ mode: "shadow", wake: "always", intent: "question", duplicate: true, idle: false, unchanged: false });
	assert.equal(duplicate.deliver, false);
	assert.equal(duplicate.decision, "duplicate");
	const unspecified = decideRoute({ mode: "enforce", wake: "auto", intent: null, duplicate: false, idle: false, unchanged: false });
	assert.equal(unspecified.decision, "auto_unspecified");
	assert.equal(unspecified.deliver, true);
});

test("the send tool advertises wake and intent and forbids ack loops", () => {
	const send = TOOLS.find((tool) => tool.name === "send");
	assert.ok(send);
	const props = send.inputSchema.properties as Record<string, { enum?: string[] }>;
	assert.deepEqual(props.wake.enum, ["auto", "always", "never"]);
	assert.deepEqual(props.intent.enum, ["handoff", "blocker", "question", "status", "ack"]);
	assert.match(send.description, /acknowledgement-only/);
	assert.match(send.description, /do not answer an ack/i);
});

function envFor(over: Record<string, string> = {}) {
	return {
		DB: d1(new URL("../migrations/", import.meta.url)), PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret",
		WAKE_PRESET: "generic", WAKE_WEBHOOK_URL: "https://hook.example.net/wake", WAKE_WEBHOOK_KEY: "k",
		WAKE_DEBOUNCE_SECONDS: "0", WAKE_BUSY_SECONDS: "0", ...over,
	};
}

function harness(env: ReturnType<typeof envFor>) {
	const sent: { contextId?: string; taskId?: string; taskIds?: string[]; kind?: string; preview?: string }[] = [];
	const logs: string[] = [];
	const origFetch = globalThis.fetch;
	const origLog = console.log;
	globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
		if (init?.body) sent.push(JSON.parse(String(init.body)));
		return new Response("ok", { status: 200 });
	}) as typeof fetch;
	console.log = (...args: unknown[]) => { logs.push(String(args[0])); };
	const call = async (method: string, path: string, json?: unknown, auth = "Bearer owner-secret") => {
		const pending: Promise<unknown>[] = [];
		const res = await worker.fetch(new Request(BASE + path, {
			method, headers: { "content-type": "application/json", authorization: auth },
			body: json === undefined ? undefined : JSON.stringify(json),
		}) as never, env, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as never);
		await Promise.allSettled(pending);
		const text = await res.text();
		let data: unknown = text;
		try { data = text ? JSON.parse(text) : null; } catch { /* plain */ }
		return { status: res.status, data };
	};
	const restore = () => { globalThis.fetch = origFetch; console.log = origLog; };
	return { sent, logs, call, restore };
}

function message(text: string, extra: Record<string, unknown> = {}, id = crypto.randomUUID()) {
	return {
		jsonrpc: "2.0", id: 1, method: "message/send",
		params: {
			message: {
				kind: "message", role: "user", messageId: id, parts: [{ kind: "text", text }],
				...(extra.message ? { metadata: extra.message } : {}),
				...(extra.contextId ? { contextId: extra.contextId } : {}),
				...(extra.taskId ? { taskId: extra.taskId } : {}),
			},
			...(extra.params ? { metadata: extra.params } : {}),
		},
	};
}

function taskIdOf(data: unknown): string {
	const body = data as { result?: { id?: string; task?: { id?: string } } };
	const id = body.result?.id || body.result?.task?.id;
	assert.equal(typeof id, "string", JSON.stringify(data));
	return id as string;
}

function routes(logs: string[]) {
	return logs.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((row) => row?.event === "wake_route");
}

test("legacy, never, always, auto, dedup, and shadow metrics", async (t) => {
	const phrase = "phrase-not-for-logs";
	const shadow = envFor();
	const h = harness(shadow);
	t.after(h.restore);
	const token = ((await h.call("POST", "/owner/peers", { label: "ada" })).data as { token: string }).token;
	const peer = `Bearer ${token}`;
	const wakes = () => h.sent.length;

	const legacy = await h.call("POST", "/", message(`${phrase} legacy`, { contextId: "ctx-legacy" }), peer);
	assert.equal(taskIdOf(legacy.data).length > 0, true);
	assert.equal(wakes(), 1);
	assert.equal(routes(h.logs).at(-1).decision, "legacy");
	assert.equal(routes(h.logs).at(-1).action, "wake");

	const beforeNever = wakes();
	const quiet = await h.call("POST", "/", message(`${phrase} never`, { contextId: "ctx-never", message: { "a2a.exposed/wake": "never" } }), peer);
	const neverId = taskIdOf(quiet.data);
	assert.equal(wakes(), beforeNever);
	const inbox = await h.call("GET", "/owner/inbox?context=ctx-never&from=ada");
	assert.equal((inbox.data as { taskId: string; text: string }[])[0].taskId, neverId);
	assert.match((inbox.data as { text: string }[])[0].text, /never/);
	const got = await h.call("POST", "/", { jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: neverId } }, peer);
	assert.equal((got.data as { result?: { id?: string } }).result?.id, neverId);

	const beforeAlways = wakes();
	await h.call("POST", "/", message("need you now", { contextId: "ctx-always", message: { "a2a.exposed/wake": "always", "a2a.exposed/intent": "ack" } }), peer);
	assert.equal(wakes(), beforeAlways + 1);
	assert.equal(routes(h.logs).at(-1).decision, "always");

	const beforeShadowAck = wakes();
	await h.call("POST", "/", message(`${phrase} ack`, { contextId: "ctx-shadow-ack", message: { "a2a.exposed/wake": "auto", "a2a.exposed/intent": "ack" } }), peer);
	assert.equal(wakes(), beforeShadowAck + 1, "shadow still wakes an ack");
	assert.equal(routes(h.logs).at(-1).action, "shadow");
	assert.equal(routes(h.logs).at(-1).proposed, "suppress");

	for (const intent of ["handoff", "blocker", "question"]) {
		const before = wakes();
		await h.call("POST", "/", message(intent, { contextId: `ctx-${intent}`, params: { "a2a.exposed/wake": "auto", "a2a.exposed/intent": intent } }), peer);
		assert.equal(wakes(), before + 1, intent);
		assert.equal(routes(h.logs).at(-1).decision, intent);
	}

	const retryId = "msg-retry-1";
	const first = await h.call("POST", "/", message("original", { contextId: "ctx-retry", message: { "a2a.exposed/wake": "always" } }, retryId), peer);
	const firstTask = taskIdOf(first.data);
	const beforeRetry = wakes();
	const second = await h.call("POST", "/", message("original again", { contextId: "ctx-retry", message: { "a2a.exposed/wake": "always" } }, retryId), peer);
	assert.equal(taskIdOf(second.data), firstTask);
	assert.equal(wakes(), beforeRetry);
	assert.equal(routes(h.logs).at(-1).decision, "duplicate");
	const stored = shadow.DB.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE message_id = ?").get(retryId) as { n: number };
	assert.equal(stored.n, 1);

	const bad = await h.call("POST", "/", message("nope", { message: { "a2a.exposed/wake": "later" } }), peer);
	assert.equal((bad.data as { error?: { code?: number } }).error?.code, -32602);
	const clash = await h.call("POST", "/", message("nope", {
		message: { "a2a.exposed/wake": "auto" }, params: { "a2a.exposed/wake": "never" },
	}), peer);
	assert.equal((clash.data as { error?: { code?: number } }).error?.code, -32602);

	const report = await h.call("GET", "/owner/wake/routing");
	const body = report.data as { mode: string; shadow: number; counts: { decision: string; action: string }[] };
	assert.equal(body.mode, "shadow");
	assert.ok(body.shadow >= 1);
	assert.equal(body.delivered, h.sent.length);
	assert.ok(body.decided > body.delivered, "suppressed decisions are not deliveries");
	assert.equal(body.counts.some((row: { decision: string }) => row.decision === "invocation"), false);
	assert.ok(body.counts.some((row) => row.decision === "ack" && row.action === "shadow"));
	assert.equal((await h.call("GET", "/owner/wake/routing", undefined, peer)).status, 401);
	for (const row of routes(h.logs)) {
		assert.equal("preview" in row, false);
		assert.equal(JSON.stringify(row).includes(phrase), false);
		assert.equal(JSON.stringify(row).includes("hook.example"), false);
	}
});

test("enforce suppresses acks and idle or unchanged status, and still wakes actionable and legacy sends", async (t) => {
	const env = envFor({ WAKE_ROUTING: "enforce" });
	const h = harness(env);
	t.after(h.restore);
	const token = ((await h.call("POST", "/owner/peers", { label: "ada" })).data as { token: string }).token;
	const peer = `Bearer ${token}`;

	await h.call("POST", "/", message("legacy still wakes", { contextId: "ctx-leg" }), peer);
	assert.equal(h.sent.length, 1);

	await h.call("POST", "/", message("got it", { contextId: "ctx-ack", message: { "a2a.exposed/wake": "auto", "a2a.exposed/intent": "ack" } }), peer);
	await h.call("POST", "/", message("got it too", { contextId: "ctx-ack", message: { "a2a.exposed/intent": "ack" } }), peer);
	assert.equal(h.sent.length, 1, "an ack loop does not wake");
	const acks = await h.call("GET", "/owner/inbox?context=ctx-ack&from=ada&all=1");
	assert.equal((acks.data as unknown[]).length, 2);

	await h.call("POST", "/", message("   ", { contextId: "ctx-idle", message: { "a2a.exposed/wake": "auto", "a2a.exposed/intent": "status" } }), peer);
	assert.equal(h.sent.length, 1, "an idle status does not wake");
	const idle = await h.call("GET", "/owner/history/ctx-idle?from=ada");
	assert.equal((idle.data as { text?: string }[]).some((row) => row.text !== undefined), true);

	await h.call("POST", "/", message("building", { contextId: "ctx-same", message: { "a2a.exposed/wake": "auto", "a2a.exposed/intent": "status" } }), peer);
	const afterFirstStatus = h.sent.length;
	await h.call("POST", "/", message("  building  ", { contextId: "ctx-same", message: { "a2a.exposed/wake": "auto", "a2a.exposed/intent": "status" } }), peer);
	assert.equal(h.sent.length, afterFirstStatus, "an unchanged status does not wake");
	const fp = await sha256("building");
	const row = env.DB.db.prepare("SELECT fingerprint FROM wake_dedup WHERE kind = 'status' AND peer = 'ada' AND ref = 'ctx-same'").get() as { fingerprint: string };
	assert.equal(row.fingerprint, fp);

	const beforeQuestion = h.sent.length;
	await h.call("POST", "/", message("what changed?", { contextId: "ctx-q", message: { "a2a.exposed/wake": "auto", "a2a.exposed/intent": "question" } }), peer);
	assert.equal(h.sent.length, beforeQuestion + 1);

	const report = await h.call("GET", "/owner/wake/routing");
	assert.equal((report.data as { mode: string }).mode, "enforce");
	assert.ok((report.data as { suppressed: number }).suppressed >= 3);
});

test("enforce batches changed status into one wake", async (t) => {
	const realNow = Date.now;
	let offset = 0;
	Date.now = () => realNow() + offset;
	const env = envFor({ WAKE_ROUTING: "enforce", WAKE_DEBOUNCE_SECONDS: "30", WAKE_BUSY_SECONDS: "0", ENABLE_CRON: "1" });
	const h = harness(env);
	t.after(() => { Date.now = realNow; h.restore(); });
	try {
		const token = ((await h.call("POST", "/owner/peers", { label: "ada" })).data as { token: string }).token;
		const peer = `Bearer ${token}`;
		const ids: string[] = [];
		for (const text of ["one", "two", "three"]) {
			const res = await h.call("POST", "/", message(text, { contextId: "ctx-batch", message: { "a2a.exposed/wake": "auto", "a2a.exposed/intent": "status" } }), peer);
			ids.push(taskIdOf(res.data));
		}
		assert.equal(h.sent.length, 0, "changed status waits for the debounce");
		const pending = await h.call("GET", "/owner/wake/routing");
		assert.equal((pending.data as { delivered: number }).delivered, 0);
		assert.ok((pending.data as { counts: { action: string }[] }).counts.some((row) => row.action === "batch"));
		offset += 31_000;
		await h.call("GET", "/health");
		assert.equal(h.sent.length, 1);
		assert.deepEqual(h.sent[0].taskIds, ids);
		const flushed = await h.call("GET", "/owner/wake/routing");
		assert.equal((flushed.data as { delivered: number }).delivered, 1);
	} finally {
		Date.now = realNow;
	}
});

test("always is still subject to the peer rate limit", async (t) => {
	const env = envFor({ RATE_PER_MIN: "1" });
	const h = harness(env);
	t.after(h.restore);
	const token = ((await h.call("POST", "/owner/peers", { label: "ada" })).data as { token: string }).token;
	const peer = `Bearer ${token}`;
	const first = await h.call("POST", "/", message("go", { contextId: "ctx-rate", message: { "a2a.exposed/wake": "always" } }), peer);
	assert.equal(typeof taskIdOf(first.data), "string");
	assert.equal(h.sent.length, 1);
	const limited = await h.call("POST", "/", message("again", { contextId: "ctx-rate", message: { "a2a.exposed/wake": "always" } }), peer);
	assert.equal(limited.status, 429);
	assert.equal(h.sent.length, 1);
});

test("a repeated push does not wake twice", async (t) => {
	const env = envFor();
	const h = harness(env);
	t.after(h.restore);
	const token = "push-token-dedup";
	await env.DB.prepare(
		`INSERT INTO outbound (task_id, context_id, peer, endpoint, protocol, push_token_hash, sent_at, updates_json, updates_seen)
		 VALUES ('task-push', 'ctx-push', 'ada', 'https://ada.example.net/', '0.3', ?, '2026-01-01T00:00:00.000Z', '[]', 0)`,
	).bind(await sha256(token)).run();
	const auth = `Bearer ${token}`;
	const body = { task: { id: "task-push", contextId: "ctx-push", status: { state: "working", message: { parts: [{ kind: "text", text: "same" }] } } } };
	assert.equal((await h.call("POST", "/push", body, auth)).status, 200);
	assert.equal(h.sent.length, 1);
	assert.equal((await h.call("POST", "/push", body, auth)).status, 200);
	assert.equal(h.sent.length, 1);
	assert.equal(routes(h.logs).at(-1).decision, "duplicate");
	const changed = { task: { id: "task-push", contextId: "ctx-push", status: { state: "completed", message: { parts: [{ kind: "text", text: "done" }] } } } };
	await h.call("POST", "/push", changed, auth);
	assert.equal(h.sent.length, 2);
	const stored = env.DB.db.prepare("SELECT updates_json FROM outbound WHERE task_id = 'task-push'").get() as { updates_json: string };
	assert.equal(JSON.parse(stored.updates_json).length, 3);
});

test("an empty working push is an idle status: shadow still wakes, enforce does not", async (t) => {
	const token = "push-token-idle";
	const empty = { task: { id: "task-idle", contextId: "ctx-idle-push", status: { state: "working" } } };
	const emptyV1 = { task: { id: "task-idle", contextId: "ctx-idle-push", status: { state: "TASK_STATE_WORKING" } } };
	const withText = { task: { id: "task-idle", contextId: "ctx-idle-push", status: { state: "working", message: { parts: [{ kind: "text", text: "still going" }] } } } };
	const completed = { task: { id: "task-idle", contextId: "ctx-idle-push", status: { state: "completed" } } };

	const shadow = envFor();
	const hs = harness(shadow);
	t.after(hs.restore);
	await shadow.DB.prepare(
		`INSERT INTO outbound (task_id, context_id, peer, endpoint, protocol, push_token_hash, sent_at, updates_json, updates_seen)
		 VALUES ('task-idle', 'ctx-idle-push', 'ada', 'https://ada.example.net/', '0.3', ?, '2026-01-01T00:00:00.000Z', '[]', 0)`,
	).bind(await sha256(token)).run();
	const auth = `Bearer ${token}`;
	assert.equal((await hs.call("POST", "/push", empty, auth)).status, 200);
	assert.equal(hs.sent.length, 1, "shadow still wakes an empty working push");
	assert.equal(routes(hs.logs).at(-1).decision, "status_idle");
	assert.equal(routes(hs.logs).at(-1).action, "shadow");
	const shadowReport = await hs.call("GET", "/owner/wake/routing");
	assert.equal((shadowReport.data as { mode?: string }).mode, "shadow");
	assert.ok(((shadowReport.data as { counts?: { decision: string; action: string; count: number }[] }).counts || [])
		.some((row) => row.decision === "status_idle" && row.action === "shadow" && row.count >= 1));

	const env = envFor({ WAKE_ROUTING: "enforce" });
	const h = harness(env);
	t.after(h.restore);
	await env.DB.prepare(
		`INSERT INTO outbound (task_id, context_id, peer, endpoint, protocol, push_token_hash, sent_at, updates_json, updates_seen)
		 VALUES ('task-idle', 'ctx-idle-push', 'ada', 'https://ada.example.net/', '0.3', ?, '2026-01-01T00:00:00.000Z', '[]', 0)`,
	).bind(await sha256(token)).run();
	assert.equal((await h.call("POST", "/push", empty, auth)).status, 200);
	assert.equal(h.sent.length, 0, "enforce does not wake an empty working push");
	assert.equal(routes(h.logs).at(-1).decision, "status_idle");
	assert.equal(routes(h.logs).at(-1).action, "suppress");
	assert.equal((await h.call("POST", "/push", emptyV1, auth)).status, 200);
	assert.equal(h.sent.length, 0, "the v1 working spelling is also idle");
	assert.equal((await h.call("POST", "/push", withText, auth)).status, 200);
	assert.equal(h.sent.length, 1, "a working push with text still wakes");
	assert.equal(routes(h.logs).at(-1).decision, "legacy");
	const withFile = { task: { id: "task-idle", contextId: "ctx-idle-push", status: { state: "working", message: { parts: [{ kind: "file", file: { name: "note.txt", bytes: "aaa" } }] } } } };
	assert.equal((await h.call("POST", "/push", withFile, auth)).status, 200);
	assert.equal(h.sent.length, 2, "a working push with a file still wakes");
	assert.equal((await h.call("POST", "/push", completed, auth)).status, 200);
	assert.equal(h.sent.length, 3, "an empty completed push still wakes");
	const stored = env.DB.db.prepare("SELECT updates_json FROM outbound WHERE task_id = 'task-idle'").get() as { updates_json: string };
	assert.equal(JSON.parse(stored.updates_json).length, 5);
	const report = await h.call("GET", "/owner/wake/routing");
	assert.equal((report.data as { mode?: string }).mode, "enforce");
	assert.ok(((report.data as { counts?: { decision: string; action: string; count: number }[] }).counts || [])
		.some((row) => row.decision === "status_idle" && row.action === "suppress" && row.count >= 1));
});

test("a labelled push follows the sender's wake and intent fields", async (t) => {
	const env = envFor({ WAKE_ROUTING: "enforce" });
	const h = harness(env);
	t.after(h.restore);
	const token = "push-token-label";
	await env.DB.prepare(
		`INSERT INTO outbound (task_id, context_id, peer, endpoint, protocol, push_token_hash, sent_at, updates_json, updates_seen)
		 VALUES ('task-label', 'ctx-label', 'ada', 'https://ada.example.net/', '0.3', ?, '2026-01-01T00:00:00.000Z', '[]', 0)`,
	).bind(await sha256(token)).run();
	const auth = `Bearer ${token}`;
	const ack = {
		task: {
			id: "task-label", contextId: "ctx-label",
			status: { state: "working", message: { parts: [{ kind: "text", text: "ok" }], metadata: { "a2a.exposed/intent": "ack" } } },
		},
	};
	assert.equal((await h.call("POST", "/push", ack, auth)).status, 200);
	assert.equal(h.sent.length, 0, "an ack-labelled push does not wake in enforce");
	assert.equal(routes(h.logs).at(-1).decision, "ack");
	assert.equal(routes(h.logs).at(-1).action, "suppress");
	const always = {
		task: {
			id: "task-label", contextId: "ctx-label",
			status: { state: "working", message: { metadata: { "a2a.exposed/wake": "always" } } },
		},
	};
	assert.equal((await h.call("POST", "/push", always, auth)).status, 200);
	assert.equal(h.sent.length, 1, "always still wakes an empty working push");
	assert.equal(routes(h.logs).at(-1).decision, "always");
	const invalid = {
		task: {
			id: "task-label", contextId: "ctx-label",
			status: { state: "working", message: { metadata: { "a2a.exposed/intent": "ping" } } },
		},
	};
	assert.equal((await h.call("POST", "/push", invalid, auth)).status, 200, "invalid metadata does not reject the push");
	assert.equal(h.sent.length, 1, "invalid labels fall back to the empty-working rule");
	assert.equal(routes(h.logs).at(-1).decision, "status_idle");
	const taskNever = {
		task: {
			id: "task-label", contextId: "ctx-label",
			metadata: { "a2a.exposed/wake": "never" },
			status: { state: "working", message: { parts: [{ kind: "text", text: "still going" }] } },
		},
	};
	assert.equal((await h.call("POST", "/push", taskNever, auth)).status, 200);
	assert.equal(h.sent.length, 1, "task-level never is kept when the status message has no metadata");
	assert.equal(routes(h.logs).at(-1).decision, "never");
	const messageWins = {
		task: {
			id: "task-label", contextId: "ctx-label",
			metadata: { "a2a.exposed/intent": "ack" },
			status: { state: "completed", message: { metadata: { "a2a.exposed/wake": "always" } } },
		},
	};
	assert.equal((await h.call("POST", "/push", messageWins, auth)).status, 200);
	assert.equal(h.sent.length, 2, "message wake is combined with task intent and always still wakes");
	assert.equal(routes(h.logs).at(-1).decision, "always");
	const conflict = {
		task: {
			id: "task-label", contextId: "ctx-label",
			metadata: { "a2a.exposed/wake": "never" },
			status: { state: "completed", message: { metadata: { "a2a.exposed/wake": "always" } } },
		},
	};
	assert.equal((await h.call("POST", "/push", conflict, auth)).status, 200, "conflicting metadata does not reject the push");
	assert.equal(h.sent.length, 3, "conflicting labels fall back to unlabelled rules");
	assert.equal(routes(h.logs).at(-1).decision, "legacy");
});

test("enforce batches a labelled status push instead of waking immediately", async (t) => {
	const realNow = Date.now;
	let offset = 0;
	Date.now = () => realNow() + offset;
	const env = envFor({ WAKE_ROUTING: "enforce", WAKE_DEBOUNCE_SECONDS: "30", WAKE_BUSY_SECONDS: "0", ENABLE_CRON: "1" });
	const h = harness(env);
	t.after(() => { Date.now = realNow; h.restore(); });
	try {
		const token = "push-token-batch";
		await env.DB.prepare(
			`INSERT INTO outbound (task_id, context_id, peer, endpoint, protocol, push_token_hash, sent_at, updates_json, updates_seen)
			 VALUES ('task-batch', 'ctx-batch-push', 'ada', 'https://ada.example.net/', '0.3', ?, '2026-01-01T00:00:00.000Z', '[]', 0)`,
		).bind(await sha256(token)).run();
		const auth = `Bearer ${token}`;
		const status = (text: string) => ({
			task: {
				id: "task-batch", contextId: "ctx-batch-push",
				status: { state: "working", message: { parts: [{ kind: "text", text }], metadata: { "a2a.exposed/intent": "status" } } },
			},
		});
		assert.equal((await h.call("POST", "/push", status("one"), auth)).status, 200);
		assert.equal((await h.call("POST", "/push", status("two"), auth)).status, 200);
		assert.equal(h.sent.length, 0, "changed status waits for the debounce");
		assert.ok(routes(h.logs).some((row) => row.decision === "status" && row.action === "batch"));
		offset += 31_000;
		await h.call("GET", "/health");
		assert.equal(h.sent.length, 1);
	} finally {
		Date.now = realNow;
	}
});

test("concurrent retries of one message id store one task and wake once", async (t) => {
	const env = envFor();
	const h = harness(env);
	t.after(h.restore);
	const token = ((await h.call("POST", "/owner/peers", { label: "ada" })).data as { token: string }).token;
	const peer = `Bearer ${token}`;
	const body = message("once", { contextId: "ctx-race", message: { "a2a.exposed/wake": "always" } }, "msg-race");
	const [a, b] = await Promise.all([h.call("POST", "/", body, peer), h.call("POST", "/", body, peer)]);
	assert.equal(a.status, 200, JSON.stringify(a.data));
	assert.equal(b.status, 200, JSON.stringify(b.data));
	assert.equal(taskIdOf(a.data), taskIdOf(b.data));
	assert.equal(h.sent.length, 1);
	const tasks = env.DB.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE context_id = 'ctx-race'").get() as { n: number };
	const msgs = env.DB.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE message_id = 'msg-race'").get() as { n: number };
	const claims = env.DB.db.prepare("SELECT COUNT(*) AS n FROM message_claims WHERE peer = 'ada' AND message_id = 'msg-race'").get() as { n: number };
	assert.equal(tasks.n, 1);
	assert.equal(msgs.n, 1);
	assert.equal(claims.n, 1);
});

test("a push with the same filename and different bytes still wakes", async (t) => {
	const env = envFor();
	const h = harness(env);
	t.after(h.restore);
	const token = "push-token-file";
	await env.DB.prepare(
		`INSERT INTO outbound (task_id, context_id, peer, endpoint, protocol, push_token_hash, sent_at, updates_json, updates_seen)
		 VALUES ('task-file', 'ctx-file', 'ada', 'https://ada.example.net/', '0.3', ?, '2026-01-01T00:00:00.000Z', '[]', 0)`,
	).bind(await sha256(token)).run();
	const auth = `Bearer ${token}`;
	const file = (bytes: string) => ({
		task: {
			id: "task-file", contextId: "ctx-file",
			status: { state: "working", message: { parts: [{ kind: "file", file: { name: "note.txt", bytes } }] } },
		},
	});
	assert.equal((await h.call("POST", "/push", file("aaa"), auth)).status, 200);
	assert.equal(h.sent.length, 1);
	assert.equal((await h.call("POST", "/push", file("bbb"), auth)).status, 200);
	assert.equal(h.sent.length, 2, "different file bytes are not a duplicate");
	assert.equal((await h.call("POST", "/push", file("bbb"), auth)).status, 200);
	assert.equal(h.sent.length, 2, "the same payload does not wake again");
});

test("purge drops message claims and status fingerprints", async (t) => {
	const env = envFor({ WAKE_ROUTING: "enforce" });
	const h = harness(env);
	t.after(h.restore);
	const token = ((await h.call("POST", "/owner/peers", { label: "ada" })).data as { token: string }).token;
	const peer = `Bearer ${token}`;
	const first = await h.call("POST", "/", message("building", {
		contextId: "ctx-purge", message: { "a2a.exposed/wake": "auto", "a2a.exposed/intent": "status" },
	}, "msg-purge"), peer);
	assert.equal(first.status, 200, JSON.stringify(first.data));
	const purged = await h.call("POST", "/owner/purge", { contexts: ["ctx-purge"] });
	assert.equal(purged.status, 200, JSON.stringify(purged.data));
	const claims = env.DB.db.prepare("SELECT COUNT(*) AS n FROM message_claims WHERE message_id = 'msg-purge'").get() as { n: number };
	const fps = env.DB.db.prepare("SELECT COUNT(*) AS n FROM wake_dedup WHERE ref = 'ctx-purge'").get() as { n: number };
	assert.equal(claims.n, 0);
	assert.equal(fps.n, 0);
	const before = h.sent.length;
	const retried = await h.call("POST", "/", message("building", {
		contextId: "ctx-purge", message: { "a2a.exposed/wake": "auto", "a2a.exposed/intent": "status" },
	}, "msg-purge"), peer);
	assert.equal(retried.status, 200, JSON.stringify(retried.data));
	assert.equal((retried.data as { error?: { code?: number } }).error, undefined);
	assert.notEqual(taskIdOf(retried.data), taskIdOf(first.data));
	assert.notEqual(routes(h.logs).at(-1).decision, "status_unchanged");
	assert.ok(h.sent.length > before, "the same status text wakes again after purge");
});
