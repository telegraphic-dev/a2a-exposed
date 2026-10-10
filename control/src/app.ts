import { Hono } from "hono";
import { handleSignIn } from "./auth/sign-in.ts";
import { loadAuth } from "./auth/instance.ts";
import { authBlockers, type AuthDeps } from "./auth/options.ts";
import type { ControlEnv } from "./env.ts";
import { renderApp, securityHeaders } from "./views/document.tsx";
import { renderSignIn } from "./views/sign-in.tsx";

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

export function createApp(env: ControlEnv = {}, deps: AuthDeps = {}) {
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

	app.get("/app", async (c) => {
		const shell = await renderShell(c.req.raw);
		return c.html(shell.html, 200, securityHeaders({ turnstile: shell.turnstile }));
	});
	app.get("/app/*", async (c) => {
		const shell = await renderShell(c.req.raw);
		return c.html(shell.html, 200, securityHeaders({ turnstile: shell.turnstile }));
	});
	app.post("/app/sign-in", async (c) => {
		const loaded = await loadAuth(env, c.req.raw, deps);
		if (!loaded) return c.json({ error: "not_found" }, 404);
		return handleSignIn(c.req.raw, loaded.auth, loaded.options);
	});
	app.all("/api/auth/*", async (c) => {
		const loaded = await loadAuth(env, c.req.raw, deps);
		if (!loaded) return c.json({ error: "not_found" }, 404);
		return loaded.auth.handler(c.req.raw);
	});

	async function renderShell(request: Request): Promise<{ html: string; turnstile: boolean }> {
		const loaded = await loadAuth(env, request, deps);
		const url = new URL(request.url);
		const turnstile = Boolean(loaded?.options.turnstile);
		let body = "";
		if (loaded) {
			body = renderSignIn({
				providers: [
					loaded.options.github ? "github" : "",
					loaded.options.google ? "google" : "",
					loaded.options.cloudflare ? "cloudflare" : "",
				].filter(Boolean),
				magicLink: Boolean(loaded.options.mailer || loaded.options.emailBinding),
				invitesRequired: loaded.options.invitesRequired,
				turnstileSiteKey: loaded.options.turnstile?.siteKey,
				error: url.searchParams.get("error") ?? undefined,
				sent: url.searchParams.get("sent") === "1",
			});
		} else {
			const blockers = authBlockers(env, deps);
			if (blockers.length) body = renderSignIn({ providers: [], magicLink: false, invitesRequired: false, notice: blockers[0] });
		}
		return { html: renderApp(env, body || undefined), turnstile };
	}

	app.all("/api", (c) => c.json({ error: "not_found" }, 404));
	app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
	app.all("/.well-known", (c) => c.json({ error: "not_found" }, 404));
	app.all("/.well-known/*", (c) => c.json({ error: "not_found" }, 404));

	return app;
}
