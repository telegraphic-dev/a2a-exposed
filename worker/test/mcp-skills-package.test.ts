import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_ROOT } from "../scripts/mcp-skills-catalog.mjs";
import { checkPortableCatalog } from "../scripts/check-portable-catalog.mjs";
import { writePortableSkillsCatalog } from "../scripts/mcp-portable-skills-catalog.mjs";

test("committed portable edition matches source and packaged version/integrity checks", async () => {
	assert.equal(await writePortableSkillsCatalog(DEFAULT_ROOT, { check: true }), true);
	assert.equal(checkPortableCatalog(path.join(DEFAULT_ROOT, "worker")), true);
});

test("release command regenerates portable digests; packaged checks need no source or Git", async (t) => {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mcp-release-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	for (const relative of ["package.json", "cli/package.json", "worker/package.json", "worker/package-lock.json", "control/package.json", "control/package-lock.json", "encryption/package.json", "encryption/package-lock.json", "plugin.json", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", ".cursor-plugin/plugin.json", ".grok-plugin/plugin.json", "worker/src/version.ts", "scripts/set-version.mjs", "scripts/set-release-version.mjs", "worker/scripts/skills-index.mjs", "worker/scripts/mcp-skills-catalog.mjs", "worker/scripts/mcp-portable-skills-catalog.mjs"]) {
		const dest = path.join(root, relative);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.copyFileSync(path.join(DEFAULT_ROOT, relative), dest);
	}
	fs.cpSync(path.join(DEFAULT_ROOT, "skills"), path.join(root, "skills"), { recursive: true });
	fs.symlinkSync(path.join(DEFAULT_ROOT, "worker/node_modules"), path.join(root, "worker/node_modules"), "dir");
	for (const args of [["init", "-q"], ["add", "skills"]]) assert.equal(spawnSync("git", args, { cwd: root }).status, 0);
	const result = spawnSync(process.execPath, [path.join(root, "scripts/set-release-version.mjs"), "1.2.3"], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.equal(checkPortableCatalog(path.join(root, "worker")), true);
	const output = path.join(root, "worker/src/mcp-portable-skills-catalog.json");
	const original = fs.readFileSync(output, "utf8");
	const catalog = JSON.parse(original);
	assert.ok(catalog.skills.every((s: any) => s.frontmatter.metadata.version === "1.2.3"));
	for (const name of ["a2a-exposed", "a2a-exposed-setup"]) assert.match(fs.readFileSync(path.join(root, `skills/${name}/SKILL.md`), "utf8"), /  hermes:\n[\s\S]*  openclaw:/);
	fs.rmSync(path.join(root, "skills"), { recursive: true });
	fs.rmSync(path.join(root, ".git"), { recursive: true });
	assert.equal(checkPortableCatalog(path.join(root, "worker")), true);
	catalog.skills[0].frontmatter.metadata.version = "0.0.0";
	fs.writeFileSync(output, JSON.stringify(catalog));
	assert.throws(() => checkPortableCatalog(path.join(root, "worker")), /version or identity mismatch/);
	fs.writeFileSync(output, original);
	const uri = catalog.skills[0].resources[0].uri;
	catalog.skills[0].frontmatter.metadata.version = "1.2.3";
	catalog.resources[uri] = Buffer.from("changed").toString("base64");
	fs.writeFileSync(output, JSON.stringify(catalog));
	assert.throws(() => checkPortableCatalog(path.join(root, "worker")), /integrity mismatch/);
});
