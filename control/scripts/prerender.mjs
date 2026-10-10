// Markdown in content/ becomes HTML, a .md twin, and (when SITE_URL is https) a sitemap.
// Brand slots are rendered with the same hono/jsx template as the dashboard shell.
// An overlay copies its public/ on top of the neutral public/, then this script runs.
import esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const MARKER_BEGIN = "# BEGIN prerender";
const MARKER_END = "# END prerender";

export function escapeHtml(value) {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function safeUrl(value) {
	if (value.startsWith("/") && !value.startsWith("//")) return value;
	try {
		const url = new URL(value);
		if (url.protocol === "https:" || url.protocol === "http:") return url.href;
	} catch {
		return null;
	}
	return null;
}

function inline(source) {
	const parts = source.split("`");
	let html = "";
	for (let i = 0; i < parts.length; i++) {
		if (i % 2 === 1) {
			html += `<code>${escapeHtml(parts[i])}</code>`;
			continue;
		}
		const text = parts[i];
		const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;
		let last = 0;
		for (const match of text.matchAll(re)) {
			html += escapeHtml(text.slice(last, match.index));
			const href = safeUrl(match[2]);
			const label = escapeHtml(match[1]);
			html += href ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
			last = match.index + match[0].length;
		}
		html += escapeHtml(text.slice(last));
	}
	return html;
}

export function markdownToHtml(source) {
	const lines = source.replace(/\r\n/g, "\n").split("\n");
	const blocks = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === "") {
			i++;
			continue;
		}
		if (line.startsWith("```")) {
			const buf = [];
			i++;
			while (i < lines.length && !lines[i].startsWith("```")) {
				buf.push(lines[i]);
				i++;
			}
			if (i < lines.length) i++;
			blocks.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
			continue;
		}
		const heading = /^(#{1,3}) (.+)$/.exec(line);
		if (heading) {
			const level = heading[1].length;
			blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`);
			i++;
			continue;
		}
		if (line.startsWith("- ")) {
			const items = [];
			while (i < lines.length && lines[i].startsWith("- ")) {
				items.push(`<li>${inline(lines[i].slice(2))}</li>`);
				i++;
			}
			blocks.push(`<ul>${items.join("")}</ul>`);
			continue;
		}
		const para = [];
		while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("```") && !lines[i].startsWith("- ") && !/^#{1,3} /.test(lines[i])) {
			para.push(lines[i]);
			i++;
		}
		blocks.push(`<p>${inline(para.join(" "))}</p>`);
	}
	return blocks.join("\n");
}

export function splitFrontmatter(text) {
	const src = text.replace(/\r\n/g, "\n");
	if (!src.startsWith("---\n")) return { data: {}, body: src };
	const end = src.indexOf("\n---\n", 4);
	if (end < 0) return { data: {}, body: src };
	const data = {};
	for (const line of src.slice(4, end).split("\n")) {
		const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
		if (match) data[match[1]] = match[2].trim();
	}
	return { data, body: src.slice(end + 5) };
}

function walkMarkdown(dir, prefix = "") {
	if (!fs.existsSync(dir)) return [];
	const found = [];
	for (const name of fs.readdirSync(dir)) {
		if (name.startsWith(".") || name.startsWith("_")) continue;
		const abs = path.join(dir, name);
		const rel = prefix ? `${prefix}/${name}` : name;
		const stat = fs.statSync(abs);
		if (stat.isDirectory()) found.push(...walkMarkdown(abs, rel));
		else if (name.endsWith(".md")) found.push(rel);
	}
	return found;
}

function pagePaths(relMd) {
	const urlPath = "/" + relMd.replace(/\.md$/, "").replace(/\/index$/, "").replace(/^index$/, "");
	const canonical = urlPath === "" ? "/" : urlPath;
	const htmlRel = relMd.endsWith("/index.md") || relMd === "index.md"
		? relMd.replace(/\.md$/, ".html")
		: relMd.replace(/\.md$/, "/index.html");
	return { canonical, htmlRel, mdRel: relMd };
}

function copyTree(src, dest) {
	if (!src || !fs.existsSync(src)) return;
	const srcReal = fs.realpathSync(src);
	const destReal = fs.existsSync(dest) ? fs.realpathSync(dest) : "";
	if (srcReal === destReal) return;
	fs.cpSync(src, dest, { recursive: true, force: true });
}

function siteOrigin(value) {
	if (!value) return "";
	const url = new URL(value);
	if (url.protocol !== "https:") throw new Error("SITE_URL must be an https origin");
	if (url.username || url.password) throw new Error("SITE_URL must not include credentials");
	return url.origin;
}

async function loadRenderer(brandDir) {
	const outfile = path.join(os.tmpdir(), `control-render-${process.pid}-${Date.now()}.mjs`);
	await esbuild.build({
		absWorkingDir: ROOT,
		entryPoints: [path.join(ROOT, "src/views/document.tsx")],
		bundle: true,
		format: "esm",
		platform: "neutral",
		outfile,
		jsx: "automatic",
		jsxImportSource: "hono/jsx",
		plugins: [{
			name: "brand-alias",
			setup(build) {
				build.onResolve({ filter: /^@brand\// }, (args) => ({
					path: path.join(brandDir, args.path.slice("@brand/".length)),
				}));
			},
		}],
		logLevel: "silent",
	});
	try {
		return await import(pathToFileURL(outfile).href);
	} finally {
		fs.rmSync(outfile, { force: true });
	}
}

export async function renderSite(options) {
	const contentDir = options.contentDir;
	const brandDir = options.brandDir;
	const publicDir = options.publicDir;
	const overlayPublic = options.overlayPublic;
	const outDir = options.outDir;
	const origin = siteOrigin(options.site || "");
	fs.mkdirSync(outDir, { recursive: true });
	copyTree(publicDir, outDir);
	copyTree(overlayPublic, outDir);
	for (const file of ["tokens.css", "logo.svg"]) {
		const from = path.join(brandDir, file);
		if (fs.existsSync(from)) fs.copyFileSync(from, path.join(outDir, file));
	}

	const renderer = await loadRenderer(brandDir);
	const brandEnv = { BRAND_NAME: options.brandName || "" };
	const pages = [];
	for (const rel of walkMarkdown(contentDir)) {
		const raw = fs.readFileSync(path.join(contentDir, rel), "utf8");
		const { data, body } = splitFrontmatter(raw);
		if (!data.title && path.basename(rel) !== "index.md") throw new Error(`${rel} is missing a title`);
		const paths = pagePaths(rel);
		const html = renderer.renderDocument({
			env: brandEnv,
			title: data.title || "",
			description: data.description || "",
			bodyHtml: markdownToHtml(body),
			robots: "index,follow",
			aside: false,
		});
		const htmlPath = path.join(outDir, paths.htmlRel);
		fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
		fs.writeFileSync(htmlPath, html);
		fs.mkdirSync(path.dirname(path.join(outDir, paths.mdRel)), { recursive: true });
		fs.writeFileSync(path.join(outDir, paths.mdRel), raw.endsWith("\n") ? raw : raw + "\n");
		pages.push(paths);
	}

	const hasContentIndex = walkMarkdown(contentDir).some((rel) => rel === "index.md");
	const overlayIndex = overlayPublic && fs.existsSync(path.join(overlayPublic, "index.html"));
	if (!hasContentIndex && !overlayIndex) {
		fs.writeFileSync(path.join(outDir, "index.html"), renderer.renderHome(brandEnv));
	}

	if (origin) {
		const urls = [origin + "/", ...pages.filter((p) => p.canonical !== "/").map((p) => origin + p.canonical)];
		const body = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
			...urls.map((loc) => `  <url><loc>${escapeHtml(loc)}</loc></url>`),
			"</urlset>",
			"",
		].join("\n");
		fs.writeFileSync(path.join(outDir, "sitemap.xml"), body);
	} else {
		const stale = path.join(outDir, "sitemap.xml");
		if (fs.existsSync(stale)) fs.rmSync(stale);
	}

	const rules = [MARKER_BEGIN];
	for (const page of pages) {
		const mdUrl = "/" + page.mdRel.split(path.sep).join("/");
		rules.push(page.canonical);
		rules.push(`  Link: <${mdUrl}>; rel="alternate"; type="text/markdown"`);
		rules.push(mdUrl);
		rules.push("  Content-Type: text/markdown; charset=utf-8");
		rules.push(`  Link: <${page.canonical}>; rel="canonical"`);
	}
	rules.push(MARKER_END, "");
	const headersPath = path.join(outDir, "_headers");
	const existing = fs.existsSync(headersPath) ? fs.readFileSync(headersPath, "utf8") : "";
	const stripped = existing.replace(new RegExp(`${MARKER_BEGIN}[\\s\\S]*?${MARKER_END}\\n?`), "").trimEnd();
	const next = (stripped ? stripped + "\n\n" : "") + (pages.length ? rules.join("\n") : "");
	if (next.trim()) fs.writeFileSync(headersPath, next.endsWith("\n") ? next : next + "\n");
	return { pages: pages.map((p) => p.canonical) };
}

function arg(name, argv) {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : "";
}

async function main() {
	const argv = process.argv.slice(2);
	const outDir = path.resolve(arg("--out", argv) || path.join(ROOT, "public"));
	await renderSite({
		contentDir: path.resolve(arg("--content", argv) || process.env.CONTROL_CONTENT_DIR || path.join(ROOT, "content")),
		brandDir: path.resolve(arg("--brand", argv) || process.env.CONTROL_BRAND_DIR || path.join(ROOT, "brand")),
		publicDir: path.resolve(arg("--public", argv) || path.join(ROOT, "public")),
		overlayPublic: arg("--overlay-public", argv) ? path.resolve(arg("--overlay-public", argv)) : "",
		outDir,
		site: arg("--site", argv) || process.env.SITE_URL || "",
		brandName: process.env.BRAND_NAME || "",
	});
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	});
}
