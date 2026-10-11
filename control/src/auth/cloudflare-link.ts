import { mapCloudflareUser } from "./cloudflare-user.ts";
import type { Sql } from "./invites.ts";
import type { AuthOptions } from "./options.ts";
import { recentSignIn } from "./recent.ts";
import { sameOrigin } from "./origin.ts";

export const CLOUDFLARE_UNLINKED = "Sign in another way first, then connect Cloudflare from your account.";
export const CLOUDFLARE_REAUTH = "Sign in again to connect or disconnect Cloudflare. This session is older than 10 minutes.";

const AUTHORIZE = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN = "https://dash.cloudflare.com/oauth2/token";
const USER = "https://api.cloudflare.com/client/v4/user";
const STATE_PREFIX = "cfl_";
const LINK_TTL_MS = 10 * 60 * 1000;
/** Bound for one provider call, including the response body. The token and the profile each get one. */
export const CLOUDFLARE_FETCH_MS = 5_000;

type SessionAuth = {
	handler(request: Request): Promise<Response>;
	api: {
		getSession(input: { headers: Headers }): Promise<{
			user?: { id?: string };
			session?: { createdAt?: unknown };
		} | null>;
	};
};

function randomId(bytes = 16): string {
	const buf = new Uint8Array(bytes);
	crypto.getRandomValues(buf);
	return [...buf].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function codeChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return base64url(new Uint8Array(digest));
}

function callbackUrl(options: AuthOptions): string {
	return `${options.baseURL}/api/auth/callback/cloudflare`;
}

function appRedirect(request: Request, error?: string, flag?: "connected" | "disconnected"): string {
	const url = new URL("/app", request.url);
	if (error) url.searchParams.set("error", error);
	if (flag) url.searchParams.set(flag, "1");
	return url.href;
}

function redirect(location: string, cookies: string[] = [], status = 303): Response {
	const headers = new Headers({ location, "cache-control": "no-store" });
	for (const cookie of cookies) headers.append("set-cookie", cookie);
	return new Response(null, { status, headers });
}

function startDeadline(ms: number): { done: Promise<never>; stop: () => void } {
	let rejectDeadline: (error: unknown) => void = () => {};
	const done = new Promise<never>((_, reject) => { rejectDeadline = reject; });
	const timer = setTimeout(() => rejectDeadline(new DOMException("The operation was aborted", "TimeoutError")), ms);
	return { done, stop: () => clearTimeout(timer) };
}

type ProviderRead = { kind: "ok"; body: unknown } | { kind: "deadline" } | { kind: "failed" };

/** Token or profile read. A stalled socket, a rejected fetch, or a body that is not JSON does not throw. */
export async function readCloudflare(url: string, init: RequestInit, fetchMs = CLOUDFLARE_FETCH_MS): Promise<ProviderRead> {
	const signal = AbortSignal.timeout(fetchMs);
	const deadline = startDeadline(fetchMs);
	try {
		const request = fetch(url, { ...init, signal }).then(
			(response) => ({ response }),
			() => ({ response: null }),
		);
		let response: Response | null;
		try {
			({ response } = await Promise.race([request, deadline.done]));
		} catch {
			return { kind: "deadline" };
		}
		if (!response) return signal.aborted ? { kind: "deadline" } : { kind: "failed" };
		if (!response.ok) {
			void response.body?.cancel().catch(() => {});
			return { kind: "failed" };
		}
		const parsed = response.json().then(
			(body) => ({ body, failed: false }),
			() => ({ body: undefined, failed: true }),
		);
		try {
			const winner = await Promise.race([parsed, deadline.done]);
			if (winner.failed) return signal.aborted ? { kind: "deadline" } : { kind: "failed" };
			return { kind: "ok", body: winner.body };
		} catch {
			return { kind: "deadline" };
		}
	} finally {
		deadline.stop();
	}
}

function expiresMs(value: unknown): number {
	if (value instanceof Date) return value.getTime();
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

async function sessionOf(auth: SessionAuth, request: Request) {
	return auth.api.getSession({ headers: request.headers });
}

async function clearSession(auth: SessionAuth, request: Request): Promise<string[]> {
	const origin = new URL(request.url).origin;
	const headers = new Headers({ "content-type": "application/json", origin });
	const cookie = request.headers.get("cookie");
	if (cookie) headers.set("cookie", cookie);
	const response = await auth.handler(new Request(new URL("/api/auth/sign-out", origin), {
		method: "POST",
		headers,
		body: "{}",
	}));
	return typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
}

export async function cloudflareIsLinked(db: Sql, userId: string): Promise<boolean> {
	if (!userId) return false;
	const row = await db.prepare(
		`SELECT id FROM "account" WHERE "userId" = ? AND "providerId" = 'cloudflare' LIMIT 1`,
	).bind(userId).first<{ id: string }>();
	return Boolean(row);
}

async function deleteLinkState(db: Sql, state: string): Promise<void> {
	await db.prepare(`DELETE FROM verification WHERE identifier = ?`).bind(`cf-link:${state}`).run();
}

/** True when this callback belongs to a connect we started, not a Continue-with sign-in. */
export function cloudflareLinkState(request: Request): boolean {
	const state = new URL(request.url).searchParams.get("state") ?? "";
	return state.startsWith(STATE_PREFIX);
}

export async function handleCloudflareAccount(request: Request, auth: SessionAuth, options: AuthOptions): Promise<Response> {
	if (!options.cloudflare) return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" } });
	if (!sameOrigin(request)) return redirect(appRedirect(request, "origin"));
	const length = Number(request.headers.get("content-length") || "0");
	if (length > 16_000) return redirect(appRedirect(request, "auth"));
	const session = await sessionOf(auth, request);
	const userId = session?.user?.id ?? "";
	if (!userId) return redirect(appRedirect(request));
	if (!recentSignIn(session)) {
		const cookies = await clearSession(auth, request).catch(() => []);
		return redirect(appRedirect(request, "cloudflare_reauth"), cookies);
	}
	const form = await request.formData();
	const action = String(form.get("action") ?? "");
	if (action === "disconnect") {
		await options.database.prepare(
			`DELETE FROM "account" WHERE "userId" = ? AND "providerId" = 'cloudflare'`,
		).bind(userId).run();
		return redirect(appRedirect(request, undefined, "disconnected"));
	}
	if (action !== "connect") return redirect(appRedirect(request));
	if (await cloudflareIsLinked(options.database, userId)) return redirect(appRedirect(request, undefined, "connected"));
	const state = `${STATE_PREFIX}${randomId()}`;
	const verifierBytes = new Uint8Array(32);
	crypto.getRandomValues(verifierBytes);
	const verifier = base64url(verifierBytes);
	const now = new Date();
	const expires = new Date(now.getTime() + LINK_TTL_MS);
	await options.database.prepare(
		`INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
	).bind(
		randomId(),
		`cf-link:${state}`,
		JSON.stringify({ userId, verifier }),
		expires.toISOString(),
		now.toISOString(),
		now.toISOString(),
	).run();
	const url = new URL(AUTHORIZE);
	url.searchParams.set("client_id", options.cloudflare.clientId);
	url.searchParams.set("redirect_uri", callbackUrl(options));
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", "user-details.read");
	url.searchParams.set("state", state);
	url.searchParams.set("code_challenge", await codeChallenge(verifier));
	url.searchParams.set("code_challenge_method", "S256");
	return redirect(url.href);
}

/**
 * Completes a connect callback. Returns null when the state is a normal sign-in,
 * so Better Auth can sign in by the linked Cloudflare account id.
 * The Cloudflare email is not stored on the user and is not checked against the allowlist.
 */
export async function finishCloudflareLink(request: Request, auth: SessionAuth, options: AuthOptions, fetchMs = CLOUDFLARE_FETCH_MS): Promise<Response | null> {
	if (!cloudflareLinkState(request) || !options.cloudflare) return null;
	const url = new URL(request.url);
	const state = url.searchParams.get("state") ?? "";
	const code = url.searchParams.get("code") ?? "";
	const row = await options.database.prepare(
		`SELECT value, expiresAt FROM verification WHERE identifier = ?`,
	).bind(`cf-link:${state}`).first<{ value: string; expiresAt: unknown }>();
	await deleteLinkState(options.database, state);
	if (!row || expiresMs(row.expiresAt) <= Date.now()) return redirect(appRedirect(request, "state_mismatch"), [], 302);
	let saved: { userId?: unknown; verifier?: unknown };
	try {
		saved = JSON.parse(row.value) as { userId?: unknown; verifier?: unknown };
	} catch {
		return redirect(appRedirect(request, "auth"), [], 302);
	}
	const userId = typeof saved.userId === "string" ? saved.userId : "";
	const verifier = typeof saved.verifier === "string" ? saved.verifier : "";
	const session = await sessionOf(auth, request);
	if (!userId || !verifier || session?.user?.id !== userId) return redirect(appRedirect(request, "auth"), [], 302);
	if (!code) return redirect(appRedirect(request, "no_code"), [], 302);
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code,
		redirect_uri: callbackUrl(options),
		client_id: options.cloudflare.clientId,
		client_secret: options.cloudflare.clientSecret,
		code_verifier: verifier,
	});
	const token = await readCloudflare(TOKEN, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body,
	}, fetchMs);
	if (token.kind === "deadline") return redirect(appRedirect(request, "deadline"), [], 302);
	const tokenBody = token.kind === "ok" && token.body && typeof token.body === "object" ? token.body as { access_token?: unknown } : null;
	const accessToken = typeof tokenBody?.access_token === "string" ? tokenBody.access_token : "";
	if (!accessToken) return redirect(appRedirect(request, "invalid_code"), [], 302);
	const profile = await readCloudflare(USER, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } }, fetchMs);
	if (profile.kind === "deadline") return redirect(appRedirect(request, "deadline"), [], 302);
	const profileBody = profile.kind === "ok" && profile.body && typeof profile.body === "object"
		? profile.body as { result?: Parameters<typeof mapCloudflareUser>[0] }
		: null;
	const user = mapCloudflareUser(profileBody?.result);
	if (!user) return redirect(appRedirect(request, "unable_to_get_user_info"), [], 302);
	const now = new Date().toISOString();
	// account_provider_account_idx makes this insert lose when another callback already
	// claimed the same Cloudflare account. The following read is the winner, so two
	// overlapping connects cannot both report success.
	await options.database.prepare(
		`INSERT INTO "account" (id, "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "password", "createdAt", "updatedAt")
		 VALUES (?, ?, 'cloudflare', ?, NULL, NULL, NULL, NULL, NULL, 'user-details.read', NULL, ?, ?)
		 ON CONFLICT ("providerId", "accountId") DO NOTHING`,
	).bind(randomId(), user.id, userId, now, now).run();
	const owner = await options.database.prepare(
		`SELECT "userId" FROM "account" WHERE "providerId" = 'cloudflare' AND "accountId" = ?`,
	).bind(user.id).first<{ userId: string }>();
	if (owner?.userId !== userId) return redirect(appRedirect(request, "account_already_linked_to_different_user"), [], 302);
	return redirect(appRedirect(request, undefined, "connected"), [], 302);
}
