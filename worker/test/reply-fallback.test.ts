// #469: a reply to a task sent under a device-flow label that has no outbound row of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "../src/a2a.ts";
import * as Addr from "../src/address.ts";
import { clearDirectoryCache } from "../src/directory.ts";
import { dispatch, runOwnerRpc } from "../src/index.ts";
import { hostedTenantContext, type DoNamespace, type KvNamespace, type TenantContext, type WorkerBindings } from "../src/tenancy.ts";
import { d1 } from "./d1.ts";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const ectx = { waitUntil(p: Promise<unknown>) { p.catch(() => {}); }, passThroughOnException() {} };
const ALICE_CARD = "https://alice.example.com/.well-known/agent-card.json";

async function world(t: { after: (fn: () => void) => void }) {
	clearDirectoryCache();
	t.after(clearDirectoryCache);
	const store = new Map<string, string>();
	const kv: KvNamespace = {
		async get(key: string, type?: "json") { const v = store.get(key); return v == null ? null : type === "json" ? JSON.parse(v) : v; },
		async put(key: string, value: string) { store.set(key, value); },
	};
	const byId = new Map<string, TenantContext>();
	let directPosts = 0;
	const ns: DoNamespace = {
		idFromName(name: string) { return name; },
		get(id: unknown) {
			return { async fetch(req: Request) {
				const ctx = byId.get(String(id));
				if (!ctx) return new Response("missing", { status: 404 });
				if (req.method === "POST" && new URL(req.url).pathname === "/") directPosts++;
				return dispatch(req, ctx, ectx as never);
			} };
		},
	};
	const env = { TENANCY: "host", TENANT_DOMAIN: "example.com", TENANT_SECRETS_KEY: "platform-key", DATA_REGION: "", TENANT_DIRECTORY: kv, TENANT_DO: ns } as WorkerBindings;
	const make = async (name: string, ownerToken: string) => {
		const db = d1(MIGRATIONS);
		const ctx = hostedTenantContext(env, { id: `id-${name}`, db, publicUrl: `https://${name}.example.com`, ownerTokenHash: await sha256(ownerToken), status: "active", config: { AGENT_NAME: name } });
		byId.set(`id-${name}`, ctx);
		store.set(`tenant:${name}`, JSON.stringify({ id: `id-${name}`, status: "active", region: "default", version: 1 }));
		return { ctx, db, ownerToken };
	};
	const alice = await make("alice", "owner-alice");
	const bob = await make("bob", "owner-bob");
	const call = async (ctx: TenantContext, path: string, init: RequestInit = {}) => {
		const res = await dispatch(new Request(ctx.PUBLIC_URL + path, init), ctx, ectx as never);
		const text = await res.text();
		let data: any = null;
		try { data = JSON.parse(text); } catch { data = text; }
		return { status: res.status, data };
	};
	const owner = (ctx: TenantContext, method: string, path: string, body?: unknown) => {
		const url = new URL(path, ctx.PUBLIC_URL);
		return runOwnerRpc(ctx, ectx as never, { accountId: "acct", method, path: url.pathname, query: Object.fromEntries(url.searchParams), ...(body === undefined ? {} : { body }) });
	};
	const auth = (who: { ownerToken: string }) => ({ authorization: `Bearer ${who.ownerToken}`, "content-type": "application/json" });

	// Alice has a verified identity. Bob holds an outbound alias "alice" to her address with a token she issued,
	// and Alice holds the reverse label for it: the working pair (X in the issue).
	const ident = await Addr.generateIdentity();
	assert.equal((await call(alice.ctx, "/owner/identity", { method: "PUT", headers: auth(alice), body: JSON.stringify(ident) })).status, 200);
	const bobAtAlice = (await call(alice.ctx, "/owner/peers", { method: "POST", headers: auth(alice), body: JSON.stringify({ label: "bob" }) })).data.token as string;
	assert.equal((await owner(bob.ctx, "PUT", "/owner/outbound-peers/alice", { url: alice.ctx.PUBLIC_URL, token: bobAtAlice })).status, 200);

	/** Alice pairs with Bob again through the device flow: a new inbound label (Y) with no outbound row. */
	const devicePair = async (extra: Record<string, string> = {}) => {
		const started = await call(bob.ctx, "/oauth/device_authorization", {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ client_name: "Alice device", client_id: "alice-device", agent_identity: ident.publicKey, ...extra }),
		});
		assert.equal(started.status, 200, JSON.stringify(started.data));
		const code = String(started.data.user_code).replace("-", "");
		assert.equal((await call(bob.ctx, `/owner/pairing/${code}/approve`, { method: "POST", headers: auth(bob) })).status, 200);
		const token = await call(bob.ctx, "/oauth/token", {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: started.data.device_code }),
		});
		assert.equal(token.status, 200, JSON.stringify(token.data));
		return { access: token.data.access_token as string, label: token.data.peer_label as string };
	};
	const sendToBob = async (token: string, text: string, contextId: string) => {
		const res = await call(bob.ctx, "/", {
			method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: "s", method: "message/send", params: { message: { kind: "message", role: "user", messageId: `m-${text}`, contextId, parts: [{ kind: "text", text }] }, configuration: { blocking: false } } }),
		});
		assert.equal(res.status, 200, JSON.stringify(res.data));
		return res.data.result.id as string;
	};
	const reply = async (taskId: string, text: string) => {
		const r = await owner(bob.ctx, "POST", "/owner/mcp/reply", { taskId, text, state: "completed", intent: "handoff" });
		assert.equal(r.status, 200, JSON.stringify(r.body));
		return r.body as { text: string; structuredContent: any };
	};
	return { alice, bob, ident, bobAtAlice, call, owner, devicePair, sendToBob, reply, get directPosts() { return directPosts; } };
}

test("#469: a device-flow label with no callback stores only and says the peer was not notified", async (t) => {
	const w = await world(t as never);
	const y = await w.devicePair();
	assert.notEqual(y.label, "alice");
	const taskId = await w.sendToBob(y.access, "question", "ctx-469-none");
	const r = await w.reply(taskId, "done");
	assert.equal(r.structuredContent.status, "stored-only");
	assert.match(r.structuredContent.detail, /peer was not notified/);
	assert.match(r.structuredContent.next, /do not notify the peer/);
	assert.match(r.text, /Next: /);
	assert.equal(w.directPosts, 0);
	assert.equal(JSON.stringify(r).includes("a2aow_"), false);
});

test("#469: a claimed card names the same-address alias as a suggestion and sends nothing", async (t) => {
	const w = await world(t as never);
	const y = await w.devicePair({ agent_card_url: ALICE_CARD });
	const taskId = await w.sendToBob(y.access, "question", "ctx-469-claimed");
	const r = await w.reply(taskId, "done");
	assert.equal(r.structuredContent.status, "stored-only", "a claimed card is never a delivery target");
	assert.match(r.structuredContent.next, /stored on the task only and does not notify the peer/);
	assert.match(r.structuredContent.next, /Outbound alias alice already points at the address this peer gave, so do not pair again/);
	assert.match(r.structuredContent.next, /if your human confirms it is the same agent, continue with send to alice/i);
	assert.doesNotMatch(r.structuredContent.next, /No usable outbound callback|pairing back/);
	assert.equal(w.directPosts, 0);
	const inbox = await w.owner(w.bob.ctx, "GET", "/owner/inbox?all=1");
	const row = (inbox.body as any[]).find((x) => x.taskId === taskId);
	assert.equal(row.continuation.kind, "same-address", "#472: an existing outbound alias is not a missing pairing");
	assert.match(row.continuation.next, new RegExp(`This label ${y.label} is a separate pairing`));
	assert.deepEqual(row.continuation.sameAddressAliases, ["alice"]);
	assert.equal(row.continuation.command, undefined, "no pair-back command when an alias already points there");
});

test("#469: a verified card delivers through the one outbound alias at that address", async (t) => {
	const w = await world(t as never);
	const y = await w.devicePair({ agent_card_url: ALICE_CARD });
	// The state a verified address announcement leaves: card_url is written only after the card proved the key.
	await w.bob.db.prepare("UPDATE peers SET card_url = ? WHERE label = ?").bind(ALICE_CARD, y.label).run();
	const taskId = await w.sendToBob(y.access, "question", "ctx-469-verified");
	const inbox = await w.owner(w.bob.ctx, "GET", "/owner/inbox");
	const guide = (inbox.body as any[]).find((x) => x.taskId === taskId).continuation;
	assert.equal(guide.kind, "send");
	assert.match(guide.next, /answer open tasks with reply[\s\S]*ask your human to confirm it is still this agent/);
	const r = await w.reply(taskId, "done via alias");
	assert.equal(r.structuredContent.status, "delivered", JSON.stringify(r));
	assert.equal(r.structuredContent.method, "a2a-message");
	assert.deepEqual(r.structuredContent.target, { alias: "alice", host: "alice.example.com" });
	assert.match(r.structuredContent.detail, /through outbound alias alice/);
	assert.equal(r.structuredContent.next, undefined);
	assert.equal(w.directPosts, 1);
	const got = await w.alice.db.prepare("SELECT metadata_json FROM tasks WHERE context_id = ? AND peer = 'bob'").bind("ctx-469-verified").first() as { metadata_json: string };
	assert.equal(JSON.parse(got.metadata_json)["a2a.exposed/reply-delivery"].taskId, taskId);
	assert.equal(JSON.stringify(r).includes(w.bobAtAlice), false);
});

test("#469: the fallback stops when the card no longer proves the label's key", async (t) => {
	const w = await world(t as never);
	const y = await w.devicePair({ agent_card_url: ALICE_CARD });
	await w.bob.db.prepare("UPDATE peers SET card_url = ? WHERE label = ?").bind(ALICE_CARD, y.label).run();
	// The label's verified key is no longer the key Alice's card proves.
	const other = await Addr.generateIdentity();
	await w.bob.db.prepare("UPDATE peers SET identity_key = ? WHERE label = ?").bind(other.publicKey, y.label).run();
	const taskId = await w.sendToBob(y.access, "question", "ctx-469-stale");
	const r = await w.reply(taskId, "kept");
	assert.equal(r.structuredContent.status, "stored-only");
	assert.match(r.structuredContent.detail, /no longer proves this peer's identity, so nothing was sent there/);
	assert.match(r.structuredContent.next, /Do not send this reply to alice[\s\S]*verify the peer's current address with its owner before any send/);
	assert.doesNotMatch(r.structuredContent.next, /Continue with send|send there/);
	assert.equal(w.directPosts, 0);
});

test("#469: two outbound aliases at the verified address are ambiguous and store only", async (t) => {
	const w = await world(t as never);
	const y = await w.devicePair({ agent_card_url: ALICE_CARD });
	await w.bob.db.prepare("UPDATE peers SET card_url = ? WHERE label = ?").bind(ALICE_CARD, y.label).run();
	assert.equal((await w.owner(w.bob.ctx, "PUT", "/owner/outbound-peers/alice-2", { url: w.alice.ctx.PUBLIC_URL, token: w.bobAtAlice })).status, 200);
	const taskId = await w.sendToBob(y.access, "question", "ctx-469-two");
	const r = await w.reply(taskId, "kept");
	assert.equal(r.structuredContent.status, "stored-only");
	assert.match(r.structuredContent.next, /alice, alice-2/);
	assert.equal(w.directPosts, 0);
});

test("#469: a revoked or tokenless alias at the address is never a fallback", async (t) => {
	const w = await world(t as never);
	const y = await w.devicePair({ agent_card_url: ALICE_CARD });
	await w.bob.db.prepare("UPDATE peers SET card_url = ? WHERE label = ?").bind(ALICE_CARD, y.label).run();
	assert.equal((await w.owner(w.bob.ctx, "PUT", "/owner/outbound-peers/alice", { url: w.alice.ctx.PUBLIC_URL })).status, 200);
	const taskId = await w.sendToBob(y.access, "question", "ctx-469-tokenless");
	const r = await w.reply(taskId, "kept");
	assert.equal(r.structuredContent.status, "stored-only");
	assert.equal(w.directPosts, 0);
});

test("#472: a device-flow pairing named like an existing outbound alias gets NAME-2 and points at that alias, not a new pairing", async (t) => {
	const w = await world(t as never);
	const y = await w.devicePair({ client_name: "alice", client_id: "alice", agent_card_url: ALICE_CARD });
	assert.equal(y.label, "alice-2", "the claimed name never takes over the outbound alias");
	const taskId = await w.sendToBob(y.access, "question", "ctx-472");
	const inbox = await w.owner(w.bob.ctx, "GET", "/owner/inbox");
	const guide = (inbox.body as any[]).find((x) => x.taskId === taskId).continuation;
	assert.equal(guide.kind, "same-address");
	assert.deepEqual(guide.sameAddressAliases, ["alice"]);
	assert.equal(guide.command, undefined, "no pairing command");
	assert.match(guide.next, /^Outbound alias alice already points at the address this peer gave, so do not pair again\. This label alice-2 is a separate pairing/);
	assert.match(guide.next, /continue with send to alice and the same context id/);
	assert.match(guide.next, /Replies to alice-2 can notify the peer after its owner runs peer announce --to ALIAS/);
	const peers = await w.call(w.bob.ctx, "/owner/peers", { headers: { authorization: `Bearer ${w.bob.ownerToken}` } });
	const listed = (peers.data as any[]).find((p) => p.label === "alice-2");
	assert.equal(listed.continuation.kind, "same-address");
	assert.equal(listed.card_url, null, "the claimed card is not a verified callback");
	const r = await w.reply(taskId, "done");
	assert.equal(r.structuredContent.status, "stored-only");
	assert.match(r.structuredContent.next, /do not pair again/);
	assert.equal(w.directPosts, 0, "nothing is sent through the same-address alias without the human");
	// After the peer's verified announcement, the label routes through alice automatically.
	await w.bob.db.prepare("UPDATE peers SET card_url = ? WHERE label = ?").bind(ALICE_CARD, y.label).run();
	const after = await w.owner(w.bob.ctx, "GET", "/owner/inbox?all=1");
	assert.equal((after.body as any[]).find((x) => x.taskId === taskId).continuation.kind, "send");
});
