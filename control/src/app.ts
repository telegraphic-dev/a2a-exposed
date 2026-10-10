import { Hono } from "hono";
import type { ControlEnv } from "./env.ts";
import { renderApp, securityHeaders } from "./views/document.tsx";

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

/** True when some `text/markdown` range has a quality above zero. `q=0` rejects that range. */
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
	if (pathname === "/health" || pathname.startsWith("/app") || pathname.startsWith("/api") || pathname.startsWith("/.well-known")) return null;
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

export function createApp(env: ControlEnv = {}) {
	const app = new Hono<{ Bindings: ControlEnv }>();

	app.use("*", async (c, next) => {
		const assetPath = markdownPath(c.req.path);
		if (!assetPath || !wantsMarkdown(c.req.header("accept")) || !env.ASSETS) return next();
		const assetUrl = new URL(assetPath, c.req.url);
		const asset = await env.ASSETS.fetch(assetUrl);
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

	app.use("/app", async (c, next) => {
		c.header("x-robots-tag", "noindex");
		c.header("cache-control", "no-store");
		await next();
	});
	app.use("/app/*", async (c, next) => {
		c.header("x-robots-tag", "noindex");
		c.header("cache-control", "no-store");
		await next();
	});
	app.use("/api", async (c, next) => {
		c.header("x-robots-tag", "noindex");
		c.header("cache-control", "no-store");
		await next();
	});
	app.use("/api/*", async (c, next) => {
		c.header("x-robots-tag", "noindex");
		c.header("cache-control", "no-store");
		await next();
	});

	app.get("/health", (c) => c.json({ ok: true }, 200, { "cache-control": "no-store" }));

	app.get("/app", (c) => c.html(renderApp(env), 200, securityHeaders()));
	app.get("/app/*", (c) => c.html(renderApp(env), 200, securityHeaders()));

	app.all("/api", (c) => c.json({ error: "not_found" }, 404));
	app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
	app.all("/.well-known", (c) => c.json({ error: "not_found" }, 404));
	app.all("/.well-known/*", (c) => c.json({ error: "not_found" }, 404));

	app.all("*", async (c) => {
		if (!env.ASSETS) return c.notFound();
		const asset = await env.ASSETS.fetch(c.req.raw);
		// The same URL can be Markdown. A cache that stored this HTML response must not reuse it for that Accept.
		if (!markdownPath(c.req.path)) return asset;
		const headers = new Headers(asset.headers);
		addVary(headers, "Accept");
		return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
	});

	return app;
}
