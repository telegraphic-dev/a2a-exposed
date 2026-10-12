import { CLOUDFLARE_RESUME_COOKIE, hostCookie, readCookie } from "./cookies.ts";
import { deleteCloudflareGrant, saveCloudflareGrant } from "./cloudflare-grant.ts";
import { mapCloudflareUser } from "./cloudflare-user.ts";
import {
	cloudflareAuthorizeUrl,
	consentScope,
	parseSetupChoice,
	parseSetupHost,
	type SetupChoice,
	type SetupHost,
} from "./cloudflare-setup.ts";
import type { Sql } from "./invites.ts";
import type { AuthOptions } from "./options.ts";
import { recentSignIn } from "./recent.ts";
import { sameOrigin } from "./origin.ts";
import { fieldsFromForm, resumeFields, runInboxStep, type InboxMigration, type InboxWizard, type ProvisionFields } from "../provision/inbox.ts";

export const CLOUDFLARE_UNLINKED = "Sign in another way first, then connect Cloudflare from your account.";
/** Shown on the sign-in page when connect, disconnect, or consent needs a fresh sign-in. */
export const CLOUDFLARE_REAUTH_NOTICE = "For your security, please sign in again to change your Cloudflare connection.";

const TOKEN = "https://dash.cloudflare.com/oauth2/token";
const USER = "https://api.cloudflare.com/client/v4/user";
const STATE_PREFIX = "cfl_";
const LINK_TTL_MS = 10 * 60 * 1000;
const RESUME_PREFIX = "cf-resume:";
const RESUME_TTL_MS = 10 * 60 * 1000;
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

function appRedirect(request: Request, error?: string, flag?: "connected" | "disconnected", path = "/app"): string {
	const url = new URL(path, request.url);
	if (error) url.searchParams.set("error", error);
	if (flag) url.searchParams.set(flag, "1");
	return url.href;
}

function setupPage(request: Request, error?: string): string {
	const url = new URL("/app/cloudflare", request.url);
	if (error) url.searchParams.set("error", error);
	return url.href;
}

/** OAuth error codes are short tokens. Anything else is not logged as-is. */
function safeProviderError(value: string): string {
	const trimmed = value.trim().slice(0, 64);
	return /^[A-Za-z0-9._~:-]+$/.test(trimmed) ? trimmed : "unrecognized";
}

/**
 * Query names whose values are credentials. Matched as `name=value` or `name: value`,
 * including a percent-encoded `=`. `authorization server` has neither, so it stays.
 */
const SECRET_PARAM = /\b(?:id_token|access_token|refresh_token|client_secret|authorization|code|token)\s*(?:=|%3d|:)\s*\S/i;
/** A compact JWS: `eyJ` header, payload, signature. Error text does not look like this. */
const JWT_SHAPED = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/;

/** The description is logged. A code, a token, an id_token, or a JWT is not. */
function safeProviderDescription(value: string): string {
	const cleaned = value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
	if (!cleaned) return "";
	if (SECRET_PARAM.test(cleaned) || /bearer\s+\S/i.test(cleaned) || JWT_SHAPED.test(cleaned)) return "redacted";
	return cleaned;
}

/** Query `error` on the connect callback, as a setup-page code. */
export function cloudflareSetupErrorCode(providerError: string): "cancelled" | "refused" | "provider" {
	if (providerError === "access_denied") return "cancelled";
	if (providerError === "invalid_scope") return "refused";
	return "provider";
}

function logCloudflareProviderError(providerError: string, description: string): void {
	const error = safeProviderError(providerError);
	const errorDescription = safeProviderDescription(description);
	console.error(JSON.stringify({
		event: "cloudflare_oauth_error",
		error,
		...(errorDescription ? { error_description: errorDescription } : {}),
	}));
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
export async function readCloudflare(url: string, init: RequestInit, fetchMs = CLOUDFLARE_FETCH_MS, outer?: AbortSignal): Promise<ProviderRead> {
	const timeout = AbortSignal.timeout(fetchMs);
	const signal = outer ? AbortSignal.any([timeout, outer]) : timeout;
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

/** True when this callback belongs to a connect we started. */
export function cloudflareLinkState(request: Request): boolean {
	const state = new URL(request.url).searchParams.get("state") ?? "";
	return state.startsWith(STATE_PREFIX);
}

type CloudflareResume =
	| { userId: string; action: "disconnect" }
	| { userId: string; action: "consent"; choice: SetupChoice; host: SetupHost }
	| { userId: string; action: "finish"; state: string; code: string }
	| { userId: string; action: "provision"; fields: ProvisionFields };

export interface CloudflareProvisionDeps {
	script: string;
	migrations: InboxMigration[];
	fetchMs?: number;
}

function signInForCloudflare(request: Request, returnPath: "/app" | "/app/cloudflare"): string {
	const url = new URL("/app/sign-in", request.url);
	url.searchParams.set("return", returnPath);
	url.searchParams.set("reauth", "cloudflare");
	return url.href;
}

async function saveResume(db: Sql, resume: CloudflareResume): Promise<string> {
	const token = randomId();
	const now = new Date();
	const expires = new Date(now.getTime() + RESUME_TTL_MS);
	await db.prepare(
		`INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
	).bind(
		randomId(),
		`${RESUME_PREFIX}${token}`,
		JSON.stringify(resume),
		expires.toISOString(),
		now.toISOString(),
		now.toISOString(),
	).run();
	return token;
}

/** Sign out, then send the browser to sign in. The action waits in a one-time row, not in the URL. */
async function reauthResponse(request: Request, auth: SessionAuth, options: AuthOptions, resume: CloudflareResume, returnPath: "/app" | "/app/cloudflare", status = 303): Promise<Response> {
	const token = await saveResume(options.database, resume);
	const cookies = await clearSession(auth, request).catch((): string[] => []);
	cookies.push(hostCookie(CLOUDFLARE_RESUME_COOKIE, token, Math.floor(RESUME_TTL_MS / 1000)));
	return redirect(signInForCloudflare(request, returnPath), cookies, status);
}

function withCookie(response: Response, cookie: string): Response {
	const headers = new Headers(response.headers);
	headers.append("set-cookie", cookie);
	return new Response(response.body, { status: response.status, headers });
}

function resumeOf(value: string): CloudflareResume | null {
	let saved: { userId?: unknown; action?: unknown; choice?: unknown; host?: unknown; state?: unknown; code?: unknown; fields?: unknown };
	try {
		saved = JSON.parse(value) as typeof saved;
	} catch {
		return null;
	}
	const userId = typeof saved.userId === "string" ? saved.userId : "";
	if (!userId || userId.length > 128) return null;
	if (saved.action === "disconnect") return { userId, action: "disconnect" };
	if (saved.action === "consent") {
		const choice = parseSetupChoice(saved.choice);
		const host = parseSetupHost(saved.host);
		if (!choice || !host) return null;
		return { userId, action: "consent", choice, host };
	}
	if (saved.action === "finish") {
		const state = typeof saved.state === "string" ? saved.state : "";
		const code = typeof saved.code === "string" ? saved.code : "";
		if (!state.startsWith(STATE_PREFIX) || state.length > 80 || !code || code.length > 2048) return null;
		return { userId, action: "finish", state, code };
	}
	if (saved.action === "provision") {
		const fields = saved.fields && typeof saved.fields === "object" ? resumeFields(saved.fields as { name?: unknown; hostname?: unknown; subdomain?: unknown; account?: unknown; step?: unknown }) : null;
		if (!fields) return null;
		return { userId, action: "provision", fields };
	}
	return null;
}

export type CloudflareResumeResult =
	| { kind: "response"; response: Response }
	| { kind: "clear" }
	| { kind: "wizard"; wizard: InboxWizard; ownerToken?: string; setCookie: string };

/**
 * Finishes a connect, disconnect, or consent the user already asked for, after a fresh sign-in.
 * No resume cookie returns null. A signed-out visit leaves the row in place.
 * A mismatch or an expired row clears the cookie and does not act.
 * A create resumes that one step and returns the wizard for the setup page to render.
 */
export async function resumeCloudflare(request: Request, auth: SessionAuth, options: AuthOptions, provision?: CloudflareProvisionDeps | null, deferProvision = false): Promise<CloudflareResumeResult | null> {
	if (!options.cloudflare) return null;
	const token = readCookie(request.headers.get("cookie"), CLOUDFLARE_RESUME_COOKIE);
	if (!/^[0-9a-f]{32}$/.test(token)) return null;
	const session = await sessionOf(auth, request);
	const userId = session?.user?.id ?? "";
	if (!userId) return null;
	const identifier = `${RESUME_PREFIX}${token}`;
	const row = await options.database.prepare(
		`SELECT value, expiresAt FROM verification WHERE identifier = ?`,
	).bind(identifier).first<{ value: string; expiresAt: unknown }>();
	const clear = hostCookie(CLOUDFLARE_RESUME_COOKIE, "", 0);
	const resume = row && expiresMs(row.expiresAt) > Date.now() ? resumeOf(row.value) : null;
	if (!resume || resume.userId !== userId || !recentSignIn(session)) {
		await options.database.prepare(`DELETE FROM verification WHERE identifier = ?`).bind(identifier).run();
		return { kind: "clear" };
	}
	// The account page cannot show the account or domain choices. Leave the resume row for the setup page.
	if (deferProvision && resume.action === "provision") {
		return { kind: "response", response: redirect(setupPage(request)) };
	}
	await options.database.prepare(`DELETE FROM verification WHERE identifier = ?`).bind(identifier).run();
	if (resume.action === "disconnect") {
		await deleteCloudflareGrant(options.database, userId);
		await options.database.prepare(
			`DELETE FROM "account" WHERE "userId" = ? AND "providerId" = 'cloudflare'`,
		).bind(userId).run();
		return { kind: "response", response: redirect(appRedirect(request, undefined, "disconnected"), [clear]) };
	}
	if (resume.action === "consent") {
		const started = await startCloudflareOAuth(request, options, userId, resume.choice, resume.host);
		return { kind: "response", response: withCookie(started, clear) };
	}
	if (resume.action === "provision") {
		if (!provision) return { kind: "clear" };
		const done = await runCloudflareProvision(request, options, userId, resume.fields, provision);
		if (done.kind === "response") return { kind: "response", response: withCookie(done.response, clear) };
		return { kind: "wizard", wizard: done.wizard, ownerToken: done.ownerToken, setCookie: clear };
	}
	const url = new URL("/api/auth/callback/cloudflare", request.url);
	url.searchParams.set("code", resume.code);
	url.searchParams.set("state", resume.state);
	const finished = await finishCloudflareLink(new Request(url, { method: "GET", headers: request.headers }), auth, options);
	return { kind: "response", response: withCookie(finished, clear) };
}

export async function handleCloudflareAccount(request: Request, auth: SessionAuth, options: AuthOptions): Promise<Response> {
	if (!options.cloudflare) return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" } });
	if (!sameOrigin(request)) return redirect(appRedirect(request, "origin"));
	const length = Number(request.headers.get("content-length") || "0");
	if (length > 16_000) return redirect(appRedirect(request, "auth"));
	const session = await sessionOf(auth, request);
	const userId = session?.user?.id ?? "";
	if (!userId) return redirect(appRedirect(request));
	const form = await request.formData();
	const action = String(form.get("action") ?? "");
	if (action === "disconnect") {
		if (!recentSignIn(session)) return reauthResponse(request, auth, options, { userId, action: "disconnect" }, "/app");
		await deleteCloudflareGrant(options.database, userId);
		await options.database.prepare(
			`DELETE FROM "account" WHERE "userId" = ? AND "providerId" = 'cloudflare'`,
		).bind(userId).run();
		return redirect(appRedirect(request, undefined, "disconnected"));
	}
	// The account page used to post this. It now links to the choice page, which
	// asks before any consent. A leftover post must not skip that choice.
	if (action === "connect") return redirect(setupPage(request));
	return redirect(appRedirect(request));
}

async function startCloudflareOAuth(request: Request, options: AuthOptions, userId: string, choice: SetupChoice, host: SetupHost): Promise<Response> {
	if (!options.cloudflare) return redirect(appRedirect(request));
	const state = `${STATE_PREFIX}${randomId()}`;
	const verifierBytes = new Uint8Array(32);
	crypto.getRandomValues(verifierBytes);
	const verifier = base64url(verifierBytes);
	const now = new Date();
	const expires = new Date(now.getTime() + LINK_TTL_MS);
	const saved = { userId, verifier, choice, host };
	const scope = consentScope(choice, host);
	await options.database.prepare(
		`INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
	).bind(
		randomId(),
		`cf-link:${state}`,
		JSON.stringify(saved),
		expires.toISOString(),
		now.toISOString(),
		now.toISOString(),
	).run();
	return redirect(cloudflareAuthorizeUrl({
		clientId: options.cloudflare.clientId,
		redirectUri: callbackUrl(options),
		scope,
		state,
		codeChallenge: await codeChallenge(verifier),
	}));
}

export type CloudflareSetupPost =
	| { kind: "response"; response: Response }
	| { kind: "review"; choice: SetupChoice; host: SetupHost }
	| { kind: "wizard"; wizard: InboxWizard; ownerToken?: string };


async function runCloudflareProvision(request: Request, options: AuthOptions, userId: string, fields: ProvisionFields, deps: CloudflareProvisionDeps): Promise<Exclude<CloudflareSetupPost, { kind: "review" }>> {
	if (!options.cloudflare) return { kind: "response", response: redirect(setupPage(request)) };
	const outcome = await runInboxStep({
		database: options.database,
		secret: options.secret,
		clientId: options.cloudflare.clientId,
		clientSecret: options.cloudflare.clientSecret,
		userId,
		fields,
		script: deps.script,
		migrations: deps.migrations,
		fetchMs: deps.fetchMs,
	});
	return { kind: "wizard", wizard: outcome.wizard, ownerToken: outcome.ownerToken };
}

/** Choice page post: explain the permissions, or start consent for that choice only. */
export async function handleCloudflareSetup(request: Request, auth: SessionAuth, options: AuthOptions, provision?: CloudflareProvisionDeps | null): Promise<CloudflareSetupPost> {
	if (!options.cloudflare) {
		return { kind: "response", response: new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" } }) };
	}
	if (!sameOrigin(request)) return { kind: "response", response: redirect(appRedirect(request, "origin")) };
	const length = Number(request.headers.get("content-length") || "0");
	if (length > 16_000) return { kind: "response", response: redirect(appRedirect(request, "auth")) };
	const session = await sessionOf(auth, request);
	const userId = session?.user?.id ?? "";
	if (!userId) return { kind: "response", response: redirect(appRedirect(request)) };
	const form = await request.formData();
	const action = String(form.get("action") ?? "");
	const choice = parseSetupChoice(String(form.get("choice") ?? ""));
	const host = parseSetupHost(String(form.get("host") ?? ""));
	if (action === "review") {
		if (!choice || !host) return { kind: "response", response: redirect(setupPage(request, "choice")) };
		return { kind: "review", choice, host };
	}
	if (action === "provision" || action === "step") {
		const fields = fieldsFromForm(form);
		if (!recentSignIn(session)) {
			return { kind: "response", response: await reauthResponse(request, auth, options, { userId, action: "provision", fields }, "/app/cloudflare") };
		}
		if (!provision) return { kind: "response", response: redirect(setupPage(request, "script")) };
		return runCloudflareProvision(request, options, userId, fields, provision);
	}
	if (action !== "consent") return { kind: "response", response: redirect(setupPage(request)) };
	if (!choice || !host) return { kind: "response", response: redirect(setupPage(request, "choice")) };
	if (!recentSignIn(session)) {
		return { kind: "response", response: await reauthResponse(request, auth, options, { userId, action: "consent", choice, host }, "/app/cloudflare") };
	}
	return { kind: "response", response: await startCloudflareOAuth(request, options, userId, choice, host) };
}

/** The pending connect row belongs to this request's signed-in account. */
async function sessionOwnsConnectState(request: Request, auth: SessionAuth, options: AuthOptions, state: string): Promise<boolean> {
	if (!state.startsWith(STATE_PREFIX)) return false;
	const row = await options.database.prepare(
		`SELECT value, expiresAt FROM verification WHERE identifier = ?`,
	).bind(`cf-link:${state}`).first<{ value: string; expiresAt: unknown }>();
	if (!row || expiresMs(row.expiresAt) <= Date.now()) return false;
	let saved: { userId?: unknown };
	try {
		saved = JSON.parse(row.value) as { userId?: unknown };
	} catch {
		return false;
	}
	const userId = typeof saved.userId === "string" ? saved.userId : "";
	if (!userId) return false;
	const session = await sessionOf(auth, request);
	return session?.user?.id === userId;
}

/**
 * Completes a connect callback. Any other Cloudflare callback is refused and
 * does not create or resume a session. The access token is used to read the
 * account id and is not stored. A setup consent stores the latest refresh
 * token encrypted on cloudflare_grant. The email is not stored and is not
 * checked against the allowlist.
 */
export async function finishCloudflareLink(request: Request, auth: SessionAuth, options: AuthOptions, fetchMs = CLOUDFLARE_FETCH_MS, outer?: AbortSignal): Promise<Response> {
	if (request.method !== "GET" || !options.cloudflare) {
		return redirect(appRedirect(request, "cloudflare_unlinked"), [], 302);
	}
	const url = new URL(request.url);
	const providerError = url.searchParams.get("error");
	if (providerError) {
		const state = url.searchParams.get("state") ?? "";
		const owned = await sessionOwnsConnectState(request, auth, options, state);
		if (!owned) return redirect(appRedirect(request, "cloudflare_unlinked"), [], 302);
		await deleteLinkState(options.database, state);
		logCloudflareProviderError(providerError, url.searchParams.get("error_description") ?? "");
		return redirect(setupPage(request, cloudflareSetupErrorCode(providerError)), [], 302);
	}
	if (!cloudflareLinkState(request)) {
		return redirect(appRedirect(request, "cloudflare_unlinked"), [], 302);
	}
	const state = url.searchParams.get("state") ?? "";
	const code = url.searchParams.get("code") ?? "";
	const row = await options.database.prepare(
		`SELECT value, expiresAt FROM verification WHERE identifier = ?`,
	).bind(`cf-link:${state}`).first<{ value: string; expiresAt: unknown }>();
	if (!row || expiresMs(row.expiresAt) <= Date.now()) {
		await deleteLinkState(options.database, state);
		return redirect(appRedirect(request, "state_mismatch"), [], 302);
	}
	let saved: { userId?: unknown; verifier?: unknown; choice?: unknown; host?: unknown };
	try {
		saved = JSON.parse(row.value) as { userId?: unknown; verifier?: unknown; choice?: unknown; host?: unknown };
	} catch {
		await deleteLinkState(options.database, state);
		return redirect(appRedirect(request, "auth"), [], 302);
	}
	const userId = typeof saved.userId === "string" ? saved.userId : "";
	const verifier = typeof saved.verifier === "string" ? saved.verifier : "";
	const choice = parseSetupChoice(saved.choice);
	const host = parseSetupHost(saved.host);
	const setup = choice && host ? { choice, host } : null;
	if ((saved.choice != null || saved.host != null) && !setup) {
		await deleteLinkState(options.database, state);
		return redirect(appRedirect(request, "auth"), [], 302);
	}
	const session = await sessionOf(auth, request);
	// Knowing the state is not enough to throw away the pending connect.
	if (!session?.user?.id) {
		return redirect(appRedirect(request, "cloudflare_unlinked"), [], 302);
	}
	if (!userId || !verifier || session.user.id !== userId) {
		return redirect(appRedirect(request, "auth"), [], 302);
	}
	if (!recentSignIn(session)) {
		if (!code || code.length > 2048) {
			await deleteLinkState(options.database, state);
			return redirect(setupPage(request, "provider"), [], 302);
		}
		return reauthResponse(request, auth, options, { userId, action: "finish", state, code }, "/app/cloudflare", 302);
	}
	await deleteLinkState(options.database, state);
	if (!code) return redirect(setupPage(request, "provider"), [], 302);
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
	}, fetchMs, outer);
	if (token.kind === "deadline" || outer?.aborted) return redirect(appRedirect(request, "deadline"), [], 302);
	const tokenBody = token.kind === "ok" && token.body && typeof token.body === "object" ? token.body as {
		access_token?: unknown;
		refresh_token?: unknown;
		scope?: unknown;
		expires_in?: unknown;
	} : null;
	const accessToken = typeof tokenBody?.access_token === "string" ? tokenBody.access_token : "";
	if (!accessToken) return redirect(appRedirect(request, "invalid_code"), [], 302);
	const profile = await readCloudflare(USER, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } }, fetchMs, outer);
	if (profile.kind === "deadline" || outer?.aborted) return redirect(appRedirect(request, "deadline"), [], 302);
	const profileBody = profile.kind === "ok" && profile.body && typeof profile.body === "object"
		? profile.body as { result?: Parameters<typeof mapCloudflareUser>[0] }
		: null;
	const user = mapCloudflareUser(profileBody?.result);
	if (!user) return redirect(appRedirect(request, "unable_to_get_user_info"), [], 302);
	if (outer?.aborted) return redirect(appRedirect(request, "deadline"), [], 302);
	const now = new Date().toISOString();
	let grantedScope = typeof tokenBody?.scope === "string" ? tokenBody.scope : null;
	if (grantedScope != null && !grantedScope.split(/[\s,]+/).includes("user-details.read")) {
		grantedScope = `${grantedScope} user-details.read`.trim();
	}
	const accountScope = setup ? (grantedScope ?? "") : "user-details.read";
	// account_provider_account_idx makes this insert lose when another callback already
	// claimed the same Cloudflare account for a different user. The same user can
	// consent again, and that updates the scope. The following read is the winner.
	await options.database.prepare(
		`INSERT INTO "account" (id, "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "password", "createdAt", "updatedAt")
		 VALUES (?, ?, 'cloudflare', ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, ?)
		 ON CONFLICT ("providerId", "accountId") DO UPDATE SET
		   "scope" = excluded."scope",
		   "updatedAt" = excluded."updatedAt"
		 WHERE "account"."userId" = excluded."userId"`,
	).bind(randomId(), user.id, userId, accountScope, now, now).run();
	const owner = await options.database.prepare(
		`SELECT "userId" FROM "account" WHERE "providerId" = 'cloudflare' AND "accountId" = ?`,
	).bind(user.id).first<{ userId: string }>();
	if (owner?.userId !== userId) return redirect(appRedirect(request, "account_already_linked_to_different_user"), [], 302);
	if (!setup) return redirect(appRedirect(request, undefined, "connected"), [], 302);
	await saveCloudflareGrant(options.database, options.secret, {
		userId,
		accountId: user.id,
		choice: setup.choice,
		host: setup.host,
		requestedScope: consentScope(setup.choice, setup.host),
		grantedScope,
		refreshToken: typeof tokenBody?.refresh_token === "string" ? tokenBody.refresh_token : null,
		expiresIn: tokenBody?.expires_in,
	});
	return redirect(appRedirect(request, undefined, "connected", "/app/cloudflare"), [], 302);
}
