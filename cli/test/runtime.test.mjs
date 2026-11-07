import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pathNode, pinnedCommand, runtimeInfo, sameExecutable } from "../lib/runtime.mjs";
import { shellQuote } from "../lib/config.mjs";

const BIN = fileURLToPath(new URL("../bin/a2a-exposed.mjs", import.meta.url));
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
	!/^(A2A_|WAKE_|CF_|CLOUDFLARE_|PEER_|UPSTREAM_|APPROVAL_|EVENT_|FEEDBACK_|CONTROL_|HOSTED_|NODE_OPTIONS$)/.test(key)));

function fixture(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-runtime-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const run = (args, env = {}) => spawnSync(process.execPath, [BIN, ...args], {
		env: { ...clean(), DO_NOT_TRACK: "1", A2A_CONFIG_DIR: dir, ...env }, encoding: "utf8", timeout: 10000,
	});
	return { dir, run };
}

test("env prints only the absolute directory, quotes shell metacharacters, and writes nothing", (t) => {
	const { dir, run } = fixture(t);
	const config = path.join(dir, "a'b $HOME `id` $(id)");
	const r = run(["--config-dir", config, "env"]);
	assert.equal(r.status, 0, r.stderr);
	const evaluated = spawnSync("/bin/sh", ["-c", `${r.stdout}\nprintf '%s' "$A2A_CONFIG_DIR"`], { encoding: "utf8" });
	assert.equal(evaluated.status, 0, evaluated.stderr);
	assert.equal(evaluated.stdout, config);
	assert.equal(fs.existsSync(config), false);
	const json = run(["env", "--json", "--config-dir", config]);
	assert.deepEqual(JSON.parse(json.stdout), { A2A_CONFIG_DIR: config });
	assert.equal(run(["env", "unexpected"]).status, 1);
	const relative = run(["env", "--json", "--config-dir", "relative"]);
	assert.equal(JSON.parse(relative.stdout).A2A_CONFIG_DIR, path.resolve("relative"));
});

test("default config directory keeps default command; custom directory propagates to status next steps", (t) => {
	const { dir, run } = fixture(t);
	const r = run(["status", "--json"]);
	assert.equal(r.status, 1, r.stderr);
	const s = JSON.parse(r.stdout);
	assert.equal(s.runtime.node, process.versions.node);
	assert.equal(s.runtime.execPath, process.execPath);
	assert.ok(s.nextStep.includes(`--config-dir ${dir} init`), s.nextStep);
	const text = run(["status"]);
	assert.match(text.stdout, /runtime:.*Node/);
	assert.ok(text.stdout.includes(`--config-dir ${dir} init`), text.stdout);
	const defaults = run(["status", "--json"], { A2A_CONFIG_DIR: "", XDG_CONFIG_HOME: dir });
	assert.equal(JSON.parse(defaults.stdout).nextStep.includes("--config-dir"), false);
});

test("runtime detects explicit and PATH node mismatches without running wake commands", (t) => {
	const { dir, run } = fixture(t);
	fs.writeFileSync(path.join(dir, "config.env"), `WAKE_CLI_COMMAND="'/other node/bin/node' never-run.mjs"\n`, { mode: 0o600 });
	const r = run(["status", "--json"]);
	const runtime = JSON.parse(r.stdout).runtime;
	assert.equal(runtime.wakeExecPath, "/other node/bin/node");
	assert.match(runtime.warning, /WAKE_CLI_COMMAND selects a different Node/);
	assert.match(run(["status"]).stdout, /WARNING: WAKE_CLI_COMMAND/);
	const info = runtimeInfo({ execPath: "/a/bin/node", pathExecPath: "/b/bin/node", command: "npx -y a2a-exposed@latest" });
	assert.ok(info.warning);
	assert.equal(runtimeInfo({ command: pinnedCommand() }).warning, null);
	assert.equal(runtimeInfo({ command: "mise exec node@22 -- npx -y a2a-exposed@latest" }).wakeExecPath, null);
});

test("PATH lookup is read-only, skips non-executables, and treats symlinks to Node as the same runtime", (t) => {
	const { dir } = fixture(t);
	const a = path.join(dir, "first"), b = path.join(dir, "second");
	fs.mkdirSync(a); fs.mkdirSync(b);
	fs.writeFileSync(path.join(a, "node"), "never execute", { mode: 0o600 });
	fs.symlinkSync(process.execPath, path.join(b, "node"));
	assert.equal(pathNode({ PATH: [a, b].join(path.delimiter) }), path.join(b, "node"));
	assert.ok(sameExecutable(path.join(b, "node"), process.execPath));
});

test("pinned command overrides PATH node for npx shebangs, including quoted paths", (t) => {
	const { dir } = fixture(t);
	const bin = path.join(dir, "pin's bin"); fs.mkdirSync(bin);
	fs.symlinkSync(process.execPath, path.join(bin, "node"));
	fs.writeFileSync(path.join(bin, "npx"), '#!/usr/bin/env node\nconsole.log(process.execPath);\n', { mode: 0o700 });
	const r = spawnSync("/bin/sh", ["-c", pinnedCommand(path.join(bin, "node"))], {
		env: { PATH: process.env.PATH }, encoding: "utf8",
	});
	assert.equal(r.status, 0, r.stderr);
	assert.ok(sameExecutable(r.stdout.trim(), process.execPath));
	assert.equal(shellQuote("/tmp/simple"), "/tmp/simple");
});
