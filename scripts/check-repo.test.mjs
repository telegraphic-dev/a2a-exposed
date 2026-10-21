import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const checker = path.join(import.meta.dirname, "check-repo.mjs");
test("repository checks accept clean files and reject syntax, mutable actions, and whitespace", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-check-repo-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const git = (...args) => {
		const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	};
	git("init", "--quiet");
	fs.mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
	const write = (file, text) => fs.writeFileSync(path.join(root, file), text);
	write("ok.mjs", "export const value = 1;\n");
	write("ok.py", "value = 1\n");
	write("ok.json", "{}\n");
	write(".github/workflows/test.yml", "steps:\n  - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5\n");
	git("add", ".");
	const run = (mode) => spawnSync(process.execPath, [checker, mode], { cwd: root, encoding: "utf8" });
	for (const mode of ["lint", "format"]) assert.equal(run(mode).status, 0);
	write("ok.mjs", "export const = ;\n");
	write("ok.py", "value =\n");
	write("ok.json", "{\n");
	write(".github/workflows/test.yml", "steps:\n  - uses: actions/checkout@v4\n");
	const lint = run("lint");
	assert.equal(lint.status, 1);
	for (const file of ["ok.mjs", "ok.py", "ok.json"]) assert.ok(lint.stderr.includes(file), lint.stderr);
	assert.match(lint.stderr, /pin action to a full commit SHA/);
	write("ok.json", "{} \r\nno newline");
	const format = run("format");
	assert.equal(format.status, 1);
	for (const message of ["missing final newline", "use LF line endings", "trailing whitespace"]) {
		assert.ok(format.stderr.includes(message), format.stderr);
	}
});
