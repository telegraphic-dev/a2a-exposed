import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createAcpTarget, acpOptions } from '../lib/acp-relay.mjs';
import { acpDiagnostics, diagnosticsLimit } from '../lib/acp-diagnostics.mjs';
const fixture = fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url));
const delay = ms => new Promise(r => setTimeout(r, ms));
async function setup(t, options = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-safety-')), log = path.join(dir, 'wire'), reports = [];
	const token = 'a'.repeat(43), file = path.join(dir, 'diagnostics');
	const target = createAcpTarget({ acpMode: 'ask', command: [process.execPath, fixture, log, options.mode || 'ok'], cwd: dir, peers: new Map([['alice', createHash('sha256').update(token).digest()]]), report: m => reports.push(m), ...(options.diagnostics ? { diagnosticsFile: file } : {}), ...options });
	t.after(async () => { await target.close(); fs.rmSync(dir, { recursive: true, force: true }); });
	const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
	async function rpc(method, params) {
		const response = await target.handle({ target: 'rpc', headers: { authorization: `Bearer ${token}` }, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })) });
		return response.headers.get('content-type') === 'text/event-stream' ? response : response.json();
	}
	const send = (text, method = 'message/send') => rpc(method, { message: { role: 'user', contextId: 'ctx', parts: [{ text }] } });
	async function done(id) { for (let i = 0; i < 500; i++) { const r = await rpc('tasks/get', { id }); if (!['working', 'submitted'].includes(r.result.status.state)) return r.result; await delay(10); } throw new Error('timeout'); }
	return { dir, file, target, reports, calls, send, done, rpc };
}
for (const load of [false, true]) test(`owner mode replaces unsafe initial mode before every prompt: load=${load}`, async t => {
	const s = await setup(t, load ? { sessionId: 'exact/opaque session', sessionPeer: 'alice' } : {});
	for (const text of ['first', 'second']) { const task = (await s.send(text)).result; assert.equal((await s.done(task.id)).status.state, 'completed'); }
	const calls = s.calls().filter(m => m.method);
	assert.deepEqual(calls.map(m => m.method), ['initialize', load ? 'session/load' : 'session/new', 'session/set_mode', 'session/prompt', 'session/set_mode', 'session/prompt']);
	for (const call of calls.filter(m => m.method === 'session/set_mode')) { assert.equal(call.params.modeId, 'ask'); if (load) assert.equal(call.params.sessionId, 'exact/opaque session'); }
	assert.deepEqual(s.reports, ['ACP active mode confirmed: ask', 'ACP active mode confirmed: ask']);
});
for (const load of [false, true]) for (const mode of ['absent-modes', 'unsupported-mode', 'setter-error', 'setter-uncertain', 'setter-exit', 'setter-conflict']) test(`mode failure never prompts or recreates: ${mode}, load=${load}`, async t => {
	const s = await setup(t, { mode, ...(load ? { sessionId: 'exact', sessionPeer: 'alice' } : {}) });
	const task = (await s.send('test')).result, result = await s.done(task.id);
	assert.equal(result.status.state, 'failed');
	assert.match(result.status.message.parts[0].text, mode === 'setter-conflict' ? /mode changed/ : mode.startsWith('setter-') ? /set_mode/ : /mode discovery/);
	assert.ok(!JSON.stringify([result, s.reports]).includes('PRIVATE-STDERR'));
	assert.equal(s.calls().filter(m => m.method === 'session/prompt').length, 0);
	const next = (await s.send('retry')).result;
	assert.match((await s.done(next.id)).status.message.parts[0].text, /binding stopped; restart connector/);
	assert.equal(s.calls().filter(m => ['session/new', 'session/load'].includes(m.method)).length, 1);
});
for (const text of ['mode-change', 'config-change']) test(`conflicting authoritative update stops binding: ${text}`, async t => {
	const s = await setup(t); const task = (await s.send(text)).result;
	assert.match((await s.done(task.id)).status.message.parts[0].text, /mode changed unexpectedly/);
	const next = (await s.send('retry')).result;
	assert.match((await s.done(next.id)).status.message.parts[0].text, /binding stopped/);
	assert.equal(s.calls().filter(m => m.method === 'session/prompt').length, 1);
});
test('foreign session mode changes do not affect the binding', async t => {
	const s = await setup(t), task = (await s.send('foreign-change')).result;
	assert.equal((await s.done(task.id)).status.state, 'completed');
});
test('delayed idle mode change stops loaded binding before another prompt', async t => {
	const s = await setup(t, { mode: 'idle-conflict', sessionId: 'exact', sessionPeer: 'alice' });
	const first = (await s.send('first')).result; await s.done(first.id); await delay(200);
	const next = (await s.send('second')).result; assert.match((await s.done(next.id)).status.message.parts[0].text, /binding stopped/);
	assert.equal(s.calls().filter(m => m.method === 'session/prompt').length, 1);
});
test('native slash commands and peer-supplied mode fields are not mode controls', async t => {
	const s = await setup(t);
	assert.equal((await s.send(' /permissions unsafe')).error.code, -32602);
	assert.equal((await s.rpc('session/set_mode', { modeId: 'unsafe' })).error.code, -32601);
	assert.equal((await s.rpc('message/send', { message: { role: 'user', parts: [{ text: 'hello' }], modeId: 'unsafe' } })).error.code, -32602);
	assert.deepEqual(s.calls(), []);
});
for (const method of ['message/send', 'message/stream', 'SendStreamingMessage']) test(`message IDs separate messages, never same-message split chunks; ${method}`, async t => {
	const s = await setup(t), response = await s.send('messages', method);
	if (method === 'message/send') { assert.equal((await s.done(response.result.id)).artifacts[0].parts[0].text, 'hello\nworld\nfinal artifact'); return; }
	const events = (await response.text()).trim().split('\n\n').map(e => JSON.parse(e.slice(6)).result);
	const artifacts = events.map(e => e.artifactUpdate || (e.kind === 'artifact-update' ? e : null)).filter(Boolean);
	assert.equal(artifacts.map(e => e.artifact.parts.map(p => p.text).join('')).join(''), 'hello\nworld\nfinal artifact');
	assert.equal(artifacts.filter(e => e.lastChunk).length, 1); assert.equal(artifacts.at(-1).lastChunk, true);
});
test('ID-less chunks retain exact concatenation even mixed with IDs', async t => {
	const s = await setup(t), task = (await s.send('mixed-ids')).result;
	assert.equal((await s.done(task.id)).artifacts[0].parts[0].text, 'onetwothree');
});
test('private diagnostics exclusive creation, permissions, bounded bytes and idempotent closure', t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-diag-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, 'private'), link = path.join(dir, 'link'); const sink = acpDiagnostics(file);
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.throws(() => acpDiagnostics(file), /creation failed/);
	fs.symlinkSync(file, link); assert.throws(() => acpDiagnostics(link), /creation failed/);
	sink.write(Buffer.alloc(diagnosticsLimit - 2, 65)); sink.write(Buffer.from('BCDE')); sink.write(Buffer.from('NEVER')); sink.close(); sink.close(); sink.write(Buffer.from('AFTER'));
	assert.equal(fs.statSync(file).size, diagnosticsLimit); assert.equal(fs.readFileSync(file).subarray(-2).toString(), 'BC');
	assert.throws(() => acpDiagnostics(path.join(dir, 'missing', 'file')), /creation failed/);
});
test('raw stderr private and capped across bindings, never public even on prompt failure', async t => {
	const s = await setup(t, { diagnostics: true });
	const first = (await s.send('stderr')).result; const completed = await s.done(first.id); await delay(100);
	const second = (await s.send('prompt-error')).result; const failed = await s.done(second.id);
	await s.target.close();
	assert.match(failed.status.message.parts[0].text, /session\/prompt failed/);
	assert.equal(fs.statSync(s.file).size, diagnosticsLimit); assert.ok(fs.readFileSync(s.file, 'utf8').includes('PRIVATE-STDERR'));
	assert.ok(!JSON.stringify([completed, failed, s.reports]).includes('PRIVATE-STDERR'));
});
test('mandatory owner mode is validated without starting adapter', async t => {
	const s = await setup(t);
	for (const value of [undefined, '', '\u001b[31m', 'two modes']) assert.throws(() => acpOptions({ acp: '["agent"]', 'acp-cwd': s.dir, 'acp-mode': value }), /acp-mode/);
	assert.deepEqual(s.calls(), []);
});
test('private diagnostic write failure fences target and never reports raw error', async t => {
	const s = await setup(t, { diagnostics: true });
	t.mock.method(fs, 'writeSync', () => { throw new Error('PRIVATE-STDERR-credential-example'); });
	const task = (await s.send('stderr')).result; await delay(200);
	assert.ok(s.reports.some(m => m.includes('diagnostics write or close failed')));
	assert.ok(!JSON.stringify(s.reports).includes('PRIVATE-STDERR'));
	assert.deepEqual(await s.rpc('tasks/get', { id: task.id }), { error: 'unavailable' });
	await s.target.close();
});
test('diagnostic closure failure is fixed, once-only and retains partial file', t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-diag-close-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, 'private'); let failures = 0;
	const sink = acpDiagnostics(file, () => failures++); sink.write(Buffer.from('partial'));
	const close = fs.closeSync;
	const mock = t.mock.method(fs, 'closeSync', fd => { close(fd); throw new Error('PRIVATE-STDERR'); });
	assert.doesNotThrow(() => sink.close()); sink.close(); assert.equal(failures, 1); mock.mock.restore();
	assert.equal(fs.readFileSync(file, 'utf8'), 'partial');
});
for (const [mode, phase] of [['v2', 'initialize'], ['new-error', 'session/new'], ['missing', 'session/load']]) test(`fixed phase failure: ${phase}`, async t => {
	const s = await setup(t, { mode, ...(mode === 'missing' ? { sessionId: 'absent', sessionPeer: 'alice' } : {}) });
	const task = (await s.send('test')).result; const result = await s.done(task.id);
	assert.ok(result.status.message.parts[0].text.includes(phase)); assert.ok(s.reports.some(m => m.includes(phase)));
	assert.ok(!JSON.stringify([result, s.reports]).includes('secret'));
});
