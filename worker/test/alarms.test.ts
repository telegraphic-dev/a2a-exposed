// Hosted Durable Object alarms replace the minute cron flush. Self-host scheduled() still runs that flush.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import worker, { cronFlush, nextCronAt } from "../src/index.ts";
import { d1 } from "./d1.ts";
import { sha256 } from "../src/a2a.ts";
import { resolveTenant } from "../src/tenancy.ts";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const ectx = { waitUntil(_p: Promise<unknown>) {}, passThroughOnException() {} };

function ctx(over: Record<string, string> = {}) {
	const DB = d1(MIGRATIONS);
	const env = { DB, PUBLIC_URL: "https://agent.example.com", OWNER_TOKEN: "owner-secret", WAKE_PRESET: "generic",
		WAKE_DEBOUNCE_SECONDS: "10", WAKE_MAX_PER_HOUR: "0", ...over };
	return { DB, env, tenant: resolveTenant(env as never) };
}

test("nextCronAt is the earliest wake, rate row, or expiry", async () => {
	const { DB, tenant } = ctx();
	assert.equal(await nextCronAt(tenant, 1_700_000_000_000), null);
	const now = 1_700_000_000_000;
	await DB.prepare("INSERT INTO wakes (context_id, last_sent_ms, pending_json, pending_since_ms) VALUES ('c', ?, '{\"kind\":\"inbound\"}', ?)").bind(now - 5000, now).run();
	assert.equal(await nextCronAt(tenant, now), now - 5000 + 10_000);
	await DB.prepare("INSERT INTO rate (peer, minute, count) VALUES ('p', 1, 2)").run();
	assert.equal(await nextCronAt(tenant, now), 7 * 60_000);
	await DB.prepare("DELETE FROM wakes").run();
	await DB.prepare("DELETE FROM rate").run();
	await DB.prepare("INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scope, resource, created_ms, expires_ms) VALUES ('h', 'c', 'https://example.com/cb', 'ch', 's', 'https://agent.example.com/mcp', 1, ?)").bind(now + 5000).run();
	await DB.prepare("INSERT INTO device_requests (device_hash, user_code, status, created_ms, expires_ms, interval_s) VALUES ('d', 'WDJB4827', 'pending', 1, ?, 5)").bind(now).run();
	assert.equal(await nextCronAt(tenant, now), now + 5001);
	await DB.prepare("DELETE FROM oauth_codes").run();
	await DB.prepare("DELETE FROM device_requests").run();
	await DB.prepare("INSERT INTO oidc_txns (state, nonce, verifier, kind, csrf, payload_json, expires_ms) VALUES ('s', 'n', 'v', 'device', 'c', '{}', ?)").bind(now + 800).run();
	assert.equal(await nextCronAt(tenant, now), now + 801);
});

test("an hourly cap holds an already-due wake until the next hour", async () => {
	const now = 1_700_000_000_000;
	const hour = Math.floor(now / 3600000);
	const { DB, tenant } = ctx({ WAKE_MAX_PER_HOUR: "2" });
	await DB.prepare("INSERT INTO wake_budget (hour, count) VALUES (?, 2)").bind(hour).run();
	await DB.prepare("INSERT INTO wakes (context_id, last_sent_ms, pending_json, pending_since_ms) VALUES ('c', ?, '{}', ?)").bind(now - 60_000, now).run();
	assert.equal(await nextCronAt(tenant, now), (hour + 1) * 3600000);
});

test("self-host scheduled still deletes expired housekeeping rows", async () => {
	const { DB, env, tenant } = ctx();
	const minute = Math.floor(Date.now() / 60000);
	await DB.prepare("INSERT INTO rate (peer, minute, count) VALUES ('old', 1, 3)").run();
	await DB.prepare("INSERT INTO rate (peer, minute, count) VALUES ('new', ?, 1)").bind(minute).run();
	await DB.prepare("INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scope, resource, created_ms, expires_ms) VALUES ('h', 'c', 'https://example.com/cb', 'ch', 's', 'https://agent.example.com/mcp', 1, 1)").run();
	await DB.prepare("INSERT INTO oidc_txns (state, nonce, verifier, kind, csrf, payload_json, expires_ms) VALUES ('s', 'n', 'v', 'device', 'c', '{}', 1)").run();
	await worker.scheduled({ cron: "* * * * *" } as never, env as never, ectx as never);
	assert.equal(await DB.prepare("SELECT peer FROM rate WHERE peer = 'old'").first(), null);
	assert.equal(await DB.prepare("SELECT state FROM oidc_txns").first(), null);
	assert.equal((await DB.prepare("SELECT peer FROM rate WHERE peer = 'new'").first<{ peer: string }>())?.peer, "new");
	assert.equal(await DB.prepare("SELECT code_hash FROM oauth_codes").first(), null);
	await cronFlush(tenant, ectx as never);
	assert.equal((await DB.prepare("SELECT peer FROM rate WHERE peer = 'new'").first<{ peer: string }>())?.peer, "new");
});

const require = createRequire(new URL("../package.json", import.meta.url));

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

test("a hosted tenant arms an alarm for a debounced wake and the alarm flushes it", async (t) => {
	const mf = new Miniflare(convertV4MiniflareOptions({
		name: "a2a",
		modules: true,
		script: await bundleHosted(),
		compatibilityDate: "2026-10-06",
		d1Databases: { DB: "unused" },
		kvNamespaces: { TENANT_DIRECTORY: "tenants" },
		durableObjects: { TENANT_DO: { className: "TenantStore", useSQLite: true } },
		bindings: { TENANCY: "host", TENANT_DOMAIN: "example.com", TENANT_SECRETS_KEY: "platform-secret", OWNER_TOKEN: "platform-owner" },
	} as never));
	t.after(() => mf.dispose());
	await mf.ready;
	const kv = await mf.getKVNamespace("TENANT_DIRECTORY");
	const ns = await mf.getDurableObjectNamespace("TENANT_DO");
	const hash = await sha256("owner-alice");
	const stub = ns.get(ns.idFromName("id-alice")) as unknown as {
		pushConfig(b: Record<string, unknown>): Promise<{ applied: boolean }>;
		alarmAt(): Promise<number | null>;
		runAlarm(): Promise<void>;
		fetch(r: Request): Promise<Response>;
	};
	assert.equal(await stub.alarmAt(), null);
	// 30s is past the 25s in-request flush. The second message only writes a pending row, so the alarm has to move off the rate-row timer in that same request.
	await stub.pushConfig({ version: 1, tenantId: "id-alice", name: "alice", status: "active", ownerTokenHash: hash, config: { WAKE_DEBOUNCE_SECONDS: "30", WAKE_MAX_PER_HOUR: "0", AGENT_NAME: "Alice" } });
	await kv.put("tenant:alice", JSON.stringify({ id: "id-alice", status: "active", region: "default", version: 1 }));
	assert.equal(await stub.alarmAt(), null, "an idle tenant has nothing to flush");
	const send = (text: string, id: string) => mf.dispatchFetch("https://alice.example.com/", {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { kind: "message", role: "user", messageId: id, contextId: "ctx-a", parts: [{ kind: "text", text }] } } }),
	});
	const issued = await (await mf.dispatchFetch("https://alice.example.com/owner/peers", {
		method: "POST", headers: { authorization: "Bearer owner-alice", "content-type": "application/json" }, body: JSON.stringify({ label: "ada" }),
	})).json() as { token: string };
	const token = issued.token;
	assert.equal((await send("one", "m1")).status, 200);
	const rateAlarm = await stub.alarmAt();
	assert.ok(rateAlarm && rateAlarm > Date.now() + 4 * 60_000 && rateAlarm < Date.now() + 7 * 60_000, "the request's rate row is the next housekeeping delete");
	assert.equal((await send("two", "m2")).status, 200);
	const armed = await stub.alarmAt();
	assert.ok(armed && armed > Date.now() + 20_000 && armed < Date.now() + 45_000, "the pending wake is due before the rate row");

	// "0" is a real debounce of zero (the string is set). A runtime may run that alarm before this RPC returns.
	await stub.pushConfig({ version: 2, tenantId: "id-alice", name: "alice", status: "active", ownerTokenHash: hash, config: { WAKE_DEBOUNCE_SECONDS: "0", WAKE_MAX_PER_HOUR: "0", AGENT_NAME: "Alice" } });
	let after = await stub.alarmAt();
	if (after && after <= Date.now() + 2000) {
		await stub.runAlarm();
		after = await stub.alarmAt();
	}
	assert.ok(after && after > Date.now() + 60_000 && after < Date.now() + 7 * 60_000, "the alarm flushed the wake; the rate row is still waiting");
	const inbox = await (await mf.dispatchFetch("https://alice.example.com/owner/inbox?all=1", {
		headers: { authorization: "Bearer owner-alice" },
	})).json() as { text: string }[];
	assert.equal(inbox.length, 2);

	await stub.pushConfig({ version: 3, tenantId: "id-alice", name: "alice", status: "suspended", ownerTokenHash: hash, config: { AGENT_NAME: "Alice" } });
	assert.equal(await stub.alarmAt(), null, "a suspended tenant has no alarm");
});

test("a 429 that arrives after the response re-arms for Retry-After", async (t) => {
	const { createServer } = await import("node:http");
	const hits: number[] = [];
	// Hold the 429 until the inbox has responded, so the retry row is written after fetch returns.
	let release: () => void = () => {};
	const hold = new Promise<void>((resolve) => { release = resolve; });
	const server = createServer((_req, res) => {
		hits.push(Date.now());
		void hold.then(() => {
			if (res.writableEnded) return;
			res.writeHead(429, { "retry-after": "30" });
			res.end("slow");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const port = (server.address() as { port: number }).port;
	t.after(() => new Promise((resolve) => server.close(() => resolve(undefined))));
	const mf = new Miniflare(convertV4MiniflareOptions({
		name: "a2a",
		modules: true,
		script: await bundleHosted(),
		compatibilityDate: "2026-10-06",
		d1Databases: { DB: "unused" },
		kvNamespaces: { TENANT_DIRECTORY: "tenants" },
		durableObjects: { TENANT_DO: { className: "TenantStore", useSQLite: true } },
		bindings: { TENANCY: "host", TENANT_DOMAIN: "example.com", TENANT_SECRETS_KEY: "platform-secret", OWNER_TOKEN: "platform-owner" },
	} as never));
	t.after(() => mf.dispose());
	await mf.ready;
	const kv = await mf.getKVNamespace("TENANT_DIRECTORY");
	const ns = await mf.getDurableObjectNamespace("TENANT_DO");
	const hash = await sha256("owner-alice");
	const stub = ns.get(ns.idFromName("id-alice")) as unknown as {
		pushConfig(b: Record<string, unknown>): Promise<{ applied: boolean }>;
		alarmAt(): Promise<number | null>;
	};
	await stub.pushConfig({
		version: 1, tenantId: "id-alice", name: "alice", status: "active", ownerTokenHash: hash,
		config: { WAKE_DEBOUNCE_SECONDS: "45", WAKE_MAX_PER_HOUR: "0", WAKE_WEBHOOK_URL: `http://127.0.0.1:${port}/hook`, AGENT_NAME: "Alice" },
	});
	await kv.put("tenant:alice", JSON.stringify({ id: "id-alice", status: "active", region: "default", version: 1 }));
	const issued = await (await mf.dispatchFetch("https://alice.example.com/owner/peers", {
		method: "POST", headers: { authorization: "Bearer owner-alice", "content-type": "application/json" }, body: JSON.stringify({ label: "ada" }),
	})).json() as { token: string };
	const sentPromise = mf.dispatchFetch("https://alice.example.com/", {
		method: "POST",
		headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { kind: "message", role: "user", messageId: "m1", contextId: "ctx-a", parts: [{ kind: "text", text: "one" }] } } }),
	});
	const waitHit = Date.now() + 4000;
	while (!hits.length && Date.now() < waitHit) await new Promise((r) => setTimeout(r, 20));
	assert.equal(hits.length >= 1, true, "the webhook was called");
	const earlyResponse = await Promise.race([
		sentPromise.then((r) => r),
		new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
	]);
	assert.ok(earlyResponse, "the inbox returns while the webhook is still held");
	assert.equal(earlyResponse.status, 200);
	const before = await stub.alarmAt();
	assert.ok(before == null || before > Date.now() + 60_000, "the retry alarm is not set before the 429 is written");
	release();
	const start = Date.now();
	let armed: number | null = null;
	while (Date.now() - start < 4000) {
		armed = await stub.alarmAt();
		if (armed && armed < Date.now() + 60_000) break;
		await new Promise((r) => setTimeout(r, 40));
	}
	assert.ok(armed && armed > Date.now() + 20_000 && armed < Date.now() + 40_000, "the alarm is Retry-After (30s), not that delay plus the 45s debounce");
});
