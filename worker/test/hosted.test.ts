// Hosted router and TenantStore, in workerd via Miniflare. Self-host behaviour is the node suite (and the
// gates-unset case below). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import worker from "../src/index.ts";
import { sha256 } from "../src/a2a.ts";
import { d1 } from "./d1.ts";

const require = createRequire(new URL("../package.json", import.meta.url));
const MIGRATIONS = new URL("../migrations/", import.meta.url);
const ectx = { waitUntil(_p: Promise<unknown>) {}, passThroughOnException() {} };

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

async function start(opts: Record<string, unknown>) {
	const mf = new Miniflare(convertV4MiniflareOptions({
		name: "a2a",
		modules: true,
		script: await SCRIPT,
		compatibilityDate: "2026-10-06",
		d1Databases: { DB: `db-${Math.random().toString(36).slice(2)}` },
		...opts,
	} as never));
	return mf;
}

function sqlStatements(sql: string): string[] {
	return sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
}

async function migrateD1(mf: Miniflare) {
	const db = await mf.getD1Database("DB");
	for (const name of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
		const stmts = sqlStatements(fs.readFileSync(new URL(name, MIGRATIONS), "utf8"));
		if (stmts.length) await db.batch(stmts.map((q) => db.prepare(q)));
	}
}

async function text(res: Response): Promise<string> {
	return await res.text();
}

test("gates unset: the hosted entry matches the self-host handler, including TENANCY=host without TENANT_DO", async (t) => {
	const base = "https://agent.example.com";
	const nodeEnv = { DB: d1(MIGRATIONS), PUBLIC_URL: base, OWNER_TOKEN: "owner-secret" };
	const nodeHealth = await text(await worker.fetch(new Request(base + "/health"), nodeEnv as never, ectx as never));
	const nodeDenied = await text(await worker.fetch(new Request(base + "/", {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: {} }),
	}), nodeEnv as never, ectx as never));

	const plain = await start({ bindings: { PUBLIC_URL: base, OWNER_TOKEN: "owner-secret" }, durableObjects: { TENANT_DO: { className: "TenantStore", useSQLite: true } } });
	t.after(() => plain.dispose());
	await plain.ready;
	await migrateD1(plain);
	assert.equal(await text(await plain.dispatchFetch(base + "/health")), nodeHealth);
	assert.equal(await text(await plain.dispatchFetch(base + "/", {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: {} }),
	})), nodeDenied);
	const issued = await (await plain.dispatchFetch(base + "/owner/peers", {
		method: "POST", headers: { authorization: "Bearer owner-secret", "content-type": "application/json" },
		body: JSON.stringify({ label: "ada" }),
	})).json() as { token: string };
	assert.match(issued.token, /^a2aow_/);
	const peers = await (await plain.getD1Database("DB")).prepare("SELECT label FROM peers").all();
	assert.deepEqual(peers.results?.map((r) => (r as { label: string }).label), ["ada"]);
	assert.deepEqual(await plain.listDurableObjectIds("TENANT_DO"), [], "the flag is off, so the object is never addressed");

	// TENANCY=host but no TENANT_DO binding: still the self-host path. The class is registered unbound so the
	// script can load; the router only switches when the binding is present.
	const hostOnly = await start({
		bindings: { TENANCY: "host", TENANT_DOMAIN: "example.com", TENANT_SECRETS_KEY: "platform-secret", PUBLIC_URL: base, OWNER_TOKEN: "owner-secret" },
		additionalUnboundDurableObjects: [{ className: "TenantStore", useSQLite: true }],
	});
	t.after(() => hostOnly.dispose());
	await hostOnly.ready;
	await migrateD1(hostOnly);
	assert.equal(await text(await hostOnly.dispatchFetch(base + "/health")), nodeHealth);
	const again = await (await hostOnly.dispatchFetch(base + "/owner/peers", {
		method: "POST", headers: { authorization: "Bearer owner-secret", "content-type": "application/json" },
		body: JSON.stringify({ label: "ada" }),
	})).json() as { token?: string; error?: string };
	assert.equal(again.error, undefined);
	assert.match(again.token ?? "", /^a2aow_/);
});

test("per-tenant SQLite: directory, config push, and isolation", async (t) => {
	const mf = await start({
		bindings: {
			TENANCY: "host",
			TENANT_DOMAIN: "example.com",
			TENANT_SECRETS_KEY: "platform-secret",
			OWNER_TOKEN: "platform-owner",
			DATA_REGION: "",
		},
		kvNamespaces: { TENANT_DIRECTORY: "tenants" },
		durableObjects: { TENANT_DO: { className: "TenantStore", useSQLite: true } },
	});
	t.after(() => mf.dispose());
	await mf.ready;
	const kv = await mf.getKVNamespace("TENANT_DIRECTORY");
	const ns = await mf.getDurableObjectNamespace("TENANT_DO") as DurableObjectNamespace & {
		jurisdiction(loc: string): DurableObjectNamespace;
	};
	const tokenA = "owner-alice";
	const tokenB = "owner-bobby";
	const hashA = await sha256(tokenA);
	const hashB = await sha256(tokenB);

	const before = await mf.listDurableObjectIds("TENANT_DO");
	assert.equal((await mf.dispatchFetch("https://nope.example.com/health")).status, 404);
	assert.equal((await mf.dispatchFetch("https://example.com/health")).status, 404);
	assert.equal((await mf.dispatchFetch("https://a.b.example.com/health")).status, 404);
	assert.deepEqual(await mf.listDurableObjectIds("TENANT_DO"), before, "unknown names do not create an object");

	await kv.put("tenant:paused", JSON.stringify({ id: "id-paused", status: "suspended", region: "", version: 1 }));
	assert.equal((await mf.dispatchFetch("https://paused.example.com/health")).status, 403);
	assert.deepEqual(await mf.listDurableObjectIds("TENANT_DO"), before, "suspended is answered from the directory");

	await kv.put("tenant:dave", JSON.stringify({ id: "id-dave", status: "active", region: "", version: 1 }));
	assert.equal((await mf.dispatchFetch("https://dave.example.com/health")).status, 404);
	const dave = ns.get(ns.idFromName("id-dave")) as unknown as { storageStatus(): Promise<{ configured: boolean; tables: string[] }> };
	const daveStatus = await dave.storageStatus();
	assert.equal(daveStatus.configured, false);
	assert.deepEqual(daveStatus.tables, [], "a fetch before pushConfig writes no tables");

	type Push = { version: number; applied: boolean };
	const push = async (id: string, body: Record<string, unknown>, target: DurableObjectNamespace = ns) => {
		const stub = target.get(target.idFromName(id)) as unknown as { pushConfig(b: Record<string, unknown>): Promise<Push>; fetch(r: Request): Promise<Response> };
		return { stub, result: await stub.pushConfig(body) };
	};

	const alice = await push("id-alice", { version: 1, tenantId: "id-alice", name: "alice", status: "active", ownerTokenHash: hashA, config: { AGENT_NAME: "Alice" } });
	assert.equal(alice.result.applied, true, JSON.stringify(alice.result));
	const stale = await alice.stub.pushConfig({ version: 1, tenantId: "id-alice", name: "alice", status: "active", ownerTokenHash: hashA, config: { AGENT_NAME: "Stale" } });
	assert.equal(stale.version, 1);
	assert.equal(stale.applied, false);
	await kv.put("tenant:alice", JSON.stringify({ id: "id-alice", status: "active", region: "", version: 1 }));

	const bobPush = await push("id-bobby", { version: 1, tenantId: "id-bobby", name: "bobby", status: "active", ownerTokenHash: hashB, config: { AGENT_NAME: "Bob" } });
	assert.equal(bobPush.result.applied, true, JSON.stringify(bobPush.result));
	await kv.put("tenant:bobby", JSON.stringify({ id: "id-bobby", status: "active", region: "", version: 1 }));

	const card = async (name: string, headers?: HeadersInit) => (await mf.dispatchFetch(`https://${name}.example.com/.well-known/agent-card.json`, { headers })).json() as Promise<{ name: string }>;
	assert.equal((await card("alice")).name, "Alice");
	assert.equal((await card("bobby")).name, "Bob");
	assert.equal((await card("alice", { "x-a2a-tenant": JSON.stringify({ name: "bob", config: { AGENT_NAME: "Bob" } }) })).name, "Alice");

	const bumped = await alice.stub.pushConfig({ version: 3, tenantId: "id-alice", name: "alice", status: "active", ownerTokenHash: hashA, config: { AGENT_NAME: "Alice 3" } });
	assert.equal(bumped.version, 3);
	assert.equal(bumped.applied, true);
	const rolled = await alice.stub.pushConfig({ version: 2, tenantId: "id-alice", name: "alice", status: "active", ownerTokenHash: hashA, config: { AGENT_NAME: "Rolled" } });
	assert.equal(rolled.version, 3);
	assert.equal(rolled.applied, false);
	assert.equal((await card("alice")).name, "Alice 3");

	const call = (url: string, method: string, auth: string, json?: unknown) => mf.dispatchFetch(url, {
		method, headers: { authorization: auth, "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json),
	});
	assert.equal((await call("https://alice.example.com/owner/peers", "GET", "Bearer platform-owner")).status, 401, "the platform OWNER_TOKEN is not a tenant owner");
	const issued = await (await call("https://alice.example.com/owner/peers", "POST", `Bearer ${tokenA}`, { label: "ada" })).json() as { token: string };
	assert.match(issued.token, /^a2aow_/);
	const sent = await call("https://alice.example.com/", "POST", `Bearer ${issued.token}`, {
		jsonrpc: "2.0", id: 1, method: "message/send",
		params: { message: { kind: "message", role: "user", messageId: "m1", parts: [{ kind: "text", text: "hello alice" }] } },
	});
	assert.equal(sent.status, 200, await sent.clone().text());
	assert.equal((await call("https://bobby.example.com/", "POST", `Bearer ${issued.token}`, {
		jsonrpc: "2.0", id: 1, method: "message/send",
		params: { message: { kind: "message", role: "user", messageId: "m2", parts: [{ kind: "text", text: "for bob?" }] } },
	})).status, 401);
	assert.equal((await call("https://bobby.example.com/owner/peers", "GET", `Bearer ${tokenA}`)).status, 401);
	const bobInbox = await (await call("https://bobby.example.com/owner/inbox", "GET", `Bearer ${tokenB}`)).json() as unknown[];
	assert.deepEqual(bobInbox, []);
	const aliceInbox = await (await call("https://alice.example.com/owner/inbox?all=1", "GET", `Bearer ${tokenA}`)).json() as { text: string }[];
	assert.equal(aliceInbox.length, 1);
	assert.match(aliceInbox[0]!.text, /hello alice/);

	// workerd's local runtime throws "Jurisdiction restrictions are not implemented" on namespace.jurisdiction().
	// namespaceForRegion() is covered in tenancy.test.ts; production Durable Objects do honour eu / fedramp.
	await alice.stub.pushConfig({ version: 4, tenantId: "id-alice", name: "alice", status: "suspended", ownerTokenHash: hashA, config: { AGENT_NAME: "Alice 3" } });
	assert.equal((await mf.dispatchFetch("https://alice.example.com/health")).status, 403, "the object enforces a newer status than the directory cache");
});
