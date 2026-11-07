// Dependency-free, foreground-only wake connector. The destination is trusted local configuration.
import fs from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { owner, baseUrl } from "./commands.mjs";
import { CliError } from "./a2a.mjs";

const MAX_FRAME = 128 * 1024;
export function localDestination(value) {
	const u = new URL(value);
	if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || !['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname)) throw new Error("--local-url must be a fixed loopback HTTP(S) URL without credentials, query or fragment");
	return u.href;
}
export function relayEndpoint(value) {
	const u = new URL(value);
	if (!['wss:', 'ws:'].includes(u.protocol) || (u.protocol === 'ws:' && !['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname)) || u.username || u.password || u.search || u.hash || u.pathname !== '/relay/connect') throw new Error("relay URL must be wss://<agent>/relay/connect (ws loopback only for local tests)");
	return u.href;
}
export function protectedToken(file) {
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try { const stat = fs.fstatSync(fd); if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) || stat.size > 1024) throw new Error("relay token file must be a regular mode-600 file"); return fs.readFileSync(fd, "utf8").trim(); }
	finally { fs.closeSync(fd); }
}
export async function runConnector({ url, token, localUrl, signal, onReady = () => {} }) {
	url = relayEndpoint(url); localUrl = localDestination(localUrl);
	if (!/^a2ar_[A-Za-z0-9_-]{43}$/.test(token || '')) throw new Error("invalid relay credential");
	let attempt = 0;
	while (!signal?.aborted) {
		let permanent = false;
		await new Promise(resolve => {
			const ws = new WebSocket(url, ['a2a-wake-v1', token]);
			let generation, hello = false, ping;
			const active = new Map();
			const handshake = setTimeout(() => ws.close(), 10000);
			const shutdown = () => { for (const a of active.values()) a.abort(); ws.close(); finish(); };
			let finished = false;
			const finish = () => { if (finished) return; finished = true; clearTimeout(handshake); clearInterval(ping); for (const a of active.values()) a.abort(); active.clear(); signal?.removeEventListener('abort', shutdown); resolve(); };
			signal?.addEventListener('abort', shutdown, { once: true });
			ws.addEventListener('close', e => { if (e.code === 4001 || e.code === 1008) permanent = true; finish(); });
			ws.addEventListener('error', () => { ws.close(); finish(); });
			ws.addEventListener('message', async e => {
				if (finished) return;
				try {
					if (e.data === 'pong') return;
					if (typeof e.data !== 'string' || Buffer.byteLength(e.data) > MAX_FRAME) throw new Error();
					const m = JSON.parse(e.data);
					if (m.v !== 1 || !Number.isSafeInteger(m.generation) || m.generation < 1) throw new Error();
					if (!hello && m.type === 'hello' && Object.keys(m).sort().join(',') === 'generation,type,v') {
						generation = m.generation; hello = true; attempt = 0; clearTimeout(handshake);
						let pongAt = Date.now();
						ws.addEventListener('message', ev => { if (ev.data === 'pong') pongAt = Date.now(); });
						ping = setInterval(() => { if (Date.now() - pongAt > 75000) ws.close(); else if (ws.readyState === WebSocket.OPEN) ws.send('ping'); }, 25000);
						onReady({ generation }); return;
					}
					if (!hello || m.generation !== generation || typeof m.id !== 'string' || !/^[0-9a-f-]{36}$/.test(m.id)) throw new Error();
					if (m.type === 'cancel' && Object.keys(m).sort().join(',') === 'generation,id,type,v') { active.get(m.id)?.abort(); return; }
					if (m.type !== 'wake' || Object.keys(m).sort().join(',') !== 'body,deadline,generation,headers,id,type,v' || typeof m.body !== 'string' || Buffer.byteLength(m.body) > 65536 || !Number.isSafeInteger(m.deadline) || m.deadline <= Date.now() || m.deadline > Date.now() + 15000 || active.size >= 4 || active.has(m.id) || !m.headers || Array.isArray(m.headers) || typeof m.headers !== 'object') throw new Error();
					const headers = new Headers(); let headerSize = 0;
					for (const [k, v] of Object.entries(m.headers)) {
						if (typeof v !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(k) || /^(host|connection|upgrade|content-length|transfer-encoding|proxy-.*|sec-.*)$/i.test(k)) throw new Error();
						headerSize += k.length + v.length; if (headerSize > 16384) throw new Error(); headers.set(k, v);
					}
					const abort = new AbortController(); active.set(m.id, abort);
					const timeout = setTimeout(() => abort.abort(), Math.max(1, m.deadline - Date.now()));
					let status = 0;
					try { const r = await fetch(localUrl, { method: 'POST', headers, body: m.body, redirect: 'manual', signal: abort.signal }); status = r.status; await r.body?.cancel(); }
					catch { /* Execution may already have happened. Never retry the POST. */ }
					finally { clearTimeout(timeout); active.delete(m.id); }
					if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ v: 1, type: 'result', id: m.id, generation, status }));
				} catch { permanent = true; ws.close(1008, 'invalid relay frame'); }
			});
			if (signal?.aborted) shutdown();
		});
		if (permanent || signal?.aborted) return;
		const delay = Math.floor(Math.random() * Math.min(30000, 500 * 2 ** Math.min(attempt++, 6)));
		try { await sleep(delay, undefined, { signal }); } catch { return; }
	}
}

export async function relay(action, o) {
	if (!['create', 'status', 'revoke', 'run'].includes(action)) throw new CliError('usage: relay create|status|revoke|run (see --help)');
	const file = o['token-file'];
	if (action === 'run') {
		if (!o['local-url'] || (!file && !o['token-env']) || (file && o['token-env'])) throw new CliError('relay run requires --local-url and exactly one of --token-file or --token-env');
		const token = file ? protectedToken(file) : process.env[o['token-env']];
		const url = o.url || baseUrl().replace(/^http/, 'ws') + '/relay/connect';
		const stop = new AbortController(); const done = () => stop.abort();
		process.once('SIGINT', done); process.once('SIGTERM', done);
		try { await runConnector({ url, token, localUrl: o['local-url'], signal: stop.signal }); }
		finally { process.removeListener('SIGINT', done); process.removeListener('SIGTERM', done); }
		return;
	}
	if (action === 'create') {
		if (!file) throw new CliError('relay create requires --token-file (credential is never printed)');
		// Reserve before rotating remote authority; never overwrite a previous credential accidentally.
		const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
		try { const token = 'a2ar_' + randomBytes(32).toString('base64url'); fs.writeFileSync(fd, token + '\n'); fs.fsyncSync(fd); const result = await owner('POST', '/owner/wake/relay', { credentialHash: createHash('sha256').update(token).digest('hex'), idempotencyKey: randomBytes(24).toString('base64url'), ...(o['config-version'] ? { configVersion: Number(o['config-version']) } : {}) }); const confirmed = await owner("GET", "/owner/wake/relay"); if (!confirmed.enrolled || confirmed.generation !== result.generation) throw new Error("unconfirmed"); console.log(JSON.stringify({ enrolled: true, generation: result.generation, tokenFile: file })); }
		catch { throw new CliError('relay enrollment unconfirmed; credential file retained. Check relay status before rotating again'); } finally { fs.closeSync(fd); }
		return;
	}
	const current = await owner('GET', '/owner/wake/relay');
	if (action === 'status') return console.log(JSON.stringify(current));
	const result = await owner('DELETE', '/owner/wake/relay', { generation: current.generation });
	const confirmed = await owner('GET', '/owner/wake/relay');
	if (confirmed.enrolled || confirmed.connected || confirmed.generation !== result.generation) throw new CliError('relay revocation unconfirmed; check relay status');
	console.log(JSON.stringify(result));
}
