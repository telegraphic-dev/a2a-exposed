import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFragments, renderChangelog, planRelease } from "./changelog.mjs";

const history = "# Changelog\n\nIntro.\n\n## 1.0.0 - 2026-01-01\n\n- Old.\n";
test("preview and release preserve Markdown, markers, references and history", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-changelog-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, "changelog.d"));
	fs.writeFileSync(path.join(root, "CHANGELOG.md"), history);
	const write = (name, text) => fs.writeFileSync(path.join(root, "changelog.d", name), text);
	write("README.md", "Instructions");
	write("b.md", "### Production\n\n- **Fix (#2).** Text.\n  - Detail.\n");
	write("a.md", "<!-- staging-only -->\n- **Staging (#1).** Text.\n<!-- /staging-only -->\n");
	const fragments = readFragments(root);
	assert.deepEqual(fragments.map(({ file }) => path.basename(file)), ["a.md", "b.md"]);
	const body = fragments.map(({ text }) => text).join("\n");
	assert.equal(renderChangelog(history, fragments), history.replace("## 1.0.0", `## Unreleased\n\n${body}\n\n## 1.0.0`));
	assert.equal(renderChangelog(history, []), history);
	assert.equal(renderChangelog(history.replace("## 1.0.0", "## Unreleased\n\n## 1.0.0"), fragments), renderChangelog(history, fragments));
	assert.throws(() => renderChangelog(history.replace("## 1.0.0", "## Unreleased\n\n- Forgotten.\n\n## 1.0.0"), fragments), /Move Unreleased/);
	const plan = planRelease(root, "1.1.0", "2026-02-01");
	assert.equal(plan.text, renderChangelog(history, fragments, "1.1.0 - 2026-02-01"));
	assert.equal(fs.readFileSync(plan.file, "utf8"), history); // Planning and preview are read-only.
	fs.writeFileSync(plan.file, plan.text);
	assert.throws(() => planRelease(root, "1.1.0"), /already exists/);
	for (const { file } of plan.fragments) fs.unlinkSync(file);
	assert.equal(planRelease(root, "1.1.0").text, plan.text);
	assert.throws(() => planRelease(root, "1.2.0"), /requires/);
	for (const text of ["\n", "## Unreleased\n- Text.\n"]) {
		write("bad.md", text);
		assert.throws(() => readFragments(root), /without release headings/);
	}
});

test("repository fragments render and Unreleased stays empty (CI guard)", () => {
	const root = path.resolve(import.meta.dirname, "..");
	const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
	const fragments = readFragments(root);
	const rendered = renderChangelog(changelog, fragments);
	for (const { text } of fragments) assert.ok(rendered.includes(text));
});
