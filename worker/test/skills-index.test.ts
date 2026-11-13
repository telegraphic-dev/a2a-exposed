// The generated skills index must match skills/*/SKILL.md byte for byte: the build check from #349.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SKILLS } from "../src/skills-index.ts";
import * as D from "../src/discovery.ts";
// @ts-ignore: plain ESM build script, no types
import { DEFAULT_ROOT, skillEntries, writeSkillsIndex, render } from "../scripts/skills-index.mjs";

test("skills-index.ts is current: frontmatter descriptions and sha256 digests of skills/*/SKILL.md", () => {
	assert.equal(writeSkillsIndex(DEFAULT_ROOT, { check: true }), true, "stale: run node worker/scripts/skills-index.mjs and commit worker/src/skills-index.ts");
	assert.deepEqual(SKILLS.map((s) => s.name), ["a2a-exposed", "a2a-exposed-setup"]);
	for (const s of SKILLS) {
		const bytes = fs.readFileSync(path.join(DEFAULT_ROOT, "skills", s.name, "SKILL.md"));
		assert.equal(s.digest, "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex"), s.name);
		const fm = /^---\n([\s\S]*?)\n---/.exec(bytes.toString("utf8"))![1];
		assert.equal(s.description, /^description:\s*(.*)$/m.exec(fm)![1].trim(), s.name);
	}
	assert.deepEqual(skillEntries(DEFAULT_ROOT), SKILLS);
});

test("skills-index generator: --check reports a stale file without writing; a changed skill changes its digest", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-skills-index-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	for (const name of ["a2a-exposed", "a2a-exposed-setup"]) {
		fs.mkdirSync(path.join(root, "skills", name), { recursive: true });
		fs.copyFileSync(path.join(DEFAULT_ROOT, "skills", name, "SKILL.md"), path.join(root, "skills", name, "SKILL.md"));
	}
	fs.mkdirSync(path.join(root, "worker", "src"), { recursive: true });
	assert.equal(writeSkillsIndex(root, { check: true }), false);
	assert.equal(fs.existsSync(path.join(root, "worker/src/skills-index.ts")), false, "check never writes");
	assert.equal(writeSkillsIndex(root), false);
	assert.equal(writeSkillsIndex(root, { check: true }), true);
	fs.appendFileSync(path.join(root, "skills/a2a-exposed/SKILL.md"), "\n");
	assert.equal(writeSkillsIndex(root, { check: true }), false, "one changed byte makes the index stale");
	assert.notEqual(skillEntries(root)[0].digest, SKILLS[0].digest);
	fs.writeFileSync(path.join(root, "skills/a2a-exposed/SKILL.md"), "---\nname: other\ndescription: x\n---\n");
	assert.throws(() => skillEntries(root), /differs from its directory/);
	fs.writeFileSync(path.join(root, "skills/a2a-exposed/SKILL.md"), "---\nname: a2a-exposed\n---\n");
	assert.throws(() => skillEntries(root), /description is missing/);
	assert.match(render([]), /export const SKILLS/);
});

test("skillsIndex: v0.2.0 schema, absolute URL pinned to the release tag, digest passed through", () => {
	const base = D.skillsBase(undefined, "0.8.51");
	assert.equal(base, "https://raw.githubusercontent.com/telegraphic-dev/a2a-exposed/v0.8.51/skills");
	const idx = D.skillsIndex([{ name: "a2a-exposed", description: "d", digest: "sha256:ab" }], base);
	assert.deepEqual(idx, { $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json", skills: [
		{ name: "a2a-exposed", type: "skill-md", description: "d", url: "https://raw.githubusercontent.com/telegraphic-dev/a2a-exposed/v0.8.51/skills/a2a-exposed/SKILL.md", digest: "sha256:ab" }] });
});

test("skillsBase: https bases only (no credentials, query, or fragment), else the release tag", () => {
	const tag = D.skillsRepoBase("1.2.3");
	assert.equal(D.skillsBase("https://a2a.exposed/.well-known/agent-skills/", "1.2.3"), "https://a2a.exposed/.well-known/agent-skills");
	assert.equal(D.skillsBase(" https://staging.example.com/skills ", "1.2.3"), "https://staging.example.com/skills");
	for (const bad of ["", " ", "http://a2a.exposed/x", "https://u:p@a2a.exposed/x", "https://a2a.exposed/x?y=1", "https://a2a.exposed/x#y", "javascript:alert(1)", "not a url"])
		assert.equal(D.skillsBase(bad, "1.2.3"), tag, JSON.stringify(bad));
});

test("skillRedirect: only a listed skill's SKILL.md", () => {
	const skills = [{ name: "a2a-exposed", description: "d", digest: "sha256:ab" }];
	assert.equal(D.skillRedirect("/.well-known/agent-skills/a2a-exposed/SKILL.md", skills, "https://x.example/s"), "https://x.example/s/a2a-exposed/SKILL.md");
	for (const p of ["/.well-known/agent-skills/other/SKILL.md", "/.well-known/agent-skills/a2a-exposed/skill.md", "/.well-known/agent-skills/a2a-exposed/references/connect.md", "/.well-known/agent-skills/../a2a-exposed/SKILL.md"])
		assert.equal(D.skillRedirect(p, skills, "https://x.example/s"), null, p);
});
