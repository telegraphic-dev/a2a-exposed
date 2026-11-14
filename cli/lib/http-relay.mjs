/**
 * Dependency-free HTTP relay v2 connector. Public CLI API:
 * default/named relayHttp(args,flags), args=['http'|'a2a',action].
 * Harness API runHttpConnector({url,token,profile,localUrl,cardUrl?,localHeaders?,
 * signal,onReady?,onDiagnostic?,handshakeMs?}). No URL ever arrives in a frame.
 * Wire grammar is documented in worker/src/http-relay.ts. Each credit(seq)
 * grants exactly one <=16KiB chunk. Raw node:http preserves encoded/signed bytes.
 * Shutdown/cancel aborts local I/O; no request is replayed after uncertainty.
 */
import fs from 'node:fs';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { CliError } from './a2a.mjs';
import { owner, ownerTry, baseUrl } from './commands.mjs';
import { get as configGet } from './config.mjs';
import { protectedToken, reconnectDelay } from './relay.mjs';
import { relayDispatcher } from './relay-dispatcher.mjs';

const PROTOCOL = 'a2a-http-relay-v2';
const CAPS = ['http-response-v1', 'response-stream-v1'];
export const httpRelayLimits = Object.freeze({ maxInflight: 4, requestBytes: 262144, chunkBytes: 16384, responseBytes: 1048576, frameBytes: 393216, headerBytes: 16384, headerMs: 10000, streamMs: 60000 });
const exact = (m, fields) => Object.keys(m).sort().join(',') === fields.split(',').sort().join(',');
const headerAllowed = name => typeof name === 'string' && /^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name) && !/^(?:host|connection|upgrade|keep-alive|te|trailer|transfer-encoding|content-length|expect|origin|cookie|set-cookie|location|forwarded|via|proxy-.*|sec-.*|cf-.*|x-forwarded-.*|x-a2a-.*|x-owner-.*)$/i.test(name);
const valueValid = v => typeof v === 'string' && v.length <= 8192 && !/[^\t\x20-\x7e\x80-\xff]/.test(v);
function headersValid(pairs) {
	return Array.isArray(pairs) && pairs.length <= 64 && pairs.every(p => Array.isArray(p) && p.length === 2 && headerAllowed(p[0]) && valueValid(p[1])) && pairs.reduce((n, p) => n + p[0].length + p[1].length, 0) <= httpRelayLimits.headerBytes;
}
function decode(value, limit) {
	if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error();
	const body = Buffer.from(value, 'base64'); if (body.length > limit || body.toString('base64') !== value) throw new Error(); return body;
}
export function httpLocalDestination(value) {
	let u; try { u = new URL(value); } catch { throw new CliError('invalid fixed loopback HTTP destination'); }
	if (u.protocol !== 'http:' || u.username || u.password || u.search || u.hash || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new CliError('local destinations require loopback HTTP without credentials, query or fragment');
	// Pin localhost to loopback rather than relying on machine DNS configuration.
	if (u.hostname === 'localhost') u.hostname = '127.0.0.1'; return u;
}
export function httpRelayEndpoint(value, profile) {
	let u; try { u = new URL(value); } catch { throw new CliError('invalid HTTP relay WebSocket endpoint'); }
	if (!['wss:', 'ws:'].includes(u.protocol) || (u.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) || u.username || u.password || u.search || u.hash || u.pathname !== `/relay/http/${profile}/connect`) throw new CliError('HTTP relay URL must be the fixed /relay/http/<profile>/connect wss endpoint (ws loopback only)');
	return u.href;
}
function protectedHeaders(file) {
	let fd;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); const s = fs.fstatSync(fd);
		if (!s.isFile() || (s.mode & 0o777) !== 0o600 || (process.getuid && s.uid !== process.getuid()) || s.size > 16384) throw new Error();
		const value = JSON.parse(fs.readFileSync(fd, 'utf8')); if (!value || typeof value !== 'object' || Array.isArray(value) || !headersValid(Object.entries(value))) throw new Error();
		return value;
	} catch { throw new CliError('local headers require a regular owner-only mode-600 JSON file with safe header names/values'); }
	finally { if (fd !== undefined) fs.closeSync(fd); }
}
export async function runHttpConnector({ url, token, profile, localUrl, cardUrl, localHeaders = {}, signal, onReady = () => {}, onDiagnostic = m => console.error(m), handshakeMs = 10000 }) {
	if (!['webhook', 'a2a'].includes(profile)) throw new CliError('invalid HTTP relay profile');
	url = httpRelayEndpoint(url, profile); const local = httpLocalDestination(localUrl);
	const card = profile === 'a2a' ? httpLocalDestination(cardUrl || new URL('/.well-known/agent-card.json', local).href) : null;
	if (card && card.origin !== local.origin) throw new CliError('card URL must share the fixed RPC loopback origin');
	if (!/^a2ah_[A-Za-z0-9_-]{43}$/.test(token || '')) throw new CliError('invalid HTTP connector credential; use a fresh protected token file');
	if (!localHeaders || typeof localHeaders !== 'object' || Array.isArray(localHeaders) || !headersValid(Object.entries(localHeaders))) throw new CliError('invalid fixed local headers');
	const statusGuidance = `run relay ${profile === 'webhook' ? 'http' : 'a2a'} status and check Worker/connector v2 compatibility`;
	let failures = 0, attempt = 0;
	while (!signal?.aborted) {
		let permanent, helloReceived = false;
		await new Promise(resolve => {
			let ws; try { ws = new WebSocket(url, { protocols: [PROTOCOL, token], dispatcher: relayDispatcher }); } catch { permanent = 'HTTP relay connection setup failed; Node 22.18+ is required'; resolve(); return; }
			let generation, hello = false, finished = false, ping, pongAt = Date.now();
			const active = new Map(), retired = new Set();
			const remember = id => { retired.add(id); if (retired.size > 64) retired.delete(retired.values().next().value); };
			const handshake = setTimeout(() => close(), handshakeMs);
			const stop = () => close();
			const finish = () => {
				if (finished) return; finished = true; clearTimeout(handshake); clearInterval(ping); signal?.removeEventListener('abort', stop);
				for (const a of active.values()) a.cancel(); active.clear(); resolve();
			};
			const close = (code, reason) => { if (finished) return; finish(); try { ws.close(code, reason); } catch { try { ws.close(); } catch { /* already settled */ } } };
			const send = frame => {
				if (finished || ws.readyState !== WebSocket.OPEN) return false;
				if (ws.bufferedAmount > 128 * 1024) { close(); return false; }
				try { ws.send(JSON.stringify({ v: 2, generation, ...frame })); return true; } catch { close(); return false; }
			};
			const invalid = () => { permanent = `HTTP relay invalid frame; ${statusGuidance}`; close(4008, 'invalid relay frame'); };
			signal?.addEventListener('abort', stop, { once: true });
			ws.addEventListener('error', () => close());
			ws.addEventListener('close', e => { if (!finished && [4001, 4008, 1008].includes(e.code)) permanent = e.code === 4001 ? `HTTP relay connector replaced or revoked; ${statusGuidance}. Enrollment or rotation requires owner approval; do not automatically create again` : `HTTP relay policy rejection; ${statusGuidance} and approved relay settings`; finish(); });
			ws.addEventListener('message', e => {
				if (finished) return;
				try {
					if (e.data === 'pong') { pongAt = Date.now(); return; }
					if (typeof e.data !== 'string' || Buffer.byteLength(e.data) > httpRelayLimits.frameBytes) throw new Error();
					const m = JSON.parse(e.data);
					if (!m || m.v !== 2 || !Number.isSafeInteger(m.generation) || m.generation < 1) throw new Error();
					if (!hello && m.type === 'hello' && exact(m, 'v,type,generation,profile,capabilities') && m.profile === profile && JSON.stringify(m.capabilities) === JSON.stringify(CAPS)) {
						generation = m.generation; hello = true; helloReceived = true; failures = 0; attempt = 0; clearTimeout(handshake);
						send({ type: 'ready', profile, capabilities: CAPS });
						ping = setInterval(() => { if (Date.now() - pongAt > 75000) close(); else try { ws.send('ping'); } catch { close(); } }, 25000);
						onReady({ generation, profile, capabilities: CAPS }); return;
					}
					if (!hello || m.generation !== generation || typeof m.id !== 'string' || !/^[0-9a-f-]{36}$/.test(m.id)) throw new Error();
					if (m.type === 'cancel' && exact(m, 'v,type,generation,id')) { const a = active.get(m.id); if (a) { active.delete(m.id); remember(m.id); a.cancel(); } else if (!retired.has(m.id)) throw new Error(); return; }
					if (m.type === 'credit' && exact(m, 'v,type,generation,id,seq') && Number.isSafeInteger(m.seq) && m.seq >= 0) {
						const a = active.get(m.id); if (!a) { if (retired.has(m.id)) return; throw new Error(); }
						if (!a.started || a.credit || m.seq !== a.seq) throw new Error(); a.credit = true; a.wake?.(); return;
					}
					if (m.type !== 'request' || !exact(m, 'v,type,generation,id,target,method,headers,body,timeoutMs,deadline') || active.has(m.id) || retired.has(m.id) || !Number.isSafeInteger(m.deadline) || !Number.isSafeInteger(m.timeoutMs) || m.timeoutMs <= 0 || m.timeoutMs > httpRelayLimits.streamMs || !headersValid(m.headers) || !(profile === 'webhook' ? m.target === 'webhook' && m.method === 'POST' : (m.target === 'rpc' && m.method === 'POST') || (m.target === 'card' && m.method === 'GET'))) throw new Error();
					const body = decode(m.body, httpRelayLimits.requestBytes); if (m.target === 'card' && body.length) throw new Error();
					if (active.size >= httpRelayLimits.maxInflight) throw new Error();
					const budget = Math.min(m.timeoutMs, m.deadline - Date.now());
					if (budget <= 0) { remember(m.id); send({ type: 'error', id: m.id, code: 'timeout' }); return; }
					const headers = Object.fromEntries(m.headers); Object.assign(headers, localHeaders); if (!headersValid(Object.entries(headers))) throw new Error();
					let request, response, headerTimer, timer;
					const a = { seq: 0, credit: false, started: false, wake: null, stopped: false, cancel() { if (a.stopped) return; a.stopped = true; clearTimeout(headerTimer); clearTimeout(timer); request?.destroy(); response?.destroy(); a.wake?.(); } };
					active.set(m.id, a);
					const done = () => { active.delete(m.id); remember(m.id); a.cancel(); };
					const error = code => { if (a.stopped) return; send({ type: 'error', id: m.id, code }); done(); };
					timer = setTimeout(() => error('timeout'), budget);
					headerTimer = setTimeout(() => error('timeout'), Math.min(httpRelayLimits.headerMs, budget));
					request = http.request(m.target === 'card' ? card : local, { method: m.method, headers, highWaterMark: httpRelayLimits.chunkBytes, agent: false }, res => {
						response = res; clearTimeout(headerTimer);
						void (async () => {
							try {
								if (a.stopped) { res.destroy(); return; }
								const status = res.statusCode; if (!status || status < 200 || status > 599 || (status >= 300 && status < 400)) { error('local_failure'); return; }
								const nominated = new Set(String(res.headers.connection || '').toLowerCase().split(',').map(v => v.trim()));
								const pairs = []; for (let i = 0; i < res.rawHeaders.length; i += 2) { const k = res.rawHeaders[i].toLowerCase(); if (headerAllowed(k) && !nominated.has(k)) pairs.push([k, res.rawHeaders[i + 1]]); }
								if (!headersValid(pairs)) { error('local_failure'); return; }
								a.started = true; if (!send({ type: 'start', id: m.id, status, headers: pairs })) return;
								let bytes = 0;
								for await (const chunk of res) {
									for (let offset = 0; offset < chunk.length; offset += httpRelayLimits.chunkBytes) {
										const part = chunk.subarray(offset, offset + httpRelayLimits.chunkBytes); bytes += part.length;
										if (bytes > httpRelayLimits.responseBytes || status === 204 || status === 205) { error('local_failure'); return; }
										if (!a.credit && !a.stopped) await new Promise(r => { a.wake = r; }); a.wake = null;
										if (a.stopped || finished) return; a.credit = false;
										if (!send({ type: 'chunk', id: m.id, seq: a.seq++, body: part.toString('base64') })) return;
									}
								}
								if (!a.stopped) { send({ type: 'end', id: m.id, seq: a.seq }); done(); }
							} catch { error('local_failure'); }
						})();
					});
					request.on('error', () => error('local_failure'));
					request.end(body);
				} catch { invalid(); }
			});
			if (signal?.aborted) stop();
		});
		if (signal?.aborted) return; if (permanent) throw new CliError(permanent);
		if (!helloReceived) { if (++failures >= 3) throw new CliError(`HTTP relay handshake failed three consecutive times; ${statusGuidance}, endpoint and enrollment`); onDiagnostic('HTTP relay handshake failed; retrying with bounded backoff'); }
		try { await sleep(reconnectDelay(attempt++), undefined, { signal }); } catch { return; }
	}
}

export async function relayHttp(args, flags = {}) {
	const [kind, action] = args || [], profile = kind === 'http' ? 'webhook' : kind;
	if (args?.length !== 2 || !['webhook', 'a2a'].includes(profile) || !['create', 'status', 'revoke', 'run'].includes(action)) throw new CliError('usage: relay http|a2a create|status|revoke|run');
	const allowed = { create: ['token-file', 'ingress-token-file', 'forward-headers', 'json'], status: ['json'], revoke: ['json'], run: ['url', 'token-file', 'local-url', 'card-url', 'local-headers-file', 'json'] }[action];
	for (const key of Object.keys(flags)) if (!allowed.includes(key)) throw new CliError(`unsupported HTTP relay option --${key}`);
	const path = `/owner/relay/http/${profile}`;
	if (action === 'create') {
		const names = flags['forward-headers'] === undefined ? ['content-type', 'accept'] : String(flags['forward-headers']).split(',').map(s => s.trim());
		if (names.length > 16 || new Set(names).size !== names.length || !names.every(headerAllowed)) throw new CliError('--forward-headers must list up to 16 unique safe lowercase header names');
		if (!flags['token-file'] || !flags['ingress-token-file']) throw new CliError('create requires two new protected files: --token-file and --ingress-token-file');
		const fds = [], files = [flags['token-file'], flags['ingress-token-file']];
		// Keep descriptors open until cleanup: a pathname may have been replaced
		// while awaiting the owner response. Never unlink another file's inode.
		const cleanup = () => {
			for (const [i, fd] of fds.entries()) {
				try { const held = fs.fstatSync(fd), current = fs.lstatSync(files[i]); if (held.dev === current.dev && held.ino === current.ino) fs.unlinkSync(files[i]); } catch { /* absent, replaced, or cleanup unavailable; never mask the diagnostic */ }
			}
		};
		let uncertain = false, diagnostic = 'cannot reserve both new credential files; existing files are never overwritten';
		try {
			for (const file of files) fds.push(fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600));
			diagnostic = 'HTTP relay owner configuration requires A2A_BASE_URL and A2A_OWNER_TOKEN; configure them before enrollment';
			if (!baseUrl() || !configGet('A2A_OWNER_TOKEN')) throw new Error();
			diagnostic = 'invalid HTTP relay owner configuration; check A2A_BASE_URL and A2A_OWNER_TOKEN before enrollment';
			const endpoint = new URL(baseUrl());
			if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
			// Validate the exact header locally; fetch failures are otherwise ambiguous.
			new Headers({ authorization: `Bearer ${configGet('A2A_OWNER_TOKEN')}` });
			diagnostic = 'cannot write protected credential files; check local file permissions and storage before enrollment';
			const token = 'a2ah_' + randomBytes(32).toString('base64url'), ingress = 'a2ai_' + randomBytes(32).toString('base64url');
			for (const [i, value] of [token, ingress].entries()) { fs.fchmodSync(fds[i], 0o600); fs.writeFileSync(fds[i], value + '\n'); fs.fsyncSync(fds[i]); }
			const hash = value => createHash('sha256').update(value).digest('hex');
			uncertain = true;
			const response = await ownerTry('POST', path, { credentialHash: hash(token), ingressHash: hash(ingress), headers: names });
			if (response.status >= 400 && response.status < 500) {
				uncertain = false;
				if (response.status === 404) diagnostic = 'HTTP relay enrollment rejected (404); enable HTTP relay on a compatible v2 Worker before retrying';
				else if ([401, 403].includes(response.status)) diagnostic = 'HTTP relay enrollment rejected; check owner authentication and A2A_OWNER_TOKEN before retrying';
				else if (response.status === 409) diagnostic = `HTTP relay enrollment rejected; run relay ${kind} status and resolve the conflict with owner approval before retrying`;
				else diagnostic = 'HTTP relay enrollment rejected; check create options and compatible v2 Worker configuration before retrying';
				throw new Error();
			}
			const result = response.data;
			if (response.status < 200 || response.status >= 300 || !Number.isSafeInteger(result?.generation) || result.generation < 1) throw new Error();
			const confirmation = await ownerTry('GET', path), current = confirmation.data;
			if (confirmation.status !== 200 || current?.enrolled !== true || current.generation !== result.generation) throw new Error();
			console.log(JSON.stringify({ enrolled: true, profile, generation: result.generation, tokenFile: files[0], ingressTokenFile: files[1] }));
		} catch {
			if (uncertain) throw new CliError(`HTTP relay enrollment unconfirmed; protected files retained. Run relay ${kind} status to reconcile; do not create again or discard credentials without owner approval`);
			cleanup(); throw new CliError(diagnostic);
		} finally { for (const fd of fds) fs.closeSync(fd); } return;
	}
	if (action === 'run') {
		if (!flags['token-file'] || !flags['local-url']) throw new CliError('run requires --token-file and --local-url');
		if (profile !== 'a2a' && flags['card-url']) throw new CliError('--card-url is only supported by relay a2a');
		const token = protectedToken(flags['token-file']), localHeaders = flags['local-headers-file'] ? protectedHeaders(flags['local-headers-file']) : {};
		const stop = new AbortController(), shutdown = () => stop.abort(); process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
		try { await runHttpConnector({ url: flags.url || baseUrl().replace(/^http/, 'ws') + `/relay/http/${profile}/connect`, token, profile, localUrl: flags['local-url'], cardUrl: flags['card-url'], localHeaders, signal: stop.signal }); }
		finally { process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown); } return;
	}
	const current = await owner('GET', path); if (action === 'status') { console.log(JSON.stringify(current)); return; }
	const result = await owner('DELETE', path, { generation: current.generation }); const confirmed = await owner('GET', path);
	if (confirmed.enabled || confirmed.enrolled || confirmed.connected || confirmed.generation !== result.generation) throw new CliError('HTTP relay revocation unconfirmed; check status');
	console.log(JSON.stringify(result));
}
export default relayHttp;
