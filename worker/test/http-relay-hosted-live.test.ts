import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { runHttpConnector } from "../../cli/lib/http-relay.mjs";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => unknown, ms = 8000) {
	const end = Date.now() + ms;
	while (Date.now() < end) { if (await check()) return; await delay(20); }
	assert.fail("condition not reached within " + ms + "ms");
}
async function runtime() {
	// Only substituted boundary: loopback origin -> public tenant Host. All public
	// routing, TenantStore dispatch and HttpRelay response/cancellation are real.
	const built = await build({ stdin: { contents: `import hosted from './src/hosted.ts'; export { TenantStore, HttpRelay } from './src/hosted.ts'; export default { fetch(req,env,ctx) { const u=new URL(req.url); u.hostname=(req.headers.get('x-fixture-tenant')||'first')+'.agents.example.com'; u.port=''; u.protocol='https:'; return hosted.fetch(new Request(u,req),env,ctx); } };`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "neutral", external: ["cloudflare:*"], plugins: [{ name: "sql", setup(b) {
		b.onResolve({ filter: /\.sql\?raw$/ }, a => ({ path: new URL(a.path.replace("?raw", ""), `file://${a.resolveDir}/`).pathname, namespace: "sql" }));
		b.onLoad({ filter: /.*/, namespace: "sql" }, a => ({ contents: `export default ${JSON.stringify(readFileSync(a.path, "utf8"))}`, loader: "js" }));
	} }] });
	const mf = new Miniflare(convertV4MiniflareOptions({ name: "hosted-native-http", modules: true, script: built.outputFiles[0].text, compatibilityDate: "2026-10-06", compatibilityFlags: ["enable_request_signal"], kvNamespaces: ["TENANT_DIRECTORY"], durableObjects: { TENANT_DO: { className: "TenantStore", useSQLite: true }, HTTP_RELAY: { className: "HttpRelay", useSQLite: true } }, bindings: { TENANCY: "host", TENANT_DOMAIN: "agents.example.com", TENANT_SECRETS_KEY: "fixture-platform-key", HTTP_RELAY_ENABLED: "1", MCP: "off" } }));
	const url = await mf.ready;
	const ns = await mf.getDurableObjectNamespace("TENANT_DO"), directory = await mf.getKVNamespace("TENANT_DIRECTORY");
	const tokens = new Map<string, { token: string; ingress: string }>();
	for (const name of ["first", "second"]) {
		await directory.put(`tenant:${name}`, JSON.stringify({ id: `id-${name}`, status: "active", region: "default", version: 1 }));
		const stub = ns.get(ns.idFromName(`id-${name}`)) as any;
		await stub.pushConfig({ version: 1, tenantId: `id-${name}`, name, status: "active", ownerTokenHash: hash("fixture-owner"), approval: { allowedSubjects: ["acct_fixture"] }, config: {} });
		for (const profile of ["a2a", "webhook"]) {
			const token = "a2ah_" + randomBytes(32).toString("base64url"), ingress = "a2ai_" + randomBytes(32).toString("base64url");
			assert.equal((await stub.owner({ accountId: "acct_fixture", method: "POST", path: `/owner/relay/http/${profile}`, body: { credentialHash: hash(token), ingressHash: hash(ingress), headers: ["content-type", "accept"] } })).status, 200);
			tokens.set(`${name}:${profile}`, { token, ingress });
		}
	}
	const first = ns.get(ns.idFromName("id-first")) as any;
	const connected = async () => (await first.owner({ accountId: "acct_fixture", method: "GET", path: "/owner/relay/http/a2a" })).body.connected;
	const post = (ingress: string, id: string, signal?: AbortSignal, name = "first", profile = "a2a") => fetch(new URL(`/relay/${profile === "a2a" ? "a2a" : "webhook"}`, url), { method: "POST", headers: { "x-fixture-tenant": name, "x-a2a-relay-authorization": `Bearer ${ingress}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "message/stream", params: {} }), signal });
	return { mf, url, tokens, connected, post };
}

test("hosted public idle SSE abort closes native receiver promptly and frees one of four slots; tenant/profile credentials stay isolated", { timeout: 30000 }, async () => {
	const r = await runtime(); const stop = new AbortController(); let connector: Promise<void> | undefined;
	const calls: string[] = [], closed = new Set<string>();
	const receiver = createServer(async (req, res) => {
		let body = ""; for await (const chunk of req) body += chunk;
		const id = JSON.parse(body).id; calls.push(id);
		res.on("close", () => { if (!res.writableEnded) closed.add(id); });
		res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
		if (id === "fresh") res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { fresh: true } })}\n\n`);
		// Deliberately idle: no application events, no application completion timer.
	});
	receiver.listen(0, "127.0.0.1"); await once(receiver, "listening");
	const controllers = Array.from({ length: 4 }, () => new AbortController()); const responses: Response[] = [];
	try {
		const e = r.tokens.get("first:a2a")!;
		connector = runHttpConnector({ url: new URL("/relay/http/a2a/connect", r.url).href.replace("http:", "ws:"), token: e.token, profile: "a2a", localUrl: `http://127.0.0.1:${(receiver.address() as any).port}/rpc`, signal: stop.signal });
		await until(r.connected);
		for (let i = 0; i < 4; i++) responses.push(await r.post(e.ingress, `idle-${i}`, controllers[i].signal));
		assert.deepEqual(calls, ["idle-0", "idle-1", "idle-2", "idle-3"]);
		const busy = await r.post(e.ingress, "must-not-dispatch"); assert.equal(busy.status, 503); assert.equal((await busy.json() as any).error, "connector_busy");
		for (const [name, profile] of [["second", "a2a"], ["first", "webhook"]]) assert.equal((await r.post(e.ingress, "foreign", undefined, name, profile)).status, 401);
		for (const bad of [e.token, r.tokens.get("second:a2a")!.ingress, r.tokens.get("first:webhook")!.ingress, "fixture-owner"]) assert.equal((await r.post(bad, "foreign")).status, 401);
		const at = Date.now(); controllers[0].abort();
		await until(() => closed.has("idle-0"), 2000); assert.ok(Date.now() - at < 2000, "idle public abort must promptly close native receiver");
		const fresh = await r.post(e.ingress, "fresh"); assert.equal(fresh.status, 200); assert.match(await fresh.text(), /"fresh":true/);
		assert.deepEqual(calls, ["idle-0", "idle-1", "idle-2", "idle-3", "fresh"]);
		assert.equal(closed.size, 1, "other tenants/profiles and live requests were not cancelled");
	} finally {
		for (const c of controllers) c.abort(); for (const response of responses) await response.body?.cancel().catch(() => {});
		stop.abort(); await connector;
		receiver.closeAllConnections(); await new Promise<void>(done => receiver.close(() => done())); await r.mf.dispose();
	}
});

test("60-second completion deadline releases all four slots and closes native receivers even when public SSE bodies are never read", { timeout: 75000 }, async t => {
	const r = await runtime(); const stop = new AbortController(); let connector: Promise<void> | undefined;
	const accepted: string[] = [], closed = new Set<string>();
	const receiver = createServer(async (req, res) => {
		let body = ""; for await (const chunk of req) body += chunk;
		const id = JSON.parse(body).id; accepted.push(id);
		res.on("close", () => { if (!res.writableEnded) closed.add(id); });
		res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
		if (id === "fresh") res.end(`data: {"jsonrpc":"2.0","id":"fresh","result":{}}\n\n`);
	});
	receiver.listen(0, "127.0.0.1"); await once(receiver, "listening");
	const responses: Response[] = [], replacements: Response[] = [];
	const replacementStops = Array.from({ length: 4 }, () => new AbortController());
	try {
		const e = r.tokens.get("first:a2a")!;
		connector = runHttpConnector({ url: new URL("/relay/http/a2a/connect", r.url).href.replace("http:", "ws:"), token: e.token, profile: "a2a", localUrl: `http://127.0.0.1:${(receiver.address() as any).port}/rpc`, signal: stop.signal });
		await until(r.connected);
		const start = Date.now();
		for (let i = 0; i < 4; i++) responses.push(await r.post(e.ingress, `deadline-${i}`));
		assert.equal((await r.post(e.ingress, "busy")).status, 503);
		// Wall clock, no fake timer or modified production limit; not even getReader
		// until both local closure and fresh admission establish autonomous expiry.
		await delay(59000); assert.equal(closed.size, 0, "completion must not expire early");
		await until(() => closed.size === 4, 5000);
		const elapsed = Date.now() - start; assert.ok(elapsed >= 59000 && elapsed < 65000);
		const fresh = await r.post(e.ingress, "fresh"); assert.equal(fresh.status, 200); await fresh.text();
		for (let i = 0; i < 4; i++) {
			const replacement = await r.post(e.ingress, `replacement-${i}`, replacementStops[i].signal);
			assert.equal(replacement.status, 200); replacements.push(replacement);
		}
		assert.equal((await r.post(e.ingress, "still-bounded")).status, 503, "exactly four new in-flight slots, not an unbounded bypass");
		for (const [i, response] of responses.entries()) {
			const text = await response.text(); const records = text.split(/\r?\n\r?\n/).filter(s => s.startsWith("data:"));
			assert.equal(records.length, 1); const rpc = JSON.parse(records[0].slice(5));
			assert.equal(rpc.id, `deadline-${i}`); assert.ok(["delivery_timeout", "delivery_uncertain"].includes(rpc.error.data.code)); assert.equal(rpc.result, undefined);
		}
		assert.deepEqual(accepted, ["deadline-0", "deadline-1", "deadline-2", "deadline-3", "fresh", "replacement-0", "replacement-1", "replacement-2", "replacement-3"]);
		t.diagnostic(`wall-clock completion expiry ${elapsed}ms; no body reads before receiver closure and all four fresh admissions`);
	} finally {
		for (const c of replacementStops) c.abort();
		for (const response of [...responses, ...replacements]) await response.body?.cancel().catch(() => {});
		stop.abort(); await connector;
		receiver.closeAllConnections(); await new Promise<void>(done => receiver.close(() => done())); await r.mf.dispose();
	}
});
