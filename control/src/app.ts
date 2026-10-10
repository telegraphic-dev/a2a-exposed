import { Hono, type Context } from "hono";
import { handleSignIn } from "./auth/sign-in.ts";
import { loadAuth } from "./auth/instance.ts";
import { authBlockers, type AuthDeps } from "./auth/options.ts";
import { OIDC_COOKIE, authorize, discoveryDocument, exchangeCode, issuerOrigin, readTokenForm, resumeQuery } from "./oidc/issuer.ts";
import { hostCookie } from "./auth/cookies.ts";
import { createTenant, listTenants } from "./tenants/create.ts";
import { dataPlaneFromEnv, type DataPlane } from "./tenants/push.ts";
import type { ControlEnv } from "./env.ts";
import { renderApp, securityHeaders } from "./views/document.tsx";
import { renderSignIn } from "./views/sign-in.tsx";

/**
 * A state-changing tenant call must be JSON. `text/plain` is a CORS-safelisted type, so a page on a
 * sibling host could post it with the SameSite=Lax session cookie and no preflight. A browser Origin
 * or Sec-Fetch-Site from anywhere but this host is rejected. A non-browser client sends neither header.
 */
function allowsTenantWrite(request: Request): boolean {
	const media = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
	if (media !== "application/json") return false;
	const origin = request.headers.get("origin");
	if (origin && origin !== new URL(request.url).origin) return false;
	const site = (request.headers.get("sec-fetch-site") ?? "").trim().toLowerCase();
	if (site && site !== "same-origin" && site !== "none") return false;
	return true;
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

export function createApp(env: ControlEnv = {}, deps: AuthDeps & { dataPlane?: DataPlane } = {}) {
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

	app.get("/app", async (c) => {
		const query = resumeQuery(c.req.header("cookie") ?? null);
		if (query) {
			const loaded = await loadAuth(env, c.req.raw, deps);
			const session = loaded ? await loaded.auth.api.getSession({ headers: c.req.raw.headers }) : null;
			if (session?.user?.id) {
				c.header("set-cookie", hostCookie(OIDC_COOKIE, "", 0));
				return c.redirect(new URL(`/api/oidc/authorize${query}`, c.req.url).href, 302);
			}
		}
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

	app.get("/api/v1/tenants", (c) => tenants(c, "GET"));
	app.post("/api/v1/tenants", (c) => tenants(c, "POST"));

	async function tenants(c: Context<{ Bindings: ControlEnv }>, method: "GET" | "POST") {
		const request = c.req.raw;
		const plane = deps.dataPlane ?? dataPlaneFromEnv(env);
		const loaded = await loadAuth(env, request, deps);
		if (!loaded || !plane) return c.json({ error: "not_found" }, 404);
		if (method === "POST" && !allowsTenantWrite(request)) return c.json({ error: "forbidden" }, 403);
		const session = await loaded.auth.api.getSession({ headers: request.headers });
		const accountId = session?.user?.id;
		if (!accountId) return c.json({ error: "unauthorized" }, 401);
		if (method === "GET") {
			const rows = await listTenants(loaded.options.database, accountId, env.TENANT_DOMAIN);
			return c.json({
				tenants: rows.map((row) => ({
					id: row.id,
					name: row.name,
					status: row.status,
					public_url: row.publicUrl,
					version: row.version,
				})),
			});
		}
		let name = "";
		try {
			const body = await request.json() as unknown;
			if (body && typeof body === "object" && !Array.isArray(body)) {
				const value = (body as { name?: unknown }).name;
				if (typeof value === "string") name = value;
			}
		} catch {
			return c.json({ error: "invalid_name" }, 400);
		}
		const created = await createTenant(loaded.options.database, plane, {
			accountId, name, domain: env.TENANT_DOMAIN, dataRegion: env.DATA_REGION,
			issuer: issuerOrigin(env, request), label: env.BRAND_NAME,
		});
		if (!created.ok) {
			const status = created.error === "taken" ? 409 : 400;
			return c.json({ error: created.error }, status);
		}
		const tenant = created.tenant;
		return c.json({
			tenant: tenant.name,
			id: tenant.id,
			status: tenant.status,
			region: tenant.region,
			public_url: tenant.publicUrl,
			owner_token: tenant.ownerToken,
			version: tenant.version,
			pushed: tenant.pushed,
		}, 201);
	}

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

	app.get("/.well-known/openid-configuration", async (c) => {
		const issuer = issuerOrigin(env, c.req.raw);
		const loaded = issuer ? await loadAuth(env, c.req.raw, deps) : null;
		if (!loaded) return c.json({ error: "not_found" }, 404);
		return c.json(discoveryDocument(issuer), 200, { "cache-control": "no-store" });
	});
	app.get("/api/oidc/authorize", (c) => oidcAuthorize(c));
	app.post("/api/oidc/token", (c) => oidcToken(c));

	async function oidcAuthorize(c: Context<{ Bindings: ControlEnv }>) {
		const request = c.req.raw;
		const issuer = issuerOrigin(env, request);
		const loaded = issuer ? await loadAuth(env, request, deps) : null;
		if (!loaded) return c.json({ error: "not_found" }, 404);
		const session = await loaded.auth.api.getSession({ headers: request.headers });
		const result = await authorize(loaded.options.database, request, session?.user?.id ? { id: session.user.id } : null);
		if (result.cookie) c.header("set-cookie", result.cookie);
		if (result.location) return c.redirect(result.location, 302);
		return c.json(result.body ?? { error: "invalid_request" }, result.status as 400);
	}

	async function oidcToken(c: Context<{ Bindings: ControlEnv }>) {
		const request = c.req.raw;
		const issuer = issuerOrigin(env, request);
		const loaded = issuer ? await loadAuth(env, request, deps) : null;
		if (!loaded) return c.json({ error: "not_found" }, 404);
		const form = await readTokenForm(request);
		if (form === "too_large") return c.json({ error: "invalid_request" }, 413);
		const result = await exchangeCode(loaded.options.database, loaded.auth, issuer, form);
		return c.json(result.body, result.status as 200);
	}

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
