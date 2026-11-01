import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
// JSON is a YAML subset and keeps these configuration checks dependency-free.
const { changelog } = JSON.parse(read(".github/release.yml"));
const category = (labels) => {
	if (labels.some((label) => changelog.exclude.labels.includes(label))) return undefined;
	return changelog.categories.find((group) => group.labels.some((label) => label === "*" || labels.includes(label)))?.title;
};

test("release categories cover user changes and exclude internal staging work", () => {
	assert.equal(category(["breaking-change", "enhancement"]), "Breaking changes");
	for (const [label, title] of Object.entries({ enhancement: "Features", bug: "Fixes", documentation: "Documentation", dependencies: "Dependencies" })) {
		assert.equal(category([label]), title);
		assert.equal(category([label, "skip-release-notes"]), undefined);
	}
	assert.equal(category(["skip-release-notes"]), undefined);
	assert.equal(category([]), "Other changes");
	assert.equal(category(["from-agent"]), "Other changes");
	assert.match(read(".github/workflows/publish.yml"), /--generate-notes/);
});

test("release seed previews versioned history and rejects mutation flags", () => {
	const script = new URL("./seed-release-notes.mjs", import.meta.url);
	const preview = (...args) => spawnSync(process.execPath, [script.pathname, ...args], { encoding: "utf8" });
	const result = preview("--dry-run");
	assert.equal(result.status, 0, result.stderr);
	const plan = JSON.parse(result.stdout);
	assert.equal(new Set(plan.map(({ tag }) => tag)).size, plan.length);
	assert.equal(plan[0].tag, "v0.8.28");
	assert.equal(plan.at(-1).tag, "v0.1.0");
	assert.ok(plan.every(({ tag, body }) => tag.startsWith("v") && body.trim()));
	assert.equal(preview().stdout, result.stdout);
	assert.equal(preview("--apply").status, 2);
	assert.equal(fs.existsSync(new URL("../CHANGELOG.md", import.meta.url)), false);
});
