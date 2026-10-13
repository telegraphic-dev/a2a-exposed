// Control plane shell: health, plain feedback, and static assets.
// The hosted dashboard is a separate site. This Worker imports tenants and provisioning only for the outbox flush.
import { Hono } from "hono";
import { routes } from "./core/routes.ts";
import type { ControlEnv } from "./env.ts";
import { createFeedback, feedbackOn, type FeedbackDeps, type FeedbackResult } from "./feedback.ts";

const SHELL_HEADERS: Record<string, string> = {
	"content-type": "text/html; charset=utf-8",
	"content-security-policy": "default-src 'none'; script-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
	"referrer-policy": "same-origin",
	"x-content-type-options": "nosniff",
	"cache-control": "no-store",
	"x-robots-tag": "noindex",
};

function shellHtml(name: string): string {
	const title = `${name}: control API`;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${title}</title></head><body><main><h1>${title}</h1><p>Health is at /health. Create an inbox with the a2a-exposed CLI. The owner pages are on that inbox.</p></main></body></html>`;
}

function acceptQuality(params: string[]): number {
	for (const param of params) {
		const eq = param.indexOf("=");
		if (eq < 0) continue;
		if (param.slice(0, eq).trim().toLowerCase() !== "q") continue;
		const q = Number(param.slice(eq + 1).trim());
		return Number.isFinite(q) ? q : 1;
	}
	return 1;
}

function wantsMarkdown(accept: string | undefined): boolean {
	if (!accept) return false;
	return accept.split(",").some((part) => {
		const [type, ...params] = part.split(";").map((item) => item.trim()).filter(Boolean);
		if (type?.toLowerCase() !== "text/markdown") return false;
		return acceptQuality(params) > 0;
	});
}

function addVary(headers: Headers, name: string): void {
	const current = headers.get("vary");
	if (!current) {
		headers.set("vary", name);
		return;
	}
	const tokens = current.split(",").map((part) => part.trim().toLowerCase());
	if (tokens.includes("*") || tokens.includes(name.toLowerCase())) return;
	headers.set("vary", `${current}, ${name}`);
}

function markdownPath(pathname: string): string | null {
	if (pathname === routes.health || pathname.startsWith("/app") || pathname.startsWith("/api") || pathname.startsWith("/.well-known")) return null;
	if (pathname.endsWith(".md")) return pathname;
	if (pathname.endsWith("/")) return `${pathname}index.md`;
	return `${pathname}.md`;
}

function htmlPathFor(pathname: string): string {
	if (pathname.endsWith(".md")) {
		const bare = pathname.slice(0, -3);
		return bare.endsWith("/index") ? bare.slice(0, -"/index".length) || "/" : bare;
	}
	return pathname;
}

async function presentAsset(pathname: string, asset: Response): Promise<Response> {
	if (pathname === "/docs" || pathname.startsWith("/docs/")) return asset;
	const type = asset.headers.get("content-type") ?? "";
	if (!type.includes("text/html")) return asset;
	const html = await asset.text();
	if (!html.includes("applies to a2a-exposed")) {
		return new Response(html, { status: asset.status, statusText: asset.statusText, headers: asset.headers });
	}
	const headers = new Headers(asset.headers);
	headers.delete("content-length");
	return new Response(html.replace(/ · applies to a2a-exposed [^<]*/g, ""), {
		status: asset.status,
		statusText: asset.statusText,
		headers,
	});
}

function feedbackResponse(result: FeedbackResult): Response {
	const headers = new Headers(result.headers);
	headers.set("content-type", "application/json; charset=utf-8");
	headers.set("x-robots-tag", "noindex");
	headers.set("cache-control", "no-store");
	return new Response(JSON.stringify(result.body), { status: result.status, headers });
}

export function createApp(env: ControlEnv = {}, deps: FeedbackDeps = {}) {
	const app = new Hono<{ Bindings: ControlEnv }>();
	const feedback = createFeedback(env, deps);
	const name = (env.BRAND_NAME ?? "").trim() || "Inbox";

	app.use("*", async (c, next) => {
		const assetPath = markdownPath(c.req.path);
		if (!assetPath || !wantsMarkdown(c.req.header("accept")) || !env.ASSETS) return next();
		const asset = await env.ASSETS.fetch(new URL(assetPath, c.req.url));
		if (!asset.ok) return next();
		const headers = new Headers(asset.headers);
		headers.set("content-type", "text/markdown; charset=utf-8");
		headers.set("x-content-type-options", "nosniff");
		addVary(headers, "Accept");
		const canonical = new URL(htmlPathFor(c.req.path), c.req.url);
		canonical.search = "";
		headers.set("link", `<${canonical.pathname}>; rel="canonical"`);
		return new Response(asset.body, { status: 200, headers });
	});

	app.get(routes.health, (c) => c.json({ ok: true }));

	app.all("/api/feedback", async (c) => {
		if (!feedbackOn(env)) return c.json({ error: "not_found" }, 404, { "x-robots-tag": "noindex" });
		return feedbackResponse(await feedback.api(c.req.raw));
	});

	app.all("/api", (c) => c.json({ error: "not_found" }, 404, { "x-robots-tag": "noindex" }));
	app.all("/api/*", (c) => c.json({ error: "not_found" }, 404, { "x-robots-tag": "noindex" }));
	app.all("/.well-known", (c) => c.json({ error: "not_found" }, 404));
	app.all("/.well-known/*", (c) => c.json({ error: "not_found" }, 404));

	app.all("/app", (c) => c.html(shellHtml(name), 200, SHELL_HEADERS));
	app.all("/app/*", (c) => c.html(shellHtml(name), 200, SHELL_HEADERS));

	app.all("*", async (c) => {
		if (!env.ASSETS) return c.html(shellHtml(name), 200, SHELL_HEADERS);
		const asset = await presentAsset(c.req.path, await env.ASSETS.fetch(c.req.raw));
		if (!markdownPath(c.req.path)) return asset;
		const headers = new Headers(asset.headers);
		addVary(headers, "Accept");
		return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
	});

	return app;
}
