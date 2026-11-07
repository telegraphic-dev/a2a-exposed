import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes, createHash } from "node:crypto";
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
async function runtime(hosted = false, persistence = "") {
	const built = await build({ entryPoints: [hosted ? "src/hosted.ts" : "src/relay-entry.ts"], bundle: true, write: false, format: "esm", platform: "neutral", external: ["cloudflare:*"], plugins: [{ name: "sql", setup(b) {
		b.onResolve({ filter: /\.sql\?raw$/ }, a => ({ path: new URL(a.path.replace("?raw", ""), `file://${a.resolveDir}/`).pathname, namespace: "sql" }));
		b.onLoad({ filter: /.*/, namespace: "sql" }, a => ({ contents: `export default ${JSON.stringify(readFileSync(a.path, "utf8"))}`, loader: "js" }));
	} }] });
	const mf = new Miniflare(convertV4MiniflareOptions({ name: "relay-test", ...(persistence ? { resourcePersistencePath: persistence, isolatedResourcePersistencePath: persistence } : {}), modules: true, script: built.outputFiles[0].text, compatibilityDate: "2026-10-06", d1Databases: ["DB"], ...(hosted ? { kvNamespaces: ["TENANT_DIRECTORY"] } : {}), durableObjects: { ...(hosted ? { TENANT_DO: { className: "TenantStore", useSQLite: true } } : {}), WAKE_RELAY: { className: "WakeRelay", useSQLite: true } }, bindings: { ...(hosted ? { TENANCY: "host", TENANT_DOMAIN: "agents.example.com", TENANT_SECRETS_KEY: "dummy-platform" } : {}), OWNER_TOKEN: "dummy-owner", WAKE_RELAY_ENABLED: "1", WAKE_TRANSPORT: "relay", WAKE_PRESET: "generic", WAKE_WEBHOOK_KEY: "dummy-app-key", WAKE_DEBOUNCE_SECONDS: "0", WAKE_BUSY_SECONDS: "0", MCP: "off" } }));
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
	const server = createServer(async (req, res) => { let body = ""; for await (const chunk of req) body += chunk; received.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) }); res.writeHead(202).end(); });
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	try {
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
		await r.call("/owner/wake/relay", "DELETE", "dummy-owner", { generation: issued.generation });
		assert.equal((await (await r.call("/owner/wake/relay")).json() as any).connected, false);
		stop2.abort(); await connector; connector = null;
		assert.equal((await (await r.call("/owner/wake/test", "POST")).json() as any).status, null);
		const rotated = await r.enroll();
		assert.notEqual(rotated.token, issued.token);
	} finally { stop.abort(); stop2.abort(); if (connector) await connector; server.closeAllConnections(); await new Promise<void>(a => server.close(() => a())); await r.mf.dispose(); }
});


test("workerd rejects credentials, malformed/oversized frames, fences connected rotation and stale acks", { timeout: 30000 }, async () => {
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
		assert.equal((await (await r.call("/owner/wake/test", "POST")).json() as any).status, 403);
		mode = "disconnect";
		assert.equal((await (await r.call("/owner/wake/test", "POST")).json() as any).status, null);
		await new Promise(a => setTimeout(a, 100)); assert.equal(count, 2, "uncertain execution was not retried");
		mode = "timeout";
		const started = Date.now();
		const waiting = Array.from({ length: 4 }, () => r.call("/owner/wake/test", "POST"));
		await until(() => count === 6);
		const saturated = await (await r.call("/owner/wake/test", "POST")).json() as any;
		assert.equal(saturated.status, null); assert.ok(Date.now() - started < 5000, "bounded concurrency rejects instead of queuing");
		for (const response of await Promise.all(waiting)) assert.equal((await response.json() as any).status, null);
		assert.ok(Date.now() - started >= 9000); assert.equal(count, 6);
	} finally { stop.abort(); await connector; server.closeAllConnections(); await new Promise<void>(a => server.close(() => a())); await r.mf.dispose(); }
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


test("actual CLI create/status/run/revoke with workerd and a real local receiver", { timeout: 30000 }, async () => {
	const r = await runtime(); const dir = mkdtempSync(join(tmpdir(), "relay-cli-journey-")); let child;
	const file = join(dir, "credential"); let count = 0;
	const server = createServer(async (req, res) => { for await (const chunk of req) { void chunk; } count++; res.writeHead(204).end(); });
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const env = { ...process.env, DO_NOT_TRACK: "1", A2A_CONFIG_DIR: dir, A2A_BASE_URL: String(r.url).replace(/\/$/, ""), A2A_OWNER_TOKEN: "dummy-owner" };
	const bin = new URL("../../cli/bin/a2a-exposed.mjs", import.meta.url).pathname;
	const cli = (...args: string[]) => promisify(execFile)(process.execPath, [bin, "relay", ...args], { env });
	try {
		const created = await cli("create", "--token-file", file); assert.equal(JSON.parse(created.stdout).enrolled, true); assert.equal(created.stdout.includes("a2ar_"), false); assert.equal(statSync(file).mode & 0o077, 0);
		const status = JSON.parse((await cli("status", "--json")).stdout); assert.equal(status.protocolVersion, 1);
		child = spawn(process.execPath, [bin, "relay", "run", "--token-file", file, "--local-url", `http://127.0.0.1:${(server.address() as any).port}/fixed`], { env, stdio: "pipe" });
		await until(async () => (await (await r.call("/owner/wake/relay")).json() as any).connected);
		assert.equal((await (await r.call("/owner/wake/test", "POST")).json() as any).status, 204); assert.equal(count, 1);
		const exited = once(child, "exit"); child.kill("SIGTERM"); assert.equal((await exited)[0], 0); child = undefined;
		assert.equal(JSON.parse((await cli("revoke")).stdout).revoked, true);
		assert.equal(JSON.parse((await cli("status")).stdout).connected, false);
	} finally { child?.kill("SIGTERM"); server.closeAllConnections(); await new Promise<void>(a => server.close(() => a())); await r.mf.dispose(); rmSync(dir, { recursive: true, force: true }); }
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
