import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { runConnector } from "../../cli/lib/relay.mjs";
import { runHttpConnector } from "../../cli/lib/http-relay.mjs";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
// The shipped wake-v1 modules are unchanged from the pre-HTTP-relay base.
// This matrix exercises those real implementations, not downloaded old packages
// or a pretend server that merely emits a desired rejection/hello frame.
for (const oldClient of [true, false]) test(`${oldClient ? "wake-v1 native connector -> HTTP-v2 Worker" : "HTTP-v2 native connector -> wake-v1 Worker"} refuses incompatible wire protocol without local dispatch`, { timeout: 20000 }, async t => {
	const className = oldClient ? "HttpRelay" : "WakeRelay";
	const built = await build({ stdin: { contents: `export { ${className} } from './src/${oldClient ? "http-relay" : "relay"}.ts'; export default { fetch(req,env) { const u=new URL(req.url); if(u.pathname.endsWith('/connect'))u.pathname='/connect'; return env.RELAY.get(env.RELAY.idFromName('compatibility')).fetch(new Request(u,req)); } };`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "neutral", external: ["cloudflare:*"] });
	const mf = new Miniflare(convertV4MiniflareOptions({ name: "http-compatibility", modules: true, script: built.outputFiles[0].text, compatibilityDate: "2026-10-06", durableObjects: { RELAY: { className, useSQLite: true } } }));
	const url = await mf.ready;
	let posts = 0, ready = 0; const diagnostics: string[] = [];
	const receiver = createServer((req, res) => { posts++; req.resume(); res.end(); }); receiver.listen(0, "127.0.0.1"); await once(receiver, "listening");
	const stop = new AbortController();
	try {
		const wakeToken = "a2ar_" + randomBytes(32).toString("base64url"), httpToken = "a2ah_" + randomBytes(32).toString("base64url"), ingress = "a2ai_" + randomBytes(32).toString("base64url");
		const enrolled = await fetch(new URL(oldClient ? "/enroll" : "/issue", url), { method: "POST", body: JSON.stringify(oldClient ? { credentialHash: hash(httpToken), ingressHash: hash(ingress), profile: "webhook", headers: [] } : { credentialHash: hash(wakeToken), idempotencyKey: randomBytes(24).toString("base64url") }) });
		assert.equal(enrolled.status, 200);
		const status = async () => (await (await fetch(new URL("/status", url))).json() as any);
		const before = await status();
		const protocol = oldClient ? "a2a-wake-v1" : "a2a-http-relay-v2", token = oldClient ? wakeToken : httpToken;
		const rejection = await mf.dispatchFetch("https://fixture.example.com/connect", { headers: { upgrade: "websocket", "sec-websocket-protocol": `${protocol}, ${token}` } });
		assert.equal(rejection.status, 401); assert.deepEqual(await rejection.json(), { error: "unauthorized" }); assert.equal(rejection.webSocket, null);
		const options = { url: new URL(oldClient ? "/relay/connect" : "/relay/http/webhook/connect", url).href.replace("http:", "ws:"), token, localUrl: `http://127.0.0.1:${(receiver.address() as any).port}/must-not-post`, signal: stop.signal, onReady: () => { ready++; }, onDiagnostic: (message: string) => { diagnostics.push(message); }, handshakeMs: 1000 };
		await assert.rejects(oldClient ? runConnector(options) : runHttpConnector({ ...options, profile: "webhook" }), /handshake failed three consecutive times/);
		assert.equal(ready, 0); assert.equal(posts, 0); assert.equal(diagnostics.length, 2);
		const after = await status(); assert.equal(after.connected, false); assert.equal(after.generation, before.generation);
		assert.equal(after.protocolVersion, oldClient ? 2 : 1);
		t.diagnostic("real Worker HTTP 401 unauthorized; native connector bounded refusal; zero local POSTs (no assertion on Undici internal HTTP retry count)");
	} finally {
		stop.abort(); receiver.closeAllConnections(); await new Promise<void>(done => receiver.close(() => done())); await mf.dispose();
	}
});
