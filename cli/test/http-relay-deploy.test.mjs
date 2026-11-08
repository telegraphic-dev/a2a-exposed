import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(new URL("../bin/a2a-exposed.mjs", import.meta.url));

test("HTTP relay deploy flag maps and retains opt-in configuration without I/O", t => {
	const dir = mkdtempSync(join(tmpdir(), "http-relay-config-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
	const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(A2A_|WAKE_|CF_|CLOUDFLARE_|PEER_|UPSTREAM_|APPROVAL_|EVENT_|FEEDBACK_|CONTROL_|HOSTED_|NODE_OPTIONS$)/.test(key))), A2A_CONFIG_DIR: dir, DO_NOT_TRACK: "1" };
	const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: dir, env, encoding: "utf8", timeout: 8000 });
	const enabled = run(["init", "--dry-run", "--json", "--http-relay", "1"]); assert.equal(enabled.status, 0, enabled.stderr); assert.equal(JSON.parse(enabled.stdout).config.A2A_HTTP_RELAY, "1");
	const off = run(["init", "--dry-run", "--json"]); assert.equal(off.status, 0, off.stderr); assert.equal(JSON.parse(off.stdout).config.A2A_HTTP_RELAY, undefined);
	writeFileSync(join(dir, "config.env"), "A2A_HTTP_RELAY=1\n", { mode: 0o600 });
	const saved = run(["init", "--dry-run", "--json"]); assert.equal(saved.status, 0, saved.stderr); assert.equal(JSON.parse(saved.stdout).config.A2A_HTTP_RELAY, "1");
	const disabled = run(["init", "--dry-run", "--json", "--http-relay", "0"]); assert.equal(disabled.status, 0, disabled.stderr); assert.equal(JSON.parse(disabled.stdout).config.A2A_HTTP_RELAY, "0");
	const invalid = run(["init", "--dry-run", "--http-relay", "yes"]); assert.equal(invalid.status, 1); assert.match(invalid.stderr, /--http-relay must be 0 or 1/);
	for (const profile of ["http", "a2a"]) { const bad = run(["relay", profile, "run", "--unknown", "value"]); assert.equal(bad.status, 1); assert.match(bad.stderr, /unknown (?:option|flag)|Unknown option|unsupported/); }
	const help = run(["--help"]); assert.equal(help.status, 0); assert.match(help.stdout, /--http-relay 1/); assert.match(help.stdout, /shared ingress is NOT peer auth/);
});
