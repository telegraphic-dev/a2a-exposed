import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

// Count real wire requests, not constructors or error events: Node 24's native
// Fetch path can repeat a rejected 401 handshake inside one constructor call.
for (const profile of ['wake', 'webhook', 'a2a']) for (const status of [401, 302]) {
	test(`${profile} relay sends one upgrade per bounded attempt on HTTP ${status}`, { timeout: 10000 }, async t => {
		const sockets = new Set(), times = [], keys = [];
		let receiverCalls = 0, child;
		const server = createServer((req, res) => { receiverCalls++; res.writeHead(500).end(); });
		server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
		server.on('upgrade', (req, socket) => {
			times.push(performance.now()); keys.push(req.headers['sec-websocket-key']);
			assert.equal(req.url, profile === 'wake' ? '/relay/connect' : `/relay/http/${profile}/connect`);
			assert.match(req.headers['sec-websocket-protocol'], profile === 'wake' ? /^a2a-wake-v1, a2ar_/ : /^a2a-http-relay-v2, a2ah_/);
			socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\nWWW-Authenticate: Basic realm="fixture"\r\nLocation: /must-not-follow\r\n\r\n`);
		});
		t.after(async () => {
			if (child && child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill('SIGKILL'); await closed; }
			for (const socket of sockets) socket.destroy();
			await new Promise(resolve => server.close(resolve));
		});
		server.listen(0, '127.0.0.1'); await once(server, 'listening');
		const origin = `127.0.0.1:${server.address().port}`;
		const module = new URL(profile === 'wake' ? '../lib/relay.mjs' : '../lib/http-relay.mjs', import.meta.url).href;
		const run = profile === 'wake' ? 'runConnector' : 'runHttpConnector';
		const options = { url: `ws://${origin}${profile === 'wake' ? '/relay/connect' : `/relay/http/${profile}/connect`}`, localUrl: `http://${origin}/receiver`, profile, token: (profile === 'wake' ? 'a2ar_' : 'a2ah_') + 'x'.repeat(43) };
		// A separate process keeps the native client and deterministic backoff
		// isolated from other tests; fixture credentials are not real secrets.
		const script = `import { ${run} as run } from ${JSON.stringify(module)}; Math.random=()=>0; try { await run(${JSON.stringify(options)}); process.exitCode=2; } catch(e) { console.error(e.message); process.exitCode=1; }`;
		child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, DO_NOT_TRACK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
		let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
		const [code, signal] = await once(child, 'close');
		assert.equal(signal, null, output); assert.equal(code, 1, output);
		assert.match(output, /handshake failed three consecutive times/);
		assert.doesNotMatch(output, /a2ar_|a2ah_|fixture|Refused|must-not-follow/);
		assert.equal(times.length, 3, 'three application attempts must produce exactly three wire upgrades');
		assert.equal(new Set(keys).size, 3, 'each application attempt uses a fresh handshake key');
		for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 480, 'every wire attempt observes the reconnect floor');
		assert.equal(receiverCalls, 0, 'no redirect or local delivery follows a rejected handshake');
	});
}
