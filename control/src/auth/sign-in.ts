import { INVITE_COOKIE, hostCookie } from "./cookies.ts";
import { hasAccount, invitePending, validInviteCode } from "./invites.ts";
import type { AuthOptions } from "./options.ts";

type AuthHandler = { handler(request: Request): Promise<Response> };

interface SignInPayload {
	url?: unknown;
	redirect?: unknown;
	code?: unknown;
}

const PROVIDER_ORIGINS = new Set([
	"https://github.com",
	"https://accounts.google.com",
	"https://dash.cloudflare.com",
]);

function sameOrigin(request: Request): boolean {
	const origin = request.headers.get("origin");
	return Boolean(origin) && origin === new URL(request.url).origin;
}

function allowedProviderUrl(value: string): string | null {
	try {
		const url = new URL(value);
		if (url.username || url.password) return null;
		if (!PROVIDER_ORIGINS.has(url.origin)) return null;
		return url.href;
	} catch {
		return null;
	}
}

async function readPayload(response: Response): Promise<SignInPayload | null> {
	const type = response.headers.get("content-type") ?? "";
	if (!type.includes("json")) return null;
	try {
		const payload = await response.json() as SignInPayload;
		if (!payload || typeof payload !== "object") return null;
		return payload;
	} catch {
		return null;
	}
}

/**
 * Better Auth 1.7 answers `/sign-in/social` with 200 JSON `{ url, redirect: true }`.
 * A Workers response of that shape has no Location header. The provider URL is the
 * JSON `url` when it is present, and a Location header only when the body has none.
 */
function providerTarget(response: Response, payload: SignInPayload | null): string | null {
	if (payload && typeof payload.url === "string") {
		if (payload.redirect === false) return null;
		return allowedProviderUrl(payload.url);
	}
	const location = response.headers.get("location");
	if (!location) return null;
	return allowedProviderUrl(location);
}

function signInError(payload: SignInPayload | null): string {
	const code = typeof payload?.code === "string" ? payload.code : "";
	if (code === "VERIFICATION_FAILED" || code === "MISSING_RESPONSE") return "turnstile";
	return "auth";
}

function cookiesFrom(response: Response): string[] {
	return typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
}

function redirect(location: string, cookies: string[] = []): Response {
	const headers = new Headers({ location, "cache-control": "no-store" });
	for (const cookie of cookies) headers.append("set-cookie", cookie);
	return new Response(null, { status: 303, headers });
}

function appUrl(request: Request, error?: string): string {
	const url = new URL("/app", request.url);
	if (error) url.searchParams.set("error", error);
	return url.href;
}

export async function handleSignIn(request: Request, auth: AuthHandler, options: AuthOptions): Promise<Response> {
	if (!sameOrigin(request)) return redirect(appUrl(request, "auth"));
	const form = await request.formData();
	const provider = String(form.get("provider") ?? "");
	const email = String(form.get("email") ?? "").trim();
	const invite = String(form.get("invite") ?? "").trim();
	const allowed = new Set([
		...(options.github ? ["github"] : []),
		...(options.google ? ["google"] : []),
		...(options.cloudflare ? ["cloudflare"] : []),
		...(options.mailer || options.emailBinding ? ["email"] : []),
	]);
	if (!allowed.has(provider)) return redirect(appUrl(request, "unavailable"));
	if (provider === "email" && !email) return redirect(appUrl(request, "email"));
	const returning = provider === "email" && email ? await hasAccount(options.database, email) : false;
	const needsInvite = options.invitesRequired && provider === "email" && !returning;
	if (needsInvite || (options.invitesRequired && invite)) {
		const address = provider === "email" ? email : undefined;
		if (!validInviteCode(invite) || !await invitePending(options.database, invite, address)) {
			return redirect(appUrl(request, "invite"));
		}
	}
	const token = String(form.get("cf-turnstile-response") ?? "");
	if (options.turnstile && !token) return redirect(appUrl(request, "turnstile"));

	const origin = new URL(request.url).origin;
	const headers = new Headers({ "content-type": "application/json", origin });
	const cookie = request.headers.get("cookie");
	if (cookie) headers.set("cookie", cookie);
	if (token) headers.set("x-captcha-response", token);
	const path = provider === "email" ? "/api/auth/sign-in/magic-link" : "/api/auth/sign-in/social";
	const body = provider === "email"
		? {
			email,
			callbackURL: "/app",
			errorCallbackURL: "/app",
			newUserCallbackURL: "/app",
			...(options.invitesRequired && invite && !returning ? { metadata: { invite } } : {}),
		}
		: { provider, callbackURL: "/app", errorCallbackURL: "/app" };
	const response = await auth.handler(new Request(new URL(path, origin), { method: "POST", headers, body: JSON.stringify(body) }));
	const cookies = cookiesFrom(response);
	if (options.invitesRequired && invite && !returning) cookies.push(hostCookie(INVITE_COOKIE, invite, 60 * 15));
	const payload = await readPayload(response);
	if (!response.ok) return redirect(appUrl(request, signInError(payload)));
	if (provider !== "email") {
		const location = providerTarget(response, payload);
		if (!location) return redirect(appUrl(request, "auth"));
		return redirect(location, cookies);
	}
	return redirect(new URL("/app?sent=1", request.url).href, cookies);
}
