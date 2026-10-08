// The rename to a2a-exposed: the deprecated `a2a-over-webhook` command still works (with a notice), an existing
// ~/.config/a2a-over-webhook is still found, and a pre-rename deployment keeps its Worker name.
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

const ALIAS = path.join(HERE, "..", "..", "alias", "a2a-over-webhook");

test("packages: a2a-exposed (only its own bin), and the deprecated a2a-over-webhook alias package that depends on it", () => {
	assert.equal(PKG.name, "a2a-exposed");
	assert.deepEqual(PKG.bin, { "a2a-exposed": "bin/a2a-exposed.mjs" }, "the old bin name would clash with an installed a2a-over-webhook on npm i -g");
	assert.match(PKG.repository.url, /telegraphic-dev\/a2a-exposed\.git$/);
	const alias = JSON.parse(fs.readFileSync(path.join(ALIAS, "package.json"), "utf8"));
	assert.equal(alias.name, "a2a-over-webhook");
	assert.deepEqual(alias.bin, { "a2a-over-webhook": "bin/a2a-over-webhook.mjs" });
	assert.equal(alias.dependencies["a2a-exposed"], PKG.version, "the alias pins a2a-exposed at its own version");
	assert.equal(alias.version, PKG.version);
	assert.deepEqual(alias.dependencies, { "a2a-exposed": PKG.version }, "nothing else");
});

test("the alias package's command runs the a2a-exposed CLI and says it is deprecated", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-rename-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	// an installed alias: its bin, with a2a-exposed (this checkout) as its dependency
	const inst = path.join(dir, "node_modules", "a2a-over-webhook");
	fs.mkdirSync(path.join(inst, "bin"), { recursive: true });
	fs.copyFileSync(path.join(ALIAS, "package.json"), path.join(inst, "package.json"));
	fs.copyFileSync(path.join(ALIAS, "bin", "a2a-over-webhook.mjs"), path.join(inst, "bin", "a2a-over-webhook.mjs"));
	fs.symlinkSync(path.join(HERE, ".."), path.join(dir, "node_modules", "a2a-exposed"), "dir");
	const env = { ...clean(), A2A_NO_UPDATE_CHECK: "1" };
	const run = (bin, args, extra = {}) => spawnSync(process.execPath, [bin, ...args], { env: { ...env, ...extra }, encoding: "utf8" });
	const OLD = path.join(inst, "bin", "a2a-over-webhook.mjs"), NEW = path.join(HERE, "..", "bin", "a2a-exposed.mjs");
	const run2 = (b, args, extra) => run(b === "a2a-exposed.mjs" ? NEW : OLD, args, extra);
	const n = run2("a2a-exposed.mjs", ["--version"]), o = run2("a2a-over-webhook.mjs", ["--version"]);
	assert.equal(o.status, 0, o.stderr);
	assert.equal(o.stdout, n.stdout);
	assert.match(o.stderr, /`a2a-over-webhook` is now `a2a-exposed`/);
	assert.equal(n.stderr, "");
	assert.equal(run2("a2a-over-webhook.mjs", ["--version"], { A2A_NO_RENAME_NOTICE: "1" }).stderr, "");
	// global options still work through the alias
	const u = run2("a2a-over-webhook.mjs", ["--config-dir", dir, "url"], { A2A_NO_RENAME_NOTICE: "1" });
	assert.equal(u.status, 1);
	assert.ok(u.stderr.includes(path.join(dir, "config.env")), u.stderr);
});

test("config dir: a2a-exposed, or the pre-rename a2a-over-webhook when only that exists (never moved)", (t) => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-cfg-"));
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	assert.equal(defaultConfigDir(base), path.join(base, "a2a-exposed"));
	fs.mkdirSync(path.join(base, "a2a-over-webhook"));
	assert.equal(defaultConfigDir(base), path.join(base, "a2a-over-webhook"));
	fs.mkdirSync(path.join(base, "a2a-exposed"));
	assert.equal(defaultConfigDir(base), path.join(base, "a2a-exposed"));
	assert.ok(fs.existsSync(path.join(base, "a2a-over-webhook")), "the old directory is left alone");
});

test("worker name: new deployments default to a2a-exposed; a saved deployment without a name keeps the old default", (t) => {
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
	assert.equal(name("A2A_D1_ID=abc\n"), "a2a-over-webhook");
	assert.equal(name("A2A_D1_ID=abc\nA2A_WORKER_NAME=my-agent\n"), "my-agent");
});
