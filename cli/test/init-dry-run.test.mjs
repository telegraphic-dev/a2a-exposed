import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function sandbox(t, saved = "") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-init-plan-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const config = path.join(root, "config");
	if (saved) {
		fs.mkdirSync(config);
		fs.writeFileSync(path.join(config, "config.env"), saved, { mode: 0o600 });
	}
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
		!/^(A2A_|WAKE_|CF_|CLOUDFLARE_|PEER_|UPSTREAM_|APPROVAL_|EVENT_|FEEDBACK_|CONTROL_|HOSTED_|NODE_OPTIONS$)/.test(key)));
	// Run from an npm-shaped installation so update checking would create a cache unless skipped.
	const installed = path.join(root, "node_modules", "a2a-exposed");
	fs.mkdirSync(installed, { recursive: true });
	for (const name of ["bin", "lib", "package.json"]) fs.cpSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), path.join(installed, name), { recursive: true });
	// Refuse subprocesses, requests and stdin reads.
	for (const name of ["cf", "npx", "npm", "cloudflared", "script"]) fs.writeFileSync(path.join(root, name), `#!/bin/sh\necho called > "${root}/spawned"\nexit 99\n`, { mode: 0o700 });
	const preload = `data:text/javascript,${encodeURIComponent(`
		import fs from "node:fs";
		globalThis.fetch = () => { fs.writeFileSync(${JSON.stringify(path.join(root, 'fetched'))}, "called"); throw new Error("unexpected network"); };
		const read = fs.readFileSync;
		fs.readFileSync = (p, ...args) => { if (p === 0) throw new Error("unexpected stdin read"); return read(p, ...args); };
	`)}`;
	Object.assign(env, { A2A_CONFIG_DIR: config, PATH: root, XDG_CACHE_HOME: path.join(root, "cache"),
		WAKE_WEBHOOK_URL: "https://example.com/private-wake-secret", EVENT_SECRET: "env-event-secret",
		UPSTREAM_TOKEN: "env-upstream-secret", WAKE_WEBHOOK_KEY: "env-webhook-secret",
		CI: "", DO_NOT_TRACK: "", A2A_NO_UPDATE_CHECK: "", NO_UPDATE_NOTIFIER: "" });
	const snapshot = () => JSON.stringify(fs.readdirSync(root, { recursive: true }).sort().map(p => {
		const file = path.join(root, p), stat = fs.statSync(file);
		return [p, stat.mode, stat.isFile() ? fs.readFileSync(file, "utf8") : null];
	}));
	return (args, overrides = {}) => {
		const before = snapshot();
		const result = spawnSync(process.execPath, ["--import", preload, path.join(installed, "bin", "a2a-exposed.mjs"), "init", ...args],
			{ env: { ...env, ...overrides }, encoding: "utf8", timeout: 5000 });
		assert.ifError(result.error);
		assert.equal(snapshot(), before, "preview did not change config, cache, template, secrets or other files");
		assert.doesNotMatch(result.stdout + result.stderr, /private-wake-secret|env-event-secret|env-upstream-secret|env-webhook-secret|saved-owner-secret|saved-peer-secret/);
		return result;
	};
}

test("fresh init preview is offline, noninteractive and structured, without creating a config directory", t => {
	const run = sandbox(t);
	const result = run(["--dry-run", "--json", "--worker-name", "example-inbox", "--hostname", "https://agent.example.com/path", "--account-id", "dummy-account", "--event-secret-stdin"]);
	assert.equal(result.status, 0, result.stderr);
	const plan = JSON.parse(result.stdout);
	assert.equal(plan.dryRun, true);
	assert.equal(plan.config.A2A_HOSTNAME, "agent.example.com");
	assert.equal(plan.config.A2A_D1_NAME, "example-inbox");
	assert.equal(plan.config.CLOUDFLARE_ACCOUNT_ID, "dummy-account");
	assert.ok(plan.secretNames.includes("EVENT_SECRET"));
	assert.match(plan.actions.join("\n"), /Find or create.*D1/);
	assert.match(plan.actions.join("\n"), /Generate an owner token/);
	assert.match(plan.next, /accounts list --json/);
});

test("saved preview uses init precedence, flags, rotation and skip-install without changing saved secrets", t => {
	const run = sandbox(t, "A2A_WORKER_NAME=saved-worker\nA2A_HOSTNAME=old.example.com\nA2A_D1_ID=saved-db\nA2A_OWNER_TOKEN=saved-owner-secret\nPEER_DEMO_TOKEN=saved-peer-secret\nCF_PROFILE=saved-profile\n");
	const result = run(["--dry-run", "--json", "--workers-dev", "--worker-name", "flag-worker", "--rotate-owner-token", "--skip-install"], { A2A_WORKER_NAME: "env-worker" });
	assert.equal(result.status, 0, result.stderr);
	const plan = JSON.parse(result.stdout);
	assert.equal(plan.config.A2A_WORKER_NAME, "env-worker");
	assert.equal(plan.config.A2A_HOSTNAME, null);
	assert.equal(plan.config.CF_PROFILE, "saved-profile");
	assert.match(plan.actions.join("\n"), /Reuse the saved D1/);
	assert.match(plan.actions.join("\n"), /Replace the saved owner token/);
	assert.doesNotMatch(plan.actions.join("\n"), /Install Worker dependencies/);
});

test("proxy and tunnel preview stops before authentication probes and tunnel creation", t => {
	const run = sandbox(t);
	const proxy = run(["--dry-run", "--upstream", "https://upstream.example.com/a2a", "--upstream-token-stdin"]);
	assert.equal(proxy.status, 0, proxy.stderr);
	assert.match(proxy.stdout, /Check upstream authentication at execution time/);
	const tunnel = run(["--dry-run", "--json", "--tunnel", "--preset", "hermes", "--tunnel-path", "/webhooks/a2a", "--tunnel-zone", "example.com"], { WAKE_WEBHOOK_URL: "" });
	assert.equal(tunnel.status, 0, tunnel.stderr);
	assert.match(JSON.parse(tunnel.stdout).actions.join("\n"), /Create or resume the wake tunnel/);
});

test("invalid preview options fail promptly with no changes", t => {
	const run = sandbox(t);
	for (const args of [
		["--pairing-approval", "invalid"], ["--workers-dev", "--hostname", "example.com"],
		["--worker-name", "INVALID"], ["--mcp", "invalid"], ["--agent-skills", "{}"],
		["--event-secret-stdin", "--upstream-token-stdin"], ["--upstream-token-stdin", "--no-upstream-token"],
		["--tunnel", "--preset", "claude-code"], ["unexpected"],
	]) {
		const result = run(["--dry-run", ...args]);
		assert.equal(result.status, 1, JSON.stringify(args));
		assert.match(result.stderr, /^error:/);
	}
	assert.equal(run(["--json"]).status, 1);
});
