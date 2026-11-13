import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { AgentCard, SendMessageRequest } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { relayPhase } from "./relay-phase.ts";
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const execute = promisify(execFile);

for (const legacy of [false, true]) test(`delayed initial BOM survives keepalive: official A2A SDK 1.3 / protocol ${legacy ? "0.3" : "1.0"} through actual Worker and native CLI`, { timeout: 45000 }, async t => {
	let diagnostics = "", phase = "startup";
	const wait = <T>(name: string, work: Promise<T>, ms = 8000) => { phase = name; return relayPhase(name, work, ms, () => `completed=${completed}, aborted=${aborted}, connectorExit=${child?.exitCode}, connectorSignal=${child?.signalCode}, stderr=${diagnostics.slice(-2000)}`); };
	const root = resolve(process.env.HTTP_RELAY_WORKER_ROOT || ".");
	const built = await build({ absWorkingDir: root, entryPoints: ["src/relay-entry.ts"], bundle: true, write: false, format: "esm", platform: "neutral", external: ["cloudflare:*"], plugins: [{ name: "sql", setup(b) {
		b.onResolve({ filter: /\.sql\?raw$/ }, a => ({ path: new URL(a.path.replace("?raw", ""), `file://${a.resolveDir}/`).pathname, namespace: "sql" }));
		b.onLoad({ filter: /.*/, namespace: "sql" }, a => ({ contents: `export default ${JSON.stringify(readFileSync(a.path, "utf8"))}`, loader: "js" }));
	} }] });
	const publicOrigin = "https://agent.example.com";
	const mf = new Miniflare(convertV4MiniflareOptions({ name: "http-relay-sdk", modules: true, script: built.outputFiles[0].text, compatibilityDate: "2026-10-06", compatibilityFlags: ["enable_request_signal"], d1Databases: ["DB"], durableObjects: { HTTP_RELAY: { className: "HttpRelay", useSQLite: true } }, bindings: { OWNER_TOKEN: "fixture-owner", PUBLIC_URL: publicOrigin, HTTP_RELAY_ENABLED: "1", MCP: "off" } }));
	const dir = mkdtempSync(join(tmpdir(), "http-relay-official-sdk-"));
	let mode = "bom", completed = 0, aborted = 0;
	let abortClosed = () => {};
	const abortSawClose = new Promise<void>(resolve => { abortClosed = resolve; });
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
		const raw = Buffer.concat(chunks);
		const input = JSON.parse(raw.toString());
		const task = { id: "first-task", contextId: "context", status: { state: legacy ? "working" : "TASK_STATE_WORKING" }, ...(legacy ? { kind: "task" } : {}) };
		const record = `data: ${JSON.stringify({ jsonrpc: "2.0", id: input.id, result: legacy ? task : { task } })}\n\n`;
		res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
		const timers: ReturnType<typeof setTimeout>[] = [];
		const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));
		// The abort case stays open until the client disconnects. Ending it on a timer races the abort under load.
		const hold = raw.includes('"messageId":"abort"');
		res.on("close", () => { timers.forEach(clearTimeout); if (!res.writableEnded) { aborted++; if (hold) abortClosed(); } });
		if (mode === "empty") { later(350, () => res.end()); return; }
		const bytes = Buffer.from((mode === "plain" ? "" : "\ufeff") + record);
		// Separate the BOM bytes and data-line prefix across native HTTP writes.
		later(300, () => res.write(bytes.subarray(0, 1)));
		later(340, () => res.write(bytes.subarray(1, 2)));
		later(380, () => res.write(bytes.subarray(2, 12)));
		later(420, () => res.write(bytes.subarray(12)));
		if (!hold) later(850, () => { completed++; res.end(); });
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const fixture = { base: `http://127.0.0.1:${(server.address() as any).port}`, async close() { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } };
	let child: ReturnType<typeof spawn> | undefined;
	try {
		const db = await wait("Worker D1 startup", mf.getD1Database("DB"), 12000);
		for (const file of readdirSync(join(root, "migrations")).filter(n => n.endsWith(".sql")).sort()) await db.exec(readFileSync(join(root, "migrations", file), "utf8").replace(/--[^\n]*/g, "").replace(/\n/g, " "));
		const local = await wait("Worker ready", mf.ready);
		const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(A2A_|WAKE_|CF_|CLOUDFLARE_|PEER_|UPSTREAM_|APPROVAL_|EVENT_|FEEDBACK_|CONTROL_|HOSTED_|HTTP_RELAY_|NODE_OPTIONS$)/.test(key))), A2A_CONFIG_DIR: dir, A2A_BASE_URL: local.origin, A2A_OWNER_TOKEN: "fixture-owner", DO_NOT_TRACK: "1" };
		const cli = resolve(process.env.HTTP_RELAY_CLI || "../cli/bin/a2a-exposed.mjs");
		const tokenFile = join(dir, "connector"), ingressFile = join(dir, "ingress");
		await execute(process.execPath, [cli, "relay", "a2a", "create", "--token-file", tokenFile, "--ingress-token-file", ingressFile, "--forward-headers", "content-type,accept,authorization,a2a-version,last-event-id"], { env, cwd: dir, timeout: 10000 });
		child = spawn(process.execPath, [cli, "relay", "a2a", "run", "--url", new URL("/relay/http/a2a/connect", local).href.replace("http:", "ws:"), "--token-file", tokenFile, "--local-url", fixture.base + "/rpc"], { env, cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout!.resume(); child.stderr!.on("data", chunk => { diagnostics += chunk; });
		const deadline = Date.now() + 8000;
		for (;;) {
			assert.equal(child.exitCode, null, `connector exited: ${diagnostics}`);
			const connected = await wait("connector readiness", (async () => {
				const status = await fetch(new URL("/owner/relay/http/a2a", local), { headers: { authorization: "Bearer fixture-owner" }, signal: t.signal });
				return (await status.json() as any).connected;
			})());
			if (connected) break;
			assert.ok(Date.now() < deadline, "connector must become ready"); await new Promise(r => setTimeout(r, 20));
		}
		const ingress = readFileSync(ingressFile, "utf8").trim();
		const publicFetch: typeof fetch = async (input, init) => {
			const req = new Request(input, init); const url = new URL(req.url);
			assert.equal(url.origin, publicOrigin, "SDK must use the rewritten public endpoint, not the receiver");
			const headers = new Headers(req.headers); headers.set("x-a2a-relay-authorization", `Bearer ${ingress}`);
			// Node 22 ties a copied Request signal's controller to that Request.
			// Forward the SDK's original signal, not the temporary req.signal: GC
			// after response headers would otherwise silently detach cancellation.
			const signal = init?.signal ?? (input instanceof Request ? input.signal : t.signal);
			return fetch(new URL(url.pathname + url.search, local), { method: req.method, headers, body: req.body, signal: AbortSignal.any([signal, t.signal]), duplex: "half" } as RequestInit);
		};
		const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: publicFetch, legacyCompat: { enabled: true } })] }).createFromAgentCard(AgentCard.fromJSON({ name: "fixture", supportedInterfaces: [{ url: publicOrigin + "/relay/a2a/", protocolBinding: "JSONRPC", protocolVersion: legacy ? "0.3" : "1.0" }], capabilities: { streaming: true }, skills: [] }));
		for (mode of ["bom", "plain"]) {
			const before = completed;
			const stream = client.sendMessageStream(SendMessageRequest.fromJSON({ message: { messageId: "bom-probe", role: "ROLE_USER", parts: [{ text: "fixture" }] } }));
			const first = await wait(`${mode}: first SDK event`, stream.next());
			assert.equal(first.done, false, "initial BOM must not hide the first application event");
			assert.equal(first.value?.payload?.value.id, "first-task");
			assert.equal(completed, before, "first application event arrives before receiver completion");
			assert.equal((await wait(`${mode}: SDK completion`, stream.next())).done, true);
		}
		mode = "bom";
		const abort = new AbortController();
		const stream = client.sendMessageStream(SendMessageRequest.fromJSON({ message: { messageId: "abort", role: "ROLE_USER" } }), { signal: abort.signal });
		assert.equal((await wait("abort: first SDK event", stream.next())).done, false);
		// In the GC regression subprocess, collect the temporary normalized Request
		// after headers/first event have arrived but before aborting the SDK signal.
		if (globalThis.gc) for (let i = 0; i < 5; i++) { await delay(0); globalThis.gc(); }
		abort.abort();
		// Consume only the SDK rejection here; a phase timeout must still fail the test.
		await wait("abort: SDK iterator settlement", stream.next().catch(() => undefined));
		await wait("abort: local response closed", abortSawClose);
		assert.equal(aborted, 1);
		t.diagnostic("@a2a-js/sdk@1.3.0: delayed split BOM first event, no-BOM prefix, native abort passed");
	} finally {
		t.diagnostic(`last phase: ${phase}; completed=${completed}; aborted=${aborted}`);
		try {
			if (child && child.exitCode === null && child.signalCode === null) {
				const exited = once(child, "exit"); child.kill("SIGTERM");
				try { await wait("connector shutdown", exited, 12000); }
				finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await relayPhase("connector forced shutdown", exited, 2000); } }
			}
		} finally {
			try { await wait("fixture shutdown", fixture.close()); }
			finally { try { await wait("Worker shutdown", mf.dispose()); } finally { rmSync(dir, { recursive: true, force: true }); } }
		}
	}
});

// Force the formerly intermittent lifetime bug on every normal suite run.
// Select only the SDK cases in the subprocess, so this wrapper cannot recurse.
test("SDK fixture abort survives garbage collection of normalized Requests", { timeout: 45000 }, async t => {
	const root = resolve(process.env.HTTP_RELAY_WORKER_ROOT || ".");
	try {
		const result = await execute(process.execPath, ["--expose-gc", "--import", resolve(root, "test/register-hooks.mjs"), "--test", "--test-reporter=tap", "--test-name-pattern=^delayed initial BOM", resolve(root, "test/http-relay-bom.test.ts")], { cwd: root, timeout: 40000, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(NODE_TEST_|NODE_OPTIONS$)/.test(key))) });
		assert.match(result.stdout, /# tests 2/);
		assert.match(result.stdout, /# pass 2/);
		t.diagnostic("forced Request GC: original SDK abort reaches the receiver on protocols 1.0 and 0.3");
	} catch (error) {
		t.diagnostic((error as any).stdout || "no subprocess stdout");
		t.diagnostic((error as any).stderr || "no subprocess stderr");
		throw error;
	}
});

// Deterministic connector frames cover every BOM split and exact application bytes.
test("SSE prefix normalization strips only one initial BOM, preserving interior bytes and bounded framing", { timeout: 30000 }, async () => {
	const built = await build({ stdin: { contents: `import { HttpRelay } from './src/http-relay.ts'; export { HttpRelay }; export default { fetch(req,env) { return env.HTTP_RELAY.get(env.HTTP_RELAY.idFromName('test')).fetch(req); } };`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "neutral", external: ["cloudflare:*"] });
	const mf = new Miniflare(convertV4MiniflareOptions({ name: "bom-framing", modules: true, script: built.outputFiles[0].text, compatibilityDate: "2026-10-06", durableObjects: { HTTP_RELAY: { className: "HttpRelay", useSQLite: true } } }));
	const url = await mf.ready, token = "a2ah_" + "a".repeat(43), ingress = "a2ai_" + "b".repeat(43);
	const hash = (s: string) => createHash("sha256").update(s).digest("hex");
	const until = async (fn: () => unknown) => { const end = Date.now() + 5000; while (!await fn()) { assert.ok(Date.now() < end); await delay(5); } };
	let ws: WebSocket | undefined;
	try {
		assert.equal((await fetch(new URL("/enroll", url), { method: "POST", body: JSON.stringify({ credentialHash: hash(token), ingressHash: hash(ingress), headers: [], profile: "a2a" }) })).status, 200);
		const frames: any[] = [];
		ws = new WebSocket(new URL("/connect", url).href.replace("http:", "ws:"), ["a2a-http-relay-v2", token]);
		ws.addEventListener("message", e => frames.push(JSON.parse(String(e.data))));
		await once(ws, "open"); await until(() => frames.length);
		const generation = frames[0].generation;
		const send = (frame: any) => ws!.send(JSON.stringify({ v: 2, generation, ...frame }));
		send({ type: "ready", profile: "a2a", capabilities: frames[0].capabilities });
		await until(async () => (await (await fetch(new URL("/status", url))).json() as any).connected);
		const record = Buffer.from('data: {"text":"interior \ufeff preserved"}\r\n\r\n');
		const later = Buffer.from('\ufeffdata: intentionally-interior-BOM\n\ndata: later\n\n');
		const bom = Buffer.from([0xef, 0xbb, 0xbf]);
		const cases = [[], [bom], [bom.subarray(0, 1), bom.subarray(1)], [bom.subarray(0, 2), bom.subarray(2)], [...bom].map(b => Buffer.from([b])), [Buffer.from("data:"), Buffer.from(" plain\n\n")], [Buffer.from([0xef, 0xbb, 0xbe]), Buffer.from("data: not-a-BOM\n\n")]];
		for (const prefix of cases) {
			const start = frames.length;
			const responsePromise = fetch(new URL("/forward", url), { method: "POST", headers: { "x-a2a-relay-authorization": `Bearer ${ingress}`, "x-a2a-relay-target": "rpc", "x-a2a-relay-method": "POST" }, body: JSON.stringify({ jsonrpc: "2.0", id: "bytes", method: "message/stream", params: {} }) });
			await until(() => frames.slice(start).some(f => f.type === "request"));
			const id = frames.slice(start).find(f => f.type === "request").id;
			send({ type: "start", id, status: 200, headers: [["content-type", "text/event-stream"]] });
			const response = await responsePromise; const bytesPromise = response.arrayBuffer();
			// Force a public keepalive before upstream bytes.
			await delay(150);
			let seq = 0;
			for (const chunk of [...prefix, record.subarray(0, 1), record.subarray(1), later]) {
				await until(() => frames.some(f => f.type === "credit" && f.id === id && f.seq === seq));
				send({ type: "chunk", id, seq, body: chunk.toString("base64") }); seq++;
			}
			send({ type: "end", id, seq });
			const bytes = Buffer.from(await bytesPromise);
			const withoutComments = Buffer.from(bytes.toString("utf8").replace(/: relay keepalive\n\n/g, ""));
			const original = Buffer.concat([...prefix, record, later]);
			assert.deepEqual(withoutComments, original.subarray(original.subarray(0, 3).equals(bom) ? 3 : 0));
		}
		// Empty upstream succeeds; no prefix bytes are invented.
		const before = frames.length;
		const empty = fetch(new URL("/forward", url), { method: "POST", headers: { "x-a2a-relay-authorization": `Bearer ${ingress}`, "x-a2a-relay-target": "rpc", "x-a2a-relay-method": "POST" }, body: '{"jsonrpc":"2.0","id":0,"method":"message/stream"}' });
		await until(() => frames.slice(before).some(f => f.type === "request")); const id = frames.slice(before).find(f => f.type === "request").id;
		send({ type: "start", id, status: 200, headers: [["content-type", "text/event-stream"]] }); send({ type: "end", id, seq: 0 });
		assert.equal(await (await empty).text(), "");
		const open = async () => {
			const before = frames.length;
			const response = fetch(new URL("/forward", url), { method: "POST", headers: { "x-a2a-relay-authorization": `Bearer ${ingress}`, "x-a2a-relay-target": "rpc", "x-a2a-relay-method": "POST" }, body: '{"jsonrpc":"2.0","id":"prefix-end","method":"message/stream"}' });
			await until(() => frames.slice(before).some(f => f.type === "request"));
			const id = frames.slice(before).find(f => f.type === "request").id;
			send({ type: "start", id, status: 200, headers: [["content-type", "text/event-stream"]] });
			const bytes = (await response).text();
			return { id, bytes };
		};
		for (const size of [1, 2, 3]) {
			const { id, bytes } = await open();
			await until(() => frames.some(f => f.type === "credit" && f.id === id && f.seq === 0));
			send({ type: "chunk", id, seq: 0, body: bom.subarray(0, size).toString("base64") });
			send({ type: "end", id, seq: 1 });
			const text = (await bytes).replace(/: relay keepalive\n\n/g, "");
			if (size === 3) assert.equal(text, "", "BOM-only upstream is empty SSE");
			else assert.deepEqual(JSON.parse(text.slice(6)), { jsonrpc: "2.0", id: "prefix-end", error: { code: -32603, message: "Relay delivery uncertain", data: { code: "delivery_uncertain" } } }, "truncated UTF-8 prefix must not escape into application/error framing");
		}
		const { id: boundedId, bytes: boundedBytes } = await open();
		const closed = once(ws, "close");
		for (let seq = 0; seq <= 64; seq++) {
			await until(() => frames.some(f => f.type === "credit" && f.id === boundedId && f.seq === seq));
			send({ type: "chunk", id: boundedId, seq, body: Buffer.alloc(16384, 120).toString("base64") });
		}
		assert.equal((await closed)[0].code, 4008, "unterminated application records retain the existing 1 MiB budget");
		const bounded = await boundedBytes;
		assert.ok(bounded.length < 4096, "partial over-budget application bytes are never published");
		assert.match(bounded, /delivery_uncertain/);
	} finally { ws?.close(); await mf.dispose(); }
});
