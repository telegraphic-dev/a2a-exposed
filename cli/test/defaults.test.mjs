// Package, config directory and Worker name defaults.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfigDir } from "../lib/config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8"));
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(A2A_|PEER_|CF_|CLOUDFLARE_|UPSTREAM_)|WAKE_/.test(k)));

test("package: a2a-exposed with its one bin", () => {
	assert.equal(PKG.name, "a2a-exposed");
	assert.deepEqual(PKG.bin, { "a2a-exposed": "bin/a2a-exposed.mjs" });
	assert.match(PKG.repository.url, /telegraphic-dev\/a2a-exposed\.git$/);
});

test("config dir: <XDG config>/a2a-exposed, and nothing else", (t) => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-cfg-"));
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	assert.equal(defaultConfigDir(base), path.join(base, "a2a-exposed"));
	fs.mkdirSync(path.join(base, "some-other-tool"));
	assert.equal(defaultConfigDir(base), path.join(base, "a2a-exposed"), "other directories are never picked up");
});

test("worker name: a2a-exposed unless A2A_WORKER_NAME is saved (also for a saved deployment)", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-wn-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const name = (cfg) => {
		fs.writeFileSync(path.join(dir, "config.env"), cfg, { mode: 0o600 });
		const r = spawnSync(process.execPath, ["--input-type=module", "-e", "const d = await import(process.argv[1]); console.log(d.workerName());", new URL("../lib/deploy.mjs", import.meta.url).href],
			{ env: { ...clean(), A2A_CONFIG_DIR: dir }, encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		return r.stdout.trim();
	};
	assert.equal(name(""), "a2a-exposed");
	assert.equal(name("A2A_D1_ID=abc\n"), "a2a-exposed");
	assert.equal(name("A2A_D1_ID=abc\nA2A_WORKER_NAME=my-agent\n"), "my-agent");
});
