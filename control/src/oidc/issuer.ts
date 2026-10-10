import type { Auth } from "../auth/create-auth.ts";
import { hostCookie, readCookie } from "../auth/cookies.ts";
import type { Sql } from "../auth/invites.ts";

export const OIDC_COOKIE = "__Host-a2a_oidc";
const CODE_TTL_MS = 10 * 60 * 1000;
const COOKIE_TTL_S = 10 * 60;

export interface OidcClient {
	id: string;
	secretHash: string;
	ownerAccountId: string;
	redirectUris: string[];
}

export interface ApprovalClient {
	clientId: string;
	secretHash: string;
	redirectUris: string[];
	clientSecret: string;
	approval: Record<string, unknown>;
}

function httpsOrigin(value: string | undefined): string {
	const raw = (value || "").trim();
	if (!raw) return "";
	try {
		const url = new URL(raw);
		if (url.protocol !== "https:" || url.username || url.password) return "";
		return url.origin;
	} catch {
		return "";
	}
}

/**
 * Issuer origin for this request. A configured `ISSUER` or `SITE_URL` wins when it is https.
 * A request to a different origin does not publish that issuer: the data plane checks the
 * document's issuer against the URL it fetched.
 */
export function issuerOrigin(env: { ISSUER?: string; SITE_URL?: string }, request: Request): string {
	const requestOrigin = httpsOrigin(new URL(request.url).origin);
	const configured = httpsOrigin(env.ISSUER) || httpsOrigin(env.SITE_URL);
	if (configured) return configured === requestOrigin ? configured : "";
	return requestOrigin;
}

export function discoveryDocument(issuer: string): Record<string, unknown> {
	return {
		issuer,
		authorization_endpoint: `${issuer}/api/oidc/authorize`,
		token_endpoint: `${issuer}/api/oidc/token`,
		jwks_uri: `${issuer}/api/auth/jwks`,
		response_types_supported: ["code"],
		subject_types_supported: ["public"],
		id_token_signing_alg_values_supported: ["RS256"],
		scopes_supported: ["openid", "email"],
		token_endpoint_auth_methods_supported: ["client_secret_post"],
		code_challenge_methods_supported: ["S256"],
	};
}

function bytes(size: number): Uint8Array {
	const out = new Uint8Array(size);
	crypto.getRandomValues(out);
	return out;
}

function b64url(data: Uint8Array): string {
	let raw = "";
	for (const byte of data) raw += String.fromCharCode(byte);
	return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
	return diff === 0;
}

function buttonLabel(value: string | undefined): string {
	const label = (value || "").trim();
	if (!label || label.length > 40 || /[\u0000-\u001f<>]/.test(label)) return "";
	return label;
}

function callbackUris(publicUrl: string | null): string[] {
	if (!publicUrl) return [];
	try {
		const url = new URL(publicUrl);
		if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return [];
	} catch {
		return [];
	}
	return [`${publicUrl}/device/oidc/callback`, `${publicUrl}/oauth/authorize/oidc/callback`];
}

/** Confidential client for one tenant. Null when there is no https issuer or public host. */
export async function newApprovalClient(input: {
	accountId: string;
	issuer: string;
	publicUrl: string | null;
	label?: string;
}): Promise<ApprovalClient | null> {
	const issuer = httpsOrigin(input.issuer);
	const redirectUris = callbackUris(input.publicUrl);
	if (!issuer || !redirectUris.length) return null;
	const clientId = `a2ac_${b64url(bytes(16))}`;
	const clientSecret = `a2acs_${b64url(bytes(32))}`;
	const label = buttonLabel(input.label);
	const approval: Record<string, unknown> = {
		issuer,
		clientId,
		clientSecret,
		allowedSubjects: [input.accountId],
		methods: ["oidc"],
	};
	if (label) approval.label = label;
	return { clientId, clientSecret, secretHash: await sha256(clientSecret), redirectUris, approval };
}

async function loadClient(db: Sql, id: string): Promise<OidcClient | null> {
	const row = await db.prepare(
		"SELECT id, secret_hash, owner_account_id, redirect_uris FROM oauth_client WHERE id = ?",
	).bind(id).first<{ id: string; secret_hash: string; owner_account_id: string; redirect_uris: string }>();
	if (!row) return null;
	let redirectUris: string[] = [];
	try {
		const parsed = JSON.parse(row.redirect_uris) as unknown;
		if (Array.isArray(parsed)) redirectUris = parsed.filter((item): item is string => typeof item === "string");
	} catch { /* stored by this package */ }
	return { id: row.id, secretHash: row.secret_hash, ownerAccountId: row.owner_account_id, redirectUris };
}

function param(url: URL, name: string): string {
	return url.searchParams.get(name) ?? "";
}

function tokenChars(value: string, min: number, max: number): boolean {
	return value.length >= min && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
}

function errorRedirect(redirectUri: string, error: string, state: string): string {
	const url = new URL(redirectUri);
	url.searchParams.set("error", error);
	if (state) url.searchParams.set("state", state);
	return url.href;
}

export interface AuthorizeResult {
	status: number;
	location?: string;
	cookie?: string;
	body?: Record<string, unknown>;
}

/** Authorization code + PKCE. A missing session is sent to sign in and brought back by the host cookie. */
export async function authorize(db: Sql, request: Request, user: { id: string } | null): Promise<AuthorizeResult> {
	const url = new URL(request.url);
	const clientId = param(url, "client_id");
	const redirectUri = param(url, "redirect_uri");
	const state = param(url, "state");
	const client = clientId ? await loadClient(db, clientId) : null;
	if (!client || !client.redirectUris.includes(redirectUri)) return { status: 400, body: { error: "invalid_request" } };
	const fail = (error: string): AuthorizeResult => ({ status: 302, location: errorRedirect(redirectUri, error, state) });
	if (param(url, "response_type") !== "code") return fail("unsupported_response_type");
	if (!param(url, "scope").split(" ").includes("openid")) return fail("invalid_scope");
	if (param(url, "code_challenge_method") !== "S256" || !tokenChars(param(url, "code_challenge"), 43, 128)) return fail("invalid_request");
	if (!tokenChars(param(url, "nonce"), 16, 256) || !tokenChars(state, 16, 256)) return fail("invalid_request");
	if (!user) {
		const query = url.search;
		if (query.length < 2 || query.length > 2048 || /[\u0000-\u001f]/.test(query)) return fail("invalid_request");
		return { status: 302, location: new URL("/app", request.url).href, cookie: hostCookie(OIDC_COOKIE, query, COOKIE_TTL_S) };
	}
	if (user.id !== client.ownerAccountId) return fail("access_denied");
	const code = b64url(bytes(32));
	const now = new Date();
	const expires = new Date(now.getTime() + CODE_TTL_MS).toISOString();
	await db.prepare("DELETE FROM oauth_code WHERE expires_at < ?").bind(now.toISOString()).run();
	await db.prepare(
		`INSERT INTO oauth_code (code_hash, client_id, user_id, redirect_uri, nonce, challenge, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).bind(await sha256(code), client.id, user.id, redirectUri, param(url, "nonce"), param(url, "code_challenge"), expires).run();
	const back = new URL(redirectUri);
	back.searchParams.set("code", code);
	back.searchParams.set("state", state);
	return { status: 302, location: back.href };
}

/** Where a finished sign-in should continue, or "" when the cookie is absent or not an authorize query. */
export function resumeQuery(cookieHeader: string | null): string {
	const query = readCookie(cookieHeader, OIDC_COOKIE);
	if (!query.startsWith("?") || query.length > 2048 || /[\u0000-\u001f]/.test(query)) return "";
	return query;
}

interface TokenRow {
	client_id: string;
	user_id: string;
	redirect_uri: string;
	nonce: string;
	challenge: string;
}

async function pkce(verifier: string, challenge: string): Promise<boolean> {
	if (!tokenChars(verifier, 43, 128)) return false;
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return safeEqual(b64url(new Uint8Array(digest)), challenge);
}

export async function exchangeCode(db: Sql, auth: Auth, issuer: string, form: URLSearchParams): Promise<{ status: number; body: Record<string, unknown> }> {
	const invalid = { status: 400, body: { error: "invalid_grant" } };
	if (form.get("grant_type") !== "authorization_code") return { status: 400, body: { error: "unsupported_grant_type" } };
	const client = await loadClient(db, form.get("client_id") ?? "");
	const presented = form.get("client_secret") ?? "";
	if (!client || !presented || !safeEqual(await sha256(presented), client.secretHash)) return { status: 401, body: { error: "invalid_client" } };
	const redirectUri = form.get("redirect_uri") ?? "";
	if (!client.redirectUris.includes(redirectUri)) return invalid;
	const code = form.get("code") ?? "";
	if (!tokenChars(code, 20, 128)) return invalid;
	const now = new Date().toISOString();
	const hash = await sha256(code);
	const updated = await db.prepare(
		"UPDATE oauth_code SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
	).bind(now, hash, now).run();
	if (!updated.meta?.changes) return invalid;
	const row = await db.prepare(
		"SELECT client_id, user_id, redirect_uri, nonce, challenge FROM oauth_code WHERE code_hash = ?",
	).bind(hash).first<TokenRow>();
	if (!row || row.client_id !== client.id || row.redirect_uri !== redirectUri) return invalid;
	if (!await pkce(form.get("code_verifier") ?? "", row.challenge)) return invalid;
	const user = await db.prepare(`SELECT id, email, "emailVerified" AS email_verified FROM "user" WHERE id = ?`).bind(row.user_id).first<{
		id: string; email: string; email_verified: number | boolean;
	}>();
	if (!user) return invalid;
	const nowS = Math.floor(Date.now() / 1000);
	const signed = await auth.api.signJWT({
		body: {
			payload: {
				iss: issuer,
				aud: client.id,
				sub: user.id,
				iat: nowS,
				exp: nowS + 10 * 60,
				nonce: row.nonce,
				email: user.email,
				email_verified: user.email_verified === true || user.email_verified === 1,
				azp: client.id,
			},
		},
	});
	return { status: 200, body: { access_token: signed.token, id_token: signed.token, token_type: "Bearer", expires_in: 600 } };
}
