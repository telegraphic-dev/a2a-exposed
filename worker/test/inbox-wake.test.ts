// GET /owner/inbox clears a pending wake only for tasks in that response.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { runOwnerRpc } from "../src/index.ts";
import { sha256 } from "../src/a2a.ts";
import { hostedTenantContext, type WorkerBindings } from "../src/tenancy.ts";
import { d1 } from "./d1.ts";

const BASE = "https://agent.example.com";
const stamp = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();

function setup() {
	const DB = d1(new URL("../migrations/", import.meta.url));
	const env: any = {
		DB, PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", AGENT_NAME: "Test Inbox", WAKE_PRESET: "generic",
		WAKE_DEBOUNCE_SECONDS: "3600", WAKE_WEBHOOK_URL: "https://hook.example.net/wake",
	};
	const origFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response("ok")) as typeof fetch;
	const call = async (method: string, path: string, json?: unknown) => {
		const headers: Record<string, string> = { authorization: "Bearer owner-secret", "cf-connecting-ip": "198.51.100.7" };
		let body: string | undefined;
		if (json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(json); }
		const pending: Promise<unknown>[] = [];
		const res = await worker.fetch(new Request(BASE + path, { method, headers, body }) as any, env, {
			waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {},
		} as any);
		await Promise.allSettled(pending);
		const text = await res.text();
		let data: any = text;
		try { data = text ? JSON.parse(text) : null; } catch { /* empty or plain text */ }
		return { status: res.status, headers: res.headers, data, text };
	};
	return { DB, call, restore: () => { globalThis.fetch = origFetch; } };
}

function seed(db: any, n: number, opt: { context?: string; oneWake?: boolean; prefix?: string; text?: (id: string) => string } = {}) {
	const ids: string[] = [];
	const task = db.prepare(`INSERT INTO tasks (id, context_id, peer, state, protocol, created_at, updated_at, status_json, artifacts_json, push_configs_json)
		VALUES (?, ?, 'ada', 'submitted', '0.3', ?, ?, ?, '[]', '[]')`);
	const msg = db.prepare(`INSERT INTO messages (message_id, task_id, context_id, role, ts, message_json) VALUES (?, ?, ?, 'user', ?, ?)`);
	const wake = db.prepare(`INSERT INTO wakes (context_id, last_sent_ms, pending_json, pending_since_ms) VALUES (?, ?, ?, ?)`);
	const now = Date.now();
	for (let i = 0; i < n; i++) {
		const id = `${opt.prefix ?? "task"}-${String(i).padStart(4, "0")}`;
		const contextId = opt.context ?? `ctx-${String(i).padStart(4, "0")}`;
		const at = stamp(i);
		const text = opt.text ? opt.text(id) : `hello ${id}`;
		task.run(id, contextId, at, at, JSON.stringify({ state: "submitted", timestamp: at }));
		msg.run(`m-${id}`, id, contextId, at, JSON.stringify({ kind: "message", role: "user", messageId: `m-${id}`, parts: [{ kind: "text", text }] }));
		ids.push(id);
		if (!opt.oneWake) {
			wake.run(contextId, now, JSON.stringify({ contextId, taskId: id, taskIds: [id], from: "ada", preview: text, kind: "inbound" }), now);
		}
	}
	if (opt.oneWake && opt.context) {
		wake.run(opt.context, now, JSON.stringify({ contextId: opt.context, taskId: ids[ids.length - 1], taskIds: ids, from: "ada", preview: "batch", kind: "inbound" }), now);
	}
	return ids;
}

const pending = (db: any, contextId: string) =>
	(db.prepare("SELECT pending_json FROM wakes WHERE context_id = ?").get(contextId) as { pending_json: string | null } | undefined)?.pending_json ?? null;

const qs = (q: Record<string, string>) => "/owner/inbox?" + new URLSearchParams(q).toString();

test("a page clears only its tasks; a later call keeps wakes the first call did not return", async (t) => {
	const s = setup();
	t.after(s.restore);
	const ids = seed(s.DB.db, 3);
	const untouched = pending(s.DB.db, "ctx-0002");
	assert.ok(untouched);

	const first = await s.call("GET", qs({ limit: "2" }));
	assert.equal(first.status, 200);
	assert.deepEqual(first.data.map((r: { taskId: string }) => r.taskId), ids.slice(0, 2));
	assert.equal(pending(s.DB.db, "ctx-0000"), null);
	assert.equal(pending(s.DB.db, "ctx-0001"), null);
	assert.equal(pending(s.DB.db, "ctx-0002"), untouched, "the task past this page keeps its wake");
	const cursor = first.headers.get("x-a2a-next-cursor");
	assert.ok(cursor);

	const later = await s.call("GET", qs({ limit: "2" }));
	assert.deepEqual(later.data.map((r: { taskId: string }) => r.taskId), ids.slice(0, 2));
	assert.equal(pending(s.DB.db, "ctx-0002"), untouched, "calling the first page again does not clear the next page");
	const head = await s.call("HEAD", qs({ limit: "1" }));
	assert.equal(head.status, 200);
	assert.equal(head.text, "");
	assert.ok(head.headers.get("x-a2a-next-cursor"));
	assert.equal(pending(s.DB.db, "ctx-0002"), untouched, "HEAD does not clear a wake");

	const next = await s.call("GET", qs({ limit: "2", cursor: cursor! }));
	assert.equal(next.status, 200);
	assert.deepEqual(next.data.map((r: { taskId: string }) => r.taskId), [ids[2]]);
	assert.equal(next.headers.get("x-a2a-next-cursor"), null);
	assert.equal(pending(s.DB.db, "ctx-0002"), null);
});

test("more pending tasks than the default page stay pending until a later page", async (t) => {
	const s = setup();
	t.after(s.restore);
	const ids = seed(s.DB.db, 201);
	const last = "ctx-0200";
	const kept = pending(s.DB.db, last);
	assert.ok(kept);

	const first = await s.call("GET", "/owner/inbox");
	assert.equal(first.status, 200);
	assert.equal(first.data.length, 200);
	assert.deepEqual(first.data.map((r: { taskId: string }) => r.taskId), ids.slice(0, 200));
	assert.equal(first.data.some((r: { taskId: string }) => r.taskId === ids[200]), false);
	assert.equal(pending(s.DB.db, "ctx-0000"), null);
	assert.equal(pending(s.DB.db, last), kept);
	const cursor = first.headers.get("x-a2a-next-cursor");
	assert.ok(cursor);

	const again = await s.call("GET", "/owner/inbox");
	assert.equal(again.data.length, 200);
	assert.equal(pending(s.DB.db, last), kept);

	const next = await s.call("GET", qs({ cursor: cursor! }));
	assert.deepEqual(next.data.map((r: { taskId: string }) => r.taskId), [ids[200]]);
	assert.equal(next.headers.get("x-a2a-next-cursor"), null);
	assert.equal(pending(s.DB.db, last), null);
});

test("a wake that names tasks on two pages drops only the tasks this response returned", async (t) => {
	const s = setup();
	t.after(s.restore);
	const ids = seed(s.DB.db, 3, { context: "ctx-span", oneWake: true });
	const first = await s.call("GET", qs({ limit: "2" }));
	assert.deepEqual(first.data.map((r: { taskId: string }) => r.taskId), ids.slice(0, 2));
	assert.deepEqual(JSON.parse(pending(s.DB.db, "ctx-span")!).taskIds, [ids[2]]);

	const later = await s.call("GET", qs({ limit: "2" }));
	assert.deepEqual(JSON.parse(pending(s.DB.db, "ctx-span")!).taskIds, [ids[2]]);
	assert.equal(later.data.some((r: { taskId: string }) => r.taskId === ids[2]), false);

	const cursor = first.headers.get("x-a2a-next-cursor");
	const next = await s.call("GET", qs({ limit: "2", cursor: cursor! }));
	assert.deepEqual(next.data.map((r: { taskId: string }) => r.taskId), [ids[2]]);
	assert.equal(pending(s.DB.db, "ctx-span"), null);
});

test("another context, a bad page, and reading one task leave unseen wakes pending", async (t) => {
	const s = setup();
	t.after(s.restore);
	seed(s.DB.db, 2);
	const other = pending(s.DB.db, "ctx-0001");
	const filtered = await s.call("GET", qs({ context: "ctx-0000" }));
	assert.deepEqual(filtered.data.map((r: { taskId: string }) => r.taskId), ["task-0000"]);
	assert.equal(pending(s.DB.db, "ctx-0000"), null);
	assert.equal(pending(s.DB.db, "ctx-0001"), other);

	for (const path of [qs({ limit: "0" }), qs({ limit: "201" }), qs({ cursor: "not-a-cursor" }), qs({ cursor: "YQ" })]) {
		const bad = await s.call("GET", path);
		assert.equal(bad.status, 400, path);
		assert.equal(pending(s.DB.db, "ctx-0001"), other, path);
	}
	const shown = await s.call("GET", "/owner/tasks/task-0001");
	assert.equal(shown.status, 200);
	assert.equal(pending(s.DB.db, "ctx-0001"), other, "opening one task does not clear its wake");
});

test("mark working and reply clear that task and leave the rest of the wake pending", async (t) => {
	const s = setup();
	t.after(s.restore);
	const ids = seed(s.DB.db, 2, { context: "ctx-act", oneWake: true });
	const working = await s.call("POST", `/owner/tasks/${ids[0]}/working`, {});
	assert.equal(working.status, 200, JSON.stringify(working.data));
	assert.deepEqual(JSON.parse(pending(s.DB.db, "ctx-act")!).taskIds, [ids[1]]);
	const reply = await s.call("POST", `/owner/tasks/${ids[1]}/reply`, { text: "done" });
	assert.equal(reply.status, 200, JSON.stringify(reply.data));
	assert.equal(pending(s.DB.db, "ctx-act"), null);
});

test("an outbound wake that reuses the task id stays pending", async (t) => {
	const s = setup();
	t.after(s.restore);
	const [id] = seed(s.DB.db, 1, { context: "ctx-in" });
	const outbound = JSON.stringify({ contextId: "ctx-out", taskId: id, taskIds: [id], from: "ada", preview: "update", kind: "outbound_update" });
	s.DB.db.prepare("INSERT INTO wakes (context_id, last_sent_ms, pending_json, pending_since_ms) VALUES (?, ?, ?, ?)").run("ctx-out", Date.now(), outbound, Date.now());
	const working = await s.call("POST", `/owner/tasks/${id}/working`, {});
	assert.equal(working.status, 200, JSON.stringify(working.data));
	assert.equal(pending(s.DB.db, "ctx-in"), null);
	assert.equal(pending(s.DB.db, "ctx-out"), outbound, "another conversation's outbound update keeps its wake");

	const [id2] = seed(s.DB.db, 1, { context: "ctx-same", prefix: "same" });
	const same = JSON.stringify({ contextId: "ctx-same", taskId: id2, taskIds: [id2, "out-only"], from: "ada", preview: "update", kind: "outbound_update" });
	s.DB.db.prepare("UPDATE wakes SET pending_json = ? WHERE context_id = ?").run(same, "ctx-same");
	const listed = await s.call("GET", qs({ context: "ctx-same" }));
	assert.deepEqual(listed.data.map((r: { taskId: string }) => r.taskId), [id2]);
	assert.equal(pending(s.DB.db, "ctx-same"), same, "listing the task does not clear an outbound_update wake");
	const marked = await s.call("POST", `/owner/tasks/${id2}/working`, {});
	assert.equal(marked.status, 200, JSON.stringify(marked.data));
	assert.equal(pending(s.DB.db, "ctx-same"), same, "mark working does not clear an outbound_update wake on that conversation");
	const reply = await s.call("POST", `/owner/tasks/${id2}/reply`, { text: "done" });
	assert.equal(reply.status, 200, JSON.stringify(reply.data));
	assert.equal(pending(s.DB.db, "ctx-same"), same, "reply does not clear an outbound_update wake on that conversation");
});

test("hosted owner RPC pages, and a withheld inbox does not clear wakes", async (t) => {
	const DB = d1(new URL("../migrations/", import.meta.url));
	const hash = await sha256("hosted-owner-token");
	const env = {
		DB, TENANCY: "host", TENANT_SECRETS_KEY: "platform-key", PUBLIC_URL: BASE, OWNER_TOKEN: "platform-owner",
	} as WorkerBindings;
	const ctx = hostedTenantContext(env, {
		id: "ten_carol", db: DB, publicUrl: BASE, ownerTokenHash: hash, status: "active", config: { AGENT_NAME: "Carol" },
	});
	const ectx = { waitUntil() {}, passThroughOnException() {} };
	const ids = seed(DB.db, 3);
	const rpc = (query?: Record<string, string>) => runOwnerRpc(ctx, ectx as any, {
		accountId: "acct_carol", method: "GET", path: "/owner/inbox", ...(query ? { query } : {}),
	});

	const first = await rpc({ limit: "2" });
	assert.equal(first.status, 200);
	assert.deepEqual((first.body as { taskId: string }[]).map((r) => r.taskId), ids.slice(0, 2));
	assert.ok(first.nextCursor);
	assert.equal(pending(DB.db, "ctx-0000"), null);
	assert.equal(pending(DB.db, "ctx-0002") !== null, true);

	const later = await rpc({ limit: "2" });
	assert.equal(pending(DB.db, "ctx-0002") !== null, true);
	const next = await rpc({ limit: "2", cursor: first.nextCursor! });
	assert.deepEqual((next.body as { taskId: string }[]).map((r) => r.taskId), [ids[2]]);
	assert.equal(next.nextCursor, undefined);
	assert.equal(pending(DB.db, "ctx-0002"), null);

	const secret = "a2aow_" + "b".repeat(20);
	seed(DB.db, 1, { context: "ctx-secret", prefix: "sec", text: () => secret });
	seed(DB.db, 1, { context: "ctx-plain", prefix: "plain", text: () => "ordinary" });
	const beforeSecret = pending(DB.db, "ctx-secret");
	const beforePlain = pending(DB.db, "ctx-plain");
	assert.ok(beforeSecret && beforePlain);
	const withheld = await rpc();
	assert.equal(withheld.status, 500);
	assert.equal(JSON.stringify(withheld.body).includes(secret), false);
	assert.equal(pending(DB.db, "ctx-secret"), beforeSecret);
	assert.equal(pending(DB.db, "ctx-plain"), beforePlain);
});
