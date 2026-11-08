import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { runHttpConnector } from '../../cli/lib/http-relay.mjs';
import { AgentCard, SendMessageRequest } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const delay = (n: number) => new Promise(r => setTimeout(r, n));
async function until(fn: () => unknown, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await delay(10); } throw new Error('condition timed out'); }
async function runtime() {
	// Test-only direct DO routing, not production owner/tenant admission.
	const built = await build({ stdin: { contents: `import { HttpRelay } from './src/http-relay.ts'; import { routeHttpRelay } from './src/http-relay-routing.ts'; export { HttpRelay };
export default { async fetch(req,env) { const u = new URL(req.url); if (u.pathname.startsWith('/relay/a2a')) return routeHttpRelay(req,{httpRelayNamespace:env.HTTP_RELAY,mode:'single',id:'',gates:{dataRegion:'default'},PUBLIC_URL:'https://agent.example.com'}); const profile = u.pathname.includes('/a2a/') ? 'a2a' : 'webhook'; const checked = u.pathname === '/checked-forward'; const path = checked ? '/forward' : u.pathname.endsWith('/connect') ? '/connect' : u.pathname.replace('/a2a',''); u.pathname = path; const response = await env.HTTP_RELAY.get(env.HTTP_RELAY.idFromName('http-relay-v2:single:self:'+profile)).fetch(new Request(u,req)); if (!checked || !response.ok) return response; try { await response.arrayBuffer(); return Response.json({status:response.status}); } catch { return Response.json({error:'stream_failed'},{status:502}); } } };`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:*'] });
	const mf = new Miniflare(convertV4MiniflareOptions({ name: 'http-transport-test', modules: true, script: built.outputFiles[0].text, compatibilityDate: '2026-10-06', compatibilityFlags: ['enable_request_signal'], durableObjects: { HTTP_RELAY: { className: 'HttpRelay', useSQLite: true } } }));
	const url = await mf.ready;
	const call = (path: string, body?: unknown) => fetch(new URL(path, url), { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	const enroll = async (profile = 'webhook', headers = ['content-type', 'accept', 'authorization', 'x-hub-signature-256']) => {
		const token = 'a2ah_' + randomBytes(32).toString('base64url'), ingress = 'a2ai_' + randomBytes(32).toString('base64url');
		const response = await call(profile === 'a2a' ? '/a2a/enroll' : '/enroll', { credentialHash: hash(token), ingressHash: hash(ingress), headers, profile }); assert.equal(response.status, 200); return { token, ingress, ...await response.json() as any };
	};
	const forward = (ingress: string, body: Buffer | string = '{}', extra: Record<string, string> = {}, signal?: AbortSignal, checked = false) => fetch(new URL(checked ? '/checked-forward' : '/forward', url), { method: 'POST', headers: { 'x-a2a-relay-authorization': `Bearer ${ingress}`, 'x-a2a-relay-target': 'webhook', 'x-a2a-relay-method': 'POST', ...extra }, body, signal });
	const nativeForward = (ingress: string, signal?: AbortSignal, id: string | number = 'native-stream') => fetch(new URL('/relay/a2a', url), { method: 'POST', headers: { 'x-a2a-relay-authorization': `Bearer ${ingress}` }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'message/stream', params: {} }), signal });
	return { mf, url, call, enroll, forward, nativeForward };
}
async function* dataEvents(response: Response) {
	const reader = response.body!.getReader(); const decoder = new TextDecoder(); let text = '';
	try {
		for (;;) {
			const { done, value } = await reader.read(); if (done) break;
			text += decoder.decode(value, { stream: true });
			let boundary;
			while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(text))) {
				const record = text.slice(0, boundary.index); text = text.slice(boundary.index + boundary[0].length);
				const data = record.split(/\r\n|\n|\r/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, ''));
				if (data.length) yield data.join('\n');
			}
		}
	} finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
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

test('native SSE first event precedes completion, abort terminates receiver; admission and revoke fence in-flight streams', { timeout: 30000 }, async () => {
	const r = await runtime(), stop = new AbortController(); let connector: Promise<void> | undefined; let aborted = 0, posts = 0;
	const server = createServer(async (req, res) => { for await (const c of req) void c; posts++; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n'); const timer = setTimeout(() => res.end('data: second\n\n'), 1500); res.on('close', () => { if (!res.writableEnded) aborted++; clearTimeout(timer); }); });
	server.listen(0, '127.0.0.1'); await once(server, 'listening');
	try {
		const e = await r.enroll('a2a'); connector = runHttpConnector({ url: new URL('/relay/http/a2a/connect', r.url).href.replace('http:', 'ws:'), token: e.token, profile: 'a2a', localUrl: `http://127.0.0.1:${(server.address() as any).port}/events`, signal: stop.signal });
		await until(async () => (await (await r.call('/a2a/status')).json() as any).connected);
		const start = Date.now(), response = await r.nativeForward(e.ingress); const events = dataEvents(response); assert.equal((await events.next()).value, 'first'); assert.ok(Date.now() - start < 1200, 'first event delivered before upstream completion'); assert.equal((await events.next()).value, 'second'); assert.equal((await events.next()).done, true);
		const cancel = new AbortController(); const cancelled = await r.nativeForward(e.ingress, cancel.signal); const cancelledEvents = dataEvents(cancelled); assert.equal((await cancelledEvents.next()).value, 'first'); cancel.abort(); await cancelledEvents.return(undefined).catch(() => {}); await until(() => aborted === 1, 1000);
		const waiting = Array.from({ length: 4 }, () => r.nativeForward(e.ingress)); await until(() => posts === 6); assert.equal((await r.nativeForward(e.ingress)).status, 503);
		const refusal = assert.rejects(connector, /replaced or revoked/); await fetch(new URL('/a2a/disable', r.url), { method: 'POST' }); await refusal; connector = undefined;
		for (const response of await Promise.all(waiting)) { assert.equal(response.status, 200); const events: string[] = []; for await (const event of dataEvents(response)) events.push(event); const error = JSON.parse(events.at(-1)!); assert.equal(error.id, 'native-stream'); assert.equal(error.error.data.code, 'delivery_uncertain'); }
		assert.equal((await r.nativeForward(e.ingress)).status, 401); assert.equal((await (await r.call('/a2a/status')).json() as any).connected, false); assert.equal(posts, 6);
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

test('disable generation CAS preserves current authority; bodyless lifecycle disable always fences', { timeout: 15000 }, async () => {
	const r = await runtime();
	try {
		const first = await r.enroll();
		const current = await r.enroll();
		const before = await (await r.call('/status')).json();
		assert.equal((await r.call('/disable', { generation: first.generation })).status, 409);
		assert.deepEqual(await (await r.call('/status')).json(), before);
		assert.equal((await r.forward(current.ingress)).status, 503, 'current ingress remains authorized, but connector is offline');
		assert.equal((await fetch(new URL('/disable', r.url), { method: 'POST' })).status, 200);
		const disabled = await (await r.call('/status')).json() as any;
		assert.equal(disabled.enabled, false); assert.equal(disabled.enrolled, false); assert.equal(disabled.generation, current.generation + 1);
		assert.equal((await r.forward(current.ingress)).status, 401);
		const reenrolled = await r.enroll();
		assert.equal((await r.call('/disable', { generation: reenrolled.generation })).status, 200);
		assert.equal((await r.forward(reenrolled.ingress)).status, 401);
	} finally { await r.mf.dispose(); }
});

test('official SDK rejects native SSE uncertainty for 1.0 and 0.3, including split/partial records without fabricated completion', { timeout: 20000 }, async () => {
	const r = await runtime(), stop = new AbortController(); let connector: Promise<void> | undefined; let calls = 0, mode = 'disconnect';
	const ids: unknown[] = [];
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
		const input = JSON.parse(Buffer.concat(chunks).toString()); calls++; ids.push(input.id);
		const legacy = input.method.includes('/');
		const task = { id: 'native-task', contextId: 'native-context', status: { state: legacy ? 'working' : 'TASK_STATE_WORKING' }, ...(legacy ? { kind: 'task' } : {}) };
		const first = `data: ${JSON.stringify({ jsonrpc: '2.0', id: input.id, result: legacy ? task : { task } })}\n\n`;
		res.writeHead(200, { 'content-type': 'text/event-stream', ...(mode === 'encoded' ? { 'content-encoding': 'gzip' } : {}) }); res.write(first.slice(0, 20));
		const finishRecord = setTimeout(() => res.write(first.slice(20)), 220);
		const fail = setTimeout(() => { if (mode !== 'disconnect') res.write('data: {"jsonrpc":"2.0","result":'); if (mode === 'incomplete-end') res.end(); else res.destroy(); }, 450);
		res.on('close', () => { clearTimeout(finishRecord); clearTimeout(fail); });
	});
	server.listen(0, '127.0.0.1'); await once(server, 'listening');
	try {
		const e = await r.enroll('a2a'); connector = runHttpConnector({ url: new URL('/relay/http/a2a/connect', r.url).href.replace('http:', 'ws:'), token: e.token, profile: 'a2a', localUrl: `http://127.0.0.1:${(server.address() as any).port}/rpc`, signal: stop.signal });
		await until(async () => (await (await r.call('/a2a/status')).json() as any).connected);
		const fetchImpl: typeof fetch = async (input, init) => { const request = new Request(input, init); request.headers.set('x-a2a-relay-authorization', `Bearer ${e.ingress}`); return fetch(request); };
		for (const protocolVersion of ['1.0', '0.3']) {
			const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl, legacyCompat: { enabled: true } })] }).createFromAgentCard(AgentCard.fromJSON({ name: 'fixture', supportedInterfaces: [{ url: new URL('/relay/a2a/', r.url).href, protocolBinding: 'JSONRPC', protocolVersion }], capabilities: { streaming: true }, skills: [] }));
			for (mode of ['disconnect', 'partial-disconnect', 'incomplete-end']) {
				const stream = client.sendMessageStream(SendMessageRequest.fromJSON({ message: { messageId: 'error-probe', role: 'ROLE_USER', parts: [{ text: 'fixture' }] } }));
				const first = await stream.next(); assert.equal(first.done, false); assert.equal(first.value?.payload?.value.id, 'native-task');
				await assert.rejects(stream.next(), /Relay delivery uncertain/, `${protocolVersion}/${mode}: protocol error must reject, never look like successful end`);
			}
		}
		assert.equal(calls, 6, 'uncertain native requests are never replayed'); assert.equal(ids.length, 6);
		const response = await r.nativeForward(e.ingress, undefined, 'original-error-id');
		const events: string[] = []; for await (const event of dataEvents(response)) events.push(event);
		assert.deepEqual(JSON.parse(events.at(-1)!), { jsonrpc: '2.0', id: 'original-error-id', error: { code: -32603, message: 'Relay delivery uncertain', data: { code: 'delivery_uncertain' } } });
		mode = 'encoded'; const encoded = await r.nativeForward(e.ingress);
		assert.equal(encoded.status, 502); assert.deepEqual(await encoded.json(), { error: 'unsupported_stream_encoding' });
		assert.equal(calls, 8);
	} finally { stop.abort(); await connector; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await r.mf.dispose(); }
});

test('finite generic responses fail with 502 before public headers on mid-body transport failure, never a truncated 200', { timeout: 15000 }, async () => {
	const r = await runtime(), stop = new AbortController(); let connector: Promise<void> | undefined;
	const server = createServer(async (req, res) => { for await (const c of req) void c; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: incomplete\n\n'); const timer = setTimeout(() => res.destroy(), 100); res.on('close', () => clearTimeout(timer)); });
	server.listen(0, '127.0.0.1'); await once(server, 'listening');
	try {
		const e = await r.enroll(); connector = runHttpConnector({ url: new URL('/relay/http/webhook/connect', r.url).href.replace('http:', 'ws:'), token: e.token, profile: 'webhook', localUrl: `http://127.0.0.1:${(server.address() as any).port}/events`, signal: stop.signal });
		await until(async () => (await (await r.call('/status')).json() as any).connected);
		const response = await r.forward(e.ingress); assert.equal(response.status, 502);
		assert.deepEqual(await response.json(), { error: 'delivery_uncertain' });
	} finally { stop.abort(); await connector; server.closeAllConnections(); await new Promise<void>(a => server.close(() => a())); await r.mf.dispose(); }
});
