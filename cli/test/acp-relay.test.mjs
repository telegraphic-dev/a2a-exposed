import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createAcpTarget, acpOptions, acpPeerFile } from '../lib/acp-relay.mjs';
import { relayHttp } from '../lib/http-relay.mjs';
const fixture = fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url));
const hash = token => createHash('sha256').update(token).digest();
const tokens = { alice: 'a'.repeat(43), bob: 'b'.repeat(43) };
const delay = ms => new Promise(r => setTimeout(r, ms));
async function setup(t, options = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-target-')), log = path.join(dir, 'wire');
	const target = createAcpTarget({ command: [process.execPath, fixture, log, options.mode || 'ok'], cwd: dir, peers: new Map(Object.entries(tokens).map(([p, token]) => [p, hash(token)])), ...options });
	const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
	t.after(async () => { await target.close(); for (const { pid } of calls().filter(m => m.pid)) { assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); } fs.rmSync(dir, { recursive: true, force: true }); });
	async function rpc(method, params, peer = 'alice', extra = {}) {
		const response = await target.handle({ target: 'rpc', headers: { authorization: `Bearer ${tokens[peer] || peer}` }, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 7, method, params })), ...extra });
		return response.headers.get('content-type')?.startsWith('text/event-stream') ? response : response.json();
	}
	const send = (text, contextId, peer = 'alice', method = 'message/send') => rpc(method, { message: { role: 'user', parts: [{ kind: 'text', text }], ...(contextId ? { contextId } : {}) } }, peer);
	async function done(id, peer = 'alice') {
		for (let i = 0; i < 500; i++) { const r = await rpc('tasks/get', { id }, peer); if (r.error || !['working', 'submitted'].includes(r.result.status.state)) return r; await delay(10); } throw new Error('task timed out');
	}
	return { dir, log, target, calls, rpc, send, done };
}
test('stdio sessions reuse the exact peer/context binding, isolate peers, never expose ACP IDs or thoughts', async t => {
	const s = await setup(t);
	const a = (await s.send('first', 'same')).result; assert.equal(a.status.state, 'working');
	assert.equal((await s.done(a.id)).result.artifacts[0].parts[0].text, 'hello first');
	const second = (await s.send('second', 'same')).result; await s.done(second.id);
	const b = (await s.send('other peer', 'same', 'bob')).result; await s.done(b.id, 'bob');
	assert.equal(s.calls().filter(m => m.method === 'session/new').length, 2);
	const prompts = s.calls().filter(m => m.method === 'session/prompt');
	assert.equal(prompts[0].params.sessionId, prompts[1].params.sessionId); assert.notEqual(prompts[0].params.sessionId, prompts[2].params.sessionId);
	assert.equal((await s.rpc('tasks/get', { id: a.id }, 'bob')).error.code, -32001);
	assert.equal((await s.rpc('tasks/cancel', { id: a.id }, 'bob')).error.code, -32001);
	assert.deepEqual(s.calls().find(m => m.method === 'initialize').params.clientCapabilities, {});
	assert.ok(!JSON.stringify(await s.done(a.id)).includes('PRIVATE'));
});
test('owner targets an existing session for one peer, discards load replay, refuses context switching', async t => {
	const s = await setup(t, { sessionId: 'exact-owner-session', sessionPeer: 'alice' });
	assert.deepEqual(await s.send('forbidden', undefined, 'bob'), { error: 'unauthorized' });
	const task = (await s.send('continue')).result; const result = await s.done(task.id);
	assert.equal(result.result.artifacts[0].parts[0].text, 'hello continue');
	const second = (await s.send('again')).result; assert.equal(second.contextId, task.contextId); await s.done(second.id);
	assert.equal((await s.send('wrong', 'another')).error.code, -32602);
	assert.equal(s.calls().filter(m => m.method === 'session/new').length, 0);
	assert.equal(s.calls().filter(m => m.method === 'session/load').length, 1);
	assert.ok(s.calls().filter(m => m.method === 'session/prompt').every(m => m.params.sessionId === 'exact-owner-session'));
	assert.ok(!JSON.stringify(result).includes('exact-owner-session')); assert.ok(!JSON.stringify(result).includes('PRIVATE REPLAY'));
});
for (const mode of ['no-load', 'missing', 'v2']) test(`existing session fails closed without replacement: ${mode}`, async t => {
	const s = await setup(t, { mode, sessionId: 'exact', sessionPeer: 'alice' }); const task = (await s.send('test')).result;
	assert.equal((await s.done(task.id)).result.status.state, 'failed');
	assert.equal(s.calls().filter(m => m.method === 'session/new' || m.method === 'session/prompt').length, 0);
	if (mode === 'no-load') assert.equal(s.calls().filter(m => m.method === 'session/load').length, 0);
});
test('permissions are canceled, become owner input-required, never approve or emit provider diagnostics', async t => {
	const s = await setup(t); const task = (await s.send('permission')).result; const result = (await s.done(task.id)).result;
	assert.equal(result.status.state, 'input-required'); assert.equal(result.status.message.metadata['a2a.exposed/owner-wait'].code, 'owner-decision');
	await delay(50);
	assert.deepEqual(s.calls().find(m => m.id === 'permission' && m.result).result, { outcome: { outcome: 'cancelled' } });
	assert.equal((await s.rpc('message/send', { message: { role: 'user', taskId: task.id, parts: [{ text: 'approve' }] } })).error.code, -32602);
});
test('task cancel interrupts stdio, busy concurrent prompts are refused, no recreation after cancellation', async t => {
	const s = await setup(t); const task = (await s.send('hang', 'ctx')).result;
	for (let i = 0; i < 500 && !s.calls().some(m => m.method === 'session/prompt'); i++) await delay(10);
	assert.equal((await s.send('busy', 'ctx')).error.code, -32005);
	assert.equal((await s.rpc('tasks/cancel', { id: task.id })).result.status.state, 'canceled');
	await delay(20); const next = (await s.send('after', 'ctx')).result; assert.equal((await s.done(next.id)).result.status.state, 'failed');
	assert.equal(s.calls().filter(m => m.method === 'session/new').length, 1);
});
for (const method of ['message/stream', 'SendStreamingMessage']) test(`streaming emits real chunks and completed status: ${method}`, async t => {
	const s = await setup(t); const res = await s.send('stream', undefined, 'alice', method); const text = await res.text();
	const events = text.trim().split('\n\n').map(v => JSON.parse(v.slice(6)).result);
	assert.ok(text.includes('hello ')); assert.ok(text.includes('stream')); assert.ok(!text.includes('PRIVATE'));
	assert.ok(text.includes(method === 'message/stream' ? '"state":"completed"' : 'TASK_STATE_COMPLETED'));
	assert.ok(events.length >= 3);
});
test('stream disconnect kills the active child and freezes canceled task', async t => {
	const s = await setup(t); const res = await s.send('hang', 'ctx', 'alice', 'message/stream'); const reader = res.body.getReader();
	const first = JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6)); await reader.cancel();
	assert.equal((await s.done(first.result.id)).result.status.state, 'canceled');
});
for (const text of ['malformed', 'huge', 'overflow']) test(`malformed/unbounded stdio fails safely: ${text}`, async t => {
	const s = await setup(t); const task = (await s.send(text)).result; assert.equal((await s.done(task.id)).result.status.state, 'failed');
});
test('stream update flood is a bounded explicit error, not a fabricated completion', async t => {
	const s = await setup(t); const response = await s.send('flood', 'flood', 'alice', 'message/stream'); const text = await response.text();
	assert.ok(text.includes('ACP stream limit exceeded')); assert.ok(!text.includes('"state":"completed"')); assert.ok(Buffer.byteLength(text) < 900500);
});
test('unadvertised filesystem requests are refused and peer-file schema ships alongside the handler', async t => {
	const s = await setup(t); const task = (await s.send('capability')).result; await s.done(task.id); await delay(20);
	assert.equal(s.calls().find(m => m.id === 'fs' && m.error)?.error.code, -32601);
	const schema = JSON.parse(fs.readFileSync(new URL('../lib/acp-peers.schema.json', import.meta.url), 'utf8'));
	assert.equal(schema.additionalProperties, false); assert.equal(schema.properties.peers.maxProperties, 32);
});
test('session admission cap never evicts or silently recreates an existing context', async t => {
	const s = await setup(t);
	for (let i = 0; i < 8; i++) { const task = (await s.send('test', `c${i}`)).result; await s.done(task.id); }
	assert.equal((await s.send('over cap', 'c8')).error.code, -32005);
	const again = (await s.send('still here', 'c0')).result; await s.done(again.id);
	assert.equal(s.calls().filter(m => m.method === 'session/new').length, 8);
});
test('shutdown awaits active process reaping for every caller, without replay', async t => {
	const s = await setup(t); const task = (await s.send('hang', 'shutdown')).result;
	for (let i = 0; i < 500 && !s.calls().some(m => m.method === 'session/prompt'); i++) await delay(10);
	await Promise.all([s.target.close(), s.target.close()]);
	assert.equal((await s.rpc('tasks/get', { id: task.id })).error, 'unavailable');
	for (const { pid } of s.calls().filter(m => m.pid)) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
test('missing or unrecognized application auth never starts a process, even for card discovery', async t => {
	const s = await setup(t);
	for (const headers of [{}, { authorization: 'Bearer unknown' }, { 'x-peer': 'alice' }]) assert.equal((await s.target.handle({ target: 'card', headers, body: Buffer.alloc(0) })).status, 401);
	assert.deepEqual(s.calls(), []);
	assert.equal((await s.rpc('message/send', { message: { role: 'user', parts: [{ text: 'x' }], metadata: { sessionId: 'steal' } } })).error.code, -32602);
});
test('owner-only peer hash file and argv validation reject ambiguous targeting and HTTP mixing', async t => {
	const s = await setup(t); const file = path.join(s.dir, 'peers.json');
	fs.writeFileSync(file, JSON.stringify({ peers: { alice: hash(tokens.alice).toString('hex') } }), { mode: 0o600 });
	assert.equal(acpPeerFile(file).size, 1);
	const flags = { acp: JSON.stringify([process.execPath, fixture]), 'acp-cwd': s.dir, 'acp-peers-file': file };
	assert.equal(acpOptions(flags).cwd, s.dir);
	assert.throws(() => acpOptions({ ...flags, acp: 'sh -c evil' }), /JSON argv/);
	assert.throws(() => acpOptions({ ...flags, 'acp-session': 'exact' }), /session-peer/);
	fs.chmodSync(file, 0o644); assert.throws(() => acpPeerFile(file), /mode-600/);
	await assert.rejects(relayHttp(['a2a', 'run'], { ...flags, 'token-file': 'unused', 'local-url': 'http://127.0.0.1/' }), /cannot be combined/);
	await assert.rejects(relayHttp(['http', 'run'], { ...flags, 'token-file': 'unused' }), /require relay a2a/);
});
