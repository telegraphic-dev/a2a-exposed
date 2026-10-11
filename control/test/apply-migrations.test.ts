import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrationDatabase, resolveDatabaseId } from "../scripts/apply-migrations.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts/apply-migrations.mjs");
const databaseId = "00000000-0000-4000-8000-000000000001";

test("a deploy with no D1 binding has nothing to migrate", () => {
	assert.deepEqual(migrationDatabase({}), { skip: true });
	assert.deepEqual(migrationDatabase({ CONTROL_D1_ID: "  ", CONTROL_D1_NAME: "" }), { skip: true });
	assert.deepEqual(migrationDatabase({ CONTROL_D1_ID: databaseId, CONTROL_D1_NAME: "control-db" }), { id: databaseId });
	assert.deepEqual(migrationDatabase({ CONTROL_D1_NAME: "control-db" }), { name: "control-db" });
});

test("a name-only binding resolves to the database id", () => {
	const calls: string[][] = [];
	const resolved = resolveDatabaseId({ name: "control-db" }, {}, (args) => {
		calls.push(args);
		return { status: 0, stdout: JSON.stringify([{ name: "other" }, { name: "control-db", uuid: databaseId }]), stderr: "" };
	});
	assert.deepEqual(resolved, { id: databaseId });
	assert.deepEqual(calls, [["d1", "list"]]);
	const missing = resolveDatabaseId({ name: "control-db" }, {}, () => ({ status: 0, stdout: "[]", stderr: "" }));
	assert.equal(missing.error, "the control D1 database was not found");
	const broken = resolveDatabaseId({ name: "control-db" }, {}, () => ({ status: 0, stdout: "not-json", stderr: "" }));
	assert.equal(broken.error, "could not read the D1 list");
});

function stubCf(log: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-stub-"));
	const file = path.join(dir, "cf");
	fs.writeFileSync(file, `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
if [ "$1" = "d1" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[{"name":"control-db","uuid":"${databaseId}"}]'
  exit 0
fi
if [ "$1" = "d1" ] && [ "$2" = "migrations" ] && [ "$3" = "apply" ]; then
  exit "\${CF_STATUS:-0}"
fi
exit 1
`);
	fs.chmodSync(file, 0o755);
	return dir;
}

function runScript(env: Record<string, string>) {
	const log = path.join(os.tmpdir(), `cf-log-${process.pid}-${Math.random().toString(16).slice(2)}`);
	const pathDir = stubCf(log);
	const result = spawnSync(process.execPath, [script], {
		cwd: root,
		env: { ...env, PATH: pathDir },
		encoding: "utf8",
	});
	const lines = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
	return { status: result.status, stderr: result.stderr ?? "", lines };
}

test("deploy applies migrations before it can upload the Worker", () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: { deploy: string } };
	const deploy = pkg.scripts.deploy;
	const applyAt = deploy.indexOf("node scripts/apply-migrations.mjs");
	const uploadAt = deploy.lastIndexOf("cf deploy");
	assert.ok(applyAt > deploy.indexOf("prerender"));
	assert.ok(uploadAt > applyAt);
	assert.match(deploy, /apply-migrations\.mjs && cf deploy$/);

	const skipped = runScript({});
	assert.equal(skipped.status, 0);
	assert.match(skipped.stderr, /skipping control migrations/);
	assert.deepEqual(skipped.lines, []);

	const applied = runScript({ CONTROL_D1_ID: databaseId });
	assert.equal(applied.status, 0);
	assert.match(applied.stderr, /applying control D1 migrations/);
	assert.deepEqual(applied.lines, [`d1 migrations apply ${databaseId} --dir migrations`]);

	const named = runScript({ CONTROL_D1_NAME: "control-db" });
	assert.equal(named.status, 0);
	assert.deepEqual(named.lines, ["d1 list", `d1 migrations apply ${databaseId} --dir migrations`]);

	const failed = runScript({ CONTROL_D1_ID: databaseId, CF_STATUS: "1" });
	assert.equal(failed.status, 1);
	assert.deepEqual(failed.lines, [`d1 migrations apply ${databaseId} --dir migrations`]);
});
