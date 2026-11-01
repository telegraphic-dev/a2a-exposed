import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("set-version preserves formatting, updates release fields, and rejects invalid input without writes", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-set-version-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const source = path.resolve(import.meta.dirname, "..");
	const files = ["package.json", "cli/package.json", "worker/package.json", "control/package.json", "worker/package-lock.json", "control/package-lock.json", "plugin.json", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", ".cursor-plugin/plugin.json", ".grok-plugin/plugin.json", "worker/src/version.ts", "skills/a2a-exposed/SKILL.md", "skills/a2a-exposed-setup/SKILL.md", "scripts/set-version.mjs", "scripts/changelog.mjs"];
	for (const file of files) {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.copyFileSync(path.join(source, file), path.join(root, file));
	}
	fs.mkdirSync(path.join(root, "changelog.d"));
	fs.writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## 0.0.1 - 2020-01-01\n\n- Old.\n");
	const lock = '{\n  "version": "0.8.11",\n  "packages": {\n    "": { "version": "0.8.11" },\n    "node_modules/example": { "version": "0.8.11" }\n  }\n}\n';
	fs.writeFileSync(path.join(root, "package-lock.json"), lock);
	const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
	const originalVersion = JSON.parse(read("cli/package.json")).version;
	const before = new Map(files.map((file) => [file, read(file)]));
	const run = (...args) => spawnSync(process.execPath, [path.join(root, "scripts/set-version.mjs"), ...args], { encoding: "utf8" });
	for (const args of [[], ["v1.2.3"], ["1.2"], ["01.2.3"], ["1.2.3-01"], ["1.2.3\n"], ["1.2.3", "extra"]]) {
		assert.equal(run(...args).status, 1);
		for (const [file, text] of before) assert.equal(read(file), text);
		assert.equal(read("package-lock.json"), lock);
	}
	for (const version of ["1.2.3", "2.0.0-rc.1+build.42"]) {
		fs.writeFileSync(path.join(root, "changelog.d/entry.md"), "- Entry.\n");
		assert.equal(run(version).status, 0);
		assert.equal(fs.existsSync(path.join(root, "changelog.d/entry.md")), false);
		assert.match(read("CHANGELOG.md"), /- Entry\./);
		for (const [file, text] of before) {
			const expected = file.startsWith("scripts/") ? text : text.replaceAll(originalVersion, version);
			assert.equal(read(file), expected, file);
		}
		const doc = JSON.parse(read("package-lock.json"));
		assert.equal(doc.version, version);
		assert.equal(doc.packages[""].version, version);
		assert.equal(doc.packages["node_modules/example"].version, "0.8.11");
		const once = read("plugin.json");
		assert.equal(run(version).status, 0);
		assert.equal(read("plugin.json"), once);
		fs.writeFileSync(path.join(root, "changelog.d/entry.md"), "- Pending.\n");
		const notes = read("CHANGELOG.md");
		assert.equal(run(version).status, 1);
		assert.equal(read("CHANGELOG.md"), notes);
		assert.equal(read("plugin.json"), once);
		assert.equal(read("changelog.d/entry.md"), "- Pending.\n");
		fs.unlinkSync(path.join(root, "changelog.d/entry.md"));
	}
});
