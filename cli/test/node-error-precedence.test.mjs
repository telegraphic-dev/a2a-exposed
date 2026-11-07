import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/a2a-exposed.mjs", import.meta.url));

// Run the public executable with an isolated config and a simulated runtime version.
// Valid setup must hit the version gate before writing config or spawning cf/npm.
function run(t, version, args, config = "") {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-node-error-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, "config.env");
	// Both direct cf and the npx fallback record invocation; neither may be spawned.
	for (const name of ["cf", "npx"]) fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho invoked >> '${dir}/spawned'\nexit 99\n`, { mode: 0o700 });
	if (config) fs.writeFileSync(file, config, { mode: 0o600 });
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
		!/^(A2A_|WAKE_|CF_|CLOUDFLARE_|PEER_|UPSTREAM_|APPROVAL_|EVENT_|FEEDBACK_|CONTROL_|HOSTED_|NODE_OPTIONS$)/.test(key)));
	Object.assign(env, { A2A_CONFIG_DIR: dir, DO_NOT_TRACK: "1", PATH: dir });
	const preload = `data:text/javascript,${encodeURIComponent(`Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });`)}`;
	const result = spawnSync(process.execPath, ["--import", preload, BIN, ...args], { env, encoding: "utf8", timeout: 10000 });
	assert.ifError(result.error);
	assert.equal(result.status, 1, result.stderr);
	assert.equal(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "", config, "configuration remains unchanged");
	assert.deepEqual(fs.readdirSync(dir).sort(), config ? ["cf", "config.env", "npx"] : ["cf", "npx"], "fake cf/npm were never spawned; no worker or install artifacts");
	return result.stderr;
}

for (const version of ["20.19.5", "22.17.1", process.versions.node]) {
	test(`Node ${version}: missing deployment and invalid options keep their actual errors`, (t) => {
		for (const [args, error] of [[["deploy"], /^error: no saved deployment/], [["tunnel", "create"], /^error: nothing is deployed/]]) {
			const stderr = run(t, version, args);
			assert.match(stderr, error);
			assert.doesNotMatch(stderr, /How to get Node/);
		}
		const stderr = run(t, version, ["init", "--pairing-approval", "invalid"]);
		assert.match(stderr, /^error: --pairing-approval must be one of/);
		assert.doesNotMatch(stderr, /How to get Node/);
		const saved = "A2A_D1_ID=dummy-db\nA2A_WORKER_NAME=example-inbox\n";
		assert.match(run(t, version, ["deploy", "--mcp", "invalid"], saved), /^error: --mcp must be on or off/);
	});
}

for (const version of ["20.19.5", "22.17.1"]) {
	test(`Node ${version}: valid setup still stops before config writes or external commands`, (t) => {
		const saved = "A2A_D1_ID=dummy-db\nA2A_WORKER_NAME=example-inbox\n";
		for (const [args, config] of [
			[["init", "--worker-name", "example-inbox"], ""],
			[["deploy", "--worker-name", "changed-inbox"], saved],
		]) {
			const stderr = run(t, version, args, config);
			assert.match(stderr, new RegExp(`^error: Node ${version.replaceAll(".", "\\.")} found;`));
			assert.match(stderr, /How to get Node 22/);
			assert.doesNotMatch(stderr, /checking Cloudflare|worker project|installing/);
		}
	});
}
