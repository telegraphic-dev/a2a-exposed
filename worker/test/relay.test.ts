import { test } from "node:test";
import process from "node:process";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes, createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

async function until(check: () => boolean | Promise<boolean>, timeout = 5000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); }
	throw new Error("condition did not become true");
}
async function socket(url: URL, token: string) {
	const ws = new WebSocket(new URL("/relay/connect", url).href.replace("http:", "ws:"), ["a2a-wake-v1", token]);
	const messages: any[] = [];
	ws.addEventListener("message", e => { if (e.data !== "pong") messages.push(JSON.parse(String(e.data))); });
	await Promise.race([once(ws, "open"), once(ws, "error").then(() => { throw new Error("websocket handshake refused"); }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("websocket handshake timeout")), 5000); timer.unref(); })]); await until(() => messages.length > 0);
	return { ws, messages };
}
async function runtime(hosted = false, persistence = "", overrides: Record<string, string> = {}, relayBinding = true) {
	const built = await build({ ...(hosted ? { stdin: { contents: `import { TenantStore as Base } from "./src/hosted.ts";
export { default, WakeRelay } from "./src/hosted.ts";
export class TenantStore extends Base {
 async checkedPush(body) { try { return { value: await this.pushConfig(body) }; } catch (e) { return { error: e.message }; } }
 async checkedDelete() { try { return { value: await this.deleteStorage() }; } catch (e) { return { error: e.message }; } }
 async failConfigWrite(on) { this.ctx.storage.sql.exec(on ? "CREATE TRIGGER fail_config BEFORE UPDATE ON tenant_config BEGIN SELECT RAISE(ABORT, 'injected config failure'); END" : "DROP TRIGGER fail_config"); }
}`, resolveDir: process.cwd(), loader: "ts" as const } } : { entryPoints: ["src/relay-entry.ts"] }), bundle: true, write: false, format: "esm", platform: "neutral", external: ["cloudflare:*"], plugins: [{ name: "sql", setup(b) {
		b.onResolve({ filter: /\.sql\?raw$/ }, a => ({ path: new URL(a.path.replace("?raw", ""), `file://${a.resolveDir}/`).pathname, namespace: "sql" }));
		b.onLoad({ filter: /.*/, namespace: "sql" }, a => ({ contents: `export default ${JSON.stringify(readFileSync(a.path, "utf8"))}`, loader: "js" }));
	} }] });
	const mf = new Miniflare(convertV4MiniflareOptions({ name: "relay-test", ...(persistence ? { resourcePersistencePath: persistence, isolatedResourcePersistencePath: persistence } : {}), modules: true, script: built.outputFiles[0].text, compatibilityDate: "2026-10-06", d1Databases: ["DB"], ...(hosted ? { kvNamespaces: ["TENANT_DIRECTORY"] } : {}), durableObjects: { ...(hosted ? { TENANT_DO: { className: "TenantStore", useSQLite: true } } : {}), ...(relayBinding ? { WAKE_RELAY: { className: "WakeRelay", useSQLite: true } } : {}) }, bindings: { ...(hosted ? { TENANCY: "host", TENANT_DOMAIN: "agents.example.com", TENANT_SECRETS_KEY: "dummy-platform" } : {}), OWNER_TOKEN: "dummy-owner", WAKE_RELAY_ENABLED: "1", WAKE_TRANSPORT: "relay", WAKE_PRESET: "generic", WAKE_WEBHOOK_KEY: "dummy-app-key", WAKE_HMAC_SECRET: "dummy-app-signing", WAKE_DEBOUNCE_SECONDS: "0", WAKE_BUSY_SECONDS: "0", MCP: "off", ...overrides } }));
	const db = await mf.getD1Database("DB");
	if (!await db.prepare("SELECT name FROM sqlite_master WHERE name = 'tasks'").first()) for (const f of readdirSync("migrations").filter(n => n.endsWith(".sql")).sort()) await db.exec(readFileSync(`migrations/${f}`, "utf8").replace(/--[^\n]*/g, "").replace(/\n/g, " "));
	const url = await mf.ready;
	const call = (path: string, method = "GET", token = "dummy-owner", body?: unknown) => fetch(new URL(path, url), { method, headers: { authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
	const enroll = async () => {
		const token = "a2ar_" + randomBytes(32).toString("base64url");
		const body = { credentialHash: createHash("sha256").update(token).digest("hex"), idempotencyKey: randomBytes(24).toString("base64url") };
		const response = await call("/owner/wake/relay", "POST", "dummy-owner", body);
		assert.equal(response.status, 200);
		return { ...await response.json() as any, token, body };
	};
	return { mf, url, call, db, enroll };
}

test("real workerd relay and native connector acknowledge the local webhook, fence rotation and catch up offline inbox", { timeout: 60000 }, async () => {
	const r = await runtime();
	let connector: any;
	const stop = new AbortController();
	const stop2 = new AbortController();
	const received: any[] = [];
	const server = createServer(async (req, res) => { let body = ""; for await (const chunk of req) body += chunk; if (req.headers.authorization !== "Bearer dummy-app-key" || req.headers["x-webhook-signature-v2"] !== createHmac("sha256", "dummy-app-signing").update(`${req.headers["x-webhook-timestamp"]}.${body}`).digest("hex")) { res.writeHead(401).end(); return; } received.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) }); res.writeHead(202).end(); });
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	try {
		assert.equal((await fetch(`http://127.0.0.1:${(server.address() as any).port}/fixed`, { method: "POST", body: "{}" })).status, 401, "receiver requires application bearer and HMAC independently of transport");
		assert.equal((await r.call("/owner/wake/relay", "POST", "peer")).status, 401);
		const issued = await r.enroll();
		assert.match(issued.token, /^a2ar_/);
		assert.equal((await (await r.call("/owner/wake/relay")).json() as any).connected, false);
		const { runConnector } = await import("../../cli/lib/relay.mjs");
		connector = runConnector({ url: new URL("/relay/connect", r.url).href.replace("http:", "ws:"), token: issued.token, localUrl: `http://127.0.0.1:${(server.address() as any).port}/fixed`, signal: stop.signal });
		for (let i = 0; i < 100; i++) { if ((await (await r.call("/owner/wake/relay")).json() as any).connected) break; await new Promise(a => setTimeout(a, 20)); }
		const result = await (await r.call("/owner/wake/test", "POST")).json() as any;
		assert.equal(result.status, 202); assert.equal(received[0].path, "/fixed"); assert.equal(received[0].auth, "Bearer dummy-app-key");
		assert.equal(received[0].body.kind, "test");
		stop.abort(); await connector; connector = null;
		const peer = await (await r.call("/owner/peers", "POST", "dummy-owner", { label: "ada" })).json() as any;
		const sent = await r.call("/a2a", "POST", peer.token, { jsonrpc: "2.0", id: "send-1", method: "message/send", params: { message: { kind: "message", role: "user", messageId: "offline-message", parts: [{ kind: "text", text: "offline work" }] } } });
		assert.equal(sent.status, 200); assert.ok((await sent.json() as any).result);
		connector = runConnector({ url: new URL("/relay/connect", r.url).href.replace("http:", "ws:"), token: issued.token, localUrl: `http://127.0.0.1:${(server.address() as any).port}/fixed`, signal: stop2.signal });
		await until(() => received.some(r => r.body.kind === "catchup"));
		const catchup = received.find(r => r.body.kind === "catchup");
		assert.match(catchup.body.hint, / inbox$/); assert.equal(catchup.body.preview, "");
		const inbox = await (await r.call("/owner/inbox")).json() as any;
		assert.ok(JSON.stringify(inbox).includes("offline work"));
		assert.equal((await r.call("/owner/wake/relay", "POST", "dummy-owner", issued.body)).status, 200, "same enrollment is idempotent after reconnect");
		assert.equal((await r.call("/owner/wake/relay", "DELETE", "dummy-owner", { generation: issued.generation + 100 })).status, 409);
		const terminated = assert.rejects(connector, /replaced or revoked/);
		await r.call("/owner/wake/relay", "DELETE", "dummy-owner", { generation: issued.generation });
		await terminated; connector = null;
		assert.equal((await (await r.call("/owner/wake/relay")).json() as any).connected, false);
		stop2.abort(); if (connector) await connector; connector = null;
		assert.equal((await (await r.call("/owner/wake/test", "POST")).json() as any).status, null);
		const rotated = await r.enroll();
		assert.notEqual(rotated.token, issued.token);
	} finally { stop.abort(); stop2.abort(); if (connector) await connector; server.closeAllConnections(); await new Promise<void>(a => server.close(() => a())); await r.mf.dispose(); }
});


test("workerd rejects credentials, malformed/oversized frames, fences connected rotation and stale acks", { timeout: 45000 }, async () => {
	const r = await runtime(); const sockets: WebSocket[] = [];
	try {
		for (const token of ["dummy-owner", "a2amcp_dummy", "a2ar_" + "x".repeat(43)]) {
			const response = await r.mf.dispatchFetch("https://agent.example.com/relay/connect", { headers: { upgrade: "websocket", "sec-websocket-protocol": `a2a-wake-v1, ${token}` } });
			assert.equal(response.status, 401);
		}
		assert.equal((await r.call("/relay/connect?token=not-accepted")).status, 400);
		const issued = await r.enroll();
		const first = await socket(r.url, issued.token); sockets.push(first.ws);
		const firstGeneration = first.messages[0].generation;
		const closed = once(first.ws, "close");
		const second = await socket(r.url, issued.token); sockets.push(second.ws);
		assert.equal((await closed)[0].code, 4001);
		assert.ok(second.messages[0].generation > firstGeneration);
		const pending = r.call("/owner/wake/test", "POST");
		await until(() => second.messages.some(m => m.type === "wake"));
		const wake = second.messages.find(m => m.type === "wake");
		const invalid = once(second.ws, "close");
		second.ws.send(JSON.stringify({ v: 1, type: "result", id: wake.id, generation: firstGeneration, status: 200 }));
		assert.equal((await invalid)[0].code, 1008);
		assert.equal((await (await pending).json() as any).status, null);
		for (const frame of ["not-json", "x".repeat(1025), JSON.stringify({ v: 1, type: "result", generation: 1, id: "bad", status: 200, url: "http://127.0.0.1/admin" })]) {
			const c = await socket(r.url, issued.token); sockets.push(c.ws); const closing = once(c.ws, "close"); c.ws.send(frame); assert.equal((await closing)[0].code, 1008);
		}
		const current = await socket(r.url, issued.token); sockets.push(current.ws); const rotating = once(current.ws, "close");
		await r.enroll(); assert.equal((await rotating)[0].code, 4001);
		const refused = await r.mf.dispatchFetch("https://agent.example.com/relay/connect", { headers: { upgrade: "websocket", "sec-websocket-protocol": `a2a-wake-v1, ${issued.token}` } });
		assert.equal(refused.status, 401);
		const { runConnector } = await import("../../cli/lib/relay.mjs");
		for (const token of ["a2ar_" + "x".repeat(43), issued.token]) {
			const diagnostics: string[] = [];
			await assert.rejects(runConnector({ url: new URL("/relay/connect", r.url).href.replace("http:", "ws:"), token, localUrl: "http://127.0.0.1:1/fixed", onDiagnostic: m => diagnostics.push(m) }), /handshake failed three consecutive times/);
			assert.equal(diagnostics.length, 2); assert.ok(diagnostics.every(m => !m.includes(token)));
		}
	} finally { for (const s of sockets) s.close(); await r.mf.dispose(); }
});

test("real local HTTP non-2xx, disconnect after execution and deadline stay unconfirmed without POST replay", { timeout: 40000 }, async () => {
	const r = await runtime(); const stop = new AbortController(); let connector;
	let mode = "reject", count = 0;
	const server = createServer(async (req, res) => { for await (const chunk of req) { void chunk; } count++; if (mode === "reject") res.writeHead(403).end(); else if (mode === "disconnect") res.destroy(); });
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	try {
		const issued = await r.enroll(); const { runConnector } = await import("../../cli/lib/relay.mjs");
		connector = runConnector({ url: new URL("/relay/connect", r.url).href.replace("http:", "ws:"), token: issued.token, localUrl: `http://127.0.0.1:${(server.address() as any).port}/fixed`, signal: stop.signal });
		await until(async () => (await (await r.call("/owner/wake/relay")).json() as any).connected);
		const rejected = await (await r.call("/owner/wake/test", "POST")).json() as any; assert.equal(rejected.status, 403); assert.equal(rejected.error, "local_http");
		mode = "disconnect";
		const disconnected = await (await r.call("/owner/wake/test", "POST")).json() as any;
		assert.equal(disconnected.status, null); assert.equal(disconnected.error, "uncertain");
		await new Promise(a => setTimeout(a, 100)); assert.equal(count, 2, "uncertain execution was not retried");
		mode = "timeout";
		const started = Date.now();
		const waiting = Array.from({ length: 4 }, () => r.call("/owner/wake/test", "POST"));
		await until(() => count === 6);
		const saturated = await (await r.call("/owner/wake/test", "POST")).json() as any;
		assert.equal(saturated.status, null); assert.equal(saturated.error, "busy"); assert.ok(Date.now() - started < 5000, "bounded concurrency rejects instead of queuing");
		for (const response of await Promise.all(waiting)) assert.equal((await response.json() as any).status, null);
		assert.ok(Date.now() - started >= 9000); assert.equal(count, 6);
	} finally { stop.abort(); await connector; server.closeAllConnections(); await new Promise<void>(a => server.close(() => a())); await r.mf.dispose(); }
});


for (const [header, key] of [["host", "dummy-app-key"], ["connection", "dummy-app-key"], ["sec-example", "dummy-app-key"], ["invalid_header", "dummy-app-key"], ["Authorization", "\u0100"]]) test(`workerd rejects malformed internal relay JSON and unsafe saved forwarding header ${header} before dispatch`, { timeout: 30000 }, async () => {
	const r = await runtime(false, "", { WAKE_KEY_HEADER: header, WAKE_WEBHOOK_KEY: key });
	try {
		const ns = await r.mf.getDurableObjectNamespace("WAKE_RELAY"), stub = ns.get(ns.idFromName("wake-relay-v1:single:self"));
		for (const path of ["/issue", "/revoke", "/deliver"]) {
			const response = await stub.fetch(`https://relay.internal${path}`, { method: "POST", body: "not-json" }); assert.equal(response.status, 400);
		}
		const issued = await r.enroll(); const c = await socket(r.url, issued.token);
		try {
			const outcome = await (await r.call("/owner/wake/test", "POST")).json() as any;
			assert.equal(outcome.error, "invalid"); assert.equal(outcome.status, null); assert.equal(c.messages.length, 1);
			assert.equal((await (await r.call("/owner/wake/relay")).json() as any).connected, true);
		} finally { c.ws.close(); }
	} finally { await r.mf.dispose(); }
});

test("hosted public routing isolates tenants and suspension/deletion fence the separate relay", { timeout: 100000 }, async () => {
	const r = await runtime(true);
	const sockets: any[] = [];
	try {
		const ns = await r.mf.getDurableObjectNamespace("TENANT_DO");
		const kv = await r.mf.getKVNamespace("TENANT_DIRECTORY");
		const tenants: Record<string, any> = {};
		for (const name of ["alice", "bobby"]) {
			const stub = ns.get(ns.idFromName(`id-${name}`)) as any;
			const config = { version: 1, tenantId: `id-${name}`, name, status: "active", ownerTokenHash: createHash("sha256").update(`owner-${name}`).digest("hex"), config: { WAKE_TRANSPORT: "relay", WAKE_PRESET: "generic", WAKE_BUSY_SECONDS: "0" } };
			await stub.pushConfig(config); tenants[name] = { stub, config };
			await kv.put(`tenant:${name}`, JSON.stringify({ id: `id-${name}`, status: "active", region: "default", version: 1 }));
		}
		const call = (name: string, path: string, method = "GET", body?: unknown, token = `owner-${name}`) => r.mf.dispatchFetch(`https://${name}.agents.example.com${path}`, { method, headers: { authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
		const token = "a2ar_" + randomBytes(32).toString("base64url");
		const body = { credentialHash: createHash("sha256").update(token).digest("hex"), idempotencyKey: randomBytes(24).toString("base64url"), configVersion: 1 };
		assert.equal((await call("alice", "/owner/wake/relay", "POST", { ...body, configVersion: 0 })).status, 409);
		assert.equal((await call("alice", "/owner/wake/relay", "POST", body, "owner-bobby")).status, 401);
		assert.equal((await call("alice", "/owner/wake/relay", "POST", body)).status, 200);
		assert.equal((await (await call("bobby", "/owner/wake/relay")).json() as any).enrolled, false);
		const upgrade = (name: string) => r.mf.dispatchFetch(`https://${name}.agents.example.com/relay/connect`, { headers: { upgrade: "websocket", "sec-websocket-protocol": `a2a-wake-v1, ${token}` } });
		assert.equal((await upgrade("bobby")).status, 401, "credential cannot substitute tenants");
		const connected = await upgrade("alice"); assert.equal(connected.status, 101);
		const ws = connected.webSocket!; ws.accept(); sockets.push(ws);
		ws.addEventListener("close", () => ws.close());
		const closing = once(ws as any, "close");
		await tenants.alice.stub.pushConfig({ ...tenants.alice.config, version: 2, status: "suspended" });
		assert.equal((await closing)[0].code, 4001);
		assert.notEqual((await upgrade("alice")).status, 101, "cached directory cannot bypass tenant suspension");
		await tenants.alice.stub.pushConfig({ ...tenants.alice.config, version: 3 });
		assert.equal((await upgrade("alice")).status, 401, "reactivation does not revive revoked enrollment");
		assert.equal((await call("alice", "/owner/wake/relay", "POST", { ...body, idempotencyKey: randomBytes(24).toString("base64url"), configVersion: 3 })).status, 200);
		const again = await upgrade("alice"); again.webSocket!.accept(); sockets.push(again.webSocket);
		again.webSocket!.addEventListener("close", () => again.webSocket!.close());
		const deleted = once(again.webSocket as any, "close");
		await tenants.alice.stub.deleteStorage(); assert.equal((await deleted)[0].code, 4001);
		assert.notEqual((await upgrade("alice")).status, 101);
		assert.equal((await tenants.alice.stub.pushConfig({ ...tenants.alice.config, version: 4 })).applied, false);
		assert.equal((await call("bobby", "/issue", "POST", body)).status, 404);
	} finally { for (const ws of sockets) { try { ws.close(); } catch { /* already closed */ } } await r.mf.dispose(); }
});


for (const initial of [true, false]) test(`actual CLI signed ${initial ? "initial unsaved draft" : "applied relay offline/reconnect"} with workerd`, { timeout: 40000 }, async () => {
	const r = await runtime(false, "", initial ? { WAKE_TRANSPORT: "webhook", WAKE_PRESET: "grok-bot" } : {});
	const dir = mkdtempSync(join(tmpdir(), "relay-cli-journey-")); let child: ReturnType<typeof spawn> | undefined;
	const file = join(dir, "credential"); const received: any[] = []; let output = "";
	const key = initial ? "dummy-draft-key" : "dummy-app-key", secret = initial ? "dummy-draft-signing" : "dummy-app-signing";
	const server = createServer(async (req, res) => {
		let body = ""; for await (const chunk of req) body += chunk;
		if (req.url !== "/fixed" || req.headers.authorization !== `Bearer ${key}` || req.headers["x-webhook-signature-v2"] !== createHmac("sha256", secret).update(`${req.headers["x-webhook-timestamp"]}.${body}`).digest("hex")) { res.writeHead(401).end(); return; }
		received.push({ raw: body, body: JSON.parse(body) }); res.writeHead(204).end();
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const env = { ...process.env, DO_NOT_TRACK: "1", A2A_CONFIG_DIR: dir, A2A_BASE_URL: String(r.url).replace(/\/$/, ""), A2A_OWNER_TOKEN: "dummy-owner" };
	const bin = new URL("../../cli/bin/a2a-exposed.mjs", import.meta.url).pathname;
	const cli = (...args: string[]) => promisify(execFile)(process.execPath, [bin, "relay", ...args], { env, cwd: dir });
	const start = async () => {
		child = spawn(process.execPath, [bin, "relay", "run", "--token-file", file, "--local-url", `http://127.0.0.1:${(server.address() as any).port}/fixed`], { env, cwd: dir, stdio: "pipe" });
		child.stdout!.on("data", b => output += b); child.stderr!.on("data", b => output += b);
		await until(async () => (await (await r.call("/owner/wake/relay")).json() as any).connected);
	};
	const stop = async () => { if (child) { const exited = once(child, "exit"); child.kill("SIGTERM"); assert.equal((await exited)[0], 0); child = undefined; } };
	try {
		const created = await cli("create", "--token-file", file); assert.equal(JSON.parse(created.stdout).enrolled, true); assert.equal(created.stdout.includes("a2ar_"), false); assert.equal(statSync(file).mode & 0o077, 0);
		const status = JSON.parse((await cli("status", "--json")).stdout); assert.equal(status.protocolVersion, 1);
		const before = await (await r.call("/owner/wake/preview")).json();
		await start();
		const draft = { transport: "relay", connectorId: "default", generation: status.generation, credentialsMode: "resolved", url: "", preset: "generic", key, hmacSecret: secret, bodyTemplate: '{ "kind": "{{kind}}", "marker": "unsaved exact bytes" }' };
		assert.equal((await r.call("/owner/wake/test", "POST", "peer", draft)).status, 401);
		for (const invalid of [{ ...draft, url: "http://127.0.0.1/admin" }, { ...draft, credentialsMode: "saved" }, { ...draft, generation: 0 }, { ...draft, connectorId: "other" }, { ...draft, headers: {} }]) assert.equal((await r.call("/owner/wake/test", "POST", "dummy-owner", invalid)).status, 400);
		assert.equal((await r.call("/owner/wake/test", "POST", "dummy-owner", { ...draft, generation: status.generation + 1 })).status, 409);
		const malformed = await fetch(new URL("/owner/wake/test", r.url), { method: "POST", headers: { authorization: "Bearer dummy-owner" }, body: '{"key":"dummy-sensitive"' });
		assert.equal(malformed.status, 400); assert.deepEqual(await malformed.json(), { error: "invalid" });
		const badTemplate = await r.call("/owner/wake/test", "POST", "dummy-owner", { ...draft, bodyTemplate: "dummy-sensitive-invalid-json" });
		assert.equal(badTemplate.status, 400); assert.deepEqual(await badTemplate.json(), { error: "invalid" });
		assert.equal((await (await r.call("/owner/wake/test", "POST", "dummy-owner", { ...draft, key: "", hmacSecret: "" })).json() as any).status, 401, "blank draft secrets never inherit applied secrets");
		const pending = JSON.stringify({ contextId: "pending-probe", taskId: "none", taskIds: [], from: "ada", preview: "", kind: "inbound" });
		await r.db.prepare("INSERT INTO wakes (context_id, peer, pending_json, pending_since_ms) VALUES (?, ?, ?, ?)").bind("pending-probe", "ada", pending, 1).run();
		const tested = await r.call("/owner/wake/test", "POST", "dummy-owner", draft);
		assert.equal(tested.headers.get("cache-control"), "no-store"); const result = await tested.json() as any;
		assert.equal(result.status, 204); assert.equal("error" in result, false); assert.equal(result.transport, "relay"); assert.equal(result.preset, "generic");
		assert.equal(received.length, 1); assert.equal(received[0].raw, '{ "kind": "test", "marker": "unsaved exact bytes" }');
		assert.equal((await r.db.prepare("SELECT pending_json FROM wakes WHERE context_id='pending-probe'").first() as any).pending_json, pending, "probe does not consume or flush a real pending wake");
		await r.db.prepare("DELETE FROM wakes WHERE context_id='pending-probe'").run();
		const after = await (await r.call("/owner/wake/preview")).json() as any;
		assert.equal(after.preset, (before as any).preset); assert.deepEqual(after.fingerprints, (before as any).fingerprints); assert.equal(after.request?.body, (before as any).request?.body, "probe never saves draft configuration or credentials");
		if (!initial) assert.equal((await (await r.call("/owner/wake/test", "POST", "dummy-owner", {})).json() as any).status, 204, "legacy owner HTTP empty-object probe still uses applied settings");
		await stop(); await until(async () => !(await (await r.call("/owner/wake/relay")).json() as any).connected);
		const offline = await (await r.call("/owner/wake/test", "POST", "dummy-owner", draft)).json() as any; assert.equal(offline.status, null); assert.equal(offline.error, "offline");
		if (!initial) {
			const peer = await (await r.call("/owner/peers", "POST", "dummy-owner", { label: "ada" })).json() as any;
			await r.call("/a2a", "POST", peer.token, { jsonrpc: "2.0", id: "offline-cli", method: "message/send", params: { message: { kind: "message", role: "user", messageId: "offline-cli", parts: [{ kind: "text", text: "offline CLI work" }] } } });
		}
		await start();
		if (!initial) { await until(() => received.some(r => r.body.kind === "catchup")); assert.ok(JSON.stringify(await (await r.call("/owner/inbox")).json()).includes("offline CLI work")); }
		assert.equal((await (await r.call("/owner/wake/test", "POST", "dummy-owner", draft)).json() as any).status, 204);
		const revokedExit = once(child!, "exit"); assert.equal(JSON.parse((await cli("revoke")).stdout).revoked, true); assert.equal((await revokedExit)[0], 1); child = undefined;
		assert.equal(JSON.parse((await cli("status")).stdout).connected, false);
		assert.equal((await r.call("/owner/wake/test", "POST", "dummy-owner", draft)).status, 409);
		assert.doesNotMatch(output, /a2ar_|dummy-(?:draft|app)/);
	} finally { await stop(); server.closeAllConnections(); await new Promise<void>(a => server.close(() => a())); await r.mf.dispose(); rmSync(dir, { recursive: true, force: true }); }
});


test("hosted owner RPC accepts only explicit resolved relay drafts without applying configuration", { timeout: 45000 }, async () => {
	const r = await runtime(true); let ws: WebSocket | undefined; let receiverStatus = 202;
	try {
		const ns = await r.mf.getDurableObjectNamespace("TENANT_DO");
		const stub = ns.get(ns.idFromName("id-draft")) as any;
		await stub.pushConfig({ version: 1, tenantId: "id-draft", name: "draft", status: "active", ownerTokenHash: createHash("sha256").update("dummy-owner").digest("hex"), approval: { allowedSubjects: ["acct_draft"] }, config: {} });
		const owner = (body?: unknown, accountId = "acct_draft") => stub.owner({ accountId, method: "POST", path: "/owner/wake/test", ...(body === undefined ? {} : { body }) });
		await (await r.mf.getKVNamespace("TENANT_DIRECTORY")).put("tenant:draft", JSON.stringify({ id: "id-draft", status: "active", region: "default", version: 1 }));
		const token = "a2ar_" + randomBytes(32).toString("base64url");
		const issued = await stub.owner({ accountId: "acct_draft", method: "POST", path: "/owner/wake/relay", body: { credentialHash: createHash("sha256").update(token).digest("hex"), idempotencyKey: randomBytes(24).toString("base64url"), configVersion: 1 } });
		assert.equal(issued.status, 200);
		await (await r.mf.getKVNamespace("TENANT_DIRECTORY")).put("tenant:draft", JSON.stringify({ id: "id-draft", status: "active", region: "default", version: 1 }));
		const upgrade = await r.mf.dispatchFetch("https://draft.agents.example.com/relay/connect", { headers: { upgrade: "websocket", "sec-websocket-protocol": `a2a-wake-v1, ${token}` } });
		assert.equal(upgrade.status, 101); ws = upgrade.webSocket! as unknown as WebSocket; (ws as any).accept();
		ws.addEventListener("message", e => { const m = JSON.parse(String(e.data)); if (m.type === "wake") { assert.equal(m.body, '{"kind":"test","marker":"rpc-draft"}'); assert.equal(m.headers.authorization, "Bearer dummy-resolved"); ws!.send(JSON.stringify({ v: 1, type: "result", id: m.id, generation: m.generation, status: receiverStatus })); } });
		const draft = { transport: "relay", connectorId: "default", generation: issued.body.generation, credentialsMode: "resolved", preset: "generic", key: "dummy-resolved", bodyTemplate: '{"kind":"{{kind}}","marker":"rpc-draft"}' };
		assert.equal((await owner(draft, "../invalid")).status, 400);
		for (const body of [{ transport: "relay", generation: draft.generation }, { ...draft, url: "https://example.com" }, { ...draft, credentialsMode: "saved" }]) assert.equal((await owner(body)).status, 400);
		const result = await owner(draft); assert.equal(result.status, 200); assert.equal(result.body.status, 202); assert.equal(result.body.transport, "relay"); assert.equal("error" in result.body, false);
		for (const status of [401, 500]) {
			receiverStatus = status;
			const failed = await owner(draft); assert.equal(failed.status, 200); assert.equal(failed.body.status, status); assert.equal(failed.body.error, "local_http");
		}
		receiverStatus = 0;
		assert.equal((await owner(draft)).body.error, "uncertain");
		ws.close(); await until(async () => !(await stub.owner({ accountId: "acct_draft", method: "GET", path: "/owner/wake/relay" })).body.connected);
		const offline = await owner(draft); assert.equal(offline.body.error, "offline"); assert.equal(offline.body.status, null); assert.equal(offline.body.configured, true); assert.ok(offline.body.connector);
		const reconnect = await r.mf.dispatchFetch("https://draft.agents.example.com/relay/connect", { headers: { upgrade: "websocket", "sec-websocket-protocol": `a2a-wake-v1, ${token}` } });
		ws = reconnect.webSocket! as unknown as WebSocket; (ws as any).accept();
		const timed = await owner(draft); assert.equal(timed.body.error, "timeout"); assert.equal(timed.body.status, null);
		assert.equal((await owner()).body.configured, false, "no-body probe still tests applied settings, not the last draft");
		const rotated = await stub.owner({ accountId: "acct_draft", method: "POST", path: "/owner/wake/relay", body: { credentialHash: createHash("sha256").update("different").digest("hex"), idempotencyKey: randomBytes(24).toString("base64url"), configVersion: 1 } });
		assert.equal(rotated.status, 200); const stale = await owner(draft); assert.equal(stale.status, 409); assert.equal(stale.body.error, "stale_enrollment");
		const revoked = await stub.owner({ accountId: "acct_draft", method: "DELETE", path: "/owner/wake/relay", body: { generation: rotated.body.generation } });
		assert.equal(revoked.status, 200); assert.equal((await owner(draft)).body.error, "revoked");
		// Internal final dispatch fences a rotation even when the caller already rendered with the old epoch.
		const relay = await r.mf.getDurableObjectNamespace("WAKE_RELAY");
		const final = await relay.get(relay.idFromName("wake-relay-v1:host:id-draft")).fetch("https://relay.internal/deliver", { method: "POST", body: JSON.stringify({ body: "{}", headers: {}, enrollment: draft.generation }) });
		assert.equal(final.status, 409); assert.equal((await final.json() as any).error, "stale_enrollment");
	} finally { ws?.close(); await r.mf.dispose(); }
});


test("hosted failed post-disable transaction recovers on identical active config retry", { timeout: 30000 }, async () => {
	const r = await runtime(true);
	try {
		const ns = await r.mf.getDurableObjectNamespace("TENANT_DO"), stub = ns.get(ns.idFromName("id-tx")) as any;
		const config = { version: 1, tenantId: "id-transaction", name: "transaction", status: "active", approval: { allowedSubjects: ["acct_tx"] }, config: { WAKE_TRANSPORT: "relay" } };
		await stub.pushConfig(config);
		await (await r.mf.getKVNamespace("TENANT_DIRECTORY")).put("tenant:transaction", JSON.stringify({ id: "id-transaction", status: "active", region: "default", version: 1 }));
		const enrolled = await stub.owner({ accountId: "acct_tx", method: "POST", path: "/owner/wake/relay", body: { credentialHash: createHash("sha256").update("dummy-transaction").digest("hex"), idempotencyKey: randomBytes(24).toString("base64url"), configVersion: 1 } });
		assert.equal(enrolled.status, 200);
		const status = async () => (await stub.owner({ accountId: "acct_tx", method: "GET", path: "/owner/wake/relay" })).body;
		assert.equal((await status()).enabled, true);
		await stub.failConfigWrite(true);
		assert.match((await stub.checkedPush({ ...config, version: 2, status: "suspended" })).error, /tenant config transaction failed/);
		assert.equal((await stub.storageStatus()).version, 1);
		assert.equal((await status()).enabled, false, "remote disable precedes the rejected transaction");
		await stub.failConfigWrite(false);
		assert.equal((await stub.pushConfig(config)).applied, false);
		assert.equal((await status()).enabled, true); assert.equal((await status()).enrolled, false);
	} finally { await r.mf.dispose(); }
});

for (const loss of ["binding", "binding-and-flag"]) test(`hosted lifecycle fails closed after ${loss} loss, including unsaved webhook draft enrollment`, { timeout: 120000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "relay-binding-loss-")); let r = await runtime(true, dir);
	const config = { version: 1, tenantId: "id-loss", name: "loss", status: "active", ownerTokenHash: createHash("sha256").update("dummy-owner").digest("hex"), approval: { allowedSubjects: ["acct_loss"] }, config: { WAKE_TRANSPORT: "webhook" } };
	const token = "a2ar_" + randomBytes(32).toString("base64url");
	const getStub = async () => { const ns = await r.mf.getDurableObjectNamespace("TENANT_DO"); return ns.get(ns.idFromName("id-loss")) as any; };
	try {
		let stub = await getStub(); await stub.pushConfig(config);
		await (await r.mf.getKVNamespace("TENANT_DIRECTORY")).put("tenant:loss", JSON.stringify({ id: "id-loss", status: "active", region: "default", version: 1 }));
		const enrolled = await stub.owner({ accountId: "acct_loss", method: "POST", path: "/owner/wake/relay", body: { credentialHash: createHash("sha256").update(token).digest("hex"), idempotencyKey: randomBytes(24).toString("base64url"), configVersion: 1 } });
		assert.equal(enrolled.status, 200); const enrolledGeneration = enrolled.body.generation;
		await r.mf.dispose(); r = await runtime(true, dir, loss === "binding-and-flag" ? { WAKE_RELAY_ENABLED: "0" } : {}, false); stub = await getStub();
		for (const status of ["suspended", "deleted"]) {
			assert.match((await stub.checkedPush({ ...config, version: 2, status })).error, /relay lifecycle fence unavailable/);
			assert.equal((await stub.storageStatus()).version, 1);
		}
		assert.match((await stub.checkedDelete()).error, /relay lifecycle fence unavailable/);
		assert.equal((await stub.storageStatus()).version, 1);
		await r.mf.dispose(); r = await runtime(true, dir); stub = await getStub();
		// Failed writes did not pretend to suspend/delete; retry the fence before acceptance.
		const before = await stub.owner({ accountId: "acct_loss", method: "GET", path: "/owner/wake/relay" });
		assert.equal(before.body.generation, enrolledGeneration); assert.equal(before.body.enrolled, true);
		await stub.pushConfig({ ...config, version: 2, status: "suspended" });
		await r.mf.dispose(); r = await runtime(true, dir, { WAKE_RELAY_ENABLED: "0" }, false); stub = await getStub();
		assert.match((await stub.checkedPush({ ...config, version: 3 })).error, /relay lifecycle fence unavailable/);
		assert.equal((await stub.storageStatus()).version, 2);
		await r.mf.dispose(); r = await runtime(true, dir); stub = await getStub();
		await stub.pushConfig({ ...config, version: 3 });
		const refused = await r.mf.dispatchFetch("https://loss.agents.example.com/relay/connect", { headers: { upgrade: "websocket", "sec-websocket-protocol": `a2a-wake-v1, ${token}` } });
		assert.equal(refused.status, 401, "fresh activation cannot revive a prior generation");
		const after = await stub.owner({ accountId: "acct_loss", method: "GET", path: "/owner/wake/relay" });
		assert.equal(after.body.enrolled, false); assert.ok(after.body.generation > enrolledGeneration);
	} finally { await r.mf.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test("unrelated webhook tenants never enabled for relay retain normal lifecycle without a binding", { timeout: 30000 }, async () => {
	const r = await runtime(true, "", { WAKE_RELAY_ENABLED: "0" }, false);
	try {
		const ns = await r.mf.getDurableObjectNamespace("TENANT_DO"), stub = ns.get(ns.idFromName("id-unrelated")) as any;
		const config = { version: 1, tenantId: "id-unrelated", name: "unrelated", status: "active", config: { WAKE_TRANSPORT: "webhook" } };
		await stub.pushConfig(config); await stub.pushConfig({ ...config, version: 2, status: "suspended" });
		assert.equal((await stub.storageStatus()).version, 2);
		await stub.pushConfig({ ...config, version: 3 }); assert.equal((await stub.storageStatus()).version, 3);
		await stub.deleteStorage(); assert.equal((await stub.storageStatus()).configured, false);
	} finally { await r.mf.dispose(); }
});

test("workerd restart recovers hashed enrollment and durable pending inbox; revoked token remains refused", { timeout: 120000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "relay-runtime-reset-")); let r = await runtime(false, dir); let ws: WebSocket | undefined;
	try {
		const issued = await r.enroll();
		const peer = await (await r.call("/owner/peers", "POST", "dummy-owner", { label: "ada" })).json() as any;
		await r.call("/a2a", "POST", peer.token, { jsonrpc: "2.0", id: "offline", method: "message/send", params: { message: { kind: "message", role: "user", messageId: "durable-message", parts: [{ kind: "text", text: "durable pending work" }] } } });
		await r.mf.dispose(); r = await runtime(false, dir);
		const connected = await socket(r.url, issued.token); ws = connected.ws;
		await until(() => connected.messages.some(m => m.type === "wake"));
		const wake = connected.messages.find(m => m.type === "wake"); assert.equal(JSON.parse(wake.body).kind, "catchup");
		ws.send(JSON.stringify({ v: 1, type: "result", id: wake.id, generation: wake.generation, status: 202 }));
		assert.ok(JSON.stringify(await (await r.call("/owner/inbox")).json()).includes("durable pending work"));
		await r.call("/owner/wake/relay", "DELETE", "dummy-owner", { generation: issued.generation }); ws.close();
		await r.mf.dispose(); r = await runtime(false, dir);
		const refused = await r.mf.dispatchFetch("https://agent.example.com/relay/connect", { headers: { upgrade: "websocket", "sec-websocket-protocol": `a2a-wake-v1, ${issued.token}` } }); assert.equal(refused.status, 401);
	} finally { ws?.close(); await r.mf.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
