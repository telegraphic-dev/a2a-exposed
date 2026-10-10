import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const origin = "https://control.example.com";

function statements(sql: string): string[] {
	return sql.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n").split(";").map((part) => part.trim()).filter(Boolean);
}

test("a page load then a Turnstile sign-in reaches GitHub under workerd", async () => {
	const built = await build({
		entryPoints: [path.join(root, "test/sign-in-worker.ts")],
		bundle: true,
		format: "esm",
		write: false,
		platform: "neutral",
		target: "es2022",
		jsx: "automatic",
		jsxImportSource: "hono/jsx",
		alias: { "@brand": path.join(root, "brand") },
		external: ["cloudflare:email"],
		logLevel: "silent",
	});
	const script = built.outputFiles[0]?.text;
	assert.ok(script);
	let siteverify = 0;
	const mf = new Miniflare(convertV4MiniflareOptions({
		name: "control",
		modules: true,
		script,
		compatibilityDate: "2026-10-06",
		compatibilityFlags: ["nodejs_compat"],
		d1Databases: { DB: `control-${Math.random().toString(36).slice(2)}` },
		bindings: {
			AUTH_SECRET: "test-secret-test-secret-test-secret",
			GITHUB_CLIENT_ID: "gh-id",
			GITHUB_CLIENT_SECRET: "gh-secret",
			TURNSTILE_SITE_KEY: "site-key",
			TURNSTILE_SECRET_KEY: "turnstile-secret",
			ISSUER: origin,
		},
		outboundService: (request: Request) => {
			if (request.url.startsWith("https://challenges.cloudflare.com/turnstile/v0/siteverify")) {
				siteverify += 1;
				return Promise.resolve(Response.json({ success: true }));
			}
			return Promise.resolve(new Response("outbound", { status: 599 }));
		},
	} as never));
	try {
		const db = await mf.getD1Database("DB");
		const dir = path.join(root, "migrations");
		for (const name of fs.readdirSync(dir).filter((file) => file.endsWith(".sql")).sort()) {
			const queries = statements(fs.readFileSync(path.join(dir, name), "utf8"));
			if (queries.length) await db.batch(queries.map((query) => db.prepare(query)));
		}
		const page = await mf.dispatchFetch(`${origin}/app`);
		assert.equal(page.status, 200);
		await page.arrayBuffer();
		async function post() {
			const started = Date.now();
			const response = await Promise.race([
				mf.dispatchFetch(`${origin}/app/sign-in`, {
					method: "POST",
					redirect: "manual",
					headers: {
						origin,
						"content-type": "application/x-www-form-urlencoded",
						"sec-fetch-site": "same-origin",
						"cf-connecting-ip": "203.0.113.20",
					},
					body: "provider=github&cf-turnstile-response=widget-token",
				}),
				new Promise<Response>((_, reject) => setTimeout(() => reject(new Error("sign-in hung")), 4000)),
			]);
			assert.ok(Date.now() - started < 4000);
			return response;
		}
		const first = await post();
		assert.equal(first.status, 303);
		assert.equal(new URL(first.headers.get("location") ?? "").origin, "https://github.com");
		await first.arrayBuffer();
		const second = await post();
		assert.equal(second.status, 303);
		assert.equal(new URL(second.headers.get("location") ?? "").origin, "https://github.com");
		await second.arrayBuffer();
		assert.equal(siteverify, 2);
	} finally {
		await mf.dispose();
	}
});
