import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runHttpConnector, relayHttp, httpLocalDestination } from '../lib/http-relay.mjs';

const TOKEN = 'a2ah_' + 'x'.repeat(43), CAPS = ['http-response-v1', 'response-stream-v1'];
const delay = n => new Promise(r => setTimeout(r, n));
async function until(fn, timeout = 4000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await delay(10); } throw new Error('condition timed out'); }
function frame(opcode, value) {
	const body = Buffer.from(value), header = Buffer.alloc(body.length < 126 ? 2 : body.length <= 65535 ? 4 : 10); header[0] = 0x80 | opcode;
	if (body.length < 126) header[1] = body.length; else if (body.length <= 65535) { header[1] = 126; header.writeUInt16BE(body.length, 2); } else { header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2); }
	return Buffer.concat([header, body]);
}
async function peer(t, onLocal = async (_req, res) => res.end('ok'), profile = 'webhook', autoHello = true) {
	const sockets = new Set(), messages = []; let wire, connections = 0, localCalls = 0;
	const server = createServer(async (req, res) => { localCalls++; await onLocal(req, res); });
	const send = m => wire.write(frame(1, typeof m === 'string' ? m : JSON.stringify({ v: 2, generation: 1, ...m })));
	server.on('upgrade', (req, socket) => {
		connections++; wire = socket; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
		assert.equal(req.url, `/relay/http/${profile}/connect`); assert.equal(req.headers.authorization, undefined); assert.equal(req.headers['sec-websocket-protocol'], `a2a-http-relay-v2, ${TOKEN}`);
		const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: a2a-http-relay-v2\r\n\r\n`);
		let buf = Buffer.alloc(0);
		socket.on('data', chunk => { buf = Buffer.concat([buf, chunk]); while (buf.length >= 2) {
			const op = buf[0] & 15, masked = !!(buf[1] & 128); let size = buf[1] & 127, offset = 2;
			if (size === 126) { if (buf.length < 4) return; size = buf.readUInt16BE(2); offset = 4; } else if (size === 127) { if (buf.length < 10) return; size = Number(buf.readBigUInt64BE(2)); offset = 10; }
			if (buf.length < offset + (masked ? 4 : 0) + size) return;
			const mask = masked ? buf.subarray(offset, offset + 4) : null; if (masked) offset += 4; const body = Buffer.from(buf.subarray(offset, offset + size)); buf = buf.subarray(offset + size);
			if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
			if (op === 8) { messages.push({ close: body.length >= 2 ? body.readUInt16BE(0) : 1005 }); socket.end(frame(8, body)); }
			else if (op === 1) { if (body.toString() === 'ping') socket.write(frame(1, 'pong')); else messages.push(JSON.parse(body)); }
		} });
		if (autoHello) send({ type: 'hello', profile, capabilities: CAPS });
	});
	server.listen(0, '127.0.0.1'); await once(server, 'listening');
	t.after(async () => { for (const s of sockets) s.destroy(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
	const base = `127.0.0.1:${server.address().port}`;
	return { url: `ws://${base}/relay/http/${profile}/connect`, localUrl: `http://${base}/fixed`, messages, send, close(code, reason) { const body = Buffer.alloc(2); body.writeUInt16BE(code); wire.write(frame(8, Buffer.concat([body, Buffer.from(reason)]))); }, server, connections: () => connections, localCalls: () => localCalls };
}
function start(t, p, options = {}) {
	const stop = new AbortController(); const result = runHttpConnector({ url: p.url, token: TOKEN, profile: 'webhook', localUrl: p.localUrl, signal: stop.signal, ...options });
	// Install a handler immediately: intentional protocol errors can settle before assertions.
	result.catch(() => {}); t.after(async () => { stop.abort(); await result.catch(() => {}); }); return { stop, result };
}
function request(p, { id = randomUUID(), timeoutMs = 60000, deadline = Date.now() + timeoutMs, target = 'webhook', method = 'POST', body = Buffer.from('{}'), headers = [] } = {}) { p.send({ type: 'request', id, timeoutMs, deadline, target, method, body: body.toString('base64'), headers }); return id; }

test('native response is credit-driven, preserves compressed bytes, cancels stalled reads and never replays', { timeout: 15000 }, async t => {
	const payload = gzipSync(Buffer.from('signed bytes'.repeat(10000))); let receiverClosed = false;
	const p = await peer(t, async (req, res) => { const chunks = []; for await (const c of req) chunks.push(c); assert.deepEqual(Buffer.concat(chunks), Buffer.from([0, 255, 128, 13, 10])); assert.equal(req.headers.authorization, 'Bearer original'); assert.equal(req.headers['x-hub-signature-256'], 'dummy-hmac'); assert.equal(req.headers['x-a2a-relay-authorization'], undefined); res.writeHead(200, { 'content-encoding': 'gzip', 'x-signature': 'signed', 'set-cookie': 'secret=1' }); res.end(payload); });
	const { result, stop } = start(t, p); await until(() => p.messages.some(m => m.type === 'ready'));
	const id = request(p, { body: Buffer.from([0, 255, 128, 13, 10]), headers: [['authorization', 'Bearer original'], ['x-hub-signature-256', 'dummy-hmac']] }); await until(() => p.messages.some(m => m.type === 'start'));
	await delay(100); assert.equal(p.messages.filter(m => m.type === 'chunk').length, 0, 'no response bytes without credit');
	const s = p.messages.find(m => m.type === 'start'); assert.ok(s.headers.some(([k, v]) => k === 'content-encoding' && v === 'gzip')); assert.ok(!s.headers.some(([k]) => k === 'set-cookie'));
	p.send({ type: 'credit', id, seq: 0 }); await until(() => p.messages.some(m => m.type === 'end')); assert.deepEqual(Buffer.concat(p.messages.filter(m => m.type === 'chunk').map(m => Buffer.from(m.body, 'base64'))), payload);
	assert.equal(p.localCalls(), 1); stop.abort(); await result;
	const slow = await peer(t, async (req, res) => { for await (const c of req) void c; res.on('close', () => { receiverClosed = true; }); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n'); });
	start(t, slow); await until(() => slow.messages.some(m => m.type === 'ready')); const sid = request(slow); await until(() => slow.messages.some(m => m.type === 'start')); slow.send({ type: 'credit', id: sid, seq: 0 }); await until(() => slow.messages.some(m => m.type === 'chunk')); slow.send({ type: 'cancel', id: sid }); await until(() => receiverClosed); await delay(100); assert.equal(slow.localCalls(), 1); assert.equal(slow.messages.filter(m => m.type === 'chunk').length, 1);
});

test('native first-header deadline, disconnect and redirects emit errors exactly once, local errors preserve status', { timeout: 15000 }, async t => {
	let mode = 'hang'; const p = await peer(t, async (req, res) => { for await (const c of req) void c; if (mode === 'redirect') res.writeHead(302, { location: '/must-not-follow' }).end(); else if (mode === 'disconnect') res.destroy(); else if (mode === 'reject') res.writeHead(503).end('local unavailable'); });
	start(t, p); await until(() => p.messages.some(m => m.type === 'ready'));
	const first = request(p, { timeoutMs: 100 }); await until(() => p.messages.some(m => m.type === 'error' && m.id === first)); assert.equal(p.messages.find(m => m.id === first).code, 'timeout');
	for (const next of ['redirect', 'disconnect']) { mode = next; const id = request(p); await until(() => p.messages.some(m => m.type === 'error' && m.id === id)); assert.equal(p.messages.find(m => m.id === id).code, 'local_failure'); }
	mode = 'reject'; const id = request(p); await until(() => p.messages.some(m => m.type === 'start' && m.id === id)); assert.equal(p.messages.find(m => m.id === id).status, 503); p.send({ type: 'credit', id, seq: 0 }); await until(() => p.messages.some(m => m.type === 'end' && m.id === id)); await delay(100); assert.equal(p.localCalls(), 4);
});

for (const [name, make] of [
	['malformed JSON', () => 'not-json'],
	['extra URL', () => ({ type: 'request', id: randomUUID(), timeoutMs: 1000, target: 'webhook', method: 'POST', headers: [], body: '', url: 'http://127.0.0.1/admin' })],
	['forbidden header', () => ({ type: 'request', id: randomUUID(), timeoutMs: 1000, target: 'webhook', method: 'POST', headers: [['host', 'evil']], body: '' })],
	['non-ByteString header', () => ({ type: 'request', id: randomUUID(), timeoutMs: 1000, target: 'webhook', method: 'POST', headers: [['authorization', '\u0100']], body: '' })],
	['expired budget', () => ({ type: 'request', id: randomUUID(), timeoutMs: 0, target: 'webhook', method: 'POST', headers: [], body: '' })],
	['unsolicited credit', () => ({ type: 'credit', id: randomUUID(), seq: 0 })],
	['oversized frame', () => 'x'.repeat(393217)],
	['old generation', () => ({ generation: 0, type: 'cancel', id: randomUUID() })],
]) test(`native invalid input closes 4008 without reconnect or receiver I/O: ${name}`, { timeout: 10000 }, async t => {
	const p = await peer(t); const { result } = start(t, p); await until(() => p.messages.some(m => m.type === 'ready')); const refused = assert.rejects(result, /invalid frame/); const invalid = make(); if (invalid?.type === 'request') invalid.deadline = Date.now() + 1000; p.send(invalid); await refused; await until(() => p.messages.some(m => m.close)); assert.equal(p.messages.find(m => m.close).close, 4008); await delay(50); assert.equal(p.connections(), 1); assert.equal(p.localCalls(), 0);
});

test('native refuses an expired absolute deadline before any local POST and accepts the next fresh call', { timeout: 10000 }, async t => {
	const p = await peer(t); start(t, p); await until(() => p.messages.some(m => m.type === 'ready'));
	const old = request(p, { deadline: Date.now() - 1 }); await until(() => p.messages.some(m => m.type === 'error' && m.id === old)); assert.equal(p.messages.find(m => m.id === old).code, 'timeout'); assert.equal(p.localCalls(), 0);
	const fresh = request(p); await until(() => p.messages.some(m => m.type === 'start' && m.id === fresh)); p.send({ type: 'credit', id: fresh, seq: 0 }); await until(() => p.messages.some(m => m.type === 'end' && m.id === fresh)); assert.equal(p.localCalls(), 1);
});

test('native fixed A2A card/RPC targets share normalized loopback origin, fixed local auth overrides only explicitly', { timeout: 10000 }, async t => {
	const paths = []; const p = await peer(t, async (req, res) => { for await (const c of req) void c; paths.push([req.url, req.method, req.headers.authorization]); res.end('{}'); }, 'a2a');
	start(t, p, { profile: 'a2a', cardUrl: p.localUrl.replace('/fixed', '/card'), localHeaders: { authorization: 'Bearer configured-single-principal' } }); await until(() => p.messages.some(m => m.type === 'ready'));
	for (const target of ['card', 'rpc']) { const id = request(p, { target, method: target === 'card' ? 'GET' : 'POST', body: Buffer.from(target === 'card' ? '' : '{}'), headers: [['authorization', 'Bearer caller']] }); await until(() => p.messages.some(m => m.type === 'start' && m.id === id)); p.send({ type: 'credit', id, seq: 0 }); await until(() => p.messages.some(m => m.type === 'end' && m.id === id)); }
	assert.deepEqual(paths, [['/card', 'GET', 'Bearer configured-single-principal'], ['/fixed', 'POST', 'Bearer configured-single-principal']]);
	assert.equal(httpLocalDestination('http://localhost:1234/rpc').hostname, '127.0.0.1');
	for (const url of ['https://127.0.0.1/rpc', 'http://example.com/rpc', 'http://127.0.0.1/rpc?token=x', 'http://u:p@127.0.0.1/rpc']) assert.throws(() => httpLocalDestination(url));
});

test('enrollment reserves BOTH files before owner request; unsafe flags/headers fail before I/O', async t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-relay-files-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); const first = path.join(dir, 'connector'), second = path.join(dir, 'ingress'); fs.writeFileSync(second, 'existing', { mode: 0o600 });
	await assert.rejects(relayHttp(['http', 'create'], { 'token-file': first, 'ingress-token-file': second }), /reserve both/); assert.equal(fs.existsSync(first), false); assert.equal(fs.readFileSync(second, 'utf8'), 'existing');
	await assert.rejects(relayHttp(['http', 'create'], { 'token-file': first, 'ingress-token-file': second, 'forward-headers': 'host' }), /forward-headers/); assert.equal(fs.existsSync(first), false);
	await assert.rejects(relayHttp(['http', 'create'], { 'token-file': first, surprise: true }), /unsupported/); assert.equal(fs.existsSync(first), false);
});

test('native response chunk/total bounds and four-request admission remain finite under slow credit', { timeout: 15000 }, async t => {
	const payload = Buffer.alloc(1048577, 0xab); let closed = false;
	const p = await peer(t, async (req, res) => { for await (const c of req) void c; res.on('close', () => { closed = true; }); res.writeHead(200); res.end(payload); });
	start(t, p); await until(() => p.messages.some(m => m.type === 'ready')); const id = request(p); await until(() => p.messages.some(m => m.type === 'start'));
	let seq = 0, bytes = 0;
	while (!p.messages.some(m => m.type === 'error')) {
		p.send({ type: 'credit', id, seq }); await until(() => p.messages.some(m => m.id === id && ((m.type === 'chunk' && m.seq === seq) || m.type === 'error')));
		const chunk = p.messages.find(m => m.type === 'chunk' && m.seq === seq); if (chunk) { const n = Buffer.from(chunk.body, 'base64').length; assert.ok(n > 0 && n <= 16384); bytes += n; seq++; } else break;
	}
	assert.ok(bytes <= 1048576); assert.equal(p.messages.filter(m => m.type === 'end').length, 0); assert.equal(p.messages.find(m => m.type === 'error').code, 'local_failure'); await until(() => closed); assert.equal(p.localCalls(), 1);
	const slow = await peer(t, async (req, res) => { for await (const c of req) void c; res.writeHead(200); res.write('blocked'); }); const { result } = start(t, slow); await until(() => slow.messages.some(m => m.type === 'ready'));
	for (let i = 0; i < 4; i++) request(slow); await until(() => slow.messages.filter(m => m.type === 'start').length === 4); const denied = assert.rejects(result, /invalid frame/); request(slow); await denied; assert.equal(slow.localCalls(), 4);
});

test('actual CLI enrollment hashes distinct protected files before remote mutation and confirms owner state', { timeout: 15000 }, async t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-enroll-child-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const first = path.join(dir, 'connector'), second = path.join(dir, 'ingress'); let calls = 0;
	const server = createServer(async (req, res) => {
		calls++; assert.equal(req.url, '/owner/relay/http/webhook'); assert.equal(req.headers.authorization, 'Bearer dummy-owner');
		assert.equal(fs.statSync(first).mode & 0o777, 0o600); assert.equal(fs.statSync(second).mode & 0o777, 0o600);
		const connector = fs.readFileSync(first, 'utf8').trim(), ingress = fs.readFileSync(second, 'utf8').trim(); assert.match(connector, /^a2ah_[A-Za-z0-9_-]{43}$/); assert.match(ingress, /^a2ai_[A-Za-z0-9_-]{43}$/);
		if (req.method === 'POST') { let raw = ''; for await (const c of req) raw += c; const body = JSON.parse(raw); assert.deepEqual(body, { credentialHash: createHash('sha256').update(connector).digest('hex'), ingressHash: createHash('sha256').update(ingress).digest('hex'), headers: ['authorization', 'content-type', 'accept', 'x-hub-signature-256'] }); assert.ok(!raw.includes(connector) && !raw.includes(ingress)); }
		else assert.equal(req.method, 'GET'); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ enrolled: true, generation: 1 }));
	});
	server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
	const child = spawn(process.execPath, [new URL('../bin/a2a-exposed.mjs', import.meta.url).pathname, 'relay', 'http', 'create', '--token-file', first, '--ingress-token-file', second, '--forward-headers', 'authorization,content-type,accept,x-hub-signature-256'], { cwd: dir, env: { ...process.env, A2A_CONFIG_DIR: dir, A2A_BASE_URL: `http://127.0.0.1:${server.address().port}`, A2A_OWNER_TOKEN: 'dummy-owner', DO_NOT_TRACK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
	let output = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c); const [code, signal] = await once(child, 'close'); assert.equal(code, 0, output); assert.equal(signal, null, output); assert.equal(calls, 2); assert.doesNotMatch(output, /a2ah_|a2ai_|dummy-owner/); assert.equal(JSON.parse(output).enrolled, true);
});

for (const scenario of [4001, 4008, 1008, 'v1', 'future', 'missing capability']) test(`actual CLI terminal recovery is fixed and secret-free: ${scenario}`, { timeout: 10000 }, async t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-terminal-child-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, 'token'); fs.writeFileSync(file, TOKEN, { mode: 0o600 });
	const p = await peer(t, undefined, 'webhook', false);
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:WAKE_|A2A_|CF_|CLOUDFLARE_)/.test(k)));
	const child = spawn(process.execPath, [new URL('../bin/a2a-exposed.mjs', import.meta.url).pathname, 'relay', 'http', 'run', '--url', p.url, '--token-file', file, '--local-url', p.localUrl], { cwd: dir, env: { ...env, A2A_CONFIG_DIR: dir, DO_NOT_TRACK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
	t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
	let output = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
	await until(() => p.connections());
	if (typeof scenario === 'number') p.close(scenario, 'upstream-private-secret https://private.example.com');
	else p.send({ type: 'hello', profile: 'webhook', capabilities: scenario === 'missing capability' ? [] : CAPS, v: scenario === 'v1' ? 1 : scenario === 'future' ? 3 : 2 });
	const [code, signal] = await once(child, 'close'); assert.equal(code, 1, output); assert.equal(signal, null);
	assert.match(output, /relay http status/); assert.match(output, /compatib/i);
	if (scenario === 4001) assert.match(output, /owner approval/);
	assert.doesNotMatch(output, /upstream-private-secret|private\.example|a2ah_|a2ai_|127\.0\.0\.1|uncaught|unhandled/);
	assert.equal(p.connections(), 1); assert.equal(p.localCalls(), 0);
});

test('actual CLI child malformed protocol exits cleanly even when native close throws', { timeout: 10000 }, async t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-relay-child-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); const file = path.join(dir, 'token'); fs.writeFileSync(file, TOKEN, { mode: 0o600 });
	const p = await peer(t, undefined, 'webhook', false);
	const preload = `const close=WebSocket.prototype.close;let first=true;WebSocket.prototype.close=function(...args){if(first){first=false;throw new Error('fault');}return close.apply(this,args);};`;
	const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), new URL('../bin/a2a-exposed.mjs', import.meta.url).pathname, 'relay', 'http', 'run', '--url', p.url, '--token-file', file, '--local-url', p.localUrl], { cwd: dir, env: { ...process.env, A2A_CONFIG_DIR: dir, DO_NOT_TRACK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
	t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); }); let output = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
	await until(() => p.connections()); p.send('not-json'); const [status, signal] = await once(child, 'close'); assert.equal(status, 1, output); assert.equal(signal, null, output); assert.match(output, /invalid frame/); assert.doesNotMatch(output, /uncaught|unhandled|InvalidAccessError|a2ah_|fault/); assert.equal(p.connections(), 1); assert.equal(p.localCalls(), 0);
});
