import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "../src/a2a.ts";
import * as Addr from "../src/address.ts";
import { clearDirectoryCache } from "../src/directory.ts";
import { dispatch, runOwnerRpc } from "../src/index.ts";
import { redactExport, exportRows } from "../src/export.ts";
import { hostedTenantContext, type DoNamespace, type KvNamespace, type TenantContext, type WorkerBindings } from "../src/tenancy.ts";
import { d1 } from "./d1.ts";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const ectx = { waitUntil(p: Promise<unknown>) { p.catch(() => {}); }, passThroughOnException() {} };

test("address proofs: a card signature is bound to that URL and that key", async () => {
	const id = await Addr.generateIdentity();
	const cardUrl = "https://alice.example.com/.well-known/agent-card.json";
	const signature = await Addr.signBytes(id.privateKey, Addr.identityMessage(cardUrl, id.publicKey));
	assert.ok(signature);
	const card = { capabilities: { extensions: [Addr.identityExtension(id.publicKey, cardUrl, signature!)] } };
	assert.equal(await Addr.cardProves(card, id.publicKey, cardUrl), true);
	assert.equal(await Addr.cardProves(card, id.publicKey, "https://evil.example.com/.well-known/agent-card.json"), false);
	const other = await Addr.generateIdentity();
	assert.equal(await Addr.cardProves(card, other.publicKey, cardUrl), false);
	assert.equal(Addr.canonicalCardUrl("http://alice.example.com/.well-known/agent-card.json"), "");
	assert.equal(Addr.canonicalCardUrl("https://alice.example.com/.well-known/agent-card.json?x=1"), "");
	assert.equal(Addr.graceHours(undefined), 168);
	assert.equal(Addr.graceHours(0), null);
	assert.equal(Addr.announceOutcome(200, { result: { ok: true } }).status, "updated");
	assert.equal(Addr.announceOutcome(200, { error: { code: -32601, message: "Method not found" } }).status, "unsupported");
	assert.equal(Addr.cleanReverseToken("a2aow_" + "a".repeat(43)).length > 0, true);
	assert.equal(Addr.cleanReverseToken("owner-secret-value"), "");
});

async function world(t: { after: (fn: () => void) => void }) {
	clearDirectoryCache();
	t.after(clearDirectoryCache);
	const store = new Map<string, string>();
	const kv: KvNamespace = {
		async get(key: string, type?: "json") { const v = store.get(key); return v == null ? null : type === "json" ? JSON.parse(v) : v; },
		async put(key: string, value: string) { store.set(key, value); },
	};
	const byId = new Map<string, TenantContext>();
	const ns: DoNamespace = {
		idFromName(name: string) { return name; },
		get(id: unknown) {
			return { async fetch(req: Request) {
				const ctx = byId.get(String(id));
				if (!ctx) return new Response("missing", { status: 404 });
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
	const carol = await make("carol", "owner-carol");
	const call = async (ctx: TenantContext, path: string, init: RequestInit = {}) => {
		const res = await dispatch(new Request(ctx.PUBLIC_URL + path, init), ctx, ectx as never);
		const text = await res.text();
		let data: any = null;
		try { data = JSON.parse(text); } catch { data = text; }
		return { status: res.status, data, headers: res.headers };
	};
	const owner = (ctx: TenantContext, accountId: string, method: string, path: string, body?: unknown) =>
		runOwnerRpc(ctx, ectx as never, { accountId, method, path, ...(body === undefined ? {} : { body }) });
	return { alice, bob, carol, call, owner };
}

async function pair(bob: { ctx: TenantContext; ownerToken: string }, call: (ctx: TenantContext, path: string, init?: RequestInit) => Promise<{ status: number; data: any }>, identity?: string) {
	const started = await call(bob.ctx, "/oauth/device_authorization", {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_name: "Alice", client_id: "alice", ...(identity ? { agent_identity: identity } : {}) }),
	});
	assert.equal(started.status, 200, JSON.stringify(started.data));
	const code = String(started.data.user_code).replace("-", "");
	const approved = await call(bob.ctx, `/owner/pairing/${code}/approve`, { method: "POST", headers: { authorization: `Bearer ${bob.ownerToken}` } });
	assert.equal(approved.status, 200, JSON.stringify(approved.data));
	const token = await call(bob.ctx, "/oauth/token", {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: started.data.device_code }),
	});
	assert.equal(token.status, 200, JSON.stringify(token.data));
	assert.match(token.data.access_token, /^a2aow_/);
	return { access: token.data.access_token as string, label: token.data.peer_label as string };
}

async function send(bob: TenantContext, token: string, text: string, contextId: string) {
	const res = await dispatch(new Request(bob.PUBLIC_URL + "/", {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: "s", method: "message/send", params: { message: { kind: "message", role: "user", messageId: `m-${text}`, contextId, parts: [{ kind: "text", text }] }, configuration: { blocking: false } } }),
	}), bob, ectx as never);
	const data = await res.json() as any;
	assert.equal(res.status, 200, JSON.stringify(data));
	return data.result.id as string;
}

test("an agent with no address can pair and send; replies stay on the task until a verified announcement", async (t) => {
	const { alice, bob, call, owner } = await world(t as never);
	const ident = await Addr.generateIdentity();
	const installed = await call(alice.ctx, "/owner/identity", {
		method: "PUT", headers: { authorization: `Bearer ${alice.ownerToken}`, "content-type": "application/json" },
		body: JSON.stringify({ publicKey: ident.publicKey, privateKey: ident.privateKey }),
	});
	assert.equal(installed.status, 200, JSON.stringify(installed.data));
	assert.equal(JSON.stringify(installed.data).includes(ident.privateKey), false);
	const paired = await pair(bob, call, ident.publicKey);
	const taskId = await send(bob.ctx, paired.access, "question", "ctx-none");
	const logs: string[] = [];
	const orig = console.log;
	console.log = (line?: unknown) => { logs.push(String(line)); };
	let first: any;
	try {
		first = await owner(bob.ctx, "acct-bob", "POST", "/owner/mcp/reply", { taskId, text: "stored answer", state: "completed" });
	} finally { console.log = orig; }
	assert.equal(first.status, 200, JSON.stringify(first.body));
	assert.equal(first.body.structuredContent.status, "stored-only");
	assert.equal(JSON.stringify(first.body).includes("a2aow_"), false);
	const got = await call(bob.ctx, "/", {
		method: "POST", headers: { authorization: `Bearer ${paired.access}`, "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: "g", method: "tasks/get", params: { id: taskId } }),
	});
	assert.equal(got.status, 200, JSON.stringify(got.data));
	assert.match(JSON.stringify(got.data), /stored answer/);
	const cardUrl = "https://alice.example.com/.well-known/agent-card.json";
	const card = await call(alice.ctx, "/.well-known/agent-card.json");
	assert.equal(await Addr.cardProves(card.data, ident.publicKey, cardUrl), true);
	const forged = await Addr.generateIdentity();
	const badSig = await Addr.signBytes(forged.privateKey, Addr.updateMessage(cardUrl, ident.publicKey, "-"));
	const bad = await call(bob.ctx, "/", {
		method: "POST", headers: { authorization: `Bearer ${paired.access}`, "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: "bad", method: "PeerAddressUpdate", params: { agentCardUrl: cardUrl, publicKey: ident.publicKey, announcementSignature: badSig } }),
	});
	assert.equal(bad.data.error.code, -32602);
	assert.equal((await bob.db.prepare("SELECT card_url FROM peers WHERE label = ?").bind(paired.label).first() as any).card_url, null);
	const reverse = (await call(alice.ctx, "/owner/peers", {
		method: "POST", headers: { authorization: `Bearer ${alice.ownerToken}`, "content-type": "application/json" },
		body: JSON.stringify({ label: "bob" }),
	})).data.token as string;
	const reverseHash = await sha256(reverse);
	const signature = await Addr.signBytes(ident.privateKey, Addr.updateMessage(cardUrl, ident.publicKey, reverseHash));
	const logs2: string[] = [];
	console.log = (line?: unknown) => { logs2.push(String(line)); };
	let updated: any;
	try {
		updated = await call(bob.ctx, "/", {
			method: "POST", headers: { authorization: `Bearer ${paired.access}`, "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: "up", method: "PeerAddressUpdate", params: { agentCardUrl: cardUrl, publicKey: ident.publicKey, announcementSignature: signature, reverseToken: reverse } }),
		});
	} finally { console.log = orig; }
	assert.equal(updated.data.result?.ok, true, JSON.stringify(updated.data));
	assert.equal(JSON.stringify(updated.data).includes(reverse), false);
	assert.equal(logs2.join("\n").includes(reverse), false);
	assert.equal(logs2.join("\n").includes(ident.privateKey), false);
	const row = await bob.db.prepare("SELECT url, token_enc FROM outbound_peers WHERE alias = ?").bind(paired.label).first() as { url: string; token_enc: string };
	assert.equal(row.url, "https://alice.example.com");
	assert.ok(row.token_enc);
	assert.equal(String(row.token_enc).includes(reverse), false);
	const wrongKey = await Addr.generateIdentity();
	const wrongSig = await Addr.signBytes(wrongKey.privateKey, Addr.updateMessage(cardUrl, wrongKey.publicKey, "-"));
	const mismatch = await call(bob.ctx, "/", {
		method: "POST", headers: { authorization: `Bearer ${paired.access}`, "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: "mm", method: "PeerAddressUpdate", params: { agentCardUrl: "https://carol.example.com/.well-known/agent-card.json", publicKey: wrongKey.publicKey, announcementSignature: wrongSig } }),
	});
	assert.equal(mismatch.data.error.code, -32602);
	assert.equal((await bob.db.prepare("SELECT url FROM outbound_peers WHERE alias = ?").bind(paired.label).first() as any).url, "https://alice.example.com");
	const task2 = await send(bob.ctx, paired.access, "second", "ctx-none");
	const second = await owner(bob.ctx, "acct-bob", "POST", "/owner/mcp/reply", { taskId: task2, text: "delivered answer", state: "completed" });
	assert.equal(second.body.structuredContent.status, "delivered", JSON.stringify(second.body));
	assert.equal(second.body.structuredContent.target.host, "alice.example.com");
	assert.equal(JSON.stringify(second.body).includes(reverse), false);
	const view = await owner(bob.ctx, "acct-bob", "GET", "/owner/address");
	assert.equal(view.status, 200, JSON.stringify(view.body));
	assert.equal(JSON.stringify(view.body).includes(reverse), false);
	assert.equal(JSON.stringify(view.body).includes(ident.privateKey), false);
});

test("a legacy pairing binds an identity once, and a later key is refused", async (t) => {
	const { alice, bob, call } = await world(t as never);
	const ident = await Addr.generateIdentity();
	assert.equal((await call(alice.ctx, "/owner/identity", {
		method: "PUT", headers: { authorization: `Bearer ${alice.ownerToken}`, "content-type": "application/json" },
		body: JSON.stringify(ident),
	})).status, 200);
	const paired = await pair(bob, call);
	assert.equal((await bob.db.prepare("SELECT identity_key FROM peers WHERE label = ?").bind(paired.label).first() as any).identity_key, null);
	const cardUrl = "https://alice.example.com/.well-known/agent-card.json";
	const signature = await Addr.signBytes(ident.privateKey, Addr.updateMessage(cardUrl, ident.publicKey, "-"));
	const bound = await call(bob.ctx, "/", {
		method: "POST", headers: { authorization: `Bearer ${paired.access}`, "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: "b", method: "PeerAddressUpdate", params: { agentCardUrl: cardUrl, publicKey: ident.publicKey, announcementSignature: signature } }),
	});
	assert.equal(bound.data.result?.ok, true, JSON.stringify(bound.data));
	const other = await Addr.generateIdentity();
	await call(alice.ctx, "/owner/identity", {
		method: "PUT", headers: { authorization: `Bearer ${alice.ownerToken}`, "content-type": "application/json" },
		body: JSON.stringify(other),
	});
	const again = await Addr.signBytes(other.privateKey, Addr.updateMessage(cardUrl, other.publicKey, "-"));
	const refused = await call(bob.ctx, "/", {
		method: "POST", headers: { authorization: `Bearer ${paired.access}`, "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: "r", method: "PeerAddressUpdate", params: { agentCardUrl: cardUrl, publicKey: other.publicKey, announcementSignature: again } }),
	});
	assert.equal(refused.data.error.code, -32602);
	assert.equal((await bob.db.prepare("SELECT identity_key FROM peers WHERE label = ?").bind(paired.label).first() as any).identity_key, ident.publicKey);
});

test("the old address forwards a direct reply and answers with a moved pointer", async (t) => {
	const { alice, bob, call } = await world(t as never);
	const cardUrl = "https://alice.example.com/.well-known/agent-card.json";
	const ident = await Addr.generateIdentity();
	const set = await call(bob.ctx, "/owner/address-forward", {
		method: "PUT", headers: { authorization: `Bearer ${bob.ownerToken}`, "content-type": "application/json" },
		body: JSON.stringify({ cardUrl, hours: 24 }),
	});
	assert.equal(set.status, 200, JSON.stringify(set.data));
	const moved = await call(bob.ctx, "/.well-known/a2a-moved.json");
	assert.equal(moved.data.cardUrl, cardUrl);
	const token = (await call(bob.ctx, "/owner/peers", {
		method: "POST", headers: { authorization: `Bearer ${bob.ownerToken}`, "content-type": "application/json" },
		body: JSON.stringify({ label: "carol" }),
	})).data.token as string;
	const same = await sha256(token);
	await alice.db.prepare("INSERT INTO peers (label, token_hash, created_at) VALUES ('carol', ?, ?)").bind(same, new Date().toISOString()).run();
	const early = await call(bob.ctx, "/", {
		method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: "early", method: "message/send", params: {
			message: { kind: "message", role: "user", messageId: "m-early", contextId: "ctx-early", parts: [{ kind: "text", text: "before proof" }], metadata: { "a2a.exposed/reply-delivery": { taskId: "t0", messageId: "m0", state: "completed" } } },
			metadata: { "a2a.exposed/reply-delivery": { taskId: "t0", messageId: "m0", state: "completed" } },
		} }),
	});
	assert.equal(early.data.error.code, Addr.MOVED_CODE);
	assert.equal((await alice.db.prepare("SELECT COUNT(*) AS n FROM tasks").first() as { n: number }).n, 0);
	assert.equal((await call(bob.ctx, "/owner/identity", {
		method: "PUT", headers: { authorization: `Bearer ${bob.ownerToken}`, "content-type": "application/json" },
		body: JSON.stringify(ident),
	})).status, 200);
	assert.equal((await call(alice.ctx, "/owner/identity", {
		method: "PUT", headers: { authorization: `Bearer ${alice.ownerToken}`, "content-type": "application/json" },
		body: JSON.stringify(ident),
	})).status, 200);
	const reply = await call(bob.ctx, "/", {
		method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: "fwd", method: "message/send", params: {
			message: { kind: "message", role: "user", messageId: "m-fwd", contextId: "ctx-fwd", parts: [{ kind: "text", text: "please forward" }], metadata: { "a2a.exposed/reply-delivery": { taskId: "t", messageId: "m", state: "completed" } } },
			metadata: { "a2a.exposed/reply-delivery": { taskId: "t", messageId: "m", state: "completed" } },
		} }),
	});
	assert.equal(reply.headers.get("a2a-moved"), cardUrl);
	assert.equal(reply.status, 200);
	assert.equal(JSON.stringify(reply.data).includes(token), false);
	assert.equal((await alice.db.prepare("SELECT COUNT(*) AS n FROM tasks").first() as { n: number }).n, 1);
	const stranger = (await call(bob.ctx, "/owner/peers", {
		method: "POST", headers: { authorization: `Bearer ${bob.ownerToken}`, "content-type": "application/json" },
		body: JSON.stringify({ label: "stranger" }),
	})).data.token as string;
	const pointer = await call(bob.ctx, "/", {
		method: "POST", headers: { authorization: `Bearer ${stranger}`, "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: "ptr", method: "message/send", params: {
			message: { kind: "message", role: "user", messageId: "m-ptr", contextId: "ctx-ptr", parts: [{ kind: "text", text: "no token there" }], metadata: { "a2a.exposed/reply-delivery": { taskId: "t2", messageId: "m2", state: "completed" } } },
			metadata: { "a2a.exposed/reply-delivery": { taskId: "t2", messageId: "m2", state: "completed" } },
		} }),
	});
	assert.equal(pointer.data.error.code, Addr.MOVED_CODE);
	assert.equal(pointer.data.error.data.movedTo, cardUrl);
	assert.equal(pointer.headers.get("a2a-moved"), cardUrl);
	assert.equal(JSON.stringify(pointer.data).includes(stranger), false);
});

test("announce does not store a return token when the peer does not accept the update", async (t) => {
	const { alice, bob, call, owner } = await world(t as never);
	const ident = await Addr.generateIdentity();
	await call(alice.ctx, "/owner/identity", {
		method: "PUT", headers: { authorization: `Bearer ${alice.ownerToken}`, "content-type": "application/json" },
		body: JSON.stringify(ident),
	});
	const token = "a2aow_" + "b".repeat(43);
	await bob.db.prepare("INSERT INTO peers (label, token_hash, created_at) VALUES ('old', ?, ?)").bind(await sha256(token), new Date().toISOString()).run();
	// A peer that answers method-not-found. Carol's worker understands the method, so this stub is the old peer.
	const oldUrl = "https://old.example.com";
	assert.equal((await owner(alice.ctx, "acct-alice", "PUT", "/owner/outbound-peers/old", { url: oldUrl, token })).status, 200);
	const announced = await owner(alice.ctx, "acct-alice", "POST", "/owner/peers/announce", { to: "old" });
	assert.equal(announced.status, 200, JSON.stringify(announced.body));
	const row = (announced.body as any).results[0];
	assert.equal(row.status === "unsupported" || row.status === "failed", true, JSON.stringify(row));
	assert.equal(JSON.stringify(announced.body).includes(token), false);
	assert.equal((await alice.db.prepare("SELECT COUNT(*) AS n FROM peers WHERE source = 'reverse'").first() as any).n, 0);
	const view = await call(alice.ctx, "/owner/address", { headers: { authorization: `Bearer ${alice.ownerToken}` } });
	assert.equal(view.data.announcePending[0].alias, "old");
	assert.equal(JSON.stringify(view.data).includes(ident.privateKey), false);
});

test("a reply follows a moved card only when the new card proves the stored identity", async (t) => {
	const { alice, bob, carol, call, owner } = await world(t as never);
	const ident = await Addr.generateIdentity();
	assert.equal((await call(alice.ctx, "/owner/identity", {
		method: "PUT", headers: { authorization: `Bearer ${alice.ownerToken}`, "content-type": "application/json" },
		body: JSON.stringify(ident),
	})).status, 200);
	assert.equal((await call(carol.ctx, "/owner/address-forward", {
		method: "PUT", headers: { authorization: `Bearer ${carol.ownerToken}`, "content-type": "application/json" },
		body: JSON.stringify({ cardUrl: "https://alice.example.com/.well-known/agent-card.json", hours: 48 }),
	})).status, 200);
	const inbound = (await call(bob.ctx, "/owner/peers", {
		method: "POST", headers: { authorization: `Bearer ${bob.ownerToken}`, "content-type": "application/json" },
		body: JSON.stringify({ label: "mover" }),
	})).data.token as string;
	await bob.db.prepare("UPDATE peers SET identity_key = ? WHERE label = 'mover'").bind(ident.publicKey).run();
	const callback = (await call(alice.ctx, "/owner/peers", {
		method: "POST", headers: { authorization: `Bearer ${alice.ownerToken}`, "content-type": "application/json" },
		body: JSON.stringify({ label: "bob" }),
	})).data.token as string;
	assert.equal((await owner(bob.ctx, "acct-bob", "PUT", "/owner/outbound-peers/mover", { url: "https://carol.example.com", token: callback })).status, 200);
	await bob.db.prepare("UPDATE outbound_peers SET source = 'announce' WHERE alias = 'mover'").run();
	const taskId = await send(bob.ctx, inbound, "where", "ctx-move");
	const reply = await owner(bob.ctx, "acct-bob", "POST", "/owner/mcp/reply", { taskId, text: "followed", state: "completed" });
	assert.equal(reply.body.structuredContent.status, "delivered", JSON.stringify(reply.body));
	assert.equal(reply.body.structuredContent.target.host, "alice.example.com");
	assert.equal((await bob.db.prepare("SELECT url FROM outbound_peers WHERE alias = 'mover'").first() as { url: string }).url, "https://alice.example.com");
	assert.equal(JSON.stringify(reply.body).includes(callback), false);
});

test("an announcement cannot take over an outbound alias or keep its token", async (t) => {
	const { alice, bob, call } = await world(t as never);
	const ident = await Addr.generateIdentity();
	assert.equal((await call(alice.ctx, "/owner/identity", {
		method: "PUT", headers: { authorization: `Bearer ${alice.ownerToken}`, "content-type": "application/json" },
		body: JSON.stringify(ident),
	})).status, 200);
	const now = new Date().toISOString();
	await bob.db.prepare("INSERT INTO outbound_peers (alias, url, token_enc, created_at, updated_at) VALUES ('carol', 'https://carol.example.com', 'sealed-carol-token', ?, ?)").bind(now, now).run();
	const started = await call(bob.ctx, "/oauth/device_authorization", {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_name: "carol", client_id: "carol", agent_identity: ident.publicKey }),
	});
	assert.equal(started.status, 200, JSON.stringify(started.data));
	const code = String(started.data.user_code).replace("-", "");
	assert.equal((await call(bob.ctx, `/owner/pairing/${code}/approve`, { method: "POST", headers: { authorization: `Bearer ${bob.ownerToken}` } })).status, 200);
	const redeemed = await call(bob.ctx, "/oauth/token", {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: started.data.device_code }),
	});
	assert.equal(redeemed.data.peer_label, "carol-2");
	assert.equal((await bob.db.prepare("SELECT url, token_enc FROM outbound_peers WHERE alias = 'carol'").first() as { url: string; token_enc: string }).url, "https://carol.example.com");
	const planted = "a2aow_" + "d".repeat(43);
	await bob.db.prepare("INSERT INTO peers (label, token_hash, created_at, source) VALUES ('carol', ?, ?, 'pairing')").bind(await sha256(planted), now).run();
	const cardUrl = "https://alice.example.com/.well-known/agent-card.json";
	const signature = await Addr.signBytes(ident.privateKey, Addr.updateMessage(cardUrl, ident.publicKey, "-"));
	const taken = await call(bob.ctx, "/", {
		method: "POST", headers: { authorization: `Bearer ${planted}`, "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: "take", method: "PeerAddressUpdate", params: { agentCardUrl: cardUrl, publicKey: ident.publicKey, announcementSignature: signature } }),
	});
	assert.equal(taken.data.error.code, -32602, JSON.stringify(taken.data));
	const row = await bob.db.prepare("SELECT url, token_enc FROM outbound_peers WHERE alias = 'carol'").first() as { url: string; token_enc: string };
	assert.equal(row.url, "https://carol.example.com");
	assert.equal(row.token_enc, "sealed-carol-token");
});

test("revoking a return token stays revoked until an explicit reissue", async (t) => {
	const { alice, carol, call, owner } = await world(t as never);
	const ident = await Addr.generateIdentity();
	assert.equal((await call(alice.ctx, "/owner/identity", {
		method: "PUT", headers: { authorization: `Bearer ${alice.ownerToken}`, "content-type": "application/json" },
		body: JSON.stringify(ident),
	})).status, 200);
	const carolToken = (await call(carol.ctx, "/owner/peers", {
		method: "POST", headers: { authorization: `Bearer ${carol.ownerToken}`, "content-type": "application/json" },
		body: JSON.stringify({ label: "alice" }),
	})).data.token as string;
	assert.equal((await owner(alice.ctx, "acct-alice", "PUT", "/owner/outbound-peers/carol", { url: "https://carol.example.com", token: carolToken })).status, 200);
	const first = await owner(alice.ctx, "acct-alice", "POST", "/owner/peers/announce", { to: "carol" });
	assert.equal((first.body as any).results[0].status, "updated", JSON.stringify(first.body));
	const before = await alice.db.prepare("SELECT token_hash, revoked_at FROM peers WHERE label = 'carol' AND source = 'reverse'").first() as { token_hash: string; revoked_at: string | null };
	assert.equal(before.revoked_at, null);
	assert.equal((await call(alice.ctx, "/owner/peers/carol", { method: "DELETE", headers: { authorization: `Bearer ${alice.ownerToken}` } })).status, 200);
	const again = await owner(alice.ctx, "acct-alice", "POST", "/owner/peers/announce", { to: "carol" });
	assert.equal((again.body as any).results[0].status, "revoked", JSON.stringify(again.body));
	const stuck = await alice.db.prepare("SELECT token_hash, revoked_at FROM peers WHERE label = 'carol'").first() as { token_hash: string; revoked_at: string | null };
	assert.equal(stuck.token_hash, before.token_hash);
	assert.ok(stuck.revoked_at);
	const reissued = await owner(alice.ctx, "acct-alice", "POST", "/owner/peers/announce", { to: "carol", reissue: true });
	assert.equal((reissued.body as any).results[0].status, "updated", JSON.stringify(reissued.body));
	const after = await alice.db.prepare("SELECT token_hash, revoked_at FROM peers WHERE label = 'carol'").first() as { token_hash: string; revoked_at: string | null };
	assert.equal(after.revoked_at, null);
	assert.notEqual(after.token_hash, before.token_hash);
	assert.equal(JSON.stringify(again.body).includes("a2aow_"), false);
	assert.equal((await carol.db.prepare("SELECT source FROM outbound_peers WHERE alias = 'alice'").first() as { source: string }).source, "announce");
	assert.equal((await call(carol.ctx, "/owner/peers/alice", { method: "DELETE", headers: { authorization: `Bearer ${carol.ownerToken}` } })).status, 200);
	assert.equal((await carol.db.prepare("SELECT COUNT(*) AS n FROM outbound_peers WHERE alias = 'alice'").first() as { n: number }).n, 0);
	assert.equal((await alice.db.prepare("SELECT revoked_at FROM peers WHERE label = 'carol'").first() as { revoked_at: string | null }).revoked_at, null);
});

test("the MCP announce_address path never revives a revoked return token (#170)", async (t) => {
	const { alice, carol, call, owner } = await world(t as never);
	const ident = await Addr.generateIdentity();
	assert.equal((await call(alice.ctx, "/owner/identity", {
		method: "PUT", headers: { authorization: `Bearer ${alice.ownerToken}`, "content-type": "application/json" },
		body: JSON.stringify(ident),
	})).status, 200);
	const carolToken = (await call(carol.ctx, "/owner/peers", {
		method: "POST", headers: { authorization: `Bearer ${carol.ownerToken}`, "content-type": "application/json" },
		body: JSON.stringify({ label: "alice" }),
	})).data.token as string;
	assert.equal((await owner(alice.ctx, "acct-alice", "PUT", "/owner/outbound-peers/carol", { url: "https://carol.example.com", token: carolToken })).status, 200);
	const results = (body: unknown) => {
		const text = String((body as any).text);
		return JSON.parse(text.slice(text.indexOf("\n{") + 1)).results as any[];
	};
	// The connector path can set up the first return token.
	const first = await owner(alice.ctx, "acct-alice", "POST", "/owner/mcp/announce_address", { to: "carol" });
	assert.equal(first.status, 200, JSON.stringify(first.body));
	assert.equal(results(first.body)[0].status, "updated", JSON.stringify(first.body));
	const before = await alice.db.prepare("SELECT token_hash, revoked_at FROM peers WHERE label = 'carol' AND source = 'reverse'").first() as { token_hash: string; revoked_at: string | null };
	assert.equal(before.revoked_at, null);
	assert.equal((await call(alice.ctx, "/owner/peers/carol", { method: "DELETE", headers: { authorization: `Bearer ${alice.ownerToken}` } })).status, 200);
	const unchanged = async () => {
		const row = await alice.db.prepare("SELECT token_hash, revoked_at FROM peers WHERE label = 'carol'").first() as { token_hash: string; revoked_at: string | null };
		assert.equal(row.token_hash, before.token_hash);
		assert.ok(row.revoked_at, "the return token stays revoked");
		assert.equal((await alice.db.prepare("SELECT COUNT(*) AS n FROM peers WHERE source = 'reverse' AND revoked_at IS NULL").first() as { n: number }).n, 0);
	};
	// Hosted owner RPC for the connector: reissue is refused with a typed error, for any value.
	for (const reissue of [true, "true", false]) {
		const refused = await owner(alice.ctx, "acct-alice", "POST", "/owner/mcp/announce_address", { to: "carol", reissue });
		assert.equal(refused.status, 400);
		assert.equal((refused.body as any).code, "reissue_owner_only", JSON.stringify(refused.body));
		await unchanged();
	}
	// Self-hosted owner HTTP route for the connector refuses it the same way.
	const http = await call(alice.ctx, "/owner/mcp/announce_address", {
		method: "POST", headers: { authorization: `Bearer ${alice.ownerToken}`, "content-type": "application/json" },
		body: JSON.stringify({ to: "carol", reissue: true }),
	});
	assert.equal(http.status, 400);
	assert.equal(http.data.code, "reissue_owner_only");
	await unchanged();
	// A plain announce, to one alias or to all, reports revoked and mints nothing.
	for (const body of [{ to: "carol" }, { all: true }]) {
		const again = await owner(alice.ctx, "acct-alice", "POST", "/owner/mcp/announce_address", body);
		assert.equal(again.status, 200, JSON.stringify(again.body));
		const result = results(again.body).find((r: any) => r.alias === "carol");
		assert.equal(result.status, "revoked", JSON.stringify(again.body));
		assert.match(result.detail, /Only the owner/);
		assert.equal(JSON.stringify(again.body).includes("a2aow_"), false);
		await unchanged();
	}
	// The owner's explicit command still reissues.
	const reissued = await owner(alice.ctx, "acct-alice", "POST", "/owner/peers/announce", { to: "carol", reissue: true });
	assert.equal((reissued.body as any).results[0].status, "updated", JSON.stringify(reissued.body));
	const after = await alice.db.prepare("SELECT token_hash, revoked_at FROM peers WHERE label = 'carol'").first() as { token_hash: string; revoked_at: string | null };
	assert.equal(after.revoked_at, null);
	assert.notEqual(after.token_hash, before.token_hash);
});

test("export omits the sealed pairing identity and a stored return token", async (t) => {
	const { alice, call } = await world(t as never);
	const ident = await Addr.generateIdentity();
	await call(alice.ctx, "/owner/identity", {
		method: "PUT", headers: { authorization: `Bearer ${alice.ownerToken}`, "content-type": "application/json" },
		body: JSON.stringify(ident),
	});
	await alice.db.prepare("INSERT INTO peers (label, token_hash, created_at, source, token_enc) VALUES ('bob', 'h', 't', 'reverse', 'sealed-return')").run();
	const file = await exportRows(alice.db as never);
	const redacted = redactExport(file);
	assert.equal(redacted.tables.settings?.some((row) => row.key === "peer_identity"), false);
	assert.equal(redacted.tables.peers?.[0]?.token_enc, undefined);
	assert.equal(JSON.stringify(redacted).includes(ident.privateKey), false);
	assert.equal(JSON.stringify(redacted).includes("sealed-return"), false);
});
