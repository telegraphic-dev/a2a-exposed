import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "../src/a2a.ts";
import { clearDirectoryCache } from "../src/directory.ts";
import { dispatch, runOwnerRpc } from "../src/index.ts";
import { hostedTenantContext, type DoNamespace, type KvNamespace, type TenantContext, type WorkerBindings } from "../src/tenancy.ts";
import { d1 } from "./d1.ts";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const ectx = { waitUntil(_p: Promise<unknown>) {}, passThroughOnException() {} };
type Delivery = { status: string; method: string; taskId: string; target?: { alias?: string; host?: string }; httpStatus?: number };

async function fixture(t: Parameters<typeof test>[1] extends (t: infer T) => unknown ? T : never) {
	clearDirectoryCache();
	t.after(clearDirectoryCache);
	const store = new Map<string, string>();
	const kv: KvNamespace = {
		async get(key: string, type?: "json") { const v = store.get(key); return v == null ? null : type === "json" ? JSON.parse(v) : v; },
		async put(key: string, value: string) { store.set(key, value); },
	};
	const byId = new Map<string, TenantContext>();
	let directPosts = 0;
	let hold: Promise<void> | null = null;
	const ns: DoNamespace = {
		idFromName(name: string) { return name; },
		get(id: unknown) {
			return { async fetch(req: Request) {
				const ctx = byId.get(String(id));
				if (!ctx) return new Response("missing", { status: 404 });
				if (req.method === "POST" && new URL(req.url).pathname === "/") {
					directPosts++;
					if (hold) await hold;
				}
				return dispatch(req, ctx, ectx as never);
			} };
		},
	};
	const env = { TENANCY: "host", TENANT_DOMAIN: "example.com", TENANT_SECRETS_KEY: "platform-key", DATA_REGION: "", TENANT_DIRECTORY: kv, TENANT_DO: ns } as WorkerBindings;
	const dbA = d1(MIGRATIONS);
	const dbB = d1(MIGRATIONS);
	const ownerA = "owner-alice";
	const ownerB = "owner-bob";
	const a = hostedTenantContext(env, { id: "id-alice", db: dbA, publicUrl: "https://alice.example.com", ownerTokenHash: await sha256(ownerA), status: "active", config: { AGENT_NAME: "Alice" } });
	const b = hostedTenantContext(env, { id: "id-bob", db: dbB, publicUrl: "https://bob.example.com", ownerTokenHash: await sha256(ownerB), status: "active", config: { AGENT_NAME: "Bob" } });
	byId.set("id-alice", a); byId.set("id-bob", b);
	store.set("tenant:alice", JSON.stringify({ id: "id-alice", status: "active", region: "default", version: 1 }));
	store.set("tenant:bob", JSON.stringify({ id: "id-bob", status: "active", region: "default", version: 1 }));
	const owner = (ctx: TenantContext, accountId: string, method: string, path: string, body?: unknown) =>
		runOwnerRpc(ctx, ectx as never, { accountId, method, path, ...(body === undefined ? {} : { body }) });
	const issue = async (ctx: TenantContext, ownerToken: string, label: string) => {
		const r = await dispatch(new Request(ctx.PUBLIC_URL + "/owner/peers", { method: "POST", headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" }, body: JSON.stringify({ label }) }), ctx, ectx as never);
		return (await r.json() as { token: string }).token;
	};
	const aliceAtBob = await issue(b, ownerB, "alice");
	const bobAtAlice = await issue(a, ownerA, "bob");
	assert.equal((await owner(b, "acct-bob", "PUT", "/owner/outbound-peers/alice", { url: a.PUBLIC_URL, token: bobAtAlice })).status, 200);
	const sendToBob = async (text: string, contextId: string, push?: unknown) => {
		const body = { jsonrpc: "2.0", id: "send-1", method: "message/send", params: { message: { kind: "message", role: "user", messageId: `m-${text}`, contextId, parts: [{ kind: "text", text }] }, configuration: { blocking: false, ...(push ? { pushNotificationConfig: push } : {}) } } };
		const r = await dispatch(new Request(b.PUBLIC_URL, { method: "POST", headers: { authorization: `Bearer ${aliceAtBob}`, "content-type": "application/json" }, body: JSON.stringify(body) }), b, ectx as never);
		const data = await r.json() as any;
		assert.equal(r.status, 200, JSON.stringify(data));
		return data.result.id as string;
	};
	return { a, b, dbA, dbB, owner, sendToBob, get directPosts() { return directPosts; }, blockDirect() {
		let release!: () => void;
		hold = new Promise<void>((resolve) => { release = resolve; });
		return () => { hold = null; release(); };
	} };
}

test("reply delivers once to an exact paired peer in the same context and a direct reply cannot loop", async (t) => {
	const s = await fixture(t as never);
	const taskId = await s.sendToBob("question", "ctx-direct");
	const first = await s.owner(s.b, "acct-bob", "POST", "/owner/mcp/reply", { taskId, text: "answer", state: "completed" });
	assert.equal(first.status, 200, JSON.stringify(first.body));
	const structured = (first.body as any).structuredContent as Delivery;
	assert.deepEqual({ status: structured.status, method: structured.method, taskId: structured.taskId, alias: structured.target?.alias, host: structured.target?.host, http: structured.httpStatus },
		{ status: "delivered", method: "a2a-message", taskId, alias: "alice", host: "alice.example.com", http: 200 });
	assert.match(String((first.body as any).text), /stored.*delivered/i);
	assert.equal(JSON.stringify(first.body).includes("a2aow_"), false);
	assert.equal(s.directPosts, 1);

	const inbox = await s.owner(s.a, "acct-alice", "GET", "/owner/inbox");
	const delivered = (inbox.body as any[]).find((row) => row.text === "answer");
	assert.equal(delivered.contextId, "ctx-direct");
	const stored = await s.dbA.prepare("SELECT metadata_json FROM tasks WHERE id = ?").bind(delivered.taskId).first() as { metadata_json?: string };
	const metadata = JSON.parse(stored.metadata_json || "{}");
	assert.deepEqual(metadata["a2a.exposed/reply-delivery"].taskId, taskId);

	const noLoop = await s.owner(s.a, "acct-alice", "POST", "/owner/mcp/reply", { taskId: delivered.taskId, text: "ack", state: "completed" });
	assert.equal((noLoop.body as any).structuredContent.status, "stored-only");
	assert.equal(s.directPosts, 1, "a directly delivered reply is never delivered back");

	const retry = await s.owner(s.b, "acct-bob", "POST", "/owner/mcp/reply", { taskId, text: "answer", state: "completed" });
	assert.equal(retry.status, 200, JSON.stringify(retry.body));
	assert.equal((retry.body as any).structuredContent.status, "delivered");
	assert.equal(s.directPosts, 1, "the same logical reply is idempotent");
	const count = await s.dbA.prepare("SELECT COUNT(*) AS n FROM tasks WHERE context_id = ?").bind("ctx-direct").first() as { n: number };
	assert.equal(count.n, 1);
});

test("push wins over paired direct delivery and a revoked inbound peer stores only", async (t) => {
	const s = await fixture(t as never);
	const originalFetch = globalThis.fetch;
	let pushes = 0;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		if (u.host === "push.example.net") { pushes++; return new Response(null, { status: 204 }); }
		return originalFetch(input);
	}) as typeof fetch;
	t.after(() => { globalThis.fetch = originalFetch; });
	const pushedTask = await s.sendToBob("push question", "ctx-push", { id: "cfg", url: "https://push.example.net/update" });
	const pushed = await s.owner(s.b, "acct-bob", "POST", "/owner/mcp/reply", { taskId: pushedTask, text: "push answer" });
	assert.equal((pushed.body as any).structuredContent.method, "push");
	assert.equal(pushes, 1);
	assert.equal(s.directPosts, 0, "push and direct message are never both used");

	const revokedTask = await s.sendToBob("revoked question", "ctx-revoked");
	await s.dbB.prepare("UPDATE peers SET revoked_at = ? WHERE label = 'alice'").bind(new Date().toISOString()).run();
	const revoked = await s.owner(s.b, "acct-bob", "POST", "/owner/mcp/reply", { taskId: revokedTask, text: "stored answer" });
	assert.equal((revoked.body as any).structuredContent.status, "stored-only");
	assert.equal(s.directPosts, 0);
	const task = await s.dbB.prepare("SELECT state, status_json FROM tasks WHERE id = ?").bind(revokedTask).first() as { state: string; status_json: string };
	assert.equal(task.state, "completed");
	assert.match(task.status_json, /stored answer/);
});

test("stale recovery never overlaps an uncertain delivery and a later retry reads the settled result", async (t) => {
	const s = await fixture(t as never);
	const taskId = await s.sendToBob("concurrent question", "ctx-concurrent");
	const release = s.blockDirect();
	const first = s.owner(s.b, "acct-bob", "POST", "/owner/mcp/reply", { taskId, text: "one answer" });
	while (s.directPosts === 0) await new Promise((resolve) => setTimeout(resolve, 0));
	await s.dbB.prepare("UPDATE reply_deliveries SET updated_at = '2000-01-01T00:00:00.000Z'").run();
	const raced = await s.owner(s.b, "acct-bob", "POST", "/owner/mcp/reply", { taskId, text: "one answer" });
	assert.equal(raced.status, 200);
	assert.equal((raced.body as any).structuredContent.status, "delivery-failed");
	assert.match(String((raced.body as any).structuredContent.detail), /uncertain.*not sent again/);
	assert.equal(s.directPosts, 1, "the overlapping call cannot start a second delivery");
	release();
	assert.equal(((await first).body as any).structuredContent.status, "delivered");
	const retry = await s.owner(s.b, "acct-bob", "POST", "/owner/mcp/reply", { taskId, text: "one answer" });
	assert.equal(retry.status, 200);
	assert.equal((retry.body as any).structuredContent.status, "delivered");
	assert.equal(s.directPosts, 1);
});

test("a remote token rejection reports HTTP status without losing the stored reply", async (t) => {
	const s = await fixture(t as never);
	const taskId = await s.sendToBob("will the old token work?", "ctx-rejected");
	await s.dbA.prepare("UPDATE peers SET revoked_at = ? WHERE label = 'bob'").bind(new Date().toISOString()).run();
	const result = await s.owner(s.b, "acct-bob", "POST", "/owner/mcp/reply", { taskId, text: "the answer stays", state: "completed" });
	const delivery = (result.body as any).structuredContent as Delivery;
	assert.deepEqual({ status: delivery.status, method: delivery.method, http: delivery.httpStatus },
		{ status: "delivery-failed", method: "a2a-message", http: 401 });
	assert.match(String((result.body as any).text), /stored.*failed/i);
	assert.equal(JSON.stringify(result.body).includes("a2aow_"), false);
	const stored = await s.dbB.prepare("SELECT state, status_json FROM tasks WHERE id = ?").bind(taskId).first() as { state: string; status_json: string };
	assert.equal(stored.state, "completed");
	assert.match(stored.status_json, /the answer stays/);
});
