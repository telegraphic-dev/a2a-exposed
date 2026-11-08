import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/a2a-exposed.mjs', import.meta.url));

test('HTTP relay help makes audience, optional URL and machine/process contracts explicit', t => {
	const config = mkdtempSync(path.join(tmpdir(), 'http-relay-help-'));
	t.after(() => rmSync(config, { recursive: true, force: true }));
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (/^(?:WAKE_|A2A_|CF_|CLOUDFLARE_)/.test(key)) delete env[key];
	env.A2A_CONFIG_DIR = config;
	const result = spawnSync(process.execPath, [cli, 'help'], { env, encoding: 'utf8', timeout: 10000 });
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, '');
	const section = result.stdout.split('HTTP endpoint relays')[1]?.split('\nInbox (owner side)')[0];
	assert.ok(section, 'help contains the HTTP/native relay section');
	assert.match(section, /relay http\|a2a run --token-file FILE --local-url/);
	assert.match(section, /\[--url wss:\/\/agent\.example\.com\/relay\/http\/PROFILE\/connect\]/);
	for (const text of ['--url defaults from A2A_BASE_URL', 'CLI http maps to wire PROFILE webhook', 'create/status/revoke always print JSON', 'run is silent on stdout', 'foreground only: keep running', '3 failed 10s handshakes', 'required for discovery too: invited callers, not URL-only public access']) assert.ok(section.includes(text), text);
});
