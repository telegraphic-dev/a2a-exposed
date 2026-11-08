import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { runConnector, reconnectDelay } from '../lib/relay.mjs';

const token = 'a2ar_' + 'x'.repeat(43);
const hello = Buffer.from(JSON.stringify({ v: 1, type: 'hello', generation: 1 }));
function accept(req, socket) {
	const hash = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
	socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${hash}\r\nSec-WebSocket-Protocol: a2a-wake-v1\r\n\r\n`);
	socket.write(Buffer.concat([Buffer.from([0x81, hello.length]), hello]));
}
async function peer(t, upgrade) {
	const sockets = new Set(), times = [];
	const server = createServer((_, res) => res.writeHead(500).end());
	server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}); });
	server.on('upgrade', (req, socket) => { times.push(performance.now()); upgrade(req, socket, times.length); });
	server.listen(0, '127.0.0.1'); await once(server, 'listening');
	t.after(async () => { for (const s of sockets) s.destroy(); await new Promise(r => server.close(r)); });
	const origin = `127.0.0.1:${server.address().port}`;
	return { times, url: `ws://${origin}/relay/connect`, localUrl: `http://${origin}/fixed` };
}
function frame(value) {
	const b = Buffer.from(JSON.stringify(value)), h = Buffer.alloc(b.length < 126 ? 2 : 4);
	h[0] = 0x81; h[1] = b.length < 126 ? b.length : 126;
	if (b.length >= 126) h.writeUInt16BE(b.length, 2);
	return Buffer.concat([h, b]);
}
function readResults(socket, onResult) {
	let pending = Buffer.alloc(0);
	socket.on('data', chunk => {
		pending = Buffer.concat([pending, chunk]);
		while (pending.length >= 2) {
			const op = pending[0] & 15, masked = pending[1] & 128;
			let size = pending[1] & 127, at = 2;
			if (size === 126) { if (pending.length < 4) return; size = pending.readUInt16BE(2); at = 4; }
			assert.notEqual(size, 127);
			if (pending.length < at + (masked ? 4 : 0) + size) return;
			const mask = pending.subarray(at, at + (masked ? 4 : 0)); at += mask.length;
			const body = Buffer.from(pending.subarray(at, at + size));
			if (masked) for (let i = 0; i < size; i++) body[i] ^= mask[i % 4];
			pending = pending.subarray(at + size);
			if (op === 8) socket.end(Buffer.concat([Buffer.from([0x88, body.length]), body]));
			if (op === 1) onResult(JSON.parse(body));
		}
	});
}
const wake = n => ({ v: 1, type: 'wake', generation: 1, id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, deadline: Date.now() + 10000, headers: {}, body: '{}' });
for (const scenario of ['clock +20s', 'clock -10s', 'four cancels then fifth']) test(`actual CLI stays connected: ${scenario}`, { timeout: 12000 }, async t => {
	const results = []; let child, output = '', posts = 0;
	const local = createServer((req, res) => { posts++; if (scenario !== 'four cancels then fifth') res.writeHead(204).end(); });
	local.listen(0, '127.0.0.1'); await once(local, 'listening');
	t.after(async () => { local.closeAllConnections(); await new Promise(r => local.close(r)); });
	const p = await peer(t, (req, socket) => {
		accept(req, socket); readResults(socket, result => results.push(result));
		if (scenario === 'four cancels then fifth') {
			const wakes = [1, 2, 3, 4].map(wake);
			socket.write(Buffer.concat([...wakes.map(frame), ...wakes.map(m => frame({ v: 1, type: 'cancel', generation: 1, id: m.id })), frame(wake(5))]));
		} else socket.write(frame(wake(1)));
	});
	const offset = scenario === 'clock +20s' ? 20000 : scenario === 'clock -10s' ? -10000 : 0;
	const preload = `const now=Date.now;Date.now=()=>now()+${offset};`;
	child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), new URL('../bin/a2a-exposed.mjs', import.meta.url).pathname, 'relay', 'run', '--url', p.url, '--local-url', `http://127.0.0.1:${local.address().port}/fixed`, '--token-env', 'TEST_RELAY_TOKEN'], { env: { ...process.env, TEST_RELAY_TOKEN: token, DO_NOT_TRACK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
	t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
	child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
	const deadline = performance.now() + 7000, expected = scenario === 'four cancels then fifth' ? 5 : 1;
	while (results.length < expected && performance.now() < deadline && child.exitCode === null) await new Promise(r => setTimeout(r, 10));
	assert.equal(results.length, expected, output); assert.equal(child.exitCode, null, output); assert.equal(p.times.length, 1);
	if (scenario === 'clock +20s') { assert.equal(posts, 0); assert.equal(results[0].status, 0); }
	if (scenario === 'clock -10s') { assert.equal(posts, 1); assert.equal(results[0].status, 204); }
	if (scenario === 'four cancels then fifth') { assert.equal(results.find(r => r.id === wake(5).id).status, 0); assert.ok(posts <= 4); }
	const closed = once(child, 'close'); child.kill('SIGTERM'); const [code, signal] = await closed;
	assert.equal(code, 0, output); assert.equal(signal, null); assert.doesNotMatch(output, /invalid frame|a2ar_|TEST_RELAY_TOKEN/);
});

function noHotLoop(times) {
	for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 480, 'every reconnect waits at least 500ms (20ms scheduler tolerance)');
}
for (const status of [401, 503]) test(`actual CLI bounds repeated handshake HTTP ${status} with sanitized recovery`, { timeout: 15000 }, async t => {
	const p = await peer(t, (_, socket) => socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\n\r\n`));
	const child = spawn(process.execPath, ['--import', 'data:text/javascript,Math.random=()=>0', new URL('../bin/a2a-exposed.mjs', import.meta.url).pathname, 'relay', 'run', '--url', p.url, '--local-url', p.localUrl, '--token-env', 'TEST_RELAY_TOKEN'], { env: { ...process.env, TEST_RELAY_TOKEN: token, DO_NOT_TRACK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
	t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
	let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
	const [code, signal] = await once(child, 'close');
	assert.equal(signal, null); assert.equal(code, 1); assert.equal(p.times.length, 3); noHotLoop(p.times);
	assert.match(output, /handshake failed three consecutive times; check endpoint, relay capability and credential enrollment/);
	assert.doesNotMatch(output, /a2ar_|TEST_RELAY_TOKEN|Refused/);
});

test('native hello timeout is distinct, diagnosed and bounded', { timeout: 15000 }, async t => {
	const p = await peer(t, () => {}), diagnostics = [], stop = new AbortController();
	t.after(() => stop.abort());
	await assert.rejects(runConnector({ ...p, token, signal: stop.signal, handshakeMs: 50, onDiagnostic: m => diagnostics.push(m) }), /handshake timed out three consecutive times/);
	assert.equal(p.times.length, 3); noHotLoop(p.times); assert.equal(diagnostics.length, 2);
	assert.ok(diagnostics.every(m => m.includes('handshake timed out')));
});

test('native transient failures recover, healthy hello resets failure budget, disconnects never hot-loop', { timeout: 15000 }, async t => {
	const stop = new AbortController(), diagnostics = []; let ready = 0;
	const p = await peer(t, (req, s, n) => {
		if ([1, 2, 4, 5].includes(n)) s.end('HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n');
		else { accept(req, s); if (n === 3) setTimeout(() => s.destroy(), 30); }
	});
	t.after(() => stop.abort());
	await runConnector({ ...p, token, signal: stop.signal, onDiagnostic: m => diagnostics.push(m), onReady: () => { if (++ready === 2) stop.abort(); } });
	assert.equal(ready, 2); assert.equal(p.times.length, 6); noHotLoop(p.times);
	assert.equal(diagnostics.length, 4); assert.match(diagnostics[2], /\(1\/3\)/);
});

test('reconnect delay has an unconditional floor and capped jitter', () => {
	for (const attempt of [0, 1, 6, 1000]) {
		assert.equal(reconnectDelay(attempt, () => 0), 500);
		assert.ok(reconnectDelay(attempt, () => 0.999999) < 30000);
	}
});
