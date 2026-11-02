import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const workflow = fs.readFileSync(new URL(".github/workflows/clawhub.yml", root), "utf8");
const version = JSON.parse(fs.readFileSync(new URL("cli/package.json", root), "utf8")).version;
function step(name) {
	const section = workflow.split(`      - name: ${name}\n`)[1];
	assert.ok(section, `missing step: ${name}`);
	const lines = section.split("\n");
	const start = lines.findIndex((line) => line === "        run: |");
	assert.ok(start >= 0);
	const script = [];
	for (const line of lines.slice(start + 1)) {
		if (line && !line.startsWith("          ")) break;
		script.push(line.slice(10));
	}
	return script.join("\n");
}
function fixture(t, extra = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawhub-workflow-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const env = {
		PATH: `${dir}:${process.env.PATH}`, HOME: process.env.HOME,
		DO_NOT_TRACK: "1", CI: "true", DRY_RUN: "true",
		CLAWHUB_CONFIG_PATH: path.join(dir, "config.json"),
		CLAWHUB_REGISTRY: "https://clawhub.ai", CLAWHUB_SITE: "https://clawhub.ai",
		GITHUB_ENV: path.join(dir, "env"), GITHUB_REF: "refs/heads/main",
		GITHUB_REPOSITORY: "example/repo", VERSION: version,
		SKILL_SLUG: "a2a-exposed", SKILL_NAME: "A2A Exposed",
		CAPTURE: path.join(dir, "capture.json"), ...extra,
	};
	fs.writeFileSync(path.join(dir, "clawhub"), `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.CAPTURE, JSON.stringify({
 args: process.argv.slice(2),
 config: JSON.parse(fs.readFileSync(process.env.CLAWHUB_CONFIG_PATH, "utf8")),
 mode: fs.statSync(process.env.CLAWHUB_CONFIG_PATH).mode & 0o777
}));
process.exit(Number(process.env.CLAWHUB_TEST_EXIT || 0));
`, { mode: 0o700 });
	return {
		env,
		run: (name) => spawnSync("bash", ["-e", "-o", "pipefail", "-c", step(name)], {
			cwd: root, env, encoding: "utf8",
		}),
		capture: () => JSON.parse(fs.readFileSync(env.CAPTURE, "utf8")),
	};
}

test("preview does not use a token, and sends explicit source, version and dry-run flags", (t) => {
	const f = fixture(t, { CLH_TOKEN: "dummy-secret" });
	const prepared = f.run("Validate release and prepare credentials");
	assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
	assert.equal(f.run("Publish skill or preview").status, 0);
	const { args, config, mode } = f.capture();
	assert.equal(config.token, undefined);
	assert.equal(mode, 0o600);
	for (const flag of ["--no-input", "--workdir", "--dry-run", "--json", "--source-repo", "--source-commit", "--source-ref", "--source-path"]) {
		assert.ok(args.includes(flag), flag);
	}
	assert.equal(args[args.indexOf("--version") + 1], version);
	assert.equal(args[args.indexOf("--tags") + 1], "latest");
	assert.equal(f.run("Remove credentials").status, 0);
	assert.equal(fs.existsSync(f.env.CLAWHUB_CONFIG_PATH), false);
});

test("publishing refuses branches, version mismatch and missing credentials before creating config", (t) => {
	for (const extra of [
		{ GITHUB_REF: "refs/heads/main", CLH_TOKEN: "dummy-secret" },
		{ GITHUB_REF: "refs/tags/v0.0.0", CLH_TOKEN: "dummy-secret" },
		{ GITHUB_REF: `refs/tags/v${version}` },
	]) {
		const f = fixture(t, { DRY_RUN: "false", ...extra });
		const result = f.run("Validate release and prepare credentials");
		assert.notEqual(result.status, 0);
		assert.match(result.stdout, /::error::/);
		assert.equal(fs.existsSync(f.env.CLAWHUB_CONFIG_PATH), false);
	}
});

test("release keeps the token out of arguments, supports owner/next and propagates failures", (t) => {
	const f = fixture(t, {
		DRY_RUN: "false", GITHUB_REF: `refs/tags/v${version}`, CLH_TOKEN: "dummy-secret",
		CLAWHUB_OWNER: "example-owner", CLAWHUB_TEST_EXIT: "9",
		SKILL_SLUG: "a2a-exposed-setup", SKILL_NAME: "A2A Exposed: setup",
	});
	const prepared = f.run("Validate release and prepare credentials");
	assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
	f.env.VERSION = "1.2.3-beta.1";
	assert.equal(f.run("Publish skill or preview").status, 9);
	const { args, config, mode } = f.capture();
	assert.equal(config.token, "dummy-secret");
	assert.equal(mode, 0o600);
	assert.ok(!args.includes("--dry-run"));
	assert.ok(!args.some((arg) => arg.includes("dummy-secret")));
	assert.equal(args[args.indexOf("--tags") + 1], "next");
	assert.equal(args[args.indexOf("--owner") + 1], "example-owner");
	assert.equal(args[args.indexOf("--slug") + 1], "a2a-exposed-setup");
	assert.equal(f.run("Remove credentials").status, 0);
	assert.equal(fs.existsSync(f.env.CLAWHUB_CONFIG_PATH), false);
});
