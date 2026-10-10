import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markdownToHtml, renderSite, safeUrl } from "../scripts/prerender.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "test/fixtures/overlay");

test("markdown escapes html and keeps safe links", () => {
	const html = markdownToHtml("# Title\n\nSee [docs](/docs) and [no](javascript:alert(1)).\n\n<script>no</script>\n\n- one\n- two\n\n```\n<a>\n```\n");
	assert.match(html, /<h1>Title<\/h1>/);
	assert.match(html, /<a href="\/docs">docs<\/a>/);
	assert.equal(html.includes("javascript:"), false);
	assert.match(html, /&lt;script&gt;no&lt;\/script&gt;/);
	assert.match(html, /<li>one<\/li>/);
	assert.match(html, /<pre><code>&lt;a&gt;<\/code><\/pre>/);
	assert.equal(safeUrl("https://control.example.com/docs"), "https://control.example.com/docs");
});

test("overlay fixture replaces the neutral page, brand, and public file", async () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "control-overlay-"));
	const result = await renderSite({
		contentDir: path.join(fixture, "content"),
		brandDir: path.join(fixture, "brand"),
		publicDir: path.join(root, "public"),
		overlayPublic: path.join(fixture, "public"),
		outDir: out,
		site: "https://control.example.com",
		brandName: "",
	});
	assert.deepEqual(result.pages, ["/hello"]);
	const page = fs.readFileSync(path.join(out, "hello/index.html"), "utf8");
	assert.match(page, /data-overlay="fixture"/);
	assert.match(page, /Hello · Fixture/);
	assert.match(page, /A fixture page/);
	assert.match(page, /href="\/legal"/);
	assert.match(page, /<p>Words<\/p>/);
	assert.equal(page.includes(["a2a", "exposed"].join(".")), false);
	assert.match(fs.readFileSync(path.join(out, "hello.md"), "utf8"), /Words/);
	assert.equal(fs.readFileSync(path.join(out, "badge.txt"), "utf8").trim(), "overlay-badge");
	assert.match(fs.readFileSync(path.join(out, "tokens.css"), "utf8"), /--overlay-brand/);
	assert.match(fs.readFileSync(path.join(out, "robots.txt"), "utf8"), /overlay-robots/);
	assert.match(fs.readFileSync(path.join(out, "robots.txt"), "utf8"), /Disallow: \/app/);
	assert.match(fs.readFileSync(path.join(out, "index.html"), "utf8"), /Fixture: sign in \/ create an agent/);
	assert.match(fs.readFileSync(path.join(out, "sitemap.xml"), "utf8"), /https:\/\/control\.example\.com\/hello/);
	assert.match(fs.readFileSync(path.join(out, "_headers"), "utf8"), /Link: <\/hello\.md>; rel="alternate"; type="text\/markdown"/);
	fs.rmSync(out, { recursive: true, force: true });
});

test("neutral prerender keeps the shell and does not invent a sitemap without SITE_URL", async () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "control-neutral-"));
	await renderSite({
		contentDir: path.join(root, "content"),
		brandDir: path.join(root, "brand"),
		publicDir: path.join(root, "public"),
		overlayPublic: "",
		outDir: out,
		site: "",
		brandName: "",
	});
	const index = fs.readFileSync(path.join(out, "index.html"), "utf8");
	assert.match(index, /Inbox: sign in \/ create an agent/);
	assert.match(index, /No login provider is configured/);
	assert.equal(index, fs.readFileSync(path.join(root, "public/index.html"), "utf8"));
	assert.equal(fs.readFileSync(path.join(out, "tokens.css"), "utf8"), fs.readFileSync(path.join(root, "brand/tokens.css"), "utf8"));
	assert.equal(fs.readFileSync(path.join(out, "logo.svg"), "utf8"), fs.readFileSync(path.join(root, "brand/logo.svg"), "utf8"));
	assert.equal(fs.readFileSync(path.join(root, "public/tokens.css"), "utf8"), fs.readFileSync(path.join(root, "brand/tokens.css"), "utf8"));
	assert.equal(fs.readFileSync(path.join(root, "public/logo.svg"), "utf8"), fs.readFileSync(path.join(root, "brand/logo.svg"), "utf8"));
	assert.equal(fs.existsSync(path.join(out, "sitemap.xml")), false);
	assert.equal(fs.existsSync(path.join(out, "hello/index.html")), false);
	fs.rmSync(out, { recursive: true, force: true });
});

test("a prerender without SITE_URL deletes a sitemap left by an earlier build", async () => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), "control-sitemap-"));
	const options = {
		contentDir: path.join(fixture, "content"),
		brandDir: path.join(fixture, "brand"),
		publicDir: path.join(root, "public"),
		overlayPublic: path.join(fixture, "public"),
		outDir: out,
		brandName: "",
	};
	await renderSite({ ...options, site: "https://control.example.com" });
	assert.equal(fs.existsSync(path.join(out, "sitemap.xml")), true);
	await renderSite({ ...options, site: "" });
	assert.equal(fs.existsSync(path.join(out, "sitemap.xml")), false);
	fs.rmSync(out, { recursive: true, force: true });
});
