// Owner inspection contract (docs/owner-inspection.md): counts, read-only lists, paged history,
// owner HTTP and hosted owner RPC parity, and refusals for peers and anonymous callers.
// Run: npm test (also with STORAGE_BACKEND=d1 and STORAGE_BACKEND=do)
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { runOwnerRpc } from "../src/index.ts";
import { sha256 } from "../src/a2a.ts";
import { SEALED_URI } from "../src/sealed-keys.ts";
import { matchOwnerRpc } from "../src/owner-rpc.ts";
import { hostedTenantContext } from "../src/tenancy.ts";
import { d1 } from "./d1.ts";

const BASE = "https://agent.example.com";
const stamp = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
const ectx = { waitUntil() {}, passThroughOnException() {} };
const PASTED = "a2aow_" + "c".repeat(24);

function setup() {
	const DB = d1(new URL("../migrations/", import.meta.url));
	const env: any = { DB, PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", AGENT_NAME: "Inspect" };
	const call = async (path: string, auth: string | null = "Bearer owner-secret", method = "GET") => {
		const headers: Record<string, string> = { "cf-connecting-ip": "198.51.100.7" };
		if (auth) headers.authorization = auth;
		const res = await worker.fetch(new Request(BASE + path, { method, headers }) as any, env, ectx as any);
		const text = await res.text();
		let data: any = text;
		try { data = text ? JSON.parse(text) : null; } catch { /* plain text */ }
		return { status: res.status, data, text };
	};
	const hosted = async () => hostedTenantContext({ ...env, TENANCY: "host", TENANT_SECRETS_KEY: "platform-key" } as any, {
		id: "ten_inspect", db: DB, publicUrl: BASE, ownerTokenHash: await sha256("tenant-owner"), status: "active", config: { AGENT_NAME: "Inspect" },
	} as any);
	return { DB, env, call, hosted };
}

function seed(db: any) {
	const peer = db.prepare("INSERT INTO peers (label, token_hash, created_at, revoked_at) VALUES (?, ?, ?, ?)");
	peer.run("ada", "hash-ada", stamp(0), null);
	peer.run("bob", "hash-bob", stamp(0), stamp(9));
	const task = db.prepare(`INSERT INTO tasks (id, context_id, peer, state, protocol, created_at, updated_at, status_json, artifacts_json, push_configs_json)
		VALUES (?, ?, ?, ?, '0.3', ?, ?, ?, '[]', '[]')`);
	const msg = db.prepare("INSERT INTO messages (message_id, task_id, context_id, role, ts, message_json) VALUES (?, ?, ?, ?, ?, ?)");
	const add = (id: string, ctxId: string, from: string, state: string, i: number, texts: string[], extra: any = {}) => {
		task.run(id, ctxId, from, state, stamp(i), stamp(i), JSON.stringify({ state, timestamp: stamp(i), ...extra }));
		texts.forEach((text, k) => msg.run(`m-${id}-${k}`, id, ctxId, k % 2 ? "agent" : "user", stamp(i),
			JSON.stringify({ kind: "message", role: k % 2 ? "agent" : "user", messageId: `m-${id}-${k}`, parts: [{ kind: "text", text }] })));
	};
	add("t1", "ctx-a", "ada", "submitted", 1, ["first ada"]);
	add("t2", "ctx-a", "ada", "working", 2, ["second ada"]);
	add("t3", "ctx-b", "ada", "completed", 3, ["third ada", "done"]);
	add("t4", "ctx-c", "ada", "input-required", 4, ["fourth ada", "need you", "here"]);
	add("t6", "ctx-d", "ada", "submitted", 6, [`token ${PASTED} then ${"x".repeat(400)}`]);
	// Bob is revoked; his sealed task keeps counting.
	task.run("t5", "ctx-s", "bob", "failed", stamp(5), stamp(5), JSON.stringify({ state: "failed", timestamp: stamp(5) }));
	const envelope = { v: 1, ct: "Y2lwaGVydGV4dA", hdr: { from: "bob", to: "inspect", contextId: "ctx-s" } };
	msg.run("m-t5", "t5", "ctx-s", "user", stamp(5), JSON.stringify({ kind: "message", role: "user", messageId: "m-t5", contextId: "ctx-s", extensions: [SEALED_URI], parts: [{ kind: "data", data: envelope }] }));
	const wake = db.prepare("INSERT INTO wakes (context_id, last_sent_ms, pending_json, pending_since_ms) VALUES (?, ?, ?, ?)");
	wake.run("ctx-a", Date.now(), JSON.stringify({ contextId: "ctx-a", taskId: "t1", taskIds: ["t1"], from: "ada", preview: "x", kind: "inbound" }), Date.now());
	const out = db.prepare("INSERT INTO outbound (task_id, context_id, peer, sent_at, task_json, updates_json, updates_seen) VALUES (?, ?, ?, ?, ?, ?, ?)");
	out.run("o1", "ctx-a", "ada", stamp(1), JSON.stringify({ status: { state: "submitted" } }),
		JSON.stringify([{ receivedAt: stamp(7), payload: { statusUpdate: { taskId: "o1", contextId: "ctx-a", status: { state: "completed", timestamp: stamp(7) } } } }]), 0);
	out.run("o2", "ctx-z", "carol", stamp(2), JSON.stringify({ status: { state: "submitted" } }), "[]", 0);
	const hist = db.prepare("INSERT INTO history (context_id, ts, dir, peer, task_id, role, state, text, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
	for (let i = 0; i < 5; i++) hist.run("ctx-a", stamp(i), i % 2 ? "out" : "in", "ada", "t1", i % 2 ? "agent" : "user", "working", `row ${i}`, null);
	hist.run("ctx-s", stamp(5), "in", "bob", "t5", "user", "failed", "[encrypted message]", JSON.stringify({ messageId: "m-t5", sealed: envelope }));
}

test("summary adds groups, per-peer counts with revoked peers, and outbound counts; no message text", async () => {
	const s = setup();
	seed(s.DB.db);
	const r = await s.call("/owner/summary");
	assert.equal(r.status, 200);
	assert.deepEqual(r.data.tasks, { submitted: 2, working: 1, "input-required": 1, completed: 1, failed: 1, rejected: 0, canceled: 0 });
	assert.deepEqual(r.data.groups, { open: 3, waiting: 1, terminal: 2 });
	assert.equal(r.data.pairingPending, 0);
	const ada = r.data.peers.find((p: any) => p.peer === "ada");
	const bob = r.data.peers.find((p: any) => p.peer === "bob");
	assert.equal(ada.revoked, false);
	assert.equal(ada.tasks.submitted, 2);
	assert.equal(ada.updated, stamp(6));
	assert.deepEqual(ada.outbound, { tasks: 1, unseenReplies: 1 });
	assert.equal(bob.revoked, true, "a revoked peer stays listed while it has tasks");
	assert.equal(bob.tasks.failed, 1, "a sealed task counts like any other");
	assert.equal(bob.outbound, undefined);
	assert.deepEqual(r.data.outbound, { tasks: 2, unseenReplies: 1 });
	for (const t of ["first ada", "need you", "cipher", "Y2lwaGVydGV4dA"]) assert.equal(r.text.includes(t), false, t);
});

test("GET /owner/tasks filters, orders, pages with a bound cursor, and clears nothing", async () => {
	const s = setup();
	seed(s.DB.db);
	const all = await s.call("/owner/tasks");
	assert.equal(all.status, 200);
	assert.deepEqual(all.data.items.map((i: any) => i.taskId), ["t6", "t5", "t4", "t3", "t2", "t1"], "newest first by default");
	assert.equal(all.data.nextCursor, null);
	assert.equal(all.data.updatedSince, 0);
	assert.match(all.data.asOf, /^\d{4}-\d{2}-\d{2}T/);
	const t4 = all.data.items.find((i: any) => i.taskId === "t4");
	assert.deepEqual(Object.keys(t4).sort(), ["contextId", "createdAt", "from", "messageCount", "peerRevoked", "preview", "sealed", "state", "taskId", "updated"]);
	assert.equal(t4.messageCount, 3);
	assert.equal(t4.preview, "here", "preview is the last user message");
	const t5 = all.data.items.find((i: any) => i.taskId === "t5");
	assert.equal(t5.sealed, true);
	assert.equal(t5.preview, null);
	assert.equal(t5.peerRevoked, true);
	assert.equal(all.text.includes("Y2lwaGVydGV4dA"), false, "the list never returns ciphertext");
	assert.equal(all.text.includes("hdr"), false, "the list never returns the envelope header");
	const t6 = all.data.items.find((i: any) => i.taskId === "t6");
	assert.equal(t6.preview.length, 280);
	assert.equal(t6.preview.includes(PASTED), false, "preview is scrubbed of secrets");
	assert.match(t6.preview, /\[redacted\]/);

	const open = await s.call("/owner/tasks?state=open&order=oldest");
	assert.deepEqual(open.data.items.map((i: any) => i.taskId), ["t1", "t2", "t6"]);
	assert.deepEqual((await s.call("/owner/tasks?state=waiting")).data.items.map((i: any) => i.taskId), ["t4"]);
	assert.deepEqual((await s.call("/owner/tasks?state=terminal")).data.items.map((i: any) => i.taskId), ["t5", "t3"]);
	assert.deepEqual((await s.call("/owner/tasks?state=working")).data.items.map((i: any) => i.taskId), ["t2"]);
	assert.deepEqual((await s.call("/owner/tasks?from=bob")).data.items.map((i: any) => i.taskId), ["t5"]);
	assert.deepEqual((await s.call("/owner/tasks?context=ctx-a&order=oldest")).data.items.map((i: any) => i.taskId), ["t1", "t2"]);

	// Paging: two at a time, newest first.
	const seen: string[] = [];
	let cursor: string | null = null;
	let pages = 0;
	do {
		const page: any = await s.call(`/owner/tasks?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
		assert.equal(page.status, 200);
		seen.push(...page.data.items.map((i: any) => i.taskId));
		if (pages === 0) {
			// A task updated after asOf moves above the cursor; updatedSince reports it.
			s.DB.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = 't1'").run(new Date(Date.now() + 60_000).toISOString());
		}
		cursor = page.data.nextCursor;
		pages++;
		if (cursor) assert.equal(page.data.updatedSince, pages === 1 ? 0 : 1);
	} while (cursor && pages < 10);
	assert.deepEqual(seen, ["t6", "t5", "t4", "t3", "t2"], "with order=newest a task updated during paging is not on later pages");

	const first = await s.call("/owner/tasks?limit=1&state=open");
	const mismatch = await s.call(`/owner/tasks?limit=1&state=terminal&cursor=${first.data.nextCursor}`);
	assert.equal(mismatch.status, 400);
	assert.equal(mismatch.data.error, "cursor does not match");
	assert.equal((await s.call(`/owner/tasks?limit=1&state=open&order=oldest&cursor=${first.data.nextCursor}`)).status, 400, "order is bound too");
	assert.equal((await s.call("/owner/tasks?cursor=***")).status, 400);
	assert.equal((await s.call("/owner/tasks?state=bogus")).status, 400);
	assert.equal((await s.call("/owner/tasks?limit=201")).status, 400);
	assert.equal((await s.call("/owner/tasks?order=sideways")).status, 400);
	assert.equal((await s.call("/owner/tasks?from=bad%20peer")).status, 400);

	const wake = s.DB.db.prepare("SELECT pending_json FROM wakes WHERE context_id = 'ctx-a'").get() as any;
	assert.notEqual(wake?.pending_json, null, "the list clears no pending wake");
});

test("GET /owner/outbound lists sent tasks read-only with unseen replies", async () => {
	const s = setup();
	seed(s.DB.db);
	const r = await s.call("/owner/outbound");
	assert.equal(r.status, 200);
	assert.deepEqual(r.data.items.map((i: any) => i.taskId), ["o2", "o1"]);
	const o1 = r.data.items.find((i: any) => i.taskId === "o1");
	assert.deepEqual(o1, { taskId: "o1", contextId: "ctx-a", to: "ada", state: "completed", sentAt: stamp(1), updated: stamp(7), updateCount: 1, unseen: true });
	assert.equal(r.data.items.find((i: any) => i.taskId === "o2").unseen, false);
	assert.deepEqual((await s.call("/owner/outbound?to=carol")).data.items.map((i: any) => i.taskId), ["o2"]);
	const p1 = await s.call("/owner/outbound?limit=1&order=oldest");
	assert.deepEqual(p1.data.items.map((i: any) => i.taskId), ["o1"]);
	const p2 = await s.call(`/owner/outbound?limit=1&order=oldest&cursor=${p1.data.nextCursor}`);
	assert.deepEqual(p2.data.items.map((i: any) => i.taskId), ["o2"]);
	assert.equal(p2.data.nextCursor, null);
	assert.equal((await s.call(`/owner/outbound?limit=1&to=ada&cursor=${p1.data.nextCursor}`)).status, 400);
	assert.equal((await s.call("/owner/outbound?state=completed")).status, 400);
	const seen = s.DB.db.prepare("SELECT updates_seen FROM outbound WHERE task_id = 'o1'").get() as any;
	assert.equal(Number(seen.updates_seen), 0, "the list marks no reply seen");
	assert.equal((await s.call("/owner/outbound/o1")).status, 200, "the single outbound read still works");
});

test("GET /owner/history pages by sequence, binds from, and hides sealed envelopes", async () => {
	const s = setup();
	seed(s.DB.db);
	const legacy = await s.call("/owner/history/ctx-a?n=2");
	assert.ok(Array.isArray(legacy.data), "n keeps the array form");
	assert.deepEqual(legacy.data.map((r: any) => r.text), ["row 3", "row 4"]);

	const texts: string[] = [];
	let cursor: string | null = null;
	for (let i = 0; i < 5; i++) {
		const page: any = await s.call(`/owner/history/ctx-a?limit=2&from=ada${cursor ? `&cursor=${cursor}` : ""}`);
		assert.equal(page.status, 200);
		texts.push(...page.data.items.map((r: any) => r.text));
		cursor = page.data.nextCursor;
		if (!cursor) break;
	}
	assert.deepEqual(texts, ["row 0", "row 1", "row 2", "row 3", "row 4"]);
	const newest = await s.call("/owner/history/ctx-a?limit=2&order=newest");
	assert.deepEqual(newest.data.items.map((r: any) => r.text), ["row 4", "row 3"]);
	const older = await s.call(`/owner/history/ctx-a?limit=2&order=newest&cursor=${newest.data.nextCursor}`);
	assert.deepEqual(older.data.items.map((r: any) => r.text), ["row 2", "row 1"]);
	assert.equal((await s.call(`/owner/history/ctx-a?limit=2&order=newest&from=ada&cursor=${newest.data.nextCursor}`)).status, 400, "the cursor records from");
	assert.equal((await s.call(`/owner/history/ctx-b?limit=2&order=newest&cursor=${newest.data.nextCursor}`)).status, 400, "the cursor records the context");
	assert.equal((await s.call("/owner/history/ctx-a?n=5&limit=2")).status, 400);

	const sealed = await s.call("/owner/history/ctx-s?limit=10");
	assert.equal(sealed.data.items[0].sealed, true);
	assert.equal(sealed.data.items[0].text, "[encrypted message]");
	assert.deepEqual(sealed.data.items[0].data, { messageId: "m-t5" });
	assert.equal(sealed.text.includes("Y2lwaGVydGV4dA"), false);
	const full = await s.call("/owner/history/ctx-s");
	assert.equal(full.data[0].data.sealed.ct, "Y2lwaGVydGV4dA", "the array form keeps the envelope for local decryption");
});

test("hosted owner RPC returns the same inspection bodies and refuses unknown parameters", async () => {
	const s = setup();
	seed(s.DB.db);
	const ctx = await s.hosted();
	const rpc = (path: string, query?: Record<string, string>) => runOwnerRpc(ctx, ectx as any, { accountId: "acct_test", method: "GET", path, query });
	const strip = (v: any) => ({ ...v, asOf: undefined });

	const sum = await rpc("/owner/summary");
	assert.equal(sum.status, 200);
	assert.deepEqual(sum.body, await (async () => {
		const hostedHttp = await worker.fetch(new Request(BASE + "/owner/summary", { headers: { authorization: "Bearer owner-secret" } }) as any, s.env, ectx as any);
		return hostedHttp.json();
	})());
	const list = await rpc("/owner/tasks", { state: "open", order: "oldest", limit: "2" });
	assert.equal(list.status, 200);
	assert.deepEqual((list.body as any).items.map((i: any) => i.taskId), ["t1", "t2"]);
	const next = await rpc("/owner/tasks", { state: "open", order: "oldest", limit: "2", cursor: (list.body as any).nextCursor });
	assert.deepEqual((next.body as any).items.map((i: any) => i.taskId), ["t6"]);
	assert.equal((next.body as any).asOf, (list.body as any).asOf, "every page returns the first page's asOf");
	const t6 = (await rpc("/owner/tasks", { from: "ada", limit: "1" })).body as any;
	assert.equal(t6.items[0].taskId, "t6");
	assert.equal(JSON.stringify(t6).includes(PASTED), false, "a scrubbed preview is not withheld");
	const outbound = await rpc("/owner/outbound", { to: "ada" });
	assert.deepEqual(strip(outbound.body), strip({ items: [{ taskId: "o1", contextId: "ctx-a", to: "ada", state: "completed", sentAt: stamp(1), updated: stamp(7), updateCount: 1, unseen: true }], nextCursor: null, updatedSince: 0, asOf: "" }));
	const hist = await rpc("/owner/history/ctx-a", { limit: "2", order: "newest", from: "ada" });
	assert.deepEqual((hist.body as any).items.map((r: any) => r.text), ["row 4", "row 3"]);
	const sealedHist = await rpc("/owner/history/ctx-s", { limit: "5" });
	assert.equal(JSON.stringify(sealedHist.body).includes("Y2lwaGVydGV4dA"), false);

	for (const [path, query] of [
		["/owner/tasks", { all: "1" }], ["/owner/tasks", { state: "bogus" }], ["/owner/tasks", { limit: "500" }],
		["/owner/tasks", { from: "a b" }], ["/owner/outbound", { from: "ada" }], ["/owner/outbound", { state: "open" }],
		["/owner/history/ctx-a", { n: "5", limit: "2" }], ["/owner/history/ctx-a", { order: "up" }], ["/owner/summary", { peer: "ada" }],
	] as const) {
		const r = await rpc(path, query as Record<string, string>);
		assert.equal(r.status, 400, `${path} ${JSON.stringify(query)}`);
		assert.deepEqual(r.body, { error: "query is not allowed" });
	}
	assert.equal(matchOwnerRpc("POST", "/owner/tasks", {}).ok, false, "the list is GET only");
	assert.equal(matchOwnerRpc("GET", "/owner/tasks", { cursor: "a".repeat(513) }).ok, false);
	const pending = s.DB.db.prepare("SELECT pending_json FROM wakes WHERE context_id = 'ctx-a'").get() as any;
	assert.notEqual(pending?.pending_json, null, "the RPC list clears no pending wake");
});

test("peers and anonymous callers get nothing from the inspection routes", async () => {
	const s = setup();
	seed(s.DB.db);
	const issued = await worker.fetch(new Request(BASE + "/owner/peers", {
		method: "POST", headers: { authorization: "Bearer owner-secret", "content-type": "application/json" }, body: JSON.stringify({ label: "eve" }),
	}) as any, s.env, ectx as any);
	const peerToken = ((await issued.json()) as any).token as string;
	assert.match(peerToken, /^a2aow_/);
	for (const path of ["/owner/summary", "/owner/tasks", "/owner/tasks?from=eve", "/owner/outbound", "/owner/history/ctx-a?limit=2"]) {
		for (const auth of [null, "Bearer wrong", `Bearer ${peerToken}`, "Bearer a2amcp_connector", "Bearer tenant-owner"]) {
			const r = await s.call(path, auth);
			assert.equal(r.status, 401, `${path} ${auth ? auth.slice(0, 12) : "anonymous"}`);
			assert.deepEqual(r.data, { error: "unauthorized" });
		}
		const head = await s.call(path, null, "HEAD");
		assert.equal(head.status, 401);
	}
	// Peer A2A methods do not reach owner data either: a peer cannot list another peer's tasks.
	const listed = await worker.fetch(new Request(BASE + "/", {
		method: "POST", headers: { authorization: `Bearer ${peerToken}`, "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "t1" } }),
	}) as any, s.env, ectx as any);
	const body = await listed.text();
	assert.equal(body.includes("first ada"), false);
});
