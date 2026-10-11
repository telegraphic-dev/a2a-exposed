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
	assert.equal((await kv.get("tenant:dave", "json") as { region: string }).region, "default", "an empty region is pinned before the object is addressed");
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

test("hosted approval reaches a same-zone issuer through CONTROL_SERVICE", async (t) => {
	const issuer = "https://control.example.com";
	const tenant = "https://northwind.example.com";
	const bindingUrls: string[] = [];
	const publicHosts: string[] = [];
	const mf = await start({
		bindings: {
			TENANCY: "host",
			TENANT_DOMAIN: "example.com",
			TENANT_SECRETS_KEY: "platform-secret",
		},
		kvNamespaces: { TENANT_DIRECTORY: "tenants-oidc" },
		durableObjects: { TENANT_DO: { className: "TenantStore", useSQLite: true } },
		serviceBindings: {
			CONTROL_SERVICE: async (request: Request) => {
				const url = new URL(request.url);
				bindingUrls.push(`${url.origin}${url.pathname}`);
				if (url.origin === issuer && url.pathname === "/.well-known/openid-configuration") {
					return Response.json({
						issuer,
						authorization_endpoint: `${issuer}/api/oidc/authorize`,
						token_endpoint: `${issuer}/api/oidc/token`,
						jwks_uri: `${issuer}/api/auth/jwks`,
					});
				}
				return new Response("missing", { status: 404 });
			},
		},
		// A public fetch of another host on this zone does not reach the control Worker. If it is attempted, answer 522.
		outboundService: async (request: Request) => {
			publicHosts.push(new URL(request.url).hostname);
			return new Response("origin is unreachable", { status: 522 });
		},
	});
	t.after(() => mf.dispose());
	await mf.ready;
	const kv = await mf.getKVNamespace("TENANT_DIRECTORY");
	const ns = await mf.getDurableObjectNamespace("TENANT_DO");
	const hash = await sha256("owner-north");
	const stub = ns.get(ns.idFromName("id-north")) as unknown as { pushConfig(body: Record<string, unknown>): Promise<{ applied: boolean }> };
	const pushed = await stub.pushConfig({
		version: 1, tenantId: "id-north", name: "northwind", status: "active", ownerTokenHash: hash,
		approval: {
			issuer, clientId: "client-1", clientSecret: "tenant-secret-value",
			allowedSubjects: ["owner-1"], label: "Example",
		},
	});
	assert.equal(pushed.applied, true, JSON.stringify(pushed));
	await kv.put("tenant:northwind", JSON.stringify({ id: "id-north", status: "active", region: "default", version: 1 }));

	const started = await mf.dispatchFetch(`${tenant}/oauth/device_authorization`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.8" },
		body: "client_name=Barry+Bot&client_id=barry",
	});
	const device = await started.json() as { user_code?: string };
	assert.equal(started.status, 200, JSON.stringify(device));
	assert.ok(device.user_code);
	const page = await mf.dispatchFetch(`${tenant}/device?user_code=${device.user_code}`, {
		headers: { "cf-connecting-ip": "198.51.100.8" },
	});
	const html = await page.text();
	assert.match(html, /Approve with Example/);
	const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
	const cookie = (page.headers.get("set-cookie") || "").split(";")[0];
	const post = await mf.dispatchFetch(`${tenant}/device`, {
		method: "POST",
		redirect: "manual",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			origin: tenant,
			cookie,
			"cf-connecting-ip": "198.51.100.8",
		},
		body: new URLSearchParams({ csrf, user_code: device.user_code, decision: "oidc" }).toString(),
	});
	assert.equal(post.status, 302, await post.text());
	assert.equal(new URL(post.headers.get("location") || "").origin + new URL(post.headers.get("location") || "").pathname, `${issuer}/api/oidc/authorize`);
	assert.deepEqual(bindingUrls, [`${issuer}/.well-known/openid-configuration`]);
	assert.equal(publicHosts.includes("control.example.com"), false, `public fetch hit ${publicHosts.join(",")}`);

	const missed = await start({
		bindings: { TENANCY: "host", TENANT_DOMAIN: "example.com", TENANT_SECRETS_KEY: "platform-secret" },
		kvNamespaces: { TENANT_DIRECTORY: "tenants-oidc-miss" },
		durableObjects: { TENANT_DO: { className: "TenantStore", useSQLite: true } },
		outboundService: async () => new Response("origin is unreachable", { status: 522 }),
	});
	t.after(() => missed.dispose());
	await missed.ready;
	const missedKv = await missed.getKVNamespace("TENANT_DIRECTORY");
	const missedNs = await missed.getDurableObjectNamespace("TENANT_DO");
	const missedStub = missedNs.get(missedNs.idFromName("id-north")) as unknown as { pushConfig(body: Record<string, unknown>): Promise<{ applied: boolean }> };
	await missedStub.pushConfig({
		version: 1, tenantId: "id-north", name: "northwind", status: "active", ownerTokenHash: hash,
		approval: { issuer, clientId: "client-1", clientSecret: "tenant-secret-value", allowedSubjects: ["owner-1"], label: "Example" },
	});
	await missedKv.put("tenant:northwind", JSON.stringify({ id: "id-north", status: "active", region: "default", version: 1 }));
	const missedStart = await missed.dispatchFetch(`${tenant}/oauth/device_authorization`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.9" },
		body: "client_name=Barry+Bot&client_id=barry",
	});
	const missedDevice = await missedStart.json() as { user_code: string };
	const missedPage = await missed.dispatchFetch(`${tenant}/device?user_code=${missedDevice.user_code}`, {
		headers: { "cf-connecting-ip": "198.51.100.9" },
	});
	const missedHtml = await missedPage.text();
	const missedCsrf = /name="csrf" value="([^"]+)"/.exec(missedHtml)?.[1] ?? "";
	const missedCookie = (missedPage.headers.get("set-cookie") || "").split(";")[0];
	const missedPost = await missed.dispatchFetch(`${tenant}/device`, {
		method: "POST",
		redirect: "manual",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			origin: tenant,
			cookie: missedCookie,
			"cf-connecting-ip": "198.51.100.9",
		},
		body: new URLSearchParams({ csrf: missedCsrf, user_code: missedDevice.user_code, decision: "oidc" }).toString(),
	});
	assert.equal(missedPost.status, 502);
	assert.match(await missedPost.text(), /The identity provider could not be reached/);
});

test("an apex issuer is fetched with that Host, and a control worker that does not answer still returns", async (t) => {
	const issuer = "https://example.com";
	const tenant = "https://northwind.example.com";
	const control = `
		export default {
			fetch(request) {
				const url = new URL(request.url);
				const host = request.headers.get("host");
				if (url.origin !== ${JSON.stringify(issuer)} || host !== "example.com") return new Promise(() => {});
				if (url.pathname !== "/.well-known/openid-configuration") return new Response("missing", { status: 404 });
				return Response.json({
					issuer: ${JSON.stringify(issuer)},
					authorization_endpoint: ${JSON.stringify(issuer + "/api/oidc/authorize")},
					token_endpoint: ${JSON.stringify(issuer + "/api/oidc/token")},
					jwks_uri: ${JSON.stringify(issuer + "/api/auth/jwks")},
				});
			},
		}
	`;
	const mf = new Miniflare(convertV4MiniflareOptions({
		workers: [
			{
				name: "inbox",
				modules: true,
				script: await SCRIPT,
				compatibilityDate: "2026-10-06",
				routes: ["*://*.example.com/*"],
				d1Databases: { DB: "inbox-apex" },
				kvNamespaces: { TENANT_DIRECTORY: "tenants-apex" },
				durableObjects: { TENANT_DO: { className: "TenantStore", useSQLite: true } },
				bindings: { TENANCY: "host", TENANT_DOMAIN: "example.com", TENANT_SECRETS_KEY: "platform-secret" },
				serviceBindings: { CONTROL_SERVICE: "control" },
			},
			{
				name: "control",
				modules: true,
				script: control,
				compatibilityDate: "2026-10-06",
				routes: ["*://example.com/*"],
			},
		],
	} as never));
	t.after(() => mf.dispose());
	await mf.ready;
	const kv = await mf.getKVNamespace("TENANT_DIRECTORY", "inbox");
	const ns = await mf.getDurableObjectNamespace("TENANT_DO", "inbox");
	const hash = await sha256("owner-apex");
	const stub = ns.get(ns.idFromName("id-apex")) as unknown as { pushConfig(body: Record<string, unknown>): Promise<{ applied: boolean }> };
	assert.equal((await stub.pushConfig({
		version: 1, tenantId: "id-apex", name: "northwind", status: "active", ownerTokenHash: hash,
		approval: { issuer, clientId: "client-1", clientSecret: "tenant-secret-value", allowedSubjects: ["owner-1"], label: "Example" },
	})).applied, true);
	await kv.put("tenant:northwind", JSON.stringify({ id: "id-apex", status: "active", region: "default", version: 1 }));
	const started = await mf.dispatchFetch(`${tenant}/oauth/device_authorization`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.20" },
		body: "client_name=Barry+Bot&client_id=barry",
	});
	const device = await started.json() as { user_code?: string };
	assert.equal(started.status, 200, JSON.stringify(device));
	const page = await mf.dispatchFetch(`${tenant}/device?user_code=${device.user_code}`, {
		headers: { "cf-connecting-ip": "198.51.100.20" },
	});
	const html = await page.text();
	assert.match(html, /Alias \(claimed\)/);
	assert.match(html, />barry</);
	assert.equal(html.includes("Client id"), false);
	const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
	const cookie = (page.headers.get("set-cookie") || "").split(";")[0];
	const t0 = Date.now();
	const post = await mf.dispatchFetch(`${tenant}/device`, {
		method: "POST",
		redirect: "manual",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			origin: tenant,
			cookie,
			"cf-connecting-ip": "198.51.100.20",
		},
		body: new URLSearchParams({ csrf, user_code: device.user_code || "", decision: "oidc" }).toString(),
	});
	assert.ok(Date.now() - t0 < 3000, "a matching Host must not wait out the deadline");
	assert.equal(post.status, 302, await post.text());
	assert.equal(new URL(post.headers.get("location") || "").origin, issuer);

	const stalled = await start({
		bindings: { TENANCY: "host", TENANT_DOMAIN: "example.com", TENANT_SECRETS_KEY: "platform-secret" },
		kvNamespaces: { TENANT_DIRECTORY: "tenants-apex-stall" },
		durableObjects: { TENANT_DO: { className: "TenantStore", useSQLite: true } },
		serviceBindings: {
			CONTROL_SERVICE: async () => {
				await new Promise((resolve) => setTimeout(resolve, 8000));
				return Response.json({ issuer });
			},
		},
	});
	t.after(() => stalled.dispose());
	await stalled.ready;
	const stalledKv = await stalled.getKVNamespace("TENANT_DIRECTORY");
	const stalledNs = await stalled.getDurableObjectNamespace("TENANT_DO");
	const stalledStub = stalledNs.get(stalledNs.idFromName("id-apex")) as unknown as { pushConfig(body: Record<string, unknown>): Promise<{ applied: boolean }> };
	await stalledStub.pushConfig({
		version: 1, tenantId: "id-apex", name: "northwind", status: "active", ownerTokenHash: hash,
		approval: { issuer, clientId: "client-1", clientSecret: "tenant-secret-value", allowedSubjects: ["owner-1"], label: "Example" },
	});
	await stalledKv.put("tenant:northwind", JSON.stringify({ id: "id-apex", status: "active", region: "default", version: 1 }));
	const stalledStart = await stalled.dispatchFetch(`${tenant}/oauth/device_authorization`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.21" },
		body: "client_name=Barry+Bot&client_id=barry",
	});
	const stalledDevice = await stalledStart.json() as { user_code: string };
	const stalledPage = await stalled.dispatchFetch(`${tenant}/device?user_code=${stalledDevice.user_code}`, {
		headers: { "cf-connecting-ip": "198.51.100.21" },
	});
	const stalledHtml = await stalledPage.text();
	const stalledCsrf = /name="csrf" value="([^"]+)"/.exec(stalledHtml)?.[1] ?? "";
	const stalledCookie = (stalledPage.headers.get("set-cookie") || "").split(";")[0];
	const stallBegan = Date.now();
	const stalledPost = await Promise.race([
		stalled.dispatchFetch(`${tenant}/device`, {
			method: "POST",
			redirect: "manual",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				origin: tenant,
				cookie: stalledCookie,
				"cf-connecting-ip": "198.51.100.21",
			},
			body: new URLSearchParams({ csrf: stalledCsrf, user_code: stalledDevice.user_code, decision: "oidc" }).toString(),
		}),
		new Promise<Response>((_, reject) => setTimeout(() => reject(new Error("device post hung")), 7000)),
	]);
	assert.ok(Date.now() - stallBegan < 7000);
	assert.equal(stalledPost.status, 502);
	assert.match(await stalledPost.text(), /The identity provider could not be reached/);
});

test("TenantStore.owner runs an allowlisted owner call and does not return a peer token", async (t) => {
	const mf = await start({
		bindings: {
			TENANCY: "host",
			TENANT_DOMAIN: "example.com",
			TENANT_SECRETS_KEY: "platform-secret",
			OWNER_TOKEN: "platform-owner",
		},
		kvNamespaces: { TENANT_DIRECTORY: "tenants-owner-rpc" },
		durableObjects: { TENANT_DO: { className: "TenantStore", useSQLite: true } },
	});
	t.after(() => mf.dispose());
	await mf.ready;
	const kv = await mf.getKVNamespace("TENANT_DIRECTORY");
	const ns = await mf.getDurableObjectNamespace("TENANT_DO");
	const hash = await sha256("owner-carol");
	type OwnerStub = {
		owner(input: { accountId: string; method: string; path: string; query?: Record<string, string>; body?: unknown }): Promise<{ status: number; body: unknown }>;
		storageStatus(): Promise<{ configured: boolean; tables: string[] }>;
		pushConfig(body: Record<string, unknown>): Promise<{ applied: boolean }>;
	};
	const lines: string[] = [];
	const orig = console.log;
	console.log = (...args: unknown[]) => {
		lines.push(args.map((a) => String(a)).join(" "));
		orig(...args);
	};
	t.after(() => { console.log = orig; });
	// Workerd delivers console.log on a later turn. A busy runner (the storage-backend jobs) can
	// return the RPC before that line is in this process.
	const saw = async (part: string) => {
		const start = Date.now();
		while (!lines.some((l) => l.includes(part))) {
			if (Date.now() - start > 2000) return false;
			await new Promise((r) => setTimeout(r, 20));
		}
		return true;
	};
	const empty = ns.get(ns.idFromName("id-empty")) as unknown as OwnerStub;
	const missing = await empty.owner({ accountId: "acct_carol", method: "GET", path: "/owner/peers" });
	assert.equal(missing.status, 404);
	const emptyStatus = await empty.storageStatus();
	assert.equal(emptyStatus.configured, false);
	assert.deepEqual(emptyStatus.tables, []);
	assert.equal(await saw('"reason":"absent"'), true);

	const stub = ns.get(ns.idFromName("id-carol")) as unknown as OwnerStub;
	await stub.pushConfig({
		version: 1, tenantId: "id-carol", name: "carol", status: "active", ownerTokenHash: hash,
		approval: { issuer: "https://idp.example", clientId: "client-1", clientSecret: "tenant-secret-value", allowedSubjects: ["acct_carol"] },
		config: { AGENT_NAME: "Carol" },
	});
	await kv.put("tenant:carol", JSON.stringify({ id: "id-carol", status: "active", region: "", version: 1 }));
	const http = (method: string, path: string, auth: string, json?: unknown) => mf.dispatchFetch(`https://carol.example.com${path}`, {
		method, headers: { authorization: auth, "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json),
	});
	assert.equal((await http("POST", "/owner/peers", "Bearer platform-owner", { label: "nope" })).status, 401, "self-host owner token still does not unlock a tenant");
	const issued = await (await http("POST", "/owner/peers", "Bearer owner-carol", { label: "ada" })).json() as { token?: string };
	assert.match(issued.token ?? "", /^a2aow_/, "the owner HTTP API still returns the new token");

	const listed = await stub.owner({ accountId: "acct_carol", method: "GET", path: "/owner/peers" });
	assert.equal(listed.status, 200);
	const peers = listed.body as { label: string; token?: string }[];
	assert.deepEqual(peers.map((p) => p.label), ["ada"]);
	assert.equal(JSON.stringify(listed.body).includes("a2aow_"), false);
	assert.equal(await saw('"route":"GET /owner/peers"'), true);

	const minted = await stub.owner({ accountId: "acct_carol", method: "POST", path: "/owner/peers", body: { label: "bob" } });
	assert.equal(minted.status, 404);
	assert.equal(JSON.stringify(minted.body).includes("a2aow_"), false);
	const withBody = await stub.owner({ accountId: "acct_carol", method: "GET", path: "/owner/peers", body: { label: "bob" } });
	assert.equal(withBody.status, 400);
	const again = await stub.owner({ accountId: "acct_carol", method: "POST", path: "/owner/peers" });
	assert.equal(again.status, 404);
	const still = await stub.owner({ accountId: "acct_carol", method: "GET", path: "/owner/peers" });
	assert.deepEqual((still.body as { label: string }[]).map((p) => p.label), ["ada"], "a refused call does not mint a token");

	const setup = await stub.owner({ accountId: "acct_carol", method: "POST", path: "/owner/pairing/password-link" });
	assert.equal(setup.status, 404);
	const dumped = await stub.owner({ accountId: "acct_carol", method: "GET", path: "/owner/export" });
	assert.equal(dumped.status, 404);
	const oddQuery = await stub.owner({ accountId: "acct_carol", method: "GET", path: "/owner/inbox", query: { format: "sql" } });
	assert.equal(oddQuery.status, 400);
	const pairing = await stub.owner({ accountId: "acct_carol", method: "GET", path: "/owner/pairing" });
	assert.equal(pairing.status, 200);
	assert.equal(JSON.stringify(pairing.body).includes("tenant-secret-value"), false);
	const preview = await stub.owner({ accountId: "acct_carol", method: "GET", path: "/owner/wake/preview" });
	assert.equal(preview.status, 200);
	assert.equal(JSON.stringify(preview.body).includes("platform-secret"), false);
	assert.equal(JSON.stringify(preview.body).includes("tenant-secret-value"), false);

	await stub.pushConfig({ version: 2, tenantId: "id-carol", name: "carol", status: "suspended", ownerTokenHash: hash, config: { AGENT_NAME: "Carol" } });
	const suspended = await stub.owner({ accountId: "acct_carol", method: "GET", path: "/owner/peers" });
	assert.equal(suspended.status, 403);
	assert.equal(await saw('"reason":"status"'), true);
	const badAccount = await stub.owner({ accountId: "../acct", method: "GET", path: "/owner/peers" });
	assert.equal(badAccount.status, 400);
	assert.equal(await saw('"reason":"account"'), true);
	assert.equal(lines.some((l) => l.includes("../acct")), false);
});
