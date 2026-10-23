// A sends, B replies, and the reply shows in A's history and inbox. Both directions.
// Public peers go through fetch. Tenants on this deployment's domain are a directory lookup and stub.fetch:
// a public fetch of that hostname is 522, and these tests fail if one happens.
// Push tokens and peer tokens must not appear in a response or a log line. The peer request does carry the
// push token; that is how the reply is authenticated, and only its hash is stored on the sender.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { sha256 } from "../src/a2a.ts";
import { clearDirectoryCache } from "../src/directory.ts";
import { dispatch, runOwnerRpc } from "../src/index.ts";
import { hostedTenantContext, resolveTenant, type DoNamespace, type KvNamespace, type TenantContext, type WorkerBindings } from "../src/tenancy.ts";
import { d1 } from "./d1.ts";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const ectx = { waitUntil(_p: Promise<unknown>) {}, passThroughOnException() {} };
const require = createRequire(new URL("../package.json", import.meta.url));

type Row = { taskId?: string; contextId?: string; text?: string; kind?: string; state?: string; from?: string };
type Hist = { dir?: string; event?: string; text?: string; context_id?: string };
type SendBody = { text?: string; isError?: boolean };

function forbid(blob: string, secrets: string[], where: string) {
	for (const secret of secrets) {
		assert.equal(secret.length > 0 && blob.includes(secret), false, `${where} contains a token`);
	}
}

function contextOf(text: string): string {
	const m = /context ([A-Za-z0-9._:-]+)\. Check/.exec(text);
	assert.ok(m, text);
	return m[1]!;
}

function taskOf(text: string): string {
	const m = /task ([A-Za-z0-9._:-]+) \(/.exec(text);
	assert.ok(m, text);
	return m[1]!;
}

test("a public peer's reply is stored, and a follow-up keeps the conversation, both ways", async (t) => {
	const logs: string[] = [];
	const origLog = console.log;
	console.log = (...args: unknown[]) => {
		logs.push(args.map((a) => String(a)).join(" "));
		origLog(...args);
	};
	const aUrl = "https://a.example.net";
	const bUrl = "https://b.example.net";
	const dbA = d1(MIGRATIONS);
	const dbB = d1(MIGRATIONS);
	const ctxA = resolveTenant({ DB: dbA, PUBLIC_URL: aUrl, OWNER_TOKEN: "owner-a-secret", AGENT_NAME: "Ann" } as WorkerBindings);
	const ctxB = resolveTenant({ DB: dbB, PUBLIC_URL: bUrl, OWNER_TOKEN: "owner-b-secret", AGENT_NAME: "Bea" } as WorkerBindings);
	const byHost = new Map<string, TenantContext>([["a.example.net", ctxA], ["b.example.net", ctxB]]);
	const publicHosts: string[] = [];
	const pushTokens: string[] = [];
	const origFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const u = new URL(raw);
		publicHosts.push(u.host);
		const ctx = byHost.get(u.host);
		if (!ctx) return new Response("origin is unreachable", { status: 522 });
		const body = typeof init?.body === "string" ? init.body : null;
		if (body && (u.pathname === "/" || u.pathname === "/a2a")) {
			const parsed = JSON.parse(body) as { params?: { configuration?: { taskPushNotificationConfig?: { url?: string; token?: string }; pushNotificationConfig?: { url?: string; token?: string } } } };
			const cfg = parsed.params?.configuration?.taskPushNotificationConfig || parsed.params?.configuration?.pushNotificationConfig;
			if (cfg?.token) {
				pushTokens.push(cfg.token);
				assert.equal(cfg.url, `${ctx === ctxA ? bUrl : aUrl}/push`);
			}
		}
		const next: RequestInit = { method: init?.method, headers: init?.headers, redirect: init?.redirect };
		if (init?.body != null) next.body = init.body;
		return dispatch(new Request(u, next), ctx, ectx as never);
	}) as typeof fetch;
	t.after(() => {
		globalThis.fetch = origFetch;
		console.log = origLog;
	});

	const outputs: string[] = [];
	const http = async (ctx: TenantContext, method: string, path: string, auth: string, json?: unknown) => {
		const res = await dispatch(new Request(ctx.PUBLIC_URL + path, {
			method, headers: { authorization: auth, "content-type": "application/json" },
			body: json === undefined ? undefined : JSON.stringify(json),
		}), ctx, ectx as never);
		const text = await res.text();
		let data: unknown = text;
		try { data = JSON.parse(text); } catch { /* plain */ }
		const packed = JSON.stringify({ status: res.status, data });
		outputs.push(packed);
		return { status: res.status, data, text: packed };
	};

	const tokenFor = async (ctx: TenantContext, owner: string, label: string) => {
		const issued = await dispatch(new Request(ctx.PUBLIC_URL + "/owner/peers", {
			method: "POST", headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" },
			body: JSON.stringify({ label }),
		}), ctx, ectx as never);
		const body = await issued.json() as { token?: string };
		assert.match(body.token || "", /^a2aow_/);
		return body.token!;
	};
	// Issuing a token still returns it to the owner. Everything after this must not.
	const annAtBea = await tokenFor(ctxB, "owner-b-secret", "ann");
	const beaAtAnn = await tokenFor(ctxA, "owner-a-secret", "bea");
	outputs.length = 0;

	const syncedA = await http(ctxA, "PUT", "/owner/outbound-peers/bea", "Bearer owner-a-secret", { url: bUrl, token: annAtBea });
	assert.equal(syncedA.status, 200, syncedA.text);
	assert.deepEqual(syncedA.data, { ok: true, alias: "bea", hasToken: true });
	const syncedB = await http(ctxB, "PUT", "/owner/outbound-peers/ann", "Bearer owner-b-secret", { url: aUrl, token: beaAtAnn });
	assert.equal(syncedB.status, 200, syncedB.text);
	const listed = await http(ctxA, "GET", "/owner/outbound-peers", "Bearer owner-a-secret");
	assert.equal((listed.data as { has_token: boolean }[])[0]?.has_token, true);

	const secrets = [annAtBea, beaAtAnn, "owner-a-secret", "owner-b-secret"];
	const round = async (from: TenantContext, fromOwner: string, toAlias: string, contextId: string, ping: string, pong: string, again: string) => {
		const sent = await http(from, "POST", "/owner/mcp/send", `Bearer ${fromOwner}`, { to: toAlias, text: ping, contextId });
		assert.equal(sent.status, 200, sent.text);
		const sentBody = sent.data as SendBody;
		assert.equal(sentBody.isError, false, sent.text);
		assert.equal(contextOf(sentBody.text || ""), contextId);
		const taskId = taskOf(sentBody.text || "");
		const peer = from === ctxA ? ctxB : ctxA;
		const peerOwner = from === ctxA ? "owner-b-secret" : "owner-a-secret";
		const inbox = await http(peer, "GET", "/owner/inbox", `Bearer ${peerOwner}`);
		const inbound = (inbox.data as Row[]).find((r) => r.text === ping && r.kind !== "outbound");
		assert.ok(inbound, inbox.text);
		assert.equal(inbound.taskId, taskId);
		assert.equal(inbound.contextId, contextId);
		const replied = await http(peer, "POST", "/owner/mcp/reply", `Bearer ${peerOwner}`, { taskId, text: pong, state: "completed" });
		assert.equal(replied.status, 200, replied.text);
		assert.equal((replied.data as SendBody).isError, false, replied.text);
		const history = await http(from, "GET", `/owner/history/${contextId}`, `Bearer ${fromOwner}`);
		const rows = history.data as Hist[];
		assert.ok(rows.some((r) => r.dir === "out" && r.text === ping), history.text);
		assert.ok(rows.some((r) => r.dir === "in" && r.event === "push" && r.text === pong), history.text);
		assert.ok(rows.every((r) => r.context_id === contextId), history.text);
		const mine = await http(from, "GET", "/owner/inbox", `Bearer ${fromOwner}`);
		const reply = (mine.data as Row[]).find((r) => r.kind === "outbound" && r.taskId === taskId);
		assert.ok(reply, mine.text);
		assert.equal(reply.text, pong);
		assert.equal(reply.contextId, contextId);
		assert.equal(reply.state, "completed");
		const seen = await http(from, "GET", "/owner/inbox", `Bearer ${fromOwner}`);
		assert.equal((seen.data as Row[]).some((r) => r.taskId === taskId), false, seen.text);
		const kept = await http(from, "GET", "/owner/inbox?all=1", `Bearer ${fromOwner}`);
		assert.equal((kept.data as Row[]).some((r) => r.kind === "outbound" && r.taskId === taskId && r.text === pong), true, kept.text);
		const follow = await http(from, "POST", "/owner/mcp/send", `Bearer ${fromOwner}`, { to: toAlias, text: again, contextId });
		assert.equal((follow.data as SendBody).isError, false, follow.text);
		assert.equal(contextOf((follow.data as SendBody).text || ""), contextId);
		const againHist = await http(from, "GET", `/owner/history/${contextId}`, `Bearer ${fromOwner}`);
		const outs = (againHist.data as Hist[]).filter((r) => r.dir === "out");
		assert.equal(outs.length >= 2, true, againHist.text);
		assert.ok(outs.some((r) => r.text === again), againHist.text);
		const stored = await (from === ctxA ? dbA : dbB).prepare("SELECT push_token_hash, updates_json FROM outbound WHERE task_id = ?").bind(taskId).first() as { push_token_hash?: string; updates_json?: string } | null;
		assert.match(stored?.push_token_hash || "", /^[0-9a-f]{64}$/);
		assert.equal(stored?.updates_json?.includes(pong), true);
		const outbound = await http(from, "GET", `/owner/outbound/${taskId}`, `Bearer ${fromOwner}`);
		assert.equal(outbound.status, 200, outbound.text);
	};

	await round(ctxA, "owner-a-secret", "bea", "ctx-ab-public", "ping from ann", "pong from bea", "again from ann");
	await round(ctxB, "owner-b-secret", "ann", "ctx-ba-public", "ping from bea", "pong from ann", "again from bea");

	assert.equal(pushTokens.length >= 4, true, "each send registers a push");
	assert.equal(publicHosts.includes("a.example.net"), true);
	assert.equal(publicHosts.includes("b.example.net"), true);
	const encA = await dbA.prepare("SELECT token_enc FROM outbound_peers WHERE alias = ?").bind("bea").first() as { token_enc?: string } | null;
	assert.equal(String(encA?.token_enc || "").includes(annAtBea), false);
	forbid(outputs.join("\n"), [...secrets, ...pushTokens], "public peer response");
	forbid(logs.join("\n"), [...secrets, ...pushTokens], "public peer log");
});

test("same-deployment tenants call each other through the directory, both ways", async (t) => {
	clearDirectoryCache();
	const logs: string[] = [];
	const origLog = console.log;
	console.log = (...args: unknown[]) => {
		logs.push(args.map((a) => String(a)).join(" "));
		origLog(...args);
	};
	const publicHosts: string[] = [];
	const pushTokens: string[] = [];
	const origFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		publicHosts.push(new URL(raw).host);
		return new Response("origin is unreachable", { status: 522 });
	}) as typeof fetch;
	t.after(() => {
		globalThis.fetch = origFetch;
		console.log = origLog;
		clearDirectoryCache();
	});

	const store = new Map<string, string>();
	const kv: KvNamespace = {
		async get(key: string, type?: "json") {
			const v = store.get(key);
			if (v == null) return null;
			return type === "json" ? JSON.parse(v) : v;
		},
		async put(key: string, value: string) { store.set(key, value); },
	};
	const byId = new Map<string, TenantContext>();
	const ns: DoNamespace = {
		idFromName(name: string) { return name; },
		get(id: unknown) {
			return {
				async fetch(req: Request) {
					const ctx = byId.get(String(id));
					if (!ctx) return new Response("missing", { status: 404 });
					return dispatch(req, ctx, ectx as never);
				},
			};
		},
	};
	const env = {
		TENANCY: "host", TENANT_DOMAIN: "example.com", TENANT_SECRETS_KEY: "platform-key-for-peers",
		DATA_REGION: "", TENANT_DIRECTORY: kv, TENANT_DO: ns,
	} as WorkerBindings;
	const ownerA = "owner-alice-hosted";
	const ownerB = "owner-bobby-hosted";
	const hashA = await sha256(ownerA);
	const hashB = await sha256(ownerB);
	const dbA = d1(MIGRATIONS);
	const dbB = d1(MIGRATIONS);
	const ctxA = hostedTenantContext(env, {
		id: "id-outreplya", db: dbA, publicUrl: "https://outreplya.example.com", ownerTokenHash: hashA, status: "active",
		config: { AGENT_NAME: "Alice" },
	});
	const ctxB = hostedTenantContext(env, {
		id: "id-outreplyb", db: dbB, publicUrl: "https://outreplyb.example.com", ownerTokenHash: hashB, status: "active",
		config: { AGENT_NAME: "Bob" },
	});
	byId.set("id-outreplya", ctxA);
	byId.set("id-outreplyb", ctxB);
	store.set("tenant:outreplya", JSON.stringify({ id: "id-outreplya", status: "active", region: "default", version: 1 }));
	store.set("tenant:outreplyb", JSON.stringify({ id: "id-outreplyb", status: "active", region: "default", version: 1 }));

	const outputs: string[] = [];
	const note = (status: number, data: unknown) => {
		const packed = JSON.stringify({ status, data });
		outputs.push(packed);
		return packed;
	};
	const http = async (ctx: TenantContext, method: string, path: string, auth: string, json?: unknown) => {
		const res = await dispatch(new Request(ctx.PUBLIC_URL + path, {
			method, headers: { authorization: auth, "content-type": "application/json" },
			body: json === undefined ? undefined : JSON.stringify(json),
		}), ctx, ectx as never);
		const data = await res.json().catch(() => null);
		return { status: res.status, data, text: note(res.status, data) };
	};
	const rpc = async (ctx: TenantContext, accountId: string, method: string, path: string, body?: unknown, query?: Record<string, string>) => {
		const res = await runOwnerRpc(ctx, ectx as never, { accountId, method, path, ...(body === undefined ? {} : { body }), ...(query ? { query } : {}) });
		return { status: res.status, data: res.body, text: note(res.status, res.body) };
	};
	const tokenFor = async (ctx: TenantContext, owner: string, label: string) => {
		const issued = await http(ctx, "POST", "/owner/peers", `Bearer ${owner}`, { label });
		const token = (issued.data as { token?: string }).token || "";
		assert.match(token, /^a2aow_/);
		outputs.pop();
		return token;
	};
	const aliceAtBob = await tokenFor(ctxB, ownerB, "alice");
	const bobAtAlice = await tokenFor(ctxA, ownerA, "bobby");

	const putA = await rpc(ctxA, "acct_alice", "PUT", "/owner/outbound-peers/bobby", { url: "https://outreplyb.example.com", token: aliceAtBob });
	assert.equal(putA.status, 200, putA.text);
	assert.deepEqual(putA.data, { ok: true, alias: "bobby", hasToken: true });
	const putB = await rpc(ctxB, "acct_bobby", "PUT", "/owner/outbound-peers/alice", { url: "https://outreplya.example.com", token: bobAtAlice });
	assert.equal(putB.status, 200, putB.text);
	const peers = await rpc(ctxA, "acct_alice", "GET", "/owner/outbound-peers");
	assert.equal((peers.data as { alias: string; has_token?: boolean; token?: string }[])[0]?.has_token, true);
	assert.equal(JSON.stringify(peers.data).includes("a2aow_"), false);

	const missing = await rpc(ctxA, "acct_alice", "PUT", "/owner/outbound-peers/gone", { url: "https://outgone.example.com", token: aliceAtBob });
	assert.equal(missing.status, 200, missing.text);
	const missed = await rpc(ctxA, "acct_alice", "POST", "/owner/mcp/send", { to: "gone", text: "nobody home", contextId: "ctx-missing" });
	assert.equal((missed.data as SendBody).isError, true, missed.text);
	assert.equal(publicHosts.includes("outgone.example.com"), false, `public fetch hit ${publicHosts.join(",")}`);

	const secrets = [aliceAtBob, bobAtAlice, ownerA, ownerB, "platform-key-for-peers"];
	const round = async (from: TenantContext, account: string, toAlias: string, contextId: string, ping: string, pong: string, again: string) => {
		const peer = from === ctxA ? ctxB : ctxA;
		const peerAccount = from === ctxA ? "acct_bobby" : "acct_alice";
		const sent = await rpc(from, account, "POST", "/owner/mcp/send", { to: toAlias, text: ping, contextId });
		assert.equal(sent.status, 200, sent.text);
		const sentBody = sent.data as SendBody;
		assert.equal(sentBody.isError, false, sent.text);
		assert.equal(contextOf(sentBody.text || ""), contextId);
		const taskId = taskOf(sentBody.text || "");
		const inbox = await rpc(peer, peerAccount, "GET", "/owner/inbox");
		const inbound = (inbox.data as Row[]).find((r) => r.text === ping && r.kind !== "outbound");
		assert.ok(inbound, inbox.text);
		assert.equal(inbound.taskId, taskId);
		assert.equal(inbound.contextId, contextId);
		const replied = await rpc(peer, peerAccount, "POST", "/owner/mcp/reply", { taskId, text: pong, state: "completed" });
		assert.equal(replied.status, 200, replied.text);
		assert.equal((replied.data as SendBody).isError, false, replied.text);
		const history = await rpc(from, account, "GET", `/owner/history/${contextId}`);
		const rows = history.data as Hist[];
		assert.ok(rows.some((r) => r.dir === "out" && r.text === ping), history.text);
		assert.ok(rows.some((r) => r.dir === "in" && r.event === "push" && r.text === pong), history.text);
		assert.ok(rows.every((r) => r.context_id === contextId), history.text);
		const mine = await rpc(from, account, "GET", "/owner/inbox");
		const reply = (mine.data as Row[]).find((r) => r.kind === "outbound" && r.taskId === taskId);
		assert.ok(reply, mine.text);
		assert.equal(reply.text, pong);
		assert.equal(reply.contextId, contextId);
		const seen = await rpc(from, account, "GET", "/owner/inbox");
		assert.equal((seen.data as Row[]).some((r) => r.taskId === taskId), false, seen.text);
		const kept = await rpc(from, account, "GET", "/owner/inbox", undefined, { all: "1" });
		assert.equal((kept.data as Row[]).some((r) => r.kind === "outbound" && r.taskId === taskId && r.text === pong), true, kept.text);
		const follow = await rpc(from, account, "POST", "/owner/mcp/send", { to: toAlias, text: again, contextId });
		assert.equal((follow.data as SendBody).isError, false, follow.text);
		assert.equal(contextOf((follow.data as SendBody).text || ""), contextId);
		const db = from === ctxA ? dbA : dbB;
		const stored = await db.prepare("SELECT push_token_hash FROM outbound WHERE task_id = ?").bind(taskId).first() as { push_token_hash?: string } | null;
		assert.match(stored?.push_token_hash || "", /^[0-9a-f]{64}$/);
		const outbound = await rpc(from, account, "GET", `/owner/outbound/${taskId}`);
		assert.equal(outbound.status, 200, outbound.text);
	};

	await round(ctxA, "acct_alice", "bobby", "ctx-ab-host", "ping from alice", "pong from bobby", "again from alice");
	await round(ctxB, "acct_bobby", "alice", "ctx-ba-host", "ping from bobby", "pong from alice", "again from bobby");

	// The receiver stores the push token so it can call back. That plaintext must not show up in a response or a log.
	const internalTokens: string[] = [];
	for (const db of [dbA, dbB]) {
		const tasks = await db.prepare("SELECT push_configs_json FROM tasks").all() as { results: { push_configs_json?: string }[] };
		for (const row of tasks.results) {
			const configs = JSON.parse(row.push_configs_json || "[]") as { token?: string; url?: string }[];
			for (const cfg of configs) {
				if (!cfg.token) continue;
				internalTokens.push(cfg.token);
				assert.match(cfg.url || "", /^https:\/\/outreply[ab]\.example\.com\/push$/);
			}
		}
	}
	assert.equal(internalTokens.length >= 4, true, "each send registered a push on the peer");
	pushTokens.push(...internalTokens);
	assert.equal(publicHosts.some((h) => h === "outreplya.example.com" || h === "outreplyb.example.com" || h === "outgone.example.com"), false, `public fetch hit ${publicHosts.join(",")}`);
	const enc = await dbA.prepare("SELECT token_enc FROM outbound_peers WHERE alias = ?").bind("bobby").first() as { token_enc?: string } | null;
	assert.equal(String(enc?.token_enc || "").includes(aliceAtBob), false);
	forbid(outputs.join("\n"), [...secrets, ...pushTokens], "same-deployment response");
	forbid(logs.join("\n"), [...secrets, ...pushTokens], "same-deployment log");
});

function bundleHosted(): Promise<string> {
	const { build } = require("esbuild") as typeof import("esbuild");
	return build({
		entryPoints: [fileURLToPath(new URL("../src/hosted.ts", import.meta.url))],
		bundle: true,
		format: "esm",
		write: false,
		platform: "neutral",
		external: ["cloudflare:*"],
		target: "es2022",
		logLevel: "silent",
		plugins: [{
			name: "sql-raw",
			setup(b) {
				b.onResolve({ filter: /\.sql\?raw$/ }, (args) => ({
					path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, "")),
					namespace: "sql-raw",
				}));
				b.onLoad({ filter: /.*/, namespace: "sql-raw" }, (args) => ({
					contents: `export default ${JSON.stringify(fs.readFileSync(args.path, "utf8"))};`,
					loader: "js",
				}));
			},
		}],
	}).then((built) => {
		const file = built.outputFiles?.[0];
		if (!file) throw new Error("hosted bundle was empty");
		return file.text;
	});
}

const SCRIPT = bundleHosted();

test("same-deployment tenants in workerd use stub.fetch, and a public fetch is 522", async (t) => {
	const publicHosts: string[] = [];
	const lines: string[] = [];
	const origLog = console.log;
	console.log = (...args: unknown[]) => {
		lines.push(args.map((a) => String(a)).join(" "));
		origLog(...args);
	};
	t.after(() => { console.log = origLog; });
	const mf = new Miniflare(convertV4MiniflareOptions({
		name: "a2a",
		modules: true,
		script: await SCRIPT,
		compatibilityDate: "2026-10-06",
		bindings: {
			TENANCY: "host",
			TENANT_DOMAIN: "example.com",
			TENANT_SECRETS_KEY: "platform-secret",
			OWNER_TOKEN: "platform-owner",
			DATA_REGION: "",
		},
		kvNamespaces: { TENANT_DIRECTORY: "tenants-outbound-reply" },
		durableObjects: { TENANT_DO: { className: "TenantStore", useSQLite: true } },
		outboundService: async (request: Request) => {
			publicHosts.push(new URL(request.url).hostname);
			return new Response("origin is unreachable", { status: 522 });
		},
	} as never));
	t.after(() => mf.dispose());
	await mf.ready;
	const kv = await mf.getKVNamespace("TENANT_DIRECTORY");
	const ns = await mf.getDurableObjectNamespace("TENANT_DO");
	const ownerA = "owner-alice-zone";
	const ownerB = "owner-bobby-zone";
	const hashA = await sha256(ownerA);
	const hashB = await sha256(ownerB);
	type Stub = {
		owner(input: { accountId: string; method: string; path: string; query?: Record<string, string>; body?: unknown }): Promise<{ status: number; body: unknown }>;
		pushConfig(body: Record<string, unknown>): Promise<{ applied: boolean }>;
	};
	const alice = ns.get(ns.idFromName("id-zone-alice")) as unknown as Stub;
	const bobby = ns.get(ns.idFromName("id-zone-bobby")) as unknown as Stub;
	assert.equal((await alice.pushConfig({
		version: 1, tenantId: "id-zone-alice", name: "zonealice", status: "active", ownerTokenHash: hashA, config: { AGENT_NAME: "Alice" },
	})).applied, true);
	assert.equal((await bobby.pushConfig({
		version: 1, tenantId: "id-zone-bobby", name: "zonebobby", status: "active", ownerTokenHash: hashB, config: { AGENT_NAME: "Bob" },
	})).applied, true);
	await kv.put("tenant:zonealice", JSON.stringify({ id: "id-zone-alice", status: "active", region: "default", version: 1 }));
	await kv.put("tenant:zonebobby", JSON.stringify({ id: "id-zone-bobby", status: "active", region: "default", version: 1 }));

	const outputs: string[] = [];
	const note = (status: number, data: unknown) => {
		const packed = JSON.stringify({ status, data });
		outputs.push(packed);
		return packed;
	};
	const http = async (name: string, method: string, path: string, auth: string, json?: unknown) => {
		const res = await mf.dispatchFetch(`https://${name}.example.com${path}`, {
			method, headers: { authorization: auth, "content-type": "application/json" },
			body: json === undefined ? undefined : JSON.stringify(json),
		});
		const data = await res.json().catch(() => null);
		return { status: res.status, data, text: note(res.status, data) };
	};
	const rpc = async (stub: Stub, accountId: string, method: string, path: string, body?: unknown, query?: Record<string, string>) => {
		const res = await stub.owner({ accountId, method, path, ...(body === undefined ? {} : { body }), ...(query ? { query } : {}) });
		return { status: res.status, data: res.body, text: note(res.status, res.body) };
	};
	const saw = async (part: string) => {
		const start = Date.now();
		while (!lines.some((l) => l.includes(part))) {
			if (Date.now() - start > 2000) return false;
			await new Promise((r) => setTimeout(r, 20));
		}
		return true;
	};
	const tokenFor = async (name: string, owner: string, label: string) => {
		const issued = await http(name, "POST", "/owner/peers", `Bearer ${owner}`, { label });
		const token = (issued.data as { token?: string }).token || "";
		assert.match(token, /^a2aow_/, issued.text);
		outputs.pop();
		return token;
	};
	const aliceAtBob = await tokenFor("zonebobby", ownerB, "alice");
	const bobAtAlice = await tokenFor("zonealice", ownerA, "bobby");
	const putA = await rpc(alice, "acct_alice", "PUT", "/owner/outbound-peers/bobby", { url: "https://zonebobby.example.com", token: aliceAtBob });
	assert.equal(putA.status, 200, putA.text);
	assert.deepEqual(putA.data, { ok: true, alias: "bobby", hasToken: true });
	const putB = await rpc(bobby, "acct_bobby", "PUT", "/owner/outbound-peers/alice", { url: "https://zonealice.example.com", token: bobAtAlice });
	assert.equal(putB.status, 200, putB.text);
	assert.equal(await saw('"event":"outbound_peer_synced"'), true);

	const secrets = [aliceAtBob, bobAtAlice, ownerA, ownerB, "platform-secret", "platform-owner"];
	const round = async (from: Stub, fromName: string, fromOwner: string, account: string, peer: Stub, peerName: string, peerOwner: string, peerAccount: string, toAlias: string, contextId: string, ping: string, pong: string, again: string) => {
		const sent = await rpc(from, account, "POST", "/owner/mcp/send", { to: toAlias, text: ping, contextId });
		assert.equal(sent.status, 200, sent.text);
		const sentBody = sent.data as SendBody;
		assert.equal(sentBody.isError, false, sent.text);
		assert.equal(contextOf(sentBody.text || ""), contextId);
		const taskId = taskOf(sentBody.text || "");
		const inbox = await rpc(peer, peerAccount, "GET", "/owner/inbox");
		const inbound = (inbox.data as Row[]).find((r) => r.text === ping && r.kind !== "outbound");
		assert.ok(inbound, inbox.text);
		assert.equal(inbound.taskId, taskId);
		assert.equal(inbound.contextId, contextId);
		const replied = await rpc(peer, peerAccount, "POST", "/owner/mcp/reply", { taskId, text: pong, state: "completed" });
		assert.equal(replied.status, 200, replied.text);
		assert.equal((replied.data as SendBody).isError, false, replied.text);
		const history = await rpc(from, account, "GET", `/owner/history/${contextId}`);
		const rows = history.data as Hist[];
		assert.ok(rows.some((r) => r.dir === "out" && r.text === ping), history.text);
		assert.ok(rows.some((r) => r.dir === "in" && r.event === "push" && r.text === pong), history.text);
		const mine = await rpc(from, account, "GET", "/owner/inbox");
		const reply = (mine.data as Row[]).find((r) => r.kind === "outbound" && r.taskId === taskId);
		assert.ok(reply, mine.text);
		assert.equal(reply.text, pong);
		assert.equal(reply.contextId, contextId);
		const follow = await rpc(from, account, "POST", "/owner/mcp/send", { to: toAlias, text: again, contextId });
		assert.equal((follow.data as SendBody).isError, false, follow.text);
		assert.equal(contextOf((follow.data as SendBody).text || ""), contextId);
		const dumped = await http(peerName, "GET", "/owner/export", `Bearer ${peerOwner}`);
		const tasks = ((dumped.data as { tables?: { tasks?: { id?: string; push_configs_json?: string }[] } }).tables?.tasks) || [];
		const cfgRaw = tasks.find((row) => row.id === taskId)?.push_configs_json || "[]";
		const configs = JSON.parse(cfgRaw) as { token?: string; url?: string }[];
		assert.equal(configs[0]?.url, `https://${fromName}.example.com/push`);
		assert.ok(configs[0]?.token);
		secrets.push(configs[0]!.token!);
		outputs.pop();
		const senderDump = await http(fromName, "GET", "/owner/export", `Bearer ${fromOwner}`);
		const outbound = ((senderDump.data as { tables?: { outbound?: { task_id?: string; push_token_hash?: string }[] } }).tables?.outbound) || [];
		const saved = outbound.find((row) => row.task_id === taskId);
		assert.match(saved?.push_token_hash || "", /^[0-9a-f]{64}$/);
		assert.equal(saved?.push_token_hash, await sha256(configs[0]!.token!));
		const outboundJson = JSON.stringify(saved);
		assert.equal(outboundJson.includes(configs[0]!.token!), false);
		// The receiver keeps the push token so it can call back. A later export of that tenant is not the sender's output.
		outputs.pop();
	};

	await round(alice, "zonealice", ownerA, "acct_alice", bobby, "zonebobby", ownerB, "acct_bobby", "bobby", "ctx-ab-zone", "ping from zone alice", "pong from zone bobby", "again from zone alice");
	await round(bobby, "zonebobby", ownerB, "acct_bobby", alice, "zonealice", ownerA, "acct_alice", "alice", "ctx-ba-zone", "ping from zone bobby", "pong from zone alice", "again from zone bobby");

	assert.equal(await saw('"event":"push_received"'), true);
	assert.equal(publicHosts.some((h) => h === "zonealice.example.com" || h === "zonebobby.example.com"), false, `public fetch hit ${publicHosts.join(",")}`);
	forbid(outputs.join("\n"), secrets, "workerd response");
	forbid(lines.join("\n"), secrets, "workerd log");
});
