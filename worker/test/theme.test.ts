// Neutral inbox CSS, and the build-time WORKER_THEME check. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PAGE_STYLE, pageStyle } from "../src/theme.ts";
import { pageShell } from "../src/pairing.ts";
import { applyWorkerTheme, assertInlineCss, cssForChecks } from "../theme-build.mjs";

test("the neutral theme is inlined once and loads nothing", () => {
	assert.equal(pageStyle(), PAGE_STYLE);
	assert.equal(PAGE_STYLE.includes("background:#fafafa"), true);
	assert.equal(PAGE_STYLE.includes("background:#1a5fb4"), true);
	assert.doesNotThrow(() => assertInlineCss(PAGE_STYLE));
	const html = pageShell("Inbox", "nonce-1", "<p>Hello</p>");
	assert.equal(html.includes(`<style nonce="nonce-1">\n${PAGE_STYLE}\n</style>`), true);
	assert.equal((html.match(/<style/g) || []).length, 1);
	assert.equal(/<link|<script|<img|url\s*\(|@import/i.test(html), false);
});

test("WORKER_THEME replaces the module only when the CSS stays inline", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-theme-"));
	const file = path.join(dir, "theme.css");
	const css = "@media (max-width: 40rem) { body { background: #fff; color: \\23 222; } }";
	fs.writeFileSync(file, css);
	const next = applyWorkerTheme("/work/src/theme.ts", file);
	assert.match(next || "", /export const PAGE_STYLE = /);
	assert.match(next || "", /background: #fff/);
	assert.match(next || "", /\\\\23 222/);
	assert.equal(applyWorkerTheme("/work/src/theme.ts", undefined), null);
	assert.equal(applyWorkerTheme("/work/src/index.ts", file), null);

	for (const bad of [
		"",
		"body { background: url(https://example.com/a.png); }",
		"@import 'other.css';",
		"@font-face { font-family: x; }",
		"body { background: red; } </style><script>",
		"body { background: expression(alert(1)); }",
		"a { color: javascript:alert(1); }",
		"body{background:u\\72l(https://example.com/a.png)}",
		"body{background:\\75\\72\\6c(https://example.com/a.png)}",
		"body{background:u\\000072l(https://example.com/a.png)}",
		"@\\69mport \"https://example.com/x.css\"",
		"@\\69 mport \"https://example.com/x.css\"",
		"@\\69\\6d\\70\\6f\\72\\74 \"https://example.com/x.css\"",
		"body{background:url/*x*/(https://example.com/a.png)}",
		"@font\\2d face { font-family: x; }",
		"a{\"/*\";background:url(https://example.com/a.png);content:\"*/\"}",
		"a{content:\"foo\\\"bar\";background:url(https://example.com/a.png)}",
		"a{content:\"foo\\\nbar\";background:url(https://example.com/a.png)}",
		"a{content:\"url(https://example.com/a.png)\nbackground:url(https://example.com/b.png)}",
	]) {
		fs.writeFileSync(file, bad);
		assert.throws(() => applyWorkerTheme("/work/src/theme.ts", file), /WORKER_THEME was refused/);
	}
	for (const ok of [
		"/* url(https://example.com/a.png) */ body { color: red }",
		"a { content: \"url(https://example.com/a.png)\" }",
		"a { content: \"foo\\\nurl(https://example.com/a.png)\" }",
		"body { color: \\3c }",
	]) {
		fs.writeFileSync(file, ok);
		assert.doesNotThrow(() => applyWorkerTheme("/work/src/theme.ts", file));
	}
	assert.throws(() => applyWorkerTheme("/work/src/theme.ts", path.join(dir, "missing.css")), /could not be read/);
});

test("the resource check decodes escapes and keeps strings and comments closed", () => {
	assert.match(cssForChecks("u\\72l(https://example.com/a.png)"), /url\(https:\/\/example.com\/a.png\)/);
	assert.match(cssForChecks("@\\69 mport \"x.css\""), /@import ""/);
	assert.equal(/url\s*\(/i.test(cssForChecks("/* url(https://example.com/a.png) */ body{color:red}")), false);
	assert.equal(/url\s*\(/i.test(cssForChecks("a{content:\"url(https://example.com/a.png)\"}")), false);
	assert.match(cssForChecks("a{\"/*\";background:url(https://example.com/a.png)}"), /url\(https:\/\/example.com\/a.png\)/);
	assert.match(cssForChecks("color:\\23 222"), /color:#222/);
});
