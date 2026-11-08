import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { runHttpConnector } from '../../cli/lib/http-relay.mjs';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const delay = (n: number) => new Promise(r => setTimeout(r, n));
async function until(fn: () => unknown, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await delay(10); } throw new Error('condition timed out'); }
async function runtime() {
	// Test-only direct DO routing, not production owner/tenant admission.
	const built = await build({ stdin: { contents: `import { HttpRelay } from './src/http-relay.ts'; export { HttpRelay };
export default { async fetch(req,env) { const u = new URL(req.url); const profile = u.pathname.includes('/a2a/') ? 'a2a' : 'webhook'; const checked = u.pathname === '/checked-forward'; const path = checked ? '/forward' : u.pathname.endsWith('/connect') ? '/connect' : u.pathname.replace('/a2a',''); u.pathname = path; const response = await env.HTTP_RELAY.get(env.HTTP_RELAY.idFromName(profile)).fetch(new Request(u,req)); if (!checked) return response; try { await response.arrayBuffer(); return Response.json({status:response.status}); } catch { return Response.json({error:'stream_failed'},{status:502}); } } };`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:*'] });
	const mf = new Miniflare(convertV4MiniflareOptions({ name: 'http-transport-test', modules: true, script: built.outputFiles[0].text, compatibilityDate: '2026-10-06', durableObjects: { HTTP_RELAY: { className: 'HttpRelay', useSQLite: true } } }));
	const url = await mf.ready;
	const call = (path: string, body?: unknown) => fetch(new URL(path, url), { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	const enroll = async (profile = 'webhook', headers = ['content-type', 'accept', 'authorization', 'x-hub-signature-256']) => {
		const token = 'a2ah_' + randomBytes(32).toString('base64url'), ingress = 'a2ai_' + randomBytes(32).toString('base64url');
		const response = await call(profile === 'a2a' ? '/a2a/enroll' : '/enroll', { credentialHash: hash(token), ingressHash: hash(ingress), headers, profile }); assert.equal(response.status, 200); return { token, ingress, ...await response.json() as any };
	};
	const forward = (ingress: string, body: Buffer | string = '{}', extra: Record<string, string> = {}, signal?: AbortSignal, checked = false) => fetch(new URL(checked ? '/checked-forward' : '/forward', url), { method: 'POST', headers: { 'x-a2a-relay-authorization': `Bearer ${ingress}`, 'x-a2a-relay-target': 'webhook', 'x-a2a-relay-method': 'POST', ...extra }, body, signal });
	return { mf, url, call, enroll, forward };
}
function rawGet(url: URL, options: any): Promise<{ status: number; headers: any; body: Buffer }> {
	return new Promise((resolve, reject) => { const req = request(url, options, res => { const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) })); res.on('error', reject); }); req.on('error', reject); req.end(options.body); });
}

test('real workerd + native connector preserves binary/HMAC/application bearer, status and encoded response; no redirects/replay', { timeout: 30000 }, async () => {
	const r = await runtime(), stop = new AbortController(); let connector: Promise<void> | undefined;
	let count = 0, mode = 'echo'; const seen: any[] = [];
	const signed = gzipSync(Buffer.from('encoded signed response '.repeat(300)));
	const server = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks); count++; seen.push({ body, headers: req.headers, path: req.url });
		if (mode === 'redirect') { res.writeHead(307, { location: '/do-not-follow' }).end(); return; }
		if (mode === 'disconnect') { res.destroy(); return; }
		if (mode === 'encoded') { res.writeHead(200, { 'content-encoding': 'gzip', 'x-body-signature': hash(signed.toString('base64')) }).end(signed); return; }
		if (req.headers.authorization !== 'Bearer dummy-app' || req.headers['x-hub-signature-256'] !== 'sha256=' + createHmac('sha256', 'dummy-key').update(body).digest('hex')) { res.writeHead(401).end('application authorization failed'); return; }
		res.writeHead(422, { 'content-type': 'application/octet-stream', 'set-cookie': 'private=1', 'x-signature': 'dummy-signature' }).end(body);
	});
	server.listen(0, '127.0.0.1'); await once(server, 'listening');
	try {
		const e = await r.enroll();
		assert.equal((await r.forward(e.ingress)).status, 503);
		connector = runHttpConnector({ url: new URL('/relay/http/webhook/connect', r.url).href.replace('http:', 'ws:'), token: e.token, profile: 'webhook', localUrl: `http://127.0.0.1:${(server.address() as any).port}/fixed`, signal: stop.signal });
		await until(async () => (await (await r.call('/status')).json() as any).connected);
		for (const body of [Buffer.from('{ "signed": "json", "id": 41 }\n'), Buffer.from(Array.from({ length: 65539 }, (_, i) => i % 256))]) {
			const headers = { authorization: 'Bearer dummy-app', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'dummy-key').update(body).digest('hex'), 'x-forwarded-for': 'forged', cookie: 'blocked' };
			const response = await r.forward(e.ingress, body, headers); assert.equal(response.status, 422); assert.equal(response.headers.get('x-signature'), 'dummy-signature'); assert.equal(response.headers.get('set-cookie'), null); assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
			assert.deepEqual(seen.at(-1).body, body); assert.equal(seen.at(-1).path, '/fixed'); assert.equal(seen.at(-1).headers['x-a2a-relay-authorization'], undefined); assert.equal(seen.at(-1).headers['x-forwarded-for'], undefined); assert.equal(seen.at(-1).headers.cookie, undefined);
		}
		const unauthorized = await r.forward(e.ingress); assert.equal(unauthorized.status, 401); assert.equal(await unauthorized.text(), 'application authorization failed');
		mode = 'encoded'; const compressed = await rawGet(new URL('/forward', r.url), { method: 'POST', headers: { 'x-a2a-relay-authorization': `Bearer ${e.ingress}`, 'x-a2a-relay-target': 'webhook', 'x-a2a-relay-method': 'POST' }, body: '{}' });
		assert.equal(compressed.headers['content-encoding'], 'gzip'); assert.deepEqual(compressed.body, signed); assert.equal(compressed.headers['x-body-signature'], hash(compressed.body.toString('base64')));
		mode = 'redirect'; const before = count; assert.equal((await r.forward(e.ingress)).status, 502); await delay(100); assert.equal(count, before + 1);
		mode = 'disconnect'; const preDisconnect = count; assert.equal((await r.forward(e.ingress)).status, 502); await delay(100); assert.equal(count, preDisconnect + 1);
		assert.equal((await r.forward(e.token)).status, 401); assert.equal((await r.forward(e.ingress, '{}', { 'x-a2a-relay-target': 'rpc' })).status, 400); assert.equal((await r.forward(e.ingress, Buffer.alloc(262145))).status, 413);
	} finally { stop.abort(); await connector; server.closeAllConnections(); await new Promise<void>(a => server.close(() => a())); await r.mf.dispose(); }
});

test('native SSE first chunk precedes completion, cancel aborts receiver; admission and revoke fence in-flight streams', { timeout: 30000 }, async () => {
	const r = await runtime(), stop = new AbortController(); let connector: Promise<void> | undefined; let closed = 0, posts = 0;
	const server = createServer(async (req, res) => { for await (const c of req) void c; posts++; res.on('close', () => closed++); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n'); const timer = setTimeout(() => res.end('data: second\n\n'), 1500); res.on('close', () => clearTimeout(timer)); });
	server.listen(0, '127.0.0.1'); await once(server, 'listening');
	try {
		const e = await r.enroll(); connector = runHttpConnector({ url: new URL('/relay/http/webhook/connect', r.url).href.replace('http:', 'ws:'), token: e.token, profile: 'webhook', localUrl: `http://127.0.0.1:${(server.address() as any).port}/events`, signal: stop.signal });
		await until(async () => (await (await r.call('/status')).json() as any).connected);
		const start = Date.now(), response = await r.forward(e.ingress); const reader = response.body!.getReader(); assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n'); assert.ok(Date.now() - start < 1200, 'first event delivered before upstream completion'); assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: second\n\n'); assert.equal((await reader.read()).done, true);
		const cancel = await r.forward(e.ingress); const cr = cancel.body!.getReader(); await cr.read(); const old = closed; await cr.cancel(); await until(() => closed > old);
		const waiting = Array.from({ length: 4 }, () => r.forward(e.ingress, '{}', {}, undefined, true)); await until(() => posts === 6); assert.equal((await r.forward(e.ingress)).status, 503);
		const refusal = assert.rejects(connector, /replaced or revoked/); await r.call('/disable', {}); await refusal; connector = undefined;
		for (const response of await Promise.all(waiting)) { assert.equal(response.status, 502); assert.deepEqual(await response.json(), { error: 'stream_failed' }); }
		assert.equal((await r.forward(e.ingress)).status, 401); assert.equal((await (await r.call('/status')).json() as any).connected, false); assert.equal(posts, 6);
	} finally { stop.abort(); await connector; server.closeAllConnections(); await new Promise<void>(a => server.close(() => a())); await r.mf.dispose(); }
});

test('framed workerd rejects unsolicited, out-of-order, oversized and stale responses, negotiates v2 and bounds slow-reader credit', { timeout: 30000 }, async () => {
	const r = await runtime(); const sockets: WebSocket[] = [];
	try {
		const e = await r.enroll(); const connect = async () => {
			const ws = new WebSocket(new URL('/relay/http/webhook/connect', r.url).href.replace('http:', 'ws:'), ['a2a-http-relay-v2', e.token]); sockets.push(ws); const messages: any[] = [];
			ws.addEventListener('message', ev => { if (ev.data !== 'pong') messages.push(JSON.parse(String(ev.data))); }); await once(ws, 'open'); await until(() => messages.length); const hello = messages[0];
			ws.send(JSON.stringify({ ...hello, type: 'ready' })); await until(async () => (await (await r.call('/status')).json() as any).connected); return { ws, messages, generation: hello.generation };
		};
		const c = await connect(); const send = (frame: any) => c.ws.send(JSON.stringify({ v: 2, generation: c.generation, ...frame }));
		const pending = r.forward(e.ingress, '{}', {}, undefined, true); await until(() => c.messages.some(m => m.type === 'request')); const req = c.messages.find(m => m.type === 'request');
		send({ type: 'start', id: req.id, status: 200, headers: [] }); await until(() => c.messages.some(m => m.type === 'credit'));
		// Runtime transport may read ahead, but it cannot receive a second chunk
		// until the consumer/runtime explicitly pulls, and never has >1 outstanding credit.
		const credits = c.messages.filter(m => m.type === 'credit'); assert.equal(credits.length, 1); assert.equal(credits[0].seq, 0);
		const closed = once(c.ws, 'close'); send({ type: 'chunk', id: req.id, seq: 1, body: 'eA==' }); assert.equal((await closed)[0].code, 4008); assert.equal((await pending).status, 502);
		for (const frame of ['garbage', JSON.stringify({ v: 2, type: 'end', generation: 0, id: crypto.randomUUID(), seq: 0 }), 'x'.repeat(393217)]) { const d = await connect(); const close = once(d.ws, 'close'); d.ws.send(frame); assert.equal((await close)[0].code, 4008); }
		const current = await connect(); const rotation = once(current.ws, 'close'); const rotated = await r.enroll(); assert.equal((await rotation)[0].code, 4001); assert.ok(rotated.generation > current.generation);
		for (const [token, protocol] of [[e.token, 'a2a-http-relay-v2'], [rotated.ingress, 'a2a-http-relay-v2'], [rotated.token, 'a2a-wake-v1']]) {
			const response = await r.mf.dispatchFetch('https://example.com/connect', { headers: { upgrade: 'websocket', 'sec-websocket-protocol': `${protocol}, ${token}` } }); assert.equal(response.status, 401);
		}
		assert.equal((await r.call('/connect?token=forbidden')).status, 400);
		for (const name of ['host', 'cookie', 'x-a2a-relay-authorization', 'x-forwarded-for', 'Authorization']) { const response = await r.call('/enroll', { credentialHash: hash(rotated.token), ingressHash: hash(rotated.ingress), profile: 'webhook', headers: [name] }); assert.equal(response.status, 400); }
		const a2a = await r.enroll('a2a'); assert.equal((await fetch(new URL('/a2a/forward', r.url), { method: 'POST', headers: { 'x-a2a-relay-authorization': `Bearer ${rotated.ingress}`, 'x-a2a-relay-target': 'card', 'x-a2a-relay-method': 'GET' } })).status, 401); assert.notEqual(a2a.ingress, rotated.ingress);
	} finally { for (const ws of sockets) ws.close(); await r.mf.dispose(); }
});

test('workerd header deadline returns 504, aborts local receiver and never replays the uncertain POST', { timeout: 20000 }, async () => {
	const r = await runtime(), stop = new AbortController(); let connector: Promise<void> | undefined, calls = 0, closed = 0;
	const server = createServer(async (req, res) => { for await (const c of req) void c; calls++; res.on('close', () => closed++); });
	server.listen(0, '127.0.0.1'); await once(server, 'listening');
	try {
		const e = await r.enroll(); connector = runHttpConnector({ url: new URL('/relay/http/webhook/connect', r.url).href.replace('http:', 'ws:'), token: e.token, profile: 'webhook', localUrl: `http://127.0.0.1:${(server.address() as any).port}/events`, signal: stop.signal });
		await until(async () => (await (await r.call('/status')).json() as any).connected);
		const result = await r.forward(e.ingress); assert.equal(result.status, 504); await until(() => closed === 1); await delay(100); assert.equal(calls, 1);
	} finally { stop.abort(); await connector; server.closeAllConnections(); await new Promise<void>(a => server.close(() => a())); await r.mf.dispose(); }
});

test('HTTP bridge qualification: post-header transport error must reject the native consumer, not cleanly truncate', { timeout: 15000 }, async () => {
	const r = await runtime(), stop = new AbortController(); let connector: Promise<void> | undefined;
	const server = createServer(async (req, res) => { for await (const c of req) void c; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: incomplete\n\n'); const timer = setTimeout(() => res.destroy(), 100); res.on('close', () => clearTimeout(timer)); });
	server.listen(0, '127.0.0.1'); await once(server, 'listening');
	try {
		const e = await r.enroll(); connector = runHttpConnector({ url: new URL('/relay/http/webhook/connect', r.url).href.replace('http:', 'ws:'), token: e.token, profile: 'webhook', localUrl: `http://127.0.0.1:${(server.address() as any).port}/events`, signal: stop.signal });
		await until(async () => (await (await r.call('/status')).json() as any).connected);
		const response = await r.forward(e.ingress); assert.equal(response.status, 200);
		// Deliberately strict qualification gate: a JS ReadableStream error is not
		// enough if the runtime's HTTP bridge swallows it and sends a clean EOF.
		await assert.rejects(response.arrayBuffer(), 'post-header uncertainty must remain observable at the native HTTP boundary');
	} finally { stop.abort(); await connector; server.closeAllConnections(); await new Promise<void>(a => server.close(() => a())); await r.mf.dispose(); }
});
