/** Local ACP target for the existing bounded HTTP relay; no listening socket. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { AcpClient, acpLimits } from './acp-client.mjs';
import { CliError } from './a2a.mjs';

const digest = value => createHash('sha256').update(value).digest();
const idValid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const sessionValid = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
const obj = value => value && typeof value === 'object' && !Array.isArray(value);
const terminal = state => !['submitted', 'working'].includes(state);
const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const rpcError = (id, code, message) => json({ jsonrpc: '2.0', id, error: { code, message } });
const modern = (method, headers) => {
	const v = headers.get('a2a-version');
	if (v && !/^(?:0\.3|1\.0)(?:\.\d+)?$/.test(v)) throw new Error('version');
	return v ? v.startsWith('1.') : !method.includes('/');
};
function wireTask(task, v1) {
	const state = task.state, parts = text => v1 ? [{ text }] : [{ kind: 'text', text }];
	const status = { state: v1 ? 'TASK_STATE_' + state.toUpperCase().replaceAll('-', '_') : state, timestamp: task.timestamp };
	if (task.note) status.message = { ...(v1 ? {} : { kind: 'message' }), messageId: task.id + '-status', role: v1 ? 'ROLE_AGENT' : 'agent', parts: parts(task.note), ...(state === 'input-required' ? { metadata: { 'a2a.exposed/owner-wait': { code: 'owner-decision', note: task.note } } } : {}) };
	return { ...(v1 ? {} : { kind: 'task' }), id: task.id, contextId: task.contextId, status, artifacts: task.text ? [{ artifactId: task.id + '-output', parts: parts(task.text) }] : [] };
}
export function acpPeerFile(file) {
	let fd;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); const s = fs.fstatSync(fd);
		if (!s.isFile() || (s.mode & 0o777) !== 0o600 || (process.getuid && s.uid !== process.getuid()) || s.size > 16384) throw new Error();
		const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
		if (!obj(value) || Object.keys(value).join() !== 'peers' || !obj(value.peers)) throw new Error();
		const peers = Object.entries(value.peers);
		if (!peers.length || peers.length > 32 || peers.some(([name, hash]) => !idValid(name) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) || new Set(peers.map(([, h]) => h)).size !== peers.length) throw new Error();
		return new Map(peers.map(([name, hash]) => [name, Buffer.from(hash, 'hex')]));
	} catch { throw new CliError('--acp-peers-file requires an owner-only mode-600 JSON file containing unique peer names and SHA-256 token hashes'); }
	finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function acpOptions(flags) {
	let command;
	try { command = JSON.parse(flags.acp); } catch { throw new CliError('--acp requires a JSON argv array, not a shell command'); }
	if (!Array.isArray(command) || !command.length || command.length > 64 || command.some(v => typeof v !== 'string' || !v || v.includes('\0') || v.length > 4096)) throw new CliError('--acp requires a nonempty JSON argv array');
	if (!flags['acp-cwd'] || !path.isAbsolute(flags['acp-cwd']) || !fs.statSync(flags['acp-cwd'], { throwIfNoEntry: false })?.isDirectory()) throw new CliError('--acp-cwd requires an existing absolute working directory');
	const peers = acpPeerFile(flags['acp-peers-file']);
	const sessionId = flags['acp-session'], sessionPeer = flags['acp-session-peer'];
	if (sessionId !== undefined && !sessionValid(sessionId)) throw new CliError('invalid --acp-session');
	if (!!sessionId !== !!sessionPeer || (sessionPeer && !peers.has(sessionPeer))) throw new CliError('--acp-session requires --acp-session-peer naming one configured peer (and vice versa)');
	return { command, cwd: flags['acp-cwd'], peers, sessionId, sessionPeer };
}
export function createAcpTarget({ command, cwd, peers, sessionId, sessionPeer }) {
	const sessions = new Map(), tasks = new Map(); let closed = false, fixedContext;
	const notify = task => { task.timestamp = new Date().toISOString(); for (const cb of task.listeners) cb(); };
	const set = (task, state, note) => { if (terminal(task.state)) return; task.state = state; task.note = note; notify(task); };
	function binding(peer, contextId) {
		const key = JSON.stringify([peer, contextId]); let entry = sessions.get(key);
		if (entry) return entry;
		if (sessions.size >= acpLimits.sessions || closed) throw new Error('capacity');
		entry = { id: null, busy: false, current: null, client: null };
		entry.client = new AcpClient({ command, cwd,
			onUpdate(params) {
				const task = entry.current;
				// Ignore load replay and all thoughts, tools and other session IDs.
				if (!task || terminal(task.state) || params?.sessionId !== entry.id) return;
				const u = params.update;
				if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text' && typeof u.content.text === 'string') {
					if (Buffer.byteLength(task.text) + Buffer.byteLength(u.content.text) > acpLimits.outputBytes) { set(task, 'failed', 'ACP output limit exceeded'); void entry.client.close(); return; }
					task.text += u.content.text; notify(task);
				}
			},
			onPermission(params) {
				const task = entry.current;
				if (!task || params?.sessionId !== entry.id || terminal(task.state)) return;
				set(task, 'input-required', 'Owner decision required locally; permission was not granted. Peers cannot approve tools.');
				entry.client.cancel(entry.id);
			},
		});
		entry.ready = (async () => {
			const init = await entry.client.call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'a2a-exposed', version: '1' } });
			if (init.protocolVersion !== 1) throw new Error('protocol');
			if (sessionId) {
				if (init.agentCapabilities?.loadSession !== true) throw new Error('load');
				entry.id = sessionId;
				await entry.client.call('session/load', { sessionId, cwd, mcpServers: [] });
			} else {
				const result = await entry.client.call('session/new', { cwd, mcpServers: [] });
				if (!sessionValid(result.sessionId)) throw new Error('session'); entry.id = result.sessionId;
			}
		})().catch(async () => { await entry.client.close(); throw new Error('ACP session unavailable; no replacement session was created'); });
		entry.ready.catch(() => {}); sessions.set(key, entry); return entry;
	}
	async function execute(entry, task, prompt) {
		try {
			await entry.ready;
			if (terminal(task.state)) return;
			entry.current = task;
			const result = await entry.client.call('session/prompt', { sessionId: entry.id, prompt });
			if (!terminal(task.state)) set(task, result.stopReason === 'end_turn' ? 'completed' : result.stopReason === 'cancelled' ? 'canceled' : 'failed', result.stopReason === 'end_turn' ? undefined : 'ACP turn stopped without completion');
		} catch { set(task, 'failed', 'ACP operation failed; check the local adapter, session availability and authentication. No automatic replay.'); }
		finally { entry.current = null; entry.busy = false; }
	}
	function stream(task, v1, rpcId, signal) {
		let callback, detach, finished = false, sent = 0, count = 0, streamBytes = 0;
		const cancel = () => { if (finished) return; finished = true; task.listeners.delete(callback); detach?.(); if (!terminal(task.state)) { set(task, 'canceled', 'Caller disconnected; ACP turn canceled'); task.entry.client.cancel(task.entry.id); void task.entry.client.close(); } };
		const body = new ReadableStream({
			start(controller) {
				callback = () => {
					if (finished) return;
					const result = count++ === 0 ? (v1 ? { task: wireTask(task, true) } : wireTask(task, false)) : (v1 ? { statusUpdate: { taskId: task.id, contextId: task.contextId, status: wireTask(task, true).status, final: terminal(task.state) } } : { kind: 'status-update', taskId: task.id, contextId: task.contextId, status: wireTask(task, false).status, final: terminal(task.state) });
					const events = [result];
					if (task.text.length > sent) {
						const artifact = { artifactId: task.id + '-output', parts: [v1 ? { text: task.text.slice(sent) } : { kind: 'text', text: task.text.slice(sent) }] };
						const update = { taskId: task.id, contextId: task.contextId, artifact, append: sent > 0, lastChunk: terminal(task.state) }; sent = task.text.length;
						events.unshift(v1 ? { artifactUpdate: update } : { kind: 'artifact-update', ...update });
					}
					for (const value of events) {
						const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpcId, result: value })}\n\n`);
						streamBytes += bytes.length;
						if (streamBytes > 900000 || count > 1024) {
							finished = true; task.listeners.delete(callback); detach?.(); set(task, 'failed', 'ACP stream limit exceeded');
							controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpcId, error: { code: -32603, message: 'ACP stream limit exceeded' } })}\n\n`));
							controller.close(); void task.entry.client.close(); return;
						}
						controller.enqueue(bytes);
					}
					if (terminal(task.state)) { finished = true; task.listeners.delete(callback); detach?.(); controller.close(); }
				};
				task.listeners.add(callback);
				const abort = () => { cancel(); try { controller.close(); } catch { /* already closed */ } };
				detach = () => signal?.removeEventListener('abort', abort);
				signal?.addEventListener('abort', abort, { once: true }); callback(); if (signal?.aborted) abort();
			}, cancel,
		});
		return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
	}
	async function handle({ target, body, headers, signal }) {
		if (closed) return json({ error: 'unavailable' }, 503);
		const auth = new Headers(headers).get('authorization') || '', token = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(auth)?.[1];
		const hash = digest(token || ''); let peer;
		for (const [name, expected] of peers) if (timingSafeEqual(hash, expected)) peer = name;
		if (!token || !peer || (sessionPeer && peer !== sessionPeer)) return json({ error: 'unauthorized' }, 401);
		if (target === 'card') return json({ name: 'ACP relay', description: 'Owner-configured local ACP agent', version: '1', supportedInterfaces: [{ url: 'http://127.0.0.1/', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }, { url: 'http://127.0.0.1/', protocolBinding: 'JSONRPC', protocolVersion: '0.3' }], capabilities: { streaming: true, pushNotifications: false }, securitySchemes: { application: { httpAuthSecurityScheme: { scheme: 'bearer' } } }, securityRequirements: [{ schemes: { application: { list: [] } } }], defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [{ id: 'acp', name: 'ACP prompt', description: 'Text prompts to the owner-configured ACP agent', tags: ['acp'] }] });
		let m;
		try { if (body.length > 262144) throw new Error(); m = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { return rpcError(null, -32700, 'Parse error'); }
		if (!obj(m) || m.jsonrpc !== '2.0' || typeof m.method !== 'string' || !(typeof m.id === 'string' || (typeof m.id === 'number' && Number.isFinite(m.id)) || m.id === null)) return rpcError(null, -32600, 'Invalid Request');
		let v1; try { v1 = modern(m.method, new Headers(headers)); } catch { return rpcError(m.id, -32009, 'Unsupported protocol version'); }
		const ok = result => json({ jsonrpc: '2.0', id: m.id, result });
		const p = m.params;
		if (!obj(p)) return rpcError(m.id, -32602, 'Invalid params');
		if (['GetTask', 'tasks/get', 'CancelTask', 'tasks/cancel'].includes(m.method)) {
			const task = tasks.get(p.id);
			if (!task || task.peer !== peer) return rpcError(m.id, -32001, 'Task not found');
			if (m.method === 'CancelTask' || m.method === 'tasks/cancel') {
				if (terminal(task.state)) return rpcError(m.id, -32002, 'Task is not cancelable');
				set(task, 'canceled', 'Canceled by caller'); task.entry.client.cancel(task.entry.id); await task.entry.client.close();
			}
			return ok(wireTask(task, v1));
		}
		if (!['SendMessage', 'message/send', 'SendStreamingMessage', 'message/stream'].includes(m.method)) return rpcError(m.id, -32601, 'Method not found');
		const message = p.message;
		if (!obj(message) || !['user', 'ROLE_USER'].includes(message.role) || !Array.isArray(message.parts) || !message.parts.length || message.parts.length > 100 || message.parts.some(part => !obj(part) || typeof part.text !== 'string' || Object.keys(part).some(k => !['kind', 'text'].includes(k)) || (part.kind !== undefined && part.kind !== 'text')) || Object.keys(message).some(k => !['messageId', 'role', 'parts', 'contextId', 'taskId', 'kind'].includes(k)) || (message.contextId !== undefined && !idValid(message.contextId))) return rpcError(m.id, -32602, 'Only text user messages and opaque A2A context IDs are supported');
		if (p.configuration?.pushNotificationConfig || p.configuration?.pushNotification || p.pushNotificationConfig) return rpcError(m.id, -32003, 'Push notifications not supported');
		if (message.taskId !== undefined) return rpcError(m.id, -32602, 'Start a new task in the returned context; peer replies cannot approve tools');
		const contextId = message.contextId || (sessionId ? fixedContext : null) || randomUUID();
		if (sessionId && fixedContext && fixedContext !== contextId) return rpcError(m.id, -32602, 'This target is bound to one A2A context');
		if (tasks.size >= acpLimits.tasks) return rpcError(m.id, -32005, 'ACP target task capacity reached; owner restart required');
		let entry; try { entry = binding(peer, contextId); } catch { return rpcError(m.id, -32005, 'ACP target session capacity reached; owner restart required'); }
		if (entry.busy) return rpcError(m.id, -32005, 'ACP session is busy');
		if (sessionId) fixedContext = contextId;
		entry.busy = true;
		const task = { id: randomUUID(), peer, contextId, state: 'working', text: '', timestamp: new Date().toISOString(), listeners: new Set(), entry };
		tasks.set(task.id, task);
		void execute(entry, task, message.parts.map(p => ({ type: 'text', text: p.text })));
		if (m.method === 'SendStreamingMessage' || m.method === 'message/stream') return stream(task, v1, m.id, signal);
		return ok(v1 ? { task: wireTask(task, true) } : wireTask(task, false));
	}
	return { handle, async close() { closed = true; for (const task of tasks.values()) set(task, 'failed', 'ACP connector stopped; no automatic replay'); await Promise.all([...sessions.values()].map(entry => entry.client.close())); } };
}
