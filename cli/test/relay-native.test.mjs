import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Minimal task-owned RFC 6455 peer: no WebSocket package or client substitution.
function frame(opcode, value) {
	const body = Buffer.from(value);
	const header = Buffer.alloc(body.length < 126 ? 2 : 4);
	header[0] = 0x80 | opcode;
	if (body.length < 126) header[1] = body.length;
	else { header[1] = 126; header.writeUInt16BE(body.length, 2); }
	return Buffer.concat([header, body]);
}

const cases = [
	['malformed JSON', () => ['not-json']],
	['invalid schema', () => [JSON.stringify({ v: 1, type: 'hello', generation: 1, unexpected: true })]],
	['hostile host forwarding header', () => [JSON.stringify({ v: 1, type: 'hello', generation: 1 }), JSON.stringify({ v: 1, type: 'wake', generation: 1, id: '00000000-0000-4000-8000-000000000001', deadline: Date.now() + 10000, headers: { host: 'example.com' }, body: '{}' })]],
	['close throws', () => ['not-json'], 'fault'],
	... [1008, 4001, 4008].map(code => [`server close ${code}`, () => [], code]),
];

for (const [name, messages, mode] of cases) test(`native CLI exits cleanly without retry or local POST: ${name}`, { timeout: 10000 }, async t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-native-'));
	const sockets = new Set();
	let connections = 0, posts = 0, closeCode;
	const server = createServer((req, res) => { posts++; res.writeHead(500).end(); });
	let child;
	t.after(async () => {
		if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
		for (const socket of sockets) socket.destroy();
		await new Promise(resolve => server.close(resolve));
		fs.rmSync(dir, { recursive: true, force: true });
	});
	server.on('upgrade', (req, socket) => {
		connections++; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
		assert.equal(req.url, '/relay/connect');
		const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: a2a-wake-v1\r\n\r\n`);
		let buffered = Buffer.alloc(0);
		socket.on('data', chunk => {
			buffered = Buffer.concat([buffered, chunk]);
			while (buffered.length >= 2) {
				const opcode = buffered[0] & 15, masked = buffered[1] & 128;
				let length = buffered[1] & 127, offset = 2;
				if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
				assert.notEqual(length, 127, 'fixture expects bounded client frames');
				if (buffered.length < offset + (masked ? 4 : 0) + length) return;
				const mask = buffered.subarray(offset, offset + (masked ? 4 : 0)); offset += mask.length;
				const body = Buffer.from(buffered.subarray(offset, offset + length));
				if (masked) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
				buffered = buffered.subarray(offset + length);
				if (opcode === 8) { closeCode = body.length >= 2 ? body.readUInt16BE(0) : 1005; socket.end(frame(8, body)); }
			}
		});
		if (typeof mode === 'number') { const body = Buffer.alloc(2); body.writeUInt16BE(mode); socket.write(frame(8, body)); }
		else for (const message of messages()) socket.write(frame(1, message));
	});
	server.listen(0, '127.0.0.1'); await once(server, 'listening');
	const origin = `127.0.0.1:${server.address().port}`;
	const args = [];
	if (mode === 'fault') {
		// Keep the real native socket; only its first cleanup call fails.
		const preload = `const close = WebSocket.prototype.close; let first = true; WebSocket.prototype.close = function (...args) { if (first) { first = false; throw new Error('injected close failure'); } return close.apply(this, args); };`;
		args.push('--import', 'data:text/javascript,' + encodeURIComponent(preload));
	}
	args.push(new URL('../bin/a2a-exposed.mjs', import.meta.url).pathname, 'relay', 'run', '--url', `ws://${origin}/relay/connect`, '--token-env', 'TEST_RELAY_TOKEN', '--local-url', `http://${origin}/fixed`);
	child = spawn(process.execPath, args, { cwd: dir, env: { ...process.env, A2A_CONFIG_DIR: dir, DO_NOT_TRACK: '1', TEST_RELAY_TOKEN: 'a2ar_' + 'x'.repeat(43) }, stdio: ['ignore', 'pipe', 'pipe'] });
	let output = '';
	child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
	const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
	const [code, signal] = await once(child, 'close'); clearTimeout(timer);
	assert.doesNotMatch(output, /InvalidAccessError|uncaught|unhandled|injected close failure/i);
	assert.equal(signal, null, output); assert.equal(code, 1, output);
	assert.match(output, /relay .*?(invalid frame|replaced or revoked|policy rejection)/);
	assert.doesNotMatch(output, /a2ar_|TEST_RELAY_TOKEN/);
	assert.equal(connections, 1, 'protocol rejection must not reconnect');
	assert.equal(posts, 0, 'invalid frames must not reach the local receiver');
	assert.equal(closeCode, typeof mode === 'number' ? mode : mode === 'fault' ? 1005 : 4008);
});
