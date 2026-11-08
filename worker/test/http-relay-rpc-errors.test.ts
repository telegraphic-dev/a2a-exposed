import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { httpRelayRpcAllowed, httpRelayRpcAdmission } from "../src/http-relay-routing.ts";
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => unknown) { const end = Date.now() + 5000; while (!await check()) { assert.ok(Date.now() < end, "condition timed out"); await delay(10); } }
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function runtime() {
	const root = resolve(process.env.HTTP_RELAY_WORKER_ROOT || ".");
	const built = await build({ absWorkingDir: root, entryPoints: ["src/relay-entry.ts"], bundle: true, write: false, format: "esm", platform: "neutral", external: ["cloudflare:*"], plugins: [{ name: "sql", setup(b) {
		b.onResolve({ filter: /\.sql\?raw$/ }, a => ({ path: new URL(a.path.replace("?raw", ""), `file://${a.resolveDir}/`).pathname, namespace: "sql" }));
		b.onLoad({ filter: /.*/, namespace: "sql" }, a => ({ contents: `export default ${JSON.stringify(readFileSync(a.path, "utf8"))}`, loader: "js" }));
	} }] });
	const publicOrigin = "https://agent.example.com";
	const mf = new Miniflare(convertV4MiniflareOptions({ name: "http-relay-sdk", modules: true, script: built.outputFiles[0].text, compatibilityDate: "2026-10-06", compatibilityFlags: ["enable_request_signal"], d1Databases: ["DB"], durableObjects: { HTTP_RELAY: { className: "HttpRelay", useSQLite: true } }, bindings: { OWNER_TOKEN: "fixture-owner", PUBLIC_URL: publicOrigin, HTTP_RELAY_ENABLED: "1", MCP: "off" } }));
	const db = await mf.getD1Database("DB");
	for (const file of readdirSync(join(root, "migrations")).filter(n => n.endsWith(".sql")).sort()) await db.exec(readFileSync(join(root, "migrations", file), "utf8").replace(/--[^\n]*/g, "").replace(/\n/g, " "));
	const url = await mf.ready;
	return { mf, url };
}

test("native RPC admission returns safe distinct JSON-RPC errors and sends zero rejected connector frames", { timeout: 30000 }, async () => {
	const r = await runtime(); let ws: WebSocket | undefined;
	const token = "a2ah_" + "a".repeat(43), ingress = "a2ai_" + "b".repeat(43);
	const messages: any[] = [];
	try {
		const enrolled = await fetch(new URL("/owner/relay/http/a2a", r.url), { method: "POST", headers: { authorization: "Bearer fixture-owner" }, body: JSON.stringify({ credentialHash: hash(token), ingressHash: hash(ingress), headers: [] }) });
		assert.equal(enrolled.status, 200);
		ws = new WebSocket(new URL("/relay/http/a2a/connect", r.url).href.replace("http:", "ws:"), ["a2a-http-relay-v2", token]);
		ws.addEventListener("message", e => messages.push(JSON.parse(String(e.data))));
		await once(ws, "open"); await until(() => messages.length);
		ws.send(JSON.stringify({ ...messages[0], type: "ready" }));
		await until(async () => (await (await fetch(new URL("/owner/relay/http/a2a", r.url), { headers: { authorization: "Bearer fixture-owner" } })).json() as any).connected);
		const call = (body: string | Uint8Array, credential = ingress) => fetch(new URL("/relay/a2a/", r.url), { method: "POST", headers: { "x-a2a-relay-authorization": `Bearer ${credential}` }, body });
		const secret = "dummy-private-params-not-for-errors";
		const cases: [unknown, number, string, unknown, string][] = [
			["{", -32700, "parse_error", null, "Parse error"],
			[new Uint8Array([255]), -32700, "parse_error", null, "Parse error"],
			[[], -32600, "invalid_request", null, "Invalid Request"],
			[{ jsonrpc: "2.0", id: {}, method: "SendMessage" }, -32600, "invalid_request", null, "Invalid Request"],
			[{ jsonrpc: "1.0", id: 7, method: "SendMessage" }, -32600, "invalid_request", null, "Invalid Request"],
			[{ jsonrpc: "2.0", id: 0, method: secret, params: { secret } }, -32601, "method_not_found", 0, "Method not found"],
			[{ jsonrpc: "2.0", id: "original", method: "CreateTaskPushNotificationConfig", params: { secret } }, -32601, "method_not_found", "original", "Method not found"],
			[{ jsonrpc: "2.0", id: 9, method: "SendMessage", params: 42 }, -32602, "invalid_params", 9, "Invalid params"],
		];
		for (const method of ["SendMessage", "message/send", "SendStreamingMessage", "message/stream"]) cases.push([{ jsonrpc: "2.0", id: "push-id", method, params: { configuration: { pushNotificationConfig: { url: "https://example.com/" + secret } } } }, -32003, "push_not_supported", "push-id", "Push notifications not supported"]);
		const before = messages.length;
		for (const [value, code, reason, id, message] of cases) {
			const body = typeof value === "string" || value instanceof Uint8Array ? value : JSON.stringify(value);
			assert.equal(httpRelayRpcAllowed(typeof body === "string" ? new TextEncoder().encode(body) : body), false);
			const response = await call(body);
			assert.equal(response.status, 400); assert.equal(response.headers.get("cache-control"), "no-store");
			assert.deepEqual(await response.json(), { jsonrpc: "2.0", id, error: { code, message, data: { code: reason } } });
		}
		assert.equal((await call("{", "a2ai_" + "c".repeat(43))).status, 401, "authentication precedes parse diagnostics");
		assert.equal((await call("x".repeat(262145))).status, 413, "body cap precedes parsing");
		await delay(100); assert.equal(messages.length, before, "rejections must emit no request, credit or cancellation frames");
		for (const id of [null, 0, "original"]) assert.deepEqual(httpRelayRpcAdmission(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", method: "GetTask", id, params: {} }))), { ok: true, id });
	} finally { ws?.close(); await r.mf.dispose(); }
});
