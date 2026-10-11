import { Hono, type Context } from "hono";
import { CALLBACK_DEADLINE_MS, within } from "./auth/deadline.ts";
import { connectingIp, verifyTurnstile } from "./auth/turnstile.ts";
import { agentReturnPath } from "./auth/return.ts";
import { enabledProviderOrigins, handleSignIn } from "./auth/sign-in.ts";
import { loadAuth } from "./auth/instance.ts";
import { signupClosedText, type SignupAllowlist } from "./auth/allowlist.ts";
import { authBlockers, resolveAuth, type AuthDeps, type AuthOptions } from "./auth/options.ts";
import { OIDC_COOKIE, authorize, discoveryDocument, exchangeCode, issuerOrigin, readTokenForm, resumeQuery } from "./oidc/issuer.ts";
import { OWNER_COOKIE, bareOwnerToken, hostCookie, readCookie } from "./auth/cookies.ts";
import { deviceCodeFromCookie, handleDevice } from "./auth/device.ts";
import { sameOrigin } from "./auth/origin.ts";
import { accountAgentLimit, configuredFreeAgentLimit, createTenant, listTenants } from "./tenants/create.ts";
import { dataPlaneFromEnv, type DataPlane } from "./tenants/push.ts";
import type { ControlEnv } from "./env.ts";
import { handleAgent } from "./agents/page.ts";
import { avatarOrigin, avatarUrl, renderAccount } from "./views/account.tsx";
import { renderApp, securityHeaders } from "./views/document.tsx";
import { renderSignIn } from "./views/sign-in.tsx";

/**
 * A state-changing tenant call must be JSON. `text/plain` is a CORS-safelisted type, so a page on a
 * sibling host could post it with the SameSite=Lax session cookie and no preflight. A browser Origin
 * or Sec-Fetch-Site from anywhere but this host is rejected. A non-browser client sends neither header.
 */
/** A 403 from the allowlist is a browser page, except the CLI device-token poll. */
async function closedSignup(request: Request, response: Response, list: SignupAllowlist | null): Promise<Response> {
	if (!list || response.status !== 403) return response;
	if (new URL(request.url).pathname.endsWith("/device/token")) return response;
	const type = response.headers.get("content-type") ?? "";
	if (!type.includes("json")) return response;
	let code = "";
	try {
		const body = await response.clone().json() as { code?: unknown };
		if (typeof body?.code === "string") code = body.code;
	} catch {
		return response;
	}
	if (code !== "invite") return response;
	const url = new URL("/app", request.url);
	url.searchParams.set("error", "invite");
	return new Response(null, { status: 302, headers: { location: url.href, "cache-control": "no-store" } });
}

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

function logCallbackFailure(request: Request, error: string): void {
	const path = new URL(request.url).pathname;
	const safe = /^[A-Za-z0-9_-]{1,64}$/.test(error) ? error : "unrecognized";
	console.error(JSON.stringify({ event: "oauth_callback_failed", error: safe, path }));
}

function callbackError(request: Request, response: Response): string {
	const location = response.headers.get("location");
	if (!location) return response.status >= 500 ? "http" : "";
	try {
		const url = new URL(location, request.url);
		if (url.origin !== new URL(request.url).origin || url.pathname !== "/app") return "";
		return url.searchParams.get("error") ?? "";
	} catch {
		return "";
	}
}

function turnstileEndpoint(request: Request): boolean {
	if (request.method !== "POST") return false;
	const path = new URL(request.url).pathname;
	return path === "/api/auth/sign-in/social" || path === "/api/auth/sign-in/magic-link";
}

function callbackGaveUp(request: Request): Response {
	logCallbackFailure(request, "deadline");
	const url = new URL("/app", request.url);
	url.searchParams.set("error", "deadline");
	return new Response(null, { status: 302, headers: { location: url.href, "cache-control": "no-store" } });
}

function pageHeaders(turnstile: boolean, options?: AuthOptions | null, imgSrc: string[] = [], scriptSelf = false): Record<string, string> {
	return {
		...securityHeaders({ turnstile, formAction: options ? enabledProviderOrigins(options) : [], imgSrc, scriptSelf }),
		"cache-control": "no-store",
	};
}

function redirectTo(location: string, cookies: string[] = []): Response {
	const headers = new Headers({ location, "cache-control": "no-store" });
	for (const cookie of cookies) headers.append("set-cookie", cookie);
	return new Response(null, { status: 303, headers });
}

function formMedia(request: Request): boolean {
	const media = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
	return media === "application/x-www-form-urlencoded";
}

function htmlPathFor(pathname: string): string {
	if (pathname.endsWith(".md")) {
		const bare = pathname.slice(0, -3);
		return bare.endsWith("/index") ? bare.slice(0, -"/index".length) || "/" : bare;
	}
	return pathname;
}

export function createApp(env: ControlEnv = {}, deps: AuthDeps & { dataPlane?: DataPlane; callbackDeadlineMs?: number; signInDeadlineMs?: number } = {}) {
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
		const pendingDevice = deviceCodeFromCookie(c.req.header("cookie") ?? null);
		if (pendingDevice) {
			const loaded = await loadAuth(env, c.req.raw, deps);
			const session = loaded ? await loaded.auth.api.getSession({ headers: c.req.raw.headers }) : null;
			if (session?.user?.id) return c.redirect(new URL(`/app/device?user_code=${pendingDevice}`, c.req.url).href, 302);
		}
		const shell = await renderShell(c.req.raw);
		if (shell.clearOwner) c.header("set-cookie", hostCookie(OWNER_COOKIE, "", 0));
		const headers = shell.signedIn
			? pageHeaders(false, null, shell.imageHosts, shell.clearOwner)
			: pageHeaders(shell.turnstile, shell.options);
		return c.html(shell.html, 200, headers);
	});
	app.get("/app/device", (c) => devicePage(c));
	app.post("/app/device", (c) => devicePage(c));
	app.get("/app/sign-in", async (c) => {
		const request = c.req.raw;
		const next = agentReturnPath(new URL(request.url).searchParams.get("return") ?? "");
		const loaded = await loadAuth(env, request, deps);
		if (!loaded) return c.json({ error: "not_found" }, 404);
		const session = await loaded.auth.api.getSession({ headers: request.headers });
		if (!next && session?.user?.id) return c.redirect(new URL("/app", request.url).href, 302);
		const url = new URL(request.url);
		const body = renderSignIn({
			providers: [
				loaded.options.github ? "github" : "",
				loaded.options.google ? "google" : "",
				loaded.options.cloudflare ? "cloudflare" : "",
			].filter(Boolean),
			magicLink: Boolean(loaded.options.mailer || loaded.options.emailBinding),
			invitesRequired: loaded.options.invitesRequired,
			signupClosed: loaded.options.signupAllowlist !== null,
			closedMessage: signupClosedText(env),
			turnstileSiteKey: loaded.options.turnstile?.siteKey,
			error: url.searchParams.get("error") ?? undefined,
			sent: url.searchParams.get("sent") === "1",
			next,
		});
		return c.html(renderApp(env, body), 200, pageHeaders(Boolean(loaded.options.turnstile), loaded.options));
	});
	app.get("/app/agents/:name", (c) => handleAgent(c.req.raw, env, deps));
	app.post("/app/agents/:name", (c) => handleAgent(c.req.raw, env, deps));
	app.get("/app/*", async (c) => {
		const shell = await renderShell(c.req.raw);
		if (shell.clearOwner) c.header("set-cookie", hostCookie(OWNER_COOKIE, "", 0));
		const headers = shell.signedIn
			? pageHeaders(false, null, shell.imageHosts, shell.clearOwner)
			: pageHeaders(shell.turnstile, shell.options);
		return c.html(shell.html, 200, headers);
	});
	async function devicePage(c: Context<{ Bindings: ControlEnv }>) {
		const loaded = await loadAuth(env, c.req.raw, deps);
		if (!loaded) return c.json({ error: "not_found" }, 404);
		const result = await handleDevice(c.req.raw, loaded.auth, loaded.options, env);
		if (result.kind === "closed") return c.json({ error: "not_found" }, 404);
		if (result.cookie) c.header("set-cookie", result.cookie);
		if (result.kind === "redirect") return c.redirect(result.location ?? "/app/device", 303);
		// Approval posts stay on this host. The sign-in form on this page can still leave for a provider.
		return c.html(result.html ?? "", 200, pageHeaders(Boolean(result.turnstile), loaded.options));
	}
	app.post("/app/sign-out", async (c) => {
		const request = c.req.raw;
		if (!sameOrigin(request)) return redirectTo(new URL("/app?error=origin", request.url).href);
		const loaded = await loadAuth(env, request, deps);
		if (!loaded) return c.json({ error: "not_found" }, 404);
		const origin = new URL(request.url).origin;
		const headers = new Headers({ "content-type": "application/json", origin });
		const cookie = request.headers.get("cookie");
		if (cookie) headers.set("cookie", cookie);
		const response = await loaded.auth.handler(new Request(new URL("/api/auth/sign-out", origin), {
			method: "POST",
			headers,
			body: "{}",
		}));
		const cleared = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
		return redirectTo(new URL("/app", request.url).href, cleared);
	});
	app.post("/app/sign-in", async (c) => {
		const loaded = await loadAuth(env, c.req.raw, deps);
		if (!loaded) return c.json({ error: "not_found" }, 404);
		return handleSignIn(c.req.raw, loaded.auth, loaded.options, deps.signInDeadlineMs);
	});
	app.all("/api/auth/*", async (c) => {
		let request = c.req.raw;
		const loaded = await loadAuth(env, request, deps);
		if (!loaded) return c.json({ error: "not_found" }, 404);
		if (loaded.options.turnstile && turnstileEndpoint(request)) {
			const token = request.headers.get("x-captcha-response") ?? "";
			if (!token) return c.json({ code: "MISSING_RESPONSE", message: "Missing CAPTCHA response" }, 400);
			const failure = await verifyTurnstile(loaded.options.turnstile.secret, token, connectingIp(request));
			if (failure) {
				console.error(JSON.stringify({ event: "social_sign_in_failed", status: failure.status, code: failure.code, message: failure.message }));
				const status = failure.status >= 400 && failure.status <= 599 ? failure.status : 403;
				return c.json({ code: failure.code, message: failure.message }, status as 400);
			}
			// The token is single-use. The browser form never reaches this route;
			// a direct client must not have Better Auth submit the same token again.
			const headers = new Headers(request.headers);
			headers.delete("x-captcha-response");
			request = new Request(request, { headers });
		}
		const handle = () => loaded.auth.handler(request);
		const list = loaded.options.signupAllowlist;
		// A missing OAuth state redirects immediately. This bound is for the token
		// exchange, which does not time out on its own. A redirect does not call
		// onAPIError.onError, so the code on that Location is logged here.
		if (!new URL(request.url).pathname.startsWith("/api/auth/callback/")) return closedSignup(request, await handle(), list);
		const deadline = deps.callbackDeadlineMs ?? CALLBACK_DEADLINE_MS;
		const response = await within(deadline, handle, () => callbackGaveUp(request));
		const code = callbackError(request, response);
		if (code && code !== "deadline") logCallbackFailure(request, code);
		return closedSignup(request, response, list);
	});

	app.get("/api/v1/tenants", (c) => tenants(c, "GET"));
	app.post("/api/v1/tenants", (c) => tenants(c, "POST"));

	async function tenants(c: Context<{ Bindings: ControlEnv }>, method: "GET" | "POST") {
		const request = c.req.raw;
		const postedForm = method === "POST" && formMedia(request);
		const plane = deps.dataPlane ?? dataPlaneFromEnv(env);
		const loaded = await loadAuth(env, request, deps);
		if (postedForm) {
			const back = (error?: string) => {
				const url = new URL("/app", request.url);
				if (error) url.searchParams.set("error", error);
				return redirectTo(url.href);
			};
			if (!sameOrigin(request)) return back("origin");
			if (!loaded || !plane) return back("unavailable");
			const session = await loaded.auth.api.getSession({ headers: request.headers });
			if (!session?.user?.id) return back();
			const form = await request.formData();
			const created = await createTenant(loaded.options.database, plane, {
				accountId: session.user.id,
				name: String(form.get("name") ?? ""),
				domain: env.TENANT_DOMAIN,
				dataRegion: env.DATA_REGION,
				issuer: issuerOrigin(env, request),
				label: env.BRAND_NAME,
				freeAgentLimit: configuredFreeAgentLimit(env.FREE_AGENT_LIMIT),
			});
			if (!created.ok) return back(created.error);
			return redirectTo(new URL("/app", request.url).href, [hostCookie(OWNER_COOKIE, created.tenant.ownerToken, 120)]);
		}
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
			freeAgentLimit: configuredFreeAgentLimit(env.FREE_AGENT_LIMIT),
		});
		if (!created.ok) {
			const status = created.error === "taken" ? 409 : created.error === "limit" ? 403 : 400;
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

	async function renderShell(request: Request): Promise<{
		html: string;
		turnstile: boolean;
		options: AuthOptions | null;
		signedIn: boolean;
		imageHosts: string[];
		clearOwner: boolean;
	}> {
		const loaded = await loadAuth(env, request, deps);
		const url = new URL(request.url);
		const turnstile = Boolean(loaded?.options.turnstile);
		const session = loaded ? await loaded.auth.api.getSession({ headers: request.headers }) : null;
		if (loaded && session?.user?.id) {
			const plane = deps.dataPlane ?? dataPlaneFromEnv(env);
			const agents = await listTenants(loaded.options.database, session.user.id, env.TENANT_DOMAIN);
			const token = bareOwnerToken(readCookie(request.headers.get("cookie"), OWNER_COOKIE));
			const image = avatarUrl(typeof session.user.image === "string" ? session.user.image : "");
			const agentLimit = await accountAgentLimit(loaded.options.database, session.user.id, configuredFreeAgentLimit(env.FREE_AGENT_LIMIT));
			const body = renderAccount({
				name: session.user.name ?? "",
				email: session.user.email ?? "",
				image,
				agents,
				ownerToken: token || undefined,
				error: url.searchParams.get("error") ?? undefined,
				canCreate: Boolean(plane),
				agentLimit,
				signupClosed: loaded.options.signupAllowlist !== null,
				closedMessage: signupClosedText(env),
				deleted: url.searchParams.get("deleted") === "1",
			});
			return {
				html: renderApp(env, body, "Your agents"),
				turnstile,
				options: loaded.options,
				signedIn: true,
				imageHosts: image ? [avatarOrigin(image)] : [],
				clearOwner: Boolean(token),
			};
		}
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
				signupClosed: loaded.options.signupAllowlist !== null,
				closedMessage: signupClosedText(env),
				turnstileSiteKey: loaded.options.turnstile?.siteKey,
				error: url.searchParams.get("error") ?? undefined,
				sent: url.searchParams.get("sent") === "1",
			});
		} else {
			const blockers = authBlockers(env, deps);
			if (blockers.length) body = renderSignIn({ providers: [], magicLink: false, invitesRequired: false, notice: blockers[0] });
		}
		return {
			html: renderApp(env, body || undefined),
			turnstile,
			options: loaded?.options ?? null,
			signedIn: false,
			imageHosts: [],
			clearOwner: false,
		};
	}

	// Static document. Do not build Better Auth here: that starts a handler bound to this
	// request's D1, and a handler kept past the response waits on that binding forever.
	// Login is on when resolveAuth would build one. The same check gates sign-in.
	app.get("/.well-known/openid-configuration", (c) => {
		const issuer = issuerOrigin(env, c.req.raw);
		if (!issuer || !resolveAuth(env, c.req.raw, deps)) return c.json({ error: "not_found" }, 404);
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
		// A GET, not a form. The client's redirect_uri is outside form-action, and this response does not post there.
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
