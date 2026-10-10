import { Hono } from "hono";
import type { ControlEnv } from "./env.ts";
import { renderApp, securityHeaders } from "./views/document.tsx";

function wantsMarkdown(accept: string | undefined): boolean {
	if (!accept) return false;
	return accept.split(",").some((part) => part.split(";")[0]?.trim().toLowerCase() === "text/markdown");
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

	return app;
}
