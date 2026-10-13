import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDeploy } from "../scripts/deploy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts/deploy.mjs");

function stubCf(log: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-deploy-"));
	const file = path.join(dir, "cf");
	fs.writeFileSync(file, `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
exit "\${CF_STATUS:-0}"
`);
	fs.chmodSync(file, 0o755);
	return dir;
}

test("deploy runs cf deploy", () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: { deploy: string } };
	assert.match(pkg.scripts.deploy, /node scripts\/deploy\.mjs$/);
	assert.equal(pkg.scripts.deploy.includes("prerender"), false);
	assert.equal(pkg.scripts.deploy.includes("secrets-file"), false);

	const log = path.join(os.tmpdir(), `cf-deploy-log-${process.pid}-${Math.random().toString(16).slice(2)}`);
	const pathDir = stubCf(log);
	const notes: string[] = [];
	const status = runDeploy(
		{ PATH: pathDir, CF_STATUS: "" },
		{ rootDir: root, warn: (line: string) => notes.push(String(line)) },
	);
	const lines = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
	assert.equal(status, 0);
	assert.deepEqual(lines, ["deploy"]);
	assert.deepEqual(notes, []);

	const failedLog = path.join(os.tmpdir(), `cf-deploy-fail-${process.pid}-${Math.random().toString(16).slice(2)}`);
	const failedPath = stubCf(failedLog);
	const failed = runDeploy({ PATH: failedPath, CF_STATUS: "1" }, { rootDir: root, warn: () => {} });
	assert.equal(failed, 1);
	assert.deepEqual(fs.readFileSync(failedLog, "utf8").trim().split("\n"), ["deploy"]);
});

test("the deploy script entry runs cf deploy", () => {
	const log = path.join(os.tmpdir(), `cf-deploy-entry-${process.pid}-${Math.random().toString(16).slice(2)}`);
	const pathDir = stubCf(log);
	const result = spawnSync(process.execPath, [script], {
		cwd: root,
		env: { PATH: pathDir },
		encoding: "utf8",
	});
	const lines = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
	assert.equal(result.status, 0);
	assert.deepEqual(lines, ["deploy"]);
});
