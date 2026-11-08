import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function until(check: () => boolean | Promise<boolean>, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error("condition not reached"); }

async function runtime(hosted = false, persistence = "", enabled = true, bound = true) {
	const built = await build({ ...(hosted ? { stdin: { contents: `import { TenantStore as Base } from "./src/hosted.ts";
export { default, HttpRelay } from "./src/hosted.ts";
export class TenantStore extends Base {
 async checkedPush(body) { try { return { value: await this.pushConfig(body) }; } catch { return { error: 'fence failed' }; } }
 async checkedDelete() { try { return { value: await this.deleteStorage() }; } catch { return { error: 'fence failed' }; } }
 async failConfigWrite(on) { this.ctx.storage.sql.exec(on ? "CREATE TRIGGER fail_http_config BEFORE UPDATE ON tenant_config BEGIN SELECT RAISE(ABORT, 'injected'); END" : "DROP TRIGGER fail_http_config"); }
}`, resolveDir: process.cwd(), loader: "ts" as const } } : { entryPoints: ["src/relay-entry.ts"] }), bundle: true, write: false, format: "esm", platform: "neutral", external: ["cloudflare:*"], plugins: [{ name: "sql", setup(b) {
		b.onResolve({ filter: /\.sql\?raw$/ }, a => ({ path: new URL(a.path.replace("?raw", ""), `file://${a.resolveDir}/`).pathname, namespace: "sql" }));
		b.onLoad({ filter: /.*/, namespace: "sql" }, a => ({ contents: `export default ${JSON.stringify(readFileSync(a.path, "utf8"))}`, loader: "js" }));
	} }] });
	const mf = new Miniflare(convertV4MiniflareOptions({ name: "http-relay-integration", ...(persistence ? { resourcePersistencePath: persistence, isolatedResourcePersistencePath: persistence } : {}), modules: true, script: built.outputFiles[0].text, compatibilityDate: "2026-10-06", compatibilityFlags: ["enable_request_signal"], d1Databases: ["DB"], ...(hosted ? { kvNamespaces: ["TENANT_DIRECTORY"] } : {}), durableObjects: { ...(hosted ? { TENANT_DO: { className: "TenantStore", useSQLite: true } } : {}), ...(bound ? { HTTP_RELAY: { className: "HttpRelay", useSQLite: true } } : {}) }, bindings: { ...(hosted ? { TENANCY: "host", TENANT_DOMAIN: "agents.example.com", TENANT_SECRETS_KEY: "dummy-platform" } : {}), OWNER_TOKEN: "dummy-owner", PUBLIC_URL: "https://agent.example.com", HTTP_RELAY_ENABLED: enabled ? "1" : "0", MCP: "off" } }));
	const db = await mf.getD1Database("DB");
	if (!await db.prepare("SELECT name FROM sqlite_master WHERE name = 'tasks'").first()) for (const file of readdirSync("migrations").filter(n => n.endsWith(".sql")).sort()) await db.exec(readFileSync(`migrations/${file}`, "utf8").replace(/--[^\n]*/g, "").replace(/\n/g, " "));
	const url = await mf.ready;
	const call = (path: string, method = "GET", body?: unknown) => fetch(new URL(path, url), { method, headers: { authorization: "Bearer dummy-owner" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	return { mf, url, call };
}
const cli = resolve("../cli/bin/a2a-exposed.mjs");
function cleanEnv(dir: string, url: URL) {
	return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(A2A_|WAKE_|CF_|CLOUDFLARE_|PEER_|UPSTREAM_|APPROVAL_|EVENT_|FEEDBACK_|CONTROL_|HOSTED_|NODE_OPTIONS$)/.test(key))), A2A_CONFIG_DIR: dir, A2A_BASE_URL: url.origin, A2A_OWNER_TOKEN: "dummy-owner", DO_NOT_TRACK: "1" };
}

test("production Worker routes with native CLI create/run/revoke preserve binary, app bearer/HMAC, native RPC and SSE", { timeout: 60000 }, async t => {
	const r = await runtime(); const dir = mkdtempSync(join(tmpdir(), "http-relay-cli-integration-")); const env = cleanEnv(dir, r.url);
	const received: { url: string | undefined; body: Buffer; headers: Record<string, unknown> }[] = []; let streamAborted = false;
	const local = createServer(async (req, res) => {
		const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk); const body = Buffer.concat(chunks);
		received.push({ url: req.url, body, headers: req.headers });
		if (req.headers.authorization !== "Bearer dummy-local-application") { res.writeHead(401, { "content-type": "text/plain" }).end("local authorization required"); return; }
		if (req.url === "/card") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ name: "native localhost", description: "http://127.0.0.1/private", version: "1", protocolVersion: "0.3.0", url: `http://127.0.0.1:${(local.address() as any).port}/rpc`, preferredTransport: "JSONRPC", securitySchemes: { app: { type: "http", scheme: "bearer" } }, security: [{ app: [] }], capabilities: { streaming: true }, skills: [] })); return; }
		if (req.url === "/rpc") {
			if (!body.length) { res.writeHead(400).end("empty RPC"); return; }
			const rpc = JSON.parse(body.toString());
			if (rpc.method === "message/stream") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write('data: {"first":true}\n\n'); const timer = setTimeout(() => { res.end('data: {"second":true}\n\n'); }, 1000); res.on("close", () => { if (!res.writableEnded) streamAborted = true; clearTimeout(timer); }); return; }
			res.writeHead(200, { "content-type": "application/json" }).end(`{ "jsonrpc":"2.0", "id":${JSON.stringify(rpc.id)}, "error": {"code":-32001,"message":"local task denied"} }`); return;
		}
		if (req.headers["x-signature"] !== createHmac("sha256", "dummy-hmac").update(body).digest("hex")) { res.writeHead(403).end("signature mismatch"); return; }
		res.writeHead(422, { "content-type": "application/octet-stream", "set-cookie": "not-forwarded=yes", location: "http://127.0.0.1/private" }).end(body);
	}); local.listen(0, "127.0.0.1"); await once(local, "listening");
	const port = (local.address() as any).port; const children: ReturnType<typeof spawn>[] = [];
	const runCli = (args: string[]) => execute(process.execPath, [cli, ...args], { env, cwd: dir, timeout: 10000 });
	try {
		assert.equal((await r.call("/owner/relay/http/webhook")).status, 200);
		assert.equal((await fetch(new URL("/owner/relay/http/webhook", r.url))).status, 401);
		assert.equal((await r.call("/owner/relay/http/webhook", "POST", { credentialHash: "a".repeat(64), ingressHash: "b".repeat(64), headers: ["x-a2a-relay-authorization"] })).status, 400);
		for (const [kind, profile, path] of [["http", "webhook", "/fixed"], ["a2a", "a2a", "/rpc"]]) {
			const tokenFile = join(dir, `${kind}.token`), ingressFile = join(dir, `${kind}.ingress`);
			const created = await runCli(["relay", kind, "create", "--token-file", tokenFile, "--ingress-token-file", ingressFile, "--forward-headers", "content-type,accept,authorization,x-signature"]);
			assert.equal(JSON.parse(created.stdout).profile, profile); assert.equal(statSync(tokenFile).mode & 0o777, 0o600); assert.equal(statSync(ingressFile).mode & 0o777, 0o600);
			const child = spawn(process.execPath, [cli, "relay", kind, "run", "--url", new URL(`/relay/http/${profile}/connect`, r.url).href.replace("http:", "ws:"), "--token-file", tokenFile, "--local-url", `http://127.0.0.1:${port}${path}`, ...(profile === "a2a" ? ["--card-url", `http://127.0.0.1:${port}/card`] : [])], { env, cwd: dir, stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
			let diagnostics = ""; child.stderr!.on("data", chunk => { diagnostics += chunk; });
			await until(async () => { if (child.exitCode !== null) throw new Error(`connector exited ${child.exitCode}: ${diagnostics}`); return (await (await r.call(`/owner/relay/http/${profile}`)).json() as any).connected; });
		}
		const token = readFileSync(join(dir, "http.ingress"), "utf8").trim(); const nativeToken = readFileSync(join(dir, "a2a.ingress"), "utf8").trim();
		const publicCall = (path: string, body?: BodyInit, ingress = token, app = true, signal?: AbortSignal) => fetch(new URL(path, r.url), { method: body === undefined ? "GET" : "POST", headers: { "x-a2a-relay-authorization": `Bearer ${ingress}`, ...(app ? { authorization: "Bearer dummy-local-application" } : {}), ...(body !== undefined ? { "x-signature": createHmac("sha256", "dummy-hmac").update(body as Uint8Array).digest("hex") } : {}) }, body, signal });
		for (const body of [Buffer.from('{ "unmodified": 42 }\n'), Buffer.from([0, 255, 128, 13, 10, 0])]) {
			const res = await publicCall("/relay/webhook", body); assert.equal(res.status, 422); assert.equal(res.headers.get("set-cookie"), null); assert.equal(res.headers.get("location"), null); assert.deepEqual(Buffer.from(await res.arrayBuffer()), body); assert.deepEqual(received.at(-1)!.body, body); assert.equal(received.at(-1)!.headers["x-a2a-relay-authorization"], undefined);
		}
		assert.equal((await publicCall("/relay/webhook", Buffer.from("{}"), nativeToken)).status, 401);
		assert.equal((await publicCall("/relay/webhook", Buffer.from("{}"), token, false)).status, 401, "local application, not relay ingress, authorizes the caller");
		assert.equal((await publicCall("/relay/webhook?target=card", Buffer.from("{}"))).status, 400);
		const card = await (await publicCall("/relay/a2a/.well-known/agent-card.json", undefined, nativeToken)).json() as any;
		assert.equal(card.capabilities.streaming, true); assert.equal(card.capabilities.pushNotifications, false); assert.ok(!JSON.stringify(card).includes("127.0.0.1"));
		assert.deepEqual(card.securityRequirements, [{ schemes: { app: { list: [] }, relayIngress: { list: [] } } }]); assert.equal(card.supportedInterfaces[0].url, "https://agent.example.com/relay/a2a/");
		assert.equal((await fetch(new URL("/relay/a2a/.well-known/agent-card.json", r.url))).status, 401);
		const alias = await (await publicCall("/relay/a2a/.well-known/agent.json", undefined, nativeToken)).json() as any; assert.equal(alias.protocolVersion, "0.3.0"); assert.equal(alias.supportedInterfaces, undefined);
		const raw = Buffer.from('{ "jsonrpc":"2.0", "id":"original-id", "method":"tasks/get", "params":{"id":"foreign-task"} }');
		const rpc = await publicCall("/relay/a2a", raw, nativeToken); const reply = await rpc.text(); assert.equal(reply, '{ "jsonrpc":"2.0", "id":"original-id", "error": {"code":-32001,"message":"local task denied"} }'); assert.deepEqual(received.at(-1)!.body, raw);
		const firstAt = Date.now(); const stream = await publicCall("/relay/a2a/", Buffer.from('{"jsonrpc":"2.0","id":1,"method":"message/stream","params":{}}'), nativeToken); assert.equal(stream.headers.get("content-type"), "text/event-stream");
		const reader = stream.body!.getReader(); const readEvent = async () => { for (;;) { const part = await reader.read(); if (part.done || new TextDecoder().decode(part.value).includes("data:")) return part; assert.equal(new TextDecoder().decode(part.value), ": relay keepalive\n\n"); } }; const first = await readEvent(); assert.match(new TextDecoder().decode(first.value), /first/); assert.ok(Date.now() - firstAt < 800); const second = await readEvent(); assert.match(new TextDecoder().decode(second.value), /second/); assert.equal((await reader.read()).done, true);
		await t.test("native client abort must terminate the local stream before normal end", async () => {
		const abort = new AbortController(); const aborted = await publicCall("/relay/a2a/", Buffer.from('{"jsonrpc":"2.0","id":2,"method":"message/stream","params":{}}'), nativeToken, true, abort.signal); const abortReader = aborted.body!.getReader(); await abortReader.read(); abort.abort(); await abortReader.cancel().catch(() => {}); await until(() => streamAborted);
		});
		await t.test("native push policy must reject before any local dispatch", async () => {
		const before = received.length;
		const blocked = await publicCall("/relay/a2a", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { configuration: { pushNotificationConfig: { url: "http://127.0.0.1/admin" } } } })), nativeToken); assert.ok(blocked.status >= 400); assert.equal(received.length, before);
		});
		for (const kind of ["http", "a2a"]) { const revoked = await runCli(["relay", kind, "revoke"]); assert.equal(JSON.parse(revoked.stdout).enabled, false); }
		assert.equal((await publicCall("/relay/webhook", Buffer.from("{}"))).status, 401);
	} finally {
		for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
		await Promise.all(children.map(async child => { if (child.exitCode === null) await once(child, "exit"); }));
		local.closeAllConnections(); await new Promise<void>(done => local.close(() => done())); await r.mf.dispose(); rmSync(dir, { recursive: true, force: true });
	}
});

test("hosted public HTTP ingress isolates tenants and profiles, rotates old tokens, and rejects owner/peer credentials", { timeout: 30000 }, async () => {
	const r = await runtime(true);
	const tokens = new Map<string, { connector: string; ingress: string }>();
	const sockets: any[] = [];
	try {
		const directory = await r.mf.getKVNamespace("TENANT_DIRECTORY"), ns = await r.mf.getDurableObjectNamespace("TENANT_DO");
		for (const name of ["first", "second"]) {
			await directory.put(`tenant:${name}`, JSON.stringify({ id: `id-${name}`, status: "active", region: "default", version: 1 }));
			const stub = ns.get(ns.idFromName(`id-${name}`)) as any;
			await stub.pushConfig({ version: 1, tenantId: `id-${name}`, name, status: "active", ownerTokenHash: hash("dummy-owner"), approval: { allowedSubjects: ["acct_http"] }, config: {} });
			for (const profile of ["webhook", "a2a"]) {
				const connector = "a2ah_" + randomBytes(32).toString("base64url"), ingress = "a2ai_" + randomBytes(32).toString("base64url"); tokens.set(`${name}:${profile}`, { connector, ingress });
				assert.equal((await stub.owner({ accountId: "acct_http", method: "POST", path: `/owner/relay/http/${profile}`, body: { credentialHash: hash(connector), ingressHash: hash(ingress), headers: ["authorization", "content-type"] } })).status, 200);
			}
		}
		const post = (name: string, profile: string, token: string) => r.mf.dispatchFetch(`https://${name}.agents.example.com/relay/${profile === "webhook" ? "webhook" : "a2a"}`, { method: "POST", headers: { "x-a2a-relay-authorization": `Bearer ${token}` }, body: "{}" });
		for (const [key, token] of tokens) {
			const [name, profile] = key.split(":"); assert.equal((await post(name, profile, token.ingress)).status, 503);
			assert.equal((await post(name === "first" ? "second" : "first", profile, token.ingress)).status, 401);
			assert.equal((await post(name, profile === "webhook" ? "a2a" : "webhook", token.ingress)).status, 401);
			for (const other of [token.connector, "dummy-owner", "a2ar_" + "x".repeat(43), "a2a_peer"]) assert.equal((await post(name, profile, other)).status, 401);
		}
		const old = tokens.get("first:webhook")!, stub = ns.get(ns.idFromName("id-first")) as any;
		const generation = (await stub.owner({ accountId: "acct_http", method: "GET", path: "/owner/relay/http/webhook" })).body.generation;
		const rotated = await stub.owner({ accountId: "acct_http", method: "POST", path: "/owner/relay/http/webhook", body: { credentialHash: hash("new-connector"), ingressHash: hash("new-ingress"), headers: ["authorization"] } }); assert.equal(rotated.status, 200);
		assert.ok(rotated.body.generation > generation); assert.equal((await post("first", "webhook", old.ingress)).status, 401);
		const rejected = await r.mf.dispatchFetch("https://first.agents.example.com/relay/http/webhook/connect", { headers: { upgrade: "websocket", "sec-websocket-protocol": `a2a-http-relay-v2, ${old.connector}` } }); assert.equal(rejected.status, 401);
		for (const path of ["/owner//relay/http/a2a", "/owner/relay/http/a2a/"]) assert.equal((await r.mf.dispatchFetch(`https://first.agents.example.com${path}`, { method: "POST", headers: { authorization: "Bearer dummy-owner" }, body: JSON.stringify({ credentialHash: "a".repeat(64), ingressHash: "b".repeat(64), headers: [] }) })).status, 404);
	} finally { for (const socket of sockets) socket.close(); await r.mf.dispose(); }
});

for (const loss of ["flag", "binding-and-flag"]) test(`hosted lifecycle fences both HTTP profiles after ${loss} loss and never resurrects old authority`, { timeout: 90000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "http-relay-lifecycle-")); let r = await runtime(true, dir);
	const config = { version: 1, tenantId: "id-http-life", name: "life", status: "active", ownerTokenHash: hash("dummy-owner"), approval: { allowedSubjects: ["acct_http"] }, config: {} };
	const getStub = async () => { const ns = await r.mf.getDurableObjectNamespace("TENANT_DO"); return ns.get(ns.idFromName(config.tenantId)) as any; };
	const bodies = Object.fromEntries(["webhook", "a2a"].map(profile => [profile, { credentialHash: hash("a2ah_" + randomBytes(32).toString("base64url")), ingressHash: hash("a2ai_" + randomBytes(32).toString("base64url")), headers: ["authorization", "content-type"] }]));
	try {
		let stub = await getStub(); await stub.pushConfig(config);
		await (await r.mf.getKVNamespace("TENANT_DIRECTORY")).put("tenant:life", JSON.stringify({ id: config.tenantId, status: "active", region: "default", version: 1 }));
		for (const profile of ["webhook", "a2a"]) assert.equal((await stub.owner({ accountId: "acct_http", method: "POST", path: `/owner/relay/http/${profile}`, body: bodies[profile] })).status, 200);
		await r.mf.dispose(); r = await runtime(true, dir, false, loss === "flag"); stub = await getStub();
		if (loss === "binding-and-flag") { assert.equal((await stub.checkedPush({ ...config, version: 2, status: "suspended" })).error, "fence failed"); assert.equal((await stub.checkedDelete()).error, "fence failed"); assert.equal((await stub.storageStatus()).version, 1); await r.mf.dispose(); r = await runtime(true, dir, false, true); stub = await getStub(); }
		await stub.pushConfig({ ...config, version: 2, status: "suspended" });
		await r.mf.dispose(); r = await runtime(true, dir, true, true); stub = await getStub();
		await stub.pushConfig({ ...config, version: 3 });
		for (const profile of ["webhook", "a2a"]) { const status = await stub.owner({ accountId: "acct_http", method: "GET", path: `/owner/relay/http/${profile}` }); assert.equal(status.body.enabled, false); assert.equal(status.body.enrolled, false); }
		// A rolled-back suspension leaves a pending fence; identical-active retry cannot skip it.
		for (const profile of ["webhook", "a2a"]) await stub.owner({ accountId: "acct_http", method: "POST", path: `/owner/relay/http/${profile}`, body: bodies[profile] });
		await stub.failConfigWrite(true); assert.equal((await stub.checkedPush({ ...config, version: 4, status: "suspended" })).error, "fence failed"); assert.equal((await stub.storageStatus()).version, 3); await stub.failConfigWrite(false);
		assert.equal((await stub.pushConfig({ ...config, version: 3 })).applied, false);
		for (const profile of ["webhook", "a2a"]) { const status = await stub.owner({ accountId: "acct_http", method: "GET", path: `/owner/relay/http/${profile}` }); assert.equal(status.body.enabled, false); }
		for (const profile of ["webhook", "a2a"]) await stub.owner({ accountId: "acct_http", method: "POST", path: `/owner/relay/http/${profile}`, body: bodies[profile] });
		await stub.deleteStorage(); assert.equal((await stub.pushConfig({ ...config, version: 99 })).applied, false);
		const ns = await r.mf.getDurableObjectNamespace("HTTP_RELAY");
		for (const profile of ["webhook", "a2a"]) { const status = await (await ns.get(ns.idFromName(`http-relay-v2:host:${config.tenantId}:${profile}`)).fetch("https://http-relay.internal/status")).json() as any; assert.equal(status.enabled, false); assert.equal(status.enrolled, false); }
	} finally { await r.mf.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
