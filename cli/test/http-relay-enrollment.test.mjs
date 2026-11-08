import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:WAKE_|A2A_|CF_|CLOUDFLARE_)/.test(k)));
async function fixture(t, handler) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-enrollment-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const files = [path.join(dir, 'connector'), path.join(dir, 'ingress')];
	let calls = 0;
	const server = createServer(async (req, res) => { calls++; await handler(req, res, files); });
	server.listen(0, '127.0.0.1'); await once(server, 'listening');
	t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
	return { dir, files, calls: () => calls, async run(overrides = {}, preload) {
		const child = spawn(process.execPath, [...(preload ? ['--import', 'data:text/javascript,' + encodeURIComponent(preload)] : []), new URL('../bin/a2a-exposed.mjs', import.meta.url).pathname, 'relay', 'http', 'create', '--token-file', files[0], '--ingress-token-file', files[1]], { cwd: dir, env: { ...cleanEnv(), A2A_CONFIG_DIR: dir, A2A_BASE_URL: `http://127.0.0.1:${server.address().port}`, A2A_OWNER_TOKEN: 'dummy-owner-secret', DO_NOT_TRACK: '1', ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
		t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
		let stdout = '', stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
		const [code, signal] = await once(child, 'close'); assert.equal(signal, null);
		assert.doesNotMatch(stdout + stderr, /a2ah_|a2ai_|dummy-owner-secret|upstream-private-secret|127\.0\.0\.1/);
		return { code, stdout, stderr };
	} };
}
function reply(res, status, data = { error: 'upstream-private-secret' }) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); }

for (const [name, overrides, guidance] of [
	['missing config', { A2A_BASE_URL: '', A2A_OWNER_TOKEN: '' }, /A2A_BASE_URL.*A2A_OWNER_TOKEN/],
	['partial config', { A2A_OWNER_TOKEN: '' }, /A2A_OWNER_TOKEN/],
	['invalid URL', { A2A_BASE_URL: 'not-a-url-upstream-private-secret' }, /configuration/],
	['invalid owner header', { A2A_OWNER_TOKEN: 'bad\nupstream-private-secret' }, /configuration/],
]) test(`actual CLI ${name} is not enrollment uncertainty and leaves reusable filenames`, async t => {
	const f = await fixture(t, (_req, res) => reply(res, 500));
	const r = await f.run(overrides); assert.equal(r.code, 1); assert.match(r.stderr, guidance); assert.doesNotMatch(r.stderr, /unconfirmed|retained/);
	assert.equal(f.calls(), 0); for (const file of f.files) assert.equal(fs.existsSync(file), false);
});

for (const [status, guidance] of [[404, /enable.*compatible.*Worker/i], [401, /owner.*authentication/i], [403, /owner.*authentication/i], [400, /options.*compatible/i], [409, /status.*owner approval/i], [422, /options.*compatible/i]]) test(`actual CLI definite ${status} rejection cleans files and permits exact filename reuse`, async t => {
	let reject = true;
	const f = await fixture(t, (_req, res) => reply(res, reject ? status : 200, reject ? undefined : { enrolled: true, generation: 7 }));
	const r = await f.run(); assert.equal(r.code, 1); assert.match(r.stderr, guidance); assert.doesNotMatch(r.stderr, /unconfirmed|retained/);
	for (const file of f.files) assert.equal(fs.existsSync(file), false);
	assert.equal(f.calls(), 1); reject = false;
	const next = await f.run(); assert.equal(next.code, 0, next.stderr); assert.equal(f.calls(), 3);
});

test('actual CLI never changes preexisting credentials when reservation fails', async t => {
	const f = await fixture(t, (_req, res) => reply(res, 500));
	fs.writeFileSync(f.files[1], 'preexisting-secret', { mode: 0o600 });
	const r = await f.run(); assert.equal(r.code, 1); assert.match(r.stderr, /reserve/); assert.equal(f.calls(), 0);
	assert.equal(fs.existsSync(f.files[0]), false); assert.equal(fs.readFileSync(f.files[1], 'utf8'), 'preexisting-secret');
});

for (const mode of ['accepted response lost', 'server failure', 'confirmation lost', 'malformed success', 'generation mismatch']) test(`actual CLI ${mode} retains protected credentials for reconciliation without retry`, async t => {
	const f = await fixture(t, (req, res) => {
		if (mode === 'accepted response lost' || (mode === 'confirmation lost' && req.method === 'GET')) { req.socket.destroy(); return; }
		if (mode === 'server failure') { reply(res, 503); return; }
		reply(res, 200, mode === 'malformed success' ? {} : { enrolled: true, generation: mode === 'generation mismatch' && req.method === 'GET' ? 8 : 7 });
	});
	const r = await f.run(); assert.equal(r.code, 1); assert.match(r.stderr, /unconfirmed.*retained.*relay http status.*owner approval/i);
	assert.equal(f.calls(), ['confirmation lost', 'generation mismatch'].includes(mode) ? 2 : 1);
	for (const [i, file] of f.files.entries()) { assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.match(fs.readFileSync(file, 'utf8'), i ? /^a2ai_[\w-]{43}\n$/ : /^a2ah_[\w-]{43}\n$/); }
});

test('actual CLI cleanup preserves a path replaced during definite rejection', async t => {
	const f = await fixture(t, (_req, res, files) => { fs.renameSync(files[0], files[0] + '.original'); fs.writeFileSync(files[0], 'replacement-secret', { mode: 0o600 }); reply(res, 400); });
	const r = await f.run(); assert.equal(r.code, 1); assert.equal(fs.readFileSync(f.files[0], 'utf8'), 'replacement-secret'); assert.equal(fs.existsSync(f.files[1]), false);
});

test('actual CLI local write failure cleans only reserved files before remote request', async t => {
	const f = await fixture(t, (_req, res) => reply(res, 500));
	const r = await f.run({}, "import fs from 'node:fs';fs.fsyncSync=()=>{throw new Error('upstream-private-secret');};");
	assert.equal(r.code, 1); assert.match(r.stderr, /write.*credential files/i); assert.doesNotMatch(r.stderr, /unconfirmed/); assert.equal(f.calls(), 0);
	for (const file of f.files) assert.equal(fs.existsSync(file), false);
});
