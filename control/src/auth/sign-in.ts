import { INVITE_COOKIE, hostCookie } from "./cookies.ts";
import { hasAccount, invitePending, validInviteCode } from "./invites.ts";
import type { AuthOptions } from "./options.ts";
import { SIGN_IN_DEADLINE_MS, within } from "./deadline.ts";
import { sameOrigin } from "./origin.ts";
import { connectingIp, verifyTurnstile } from "./turnstile.ts";

type AuthHandler = { handler(request: Request): Promise<Response> };

interface SignInPayload {
	url?: unknown;
	redirect?: unknown;
	code?: unknown;
	message?: unknown;
}

const PAGE_CODES = new Set([
	"auth",
	"origin",
	"provider_url",
	"rate_limit",
	"turnstile",
	"turnstile_unavailable",
	"invalid-input-secret",
	"missing-input-secret",
	"invalid-input-response",
	"missing-input-response",
	"timeout-or-duplicate",
	"bad-request",
	"UNKNOWN_ERROR",
	"VERIFICATION_FAILED",
	"MISSING_RESPONSE",
	"INVALID_ORIGIN",
	"MISSING_OR_NULL_ORIGIN",
	"PROVIDER_NOT_FOUND",
	"INVALID_CALLBACK_URL",
	"INVALID_ERROR_CALLBACK_URL",
]);

const PROVIDER_ORIGINS = new Set([
	"https://github.com",
	"https://accounts.google.com",
	"https://dash.cloudflare.com",
]);

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
function providerTarget(response: Response, payload: SignInPayload | null): { location: string } | { origin: string | null } {
	const raw = payload && typeof payload.url === "string"
		? payload.redirect === false ? "" : payload.url
		: response.headers.get("location") ?? "";
	if (!raw) return { origin: null };
	const allowed = allowedProviderUrl(raw);
	if (allowed) return { location: allowed };
	try {
		return { origin: new URL(raw).origin };
	} catch {
		return { origin: null };
	}
}

function safeCode(value: unknown): string {
	return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : "";
}

function safeMessage(value: unknown): string {
	if (typeof value !== "string") return "";
	const message = value.replace(/[\r\n]/g, " ").slice(0, 200);
	return /^[\x20-\x7e]*$/.test(message) ? message : "";
}

function pageCode(status: number, code: string): string {
	if (status === 429) return "rate_limit";
	if (code === "VERIFICATION_FAILED" || code === "MISSING_RESPONSE") return "turnstile";
	return PAGE_CODES.has(code) ? code : "auth";
}

function logSignInFailure(status: number, code: string, message: string): void {
	console.error(JSON.stringify({ event: "social_sign_in_failed", status, code, message }));
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

export async function handleSignIn(request: Request, auth: AuthHandler, options: AuthOptions, deadlineMs = SIGN_IN_DEADLINE_MS): Promise<Response> {
	if (!sameOrigin(request)) {
		logSignInFailure(403, "origin", "The sign-in request came from another site.");
		return redirect(appUrl(request, "origin"));
	}
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
	const ip = connectingIp(request);
	if (options.turnstile) {
		const failure = await verifyTurnstile(options.turnstile.secret, token, ip);
		if (failure) {
			logSignInFailure(failure.status, failure.code, failure.message);
			return redirect(appUrl(request, pageCode(failure.status, failure.code)));
		}
	}

	// The browser may have sent `Origin: null`. Better Auth checks the origin on this request.
	const origin = new URL(request.url).origin;
	const headers = new Headers({ "content-type": "application/json", origin });
	const cookie = request.headers.get("cookie");
	if (cookie) headers.set("cookie", cookie);
	if (ip) headers.set("cf-connecting-ip", ip);
	// The Turnstile token was consumed above. It is single-use, so it is not sent on.
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
	let timedOut = false;
	const response = await within(deadlineMs, () => auth.handler(new Request(new URL(path, origin), { method: "POST", headers, body: JSON.stringify(body) })), () => {
		timedOut = true;
		console.error(JSON.stringify({ event: "social_sign_in_timeout" }));
		return new Response(null, { status: 504 });
	});
	if (timedOut) return redirect(appUrl(request, "deadline"));
	const cookies = cookiesFrom(response);
	if (options.invitesRequired && invite && !returning) cookies.push(hostCookie(INVITE_COOKIE, invite, 60 * 15));
	const payload = await readPayload(response);
	if (!response.ok) {
		const code = safeCode(payload?.code);
		const page = pageCode(response.status, code);
		logSignInFailure(response.status, code || page, safeMessage(payload?.message));
		return redirect(appUrl(request, page));
	}
	if (provider !== "email") {
		const target = providerTarget(response, payload);
		if (!("location" in target)) {
			logSignInFailure(response.status, "provider_url", target.origin ?? "");
			return redirect(appUrl(request, "provider_url"));
		}
		return redirect(target.location, cookies);
	}
	return redirect(new URL("/app?sent=1", request.url).href, cookies);
}
