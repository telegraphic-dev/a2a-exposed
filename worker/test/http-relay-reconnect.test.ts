import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { createServer as tcpServer, connect, Socket } from "node:net";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHttpConnector } from "../../cli/lib/http-relay.mjs";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => unknown, ms = 8000) {
	const end = Date.now() + ms;
	while (Date.now() < end) { if (await check()) return; await delay(20); }
	assert.fail("condition not reached within " + ms + "ms");
}
async function runtime(persistence: string) {
	// Direct DO harness: production framing/auth/storage, not owner/public routing.
	const built = await build({ stdin: { contents: `export { HttpRelay } from './src/http-relay.ts'; export default { fetch(req,env) { const u=new URL(req.url); u.pathname=u.pathname.endsWith('/connect')?'/connect':u.pathname; return env.HTTP_RELAY.get(env.HTTP_RELAY.idFromName('restart-fixture')).fetch(new Request(u,req)); } };`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "neutral", external: ["cloudflare:*"] });
	const mf = new Miniflare(convertV4MiniflareOptions({ name: "http-reconnect", resourcePersistencePath: persistence, isolatedResourcePersistencePath: persistence, modules: true, script: built.outputFiles[0].text, compatibilityDate: "2026-10-06", compatibilityFlags: ["enable_request_signal"], durableObjects: { HTTP_RELAY: { className: "HttpRelay", useSQLite: true } } }));
	const url = await mf.ready;
	const call = (path: string, body?: unknown) => fetch(new URL(path, url), { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body) });
	return { mf, url, call };
}

test("real TCP connector drop after accepted POST is uncertain, reconnects in the same invocation and never replays; persisted DO restart retains authority", { timeout: 45000 }, async t => {
	const dir = mkdtempSync(join(tmpdir(), "http-reconnect-"));
	let r = await runtime(dir), upstream = r.url;
	const sockets = new Set<Socket>(); let connections = 0;
	// Opaque TCP tunnel: destroy the actual native WebSocket transport, not the
	// receiver's HTTP response and not a synthetic close event/connector replacement.
	const proxy = tcpServer(client => {
		connections++; const remote = connect(Number(upstream.port), "127.0.0.1");
		for (const socket of [client, remote]) { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => { sockets.delete(socket); client.destroy(); remote.destroy(); }); }
		client.pipe(remote); remote.pipe(client);
	});
	proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
	const calls: string[] = []; let closed = 0;
	const receiver = createServer(async (req, res) => {
		let body = ""; for await (const chunk of req) body += chunk; calls.push(body);
		res.on("close", () => { if (!res.writableEnded) closed++; });
		if (body.startsWith("accepted-but-unanswered")) return;
		res.end(body);
	});
	receiver.listen(0, "127.0.0.1"); await once(receiver, "listening");
	const stop = new AbortController(); let connector: Promise<void> | undefined;
	const ready: number[] = []; let connectorError: unknown;
	const token = "a2ah_" + randomBytes(32).toString("base64url"), ingress = "a2ai_" + randomBytes(32).toString("base64url");
	const forward = (body: string) => fetch(new URL("/forward", r.url), { method: "POST", headers: { "x-a2a-relay-authorization": `Bearer ${ingress}`, "x-a2a-relay-target": "webhook", "x-a2a-relay-method": "POST" }, body });
	try {
		assert.equal((await r.call("/enroll", { credentialHash: hash(token), ingressHash: hash(ingress), profile: "webhook", headers: [] })).status, 200);
		connector = runHttpConnector({ url: `ws://127.0.0.1:${(proxy.address() as any).port}/relay/http/webhook/connect`, token, profile: "webhook", localUrl: `http://127.0.0.1:${(receiver.address() as any).port}/fixed`, signal: stop.signal, onReady: ({ generation }: any) => ready.push(generation) });
		void connector.catch(e => { connectorError = e; });
		await until(async () => (await (await r.call("/status")).json() as any).connected);
		const pending = forward("accepted-but-unanswered");
		await until(() => calls.length === 1);
		for (const socket of sockets) socket.destroy();
		const uncertain = await pending;
		assert.equal(uncertain.status, 502); assert.deepEqual(await uncertain.json(), { error: "delivery_uncertain" });
		await until(async () => ready.length === 2 && (await (await r.call("/status")).json() as any).connected);
		await until(() => closed === 1);
		assert.equal(connectorError, undefined); assert.equal(connections, 2);
		assert.deepEqual(calls, ["accepted-but-unanswered"]);
		assert.equal(await (await forward("fresh-after-drop")).text(), "fresh-after-drop");
		assert.deepEqual(calls, ["accepted-but-unanswered", "fresh-after-drop"]);
		const before = await (await r.call("/status")).json() as any;
		const restartPending = forward("accepted-but-unanswered-restart").then(async response => ({ status: response.status, body: await response.json(), rejected: false as const }), error => ({ rejected: true as const, error }));
		await until(() => calls.length === 3);
		// Stop workerd entirely with an accepted/unanswered POST and open the SAME
		// SQLite storage/name. No re-enroll or new runHttpConnector; this is NOT
		// preserved-socket hibernation. Killing the entire HTTP listener may reject
		// the public fetch rather than allow a structured uncertainty response.
		await r.mf.dispose();
		const interrupted = await restartPending;
		if (!interrupted.rejected) { assert.equal(interrupted.status, 502); assert.deepEqual(interrupted.body, { error: "delivery_uncertain" }); }
		await until(() => closed === 2);
		r = await runtime(dir); upstream = r.url;
		const restored = await (await r.call("/status")).json() as any;
		assert.equal(restored.enrolled, true); assert.equal(restored.enabled, true);
		assert.equal(restored.profile, "webhook"); assert.ok(restored.generation >= before.generation);
		await until(async () => ready.length >= 3 && (await (await r.call("/status")).json() as any).connected);
		assert.equal(connectorError, undefined); assert.ok(ready[2] > ready[1]);
		assert.equal(await (await forward("fresh-after-restart")).text(), "fresh-after-restart");
		await delay(200);
		assert.deepEqual(calls, ["accepted-but-unanswered", "fresh-after-drop", "accepted-but-unanswered-restart", "fresh-after-restart"]);
		t.diagnostic(`same connector invocation; ${ready.length} handshakes; same persisted SQLite; exactly one receiver call per interrupted POST; restart public fetch rejected=${interrupted.rejected}`);
	} finally {
		stop.abort(); await connector;
		for (const socket of sockets) socket.destroy();
		await new Promise<void>(done => proxy.close(() => done()));
		receiver.closeAllConnections(); await new Promise<void>(done => receiver.close(() => done()));
		await r.mf.dispose(); rmSync(dir, { recursive: true, force: true });
	}
});
