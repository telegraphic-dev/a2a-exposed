import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.ts";
import { RUN_WORKER_FIRST } from "../src/routing.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("health is ok and the shell names no hosted service", async () => {
	const app = createApp();
	const health = await app.request("https://control.example.com/health");
	assert.equal(health.status, 200);
	assert.deepEqual(await health.json(), { ok: true });

	const page = await app.request("https://control.example.com/app");
	assert.equal(page.status, 200);
	assert.equal(page.headers.get("x-robots-tag"), "noindex");
	assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
	assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'none'/);
	assert.match(page.headers.get("content-security-policy") ?? "", /form-action 'self';/);
	assert.equal(page.headers.get("referrer-policy"), "same-origin");
	const html = await page.text();
	assert.match(html, /Inbox: sign in \/ create an agent/);
	assert.match(html, /No login provider is configured/);
	assert.doesNotMatch(html, /<script/i);
	assert.equal(html.includes(["a2a", "exposed"].join(".")), false);

	const nested = await app.request("https://control.example.com/app/agents");
	assert.equal(nested.status, 200);
	assert.equal(nested.headers.get("x-robots-tag"), "noindex");
});

test("BRAND_NAME is the only name on the page", async () => {
	const app = createApp({ BRAND_NAME: "Northwind" });
	const html = await (await app.request("https://control.example.com/app")).text();
	assert.match(html, /Northwind: sign in \/ create an agent/);
	assert.equal(html.includes(">Inbox<"), false);
});

test("api and well-known are closed until configured", async () => {
	const app = createApp();
	const api = await app.request("https://control.example.com/api/v1/tenants");
	assert.equal(api.status, 404);
	assert.equal(api.headers.get("x-robots-tag"), "noindex");
	assert.deepEqual(await api.json(), { error: "not_found" });
	const oidc = await app.request("https://control.example.com/.well-known/openid-configuration");
	assert.equal(oidc.status, 404);
	assert.equal(oidc.headers.get("x-robots-tag"), null);
});

test("Accept text/markdown serves the static twin and skips the dashboard", async () => {
	const env = {
		ASSETS: {
			async fetch(input: Request | URL | string) {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				const pathname = new URL(url).pathname;
				if (pathname === "/guide.md") return new Response("hello guide\n", { headers: { vary: "Accept-Encoding" } });
				if (pathname === "/notes.md") return new Response("notes\n", { headers: { vary: "Accept" } });
				if (pathname === "/guide") return new Response("<p>Guide</p>\n", { headers: { "content-type": "text/html; charset=utf-8", vary: "Accept-Encoding" } });
				return new Response("missing", { status: 404 });
			},
		},
	};
	const app = createApp(env);
	const md = await app.request("https://control.example.com/guide", { headers: { accept: "text/markdown, text/html" } });
	assert.equal(md.status, 200);
	assert.match(md.headers.get("content-type") ?? "", /text\/markdown/);
	assert.deepEqual((md.headers.get("vary") ?? "").split(",").map((part) => part.trim()), ["Accept-Encoding", "Accept"]);
	assert.match(md.headers.get("link") ?? "", /<\/guide>; rel="canonical"/);
	assert.equal(await md.text(), "hello guide\n");

	const rejected = await app.request("https://control.example.com/guide", { headers: { accept: "text/markdown;q=0, text/html" } });
	assert.equal(rejected.status, 200);
	assert.match(rejected.headers.get("content-type") ?? "", /text\/html/);
	assert.deepEqual((rejected.headers.get("vary") ?? "").split(",").map((part) => part.trim()), ["Accept-Encoding", "Accept"]);
	assert.equal(await rejected.text(), "<p>Guide</p>\n");

	const notes = await app.request("https://control.example.com/notes", { headers: { accept: "text/markdown" } });
	assert.equal(notes.headers.get("vary"), "Accept");

	const appPage = await app.request("https://control.example.com/app", { headers: { accept: "text/markdown" } });
	assert.match(appPage.headers.get("content-type") ?? "", /text\/html/);
	assert.match(await appPage.text(), /No login provider is configured/);

	const html = await app.request("https://control.example.com/guide");
	assert.equal(html.status, 200);
	assert.match(html.headers.get("content-type") ?? "", /text\/html/);
	assert.deepEqual((html.headers.get("vary") ?? "").split(",").map((part) => part.trim()), ["Accept-Encoding", "Accept"]);
	assert.equal(await html.text(), "<p>Guide</p>\n");

	const missing = await app.request("https://control.example.com/missing");
	assert.equal(missing.status, 404);
	assert.equal(await missing.text(), "missing");
	assert.deepEqual((missing.headers.get("vary") ?? "").split(",").map((part) => part.trim()), ["Accept"]);
});

test("content requests run the worker first so Accept can select markdown", () => {
	assert.equal(RUN_WORKER_FIRST, true);
});

test("neutral robots.txt disallows only the app and the api", () => {
	const text = fs.readFileSync(path.join(root, "public/robots.txt"), "utf8");
	const disallows = [...text.matchAll(/^Disallow:\s*(\S+)/gm)].map((match) => match[1]);
	assert.deepEqual(disallows.sort(), ["/api", "/app"]);
});

test("control sources do not name a hosted domain", () => {
	const banned = ["a2a." + "exposed", "agent-to-agent." + "party", "localhost3000." + "page"];
	const skip = new Set(["node_modules", ".cloudflare", ".wrangler"]);
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const name of fs.readdirSync(dir)) {
			if (skip.has(name)) continue;
			const abs = path.join(dir, name);
			if (fs.statSync(abs).isDirectory()) walk(abs);
			else if (/\.(ts|tsx|mjs|html|css|txt|svg|md|json)$/.test(name)) files.push(abs);
		}
	};
	walk(root);
	const hits: string[] = [];
	for (const file of files) {
		const text = fs.readFileSync(file, "utf8");
		for (const word of banned) if (text.includes(word)) hits.push(`${path.relative(root, file)}: ${word}`);
	}
	assert.deepEqual(hits, []);
});
