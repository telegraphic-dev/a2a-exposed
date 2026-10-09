// Optional OpenID Connect approval for /device and /oauth/authorize.
// Active only when the issuer (https), client id, client secret and at least one allowed subject are all set,
// and the method list includes oidc (or APPROVAL_METHODS was left unset). Password stays the default.
// The client secret is read from TenantContext and is never logged or placed on the gate object.
import * as A from "./a2a.ts";
import type { ApprovalOidcGate, TenantContext } from "./tenancy.ts";

export const TXN_TTL_MS = 10 * 60 * 1000;
const ID_TOKEN_MAX = 8192;
const SKEW_S = 60;
const FETCH_MS = 5000;

export type OidcKind = "device" | "mcp";

export interface ApprovalPolicy {
	oidc: boolean;
	password: boolean;
	/** Button label: configured label, otherwise the issuer host. */
	label: string;
}

export function issuerHost(issuer: string): string {
	try { return new URL(issuer).host; } catch { return ""; }
}

export function issuerBase(issuer: string): string {
	return issuer.replace(/\/+$/, "");
}

/**
 * What the approval pages offer.
 * OIDC is on when it is fully configured and methods include oidc, or when methods were not specified.
 * Password stays on unless methods were specified as oidc only AND the OIDC config is complete
 * (an incomplete `APPROVAL_METHODS=oidc` must not lock the operator out).
 * `APPROVAL_METHODS=password` keeps the password and does not turn OIDC on.
 */
export function approvalPolicy(gate: ApprovalOidcGate): ApprovalPolicy {
	const configured = !!(gate.issuer && gate.clientId && gate.hasClientSecret && gate.allowedSubjects.length);
	const oidc = configured && (gate.methods.includes("oidc") || !gate.methodsSpecified);
	const oidcOnly = gate.methodsSpecified && gate.methods.includes("oidc") && !gate.methods.includes("password");
	return { oidc, password: !(oidcOnly && configured), label: gate.label || issuerHost(gate.issuer) };
}

export type StartResult = { ok: true; location: string } | { ok: false; error: string; reason: string };
export type FinishResult =
	| { ok: true; userCode: string | null; payload: Record<string, unknown>; subject: string }
	| { ok: false; error: string; reason: string; userCode: string | null };

const FAIL = "Sign-in could not be verified. Nothing was approved.";
const UNREACHABLE = "The identity provider could not be reached. Nothing was approved.";

function b64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(s) || s.length > ID_TOKEN_MAX) throw new Error("b64");
	const pad = "=".repeat((4 - (s.length % 4)) % 4);
	const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
	const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

function httpsEndpoint(v: unknown): string {
	if (typeof v !== "string" || !v) throw new Error("endpoint");
	const u = new URL(v);
	if (u.protocol !== "https:" || u.username || u.password) throw new Error("endpoint");
	return u.toString();
}

async function readJson(res: Response, max: number): Promise<any> {
	const len = Number(res.headers.get("content-length") || 0);
	if (len > max) throw new Error("large");
	const text = await res.text();
	if (text.length > max) throw new Error("large");
	return JSON.parse(text);
}

async function getJson(url: string): Promise<any> {
	const res = await fetch(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(FETCH_MS) });
	if (!res.ok) throw new Error("http");
	return readJson(res, 65536);
}

interface Discovery {
	authorization_endpoint: string;
	token_endpoint: string;
	jwks_uri: string;
}

async function discover(issuer: string): Promise<Discovery> {
	const doc = await getJson(`${issuerBase(issuer)}/.well-known/openid-configuration`);
	if (issuerBase(String(doc?.issuer || "")) !== issuerBase(issuer)) throw new Error("issuer");
	return {
		authorization_endpoint: httpsEndpoint(doc.authorization_endpoint),
		token_endpoint: httpsEndpoint(doc.token_endpoint),
		jwks_uri: httpsEndpoint(doc.jwks_uri),
	};
}

/** Begin a sign-in. `userCode` is stored with the state and is not put on the identity provider's URL. */
export async function startOidc(ctx: TenantContext, o: {
	kind: OidcKind; redirectUri: string; csrf: string; userCode: string | null; payload: Record<string, unknown>;
}): Promise<StartResult> {
	const gate = ctx.gates.approvalOidc;
	if (!approvalPolicy(gate).oidc || !ctx.approvalClientSecret()) return { ok: false, error: "OpenID Connect approval is not configured.", reason: "config" };
	let disc: Discovery;
	try { disc = await discover(gate.issuer); }
	catch { return { ok: false, error: UNREACHABLE, reason: "discovery" }; }
	const { verifier, challenge } = await pkce();
	const state = b64url(crypto.getRandomValues(new Uint8Array(32)));
	const nonce = b64url(crypto.getRandomValues(new Uint8Array(32)));
	const payload = JSON.stringify(o.payload);
	if (payload.length > 16384) return { ok: false, error: "This approval could not be started.", reason: "payload" };
	const now = Date.now();
	await ctx.DB.prepare("DELETE FROM oidc_txns WHERE expires_ms < ?").bind(now).run();
	await ctx.DB.prepare("INSERT INTO oidc_txns (state, nonce, verifier, kind, csrf, user_code, payload_json, expires_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
		.bind(state, nonce, verifier, o.kind, o.csrf, o.userCode, payload, now + TXN_TTL_MS).run();
	const u = new URL(disc.authorization_endpoint);
	u.searchParams.set("response_type", "code");
	u.searchParams.set("client_id", gate.clientId);
	u.searchParams.set("redirect_uri", o.redirectUri);
	// `email` is required for an email allowlist: providers omit `email` and `email_verified` unless this scope is requested.
	u.searchParams.set("scope", "openid email");
	u.searchParams.set("state", state);
	u.searchParams.set("nonce", nonce);
	u.searchParams.set("code_challenge", challenge);
	u.searchParams.set("code_challenge_method", "S256");
	return { ok: true, location: u.toString() };
}

function onAllowlist(value: unknown, subjects: string[]): boolean {
	if (typeof value !== "string") return false;
	for (const want of subjects) if (A.timingSafeEqualStr(value, want)) return true;
	return false;
}

/**
 * OIDC ID Token validation: `aud` must contain this client. When `aud` has more than one value, `azp` is required
 * and must be this client id. A present `azp` must match even when there is only one audience.
 */
function audienceOk(aud: unknown, azp: unknown, clientId: string): boolean {
	const raw = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
	if (!onAllowlist(clientId, raw.filter((a): a is string => typeof a === "string"))) return false;
	const multi = raw.length > 1;
	if (!multi && azp === undefined) return true;
	return typeof azp === "string" && A.timingSafeEqualStr(azp, clientId);
}

/**
 * Prefer `sub`. An `email` match is a separate path and is ignored unless `email_verified` is boolean true,
 * so an unverified address cannot approve.
 */
function subjectAllowed(claims: { sub?: unknown; email?: unknown; email_verified?: unknown }, subjects: string[]): boolean {
	if (onAllowlist(claims.sub, subjects)) return true;
	if (claims.email_verified !== true) return false;
	return onAllowlist(claims.email, subjects);
}

async function verifyIdToken(token: string, jwks: { keys?: any[] }, expect: { iss: string; aud: string; nonce: string; subjects: string[] }): Promise<{ subject: string } | { reason: string }> {
	if (typeof token !== "string" || token.length < 20 || token.length > ID_TOKEN_MAX) return { reason: "token" };
	const parts = token.split(".");
	if (parts.length !== 3) return { reason: "token" };
	let header: any;
	try { header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0]))); }
	catch { return { reason: "token" }; }
	// RS256 only. `none` and HMAC (which would use the client secret as a MAC key) are rejected before verification.
	if (header.alg !== "RS256") return { reason: "alg" };
	const keys: any[] = Array.isArray(jwks.keys) ? jwks.keys : [];
	const jwk = header.kid ? keys.find((k) => k && k.kid === header.kid) : keys.length === 1 ? keys[0] : null;
	if (!jwk || jwk.kty !== "RSA" || !jwk.n || !jwk.e || (jwk.alg && jwk.alg !== "RS256")) return { reason: "key" };
	let key: CryptoKey;
	try {
		key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
	} catch { return { reason: "key" }; }
	let sig: Uint8Array;
	try { sig = b64urlDecode(parts[2]); } catch { return { reason: "sig" }; }
	const ok = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
	if (!ok) return { reason: "sig" };
	let claims: any;
	try { claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))); }
	catch { return { reason: "token" }; }
	if (issuerBase(String(claims.iss || "")) !== issuerBase(expect.iss)) return { reason: "iss" };
	if (!audienceOk(claims.aud, claims.azp, expect.aud)) return { reason: "aud" };
	if (typeof claims.nonce !== "string" || !A.timingSafeEqualStr(claims.nonce, expect.nonce)) return { reason: "nonce" };
	const nowS = Date.now() / 1000;
	if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp + SKEW_S < nowS) return { reason: "exp" };
	if (typeof claims.nbf === "number" && claims.nbf - SKEW_S > nowS) return { reason: "nbf" };
	if (!subjectAllowed(claims, expect.subjects)) return { reason: "sub" };
	return { subject: typeof claims.sub === "string" ? claims.sub : String(claims.email) };
}

/**
 * Complete a sign-in. The state row is deleted on every callback, including failure, so it cannot be replayed.
 * The CSRF cookie is not read here: SameSite=Strict is dropped on the cross-site return from the identity
 * provider. The start POST already checked that cookie and stored it with this state.
 */
export async function finishOidc(ctx: TenantContext, o: {
	kind: OidcKind; redirectUri: string; state: string; code: string | null; error: string | null;
}): Promise<FinishResult> {
	const state = o.state || "";
	if (!/^[A-Za-z0-9_-]{20,128}$/.test(state)) return { ok: false, error: "This sign-in expired or was already used. Nothing was approved.", reason: "state", userCode: null };
	const row: any = await ctx.DB.prepare("DELETE FROM oidc_txns WHERE state = ? RETURNING *").bind(state).first();
	if (!row || row.kind !== o.kind) return { ok: false, error: "This sign-in expired or was already used. Nothing was approved.", reason: "state", userCode: null };
	const userCode = row.user_code || null;
	if (Date.now() >= row.expires_ms) return { ok: false, error: "This sign-in expired. Nothing was approved.", reason: "expired", userCode };
	if (o.error || !o.code) return { ok: false, error: "Sign-in was cancelled. Nothing was approved.", reason: "cancelled", userCode };
	const gate = ctx.gates.approvalOidc;
	const secret = ctx.approvalClientSecret();
	if (!approvalPolicy(gate).oidc || !secret) return { ok: false, error: "OpenID Connect approval is not configured.", reason: "config", userCode };
	let disc: Discovery;
	try { disc = await discover(gate.issuer); }
	catch { return { ok: false, error: UNREACHABLE, reason: "discovery", userCode }; }
	let idToken = "";
	try {
		const body = new URLSearchParams({
			grant_type: "authorization_code", code: o.code, redirect_uri: o.redirectUri,
			client_id: gate.clientId, client_secret: secret, code_verifier: row.verifier,
		});
		const res = await fetch(disc.token_endpoint, {
			method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
			body, redirect: "error", signal: AbortSignal.timeout(FETCH_MS),
		});
		if (!res.ok) return { ok: false, error: UNREACHABLE, reason: "token", userCode };
		const tok = await readJson(res, 65536);
		idToken = typeof tok.id_token === "string" ? tok.id_token : "";
	} catch { return { ok: false, error: UNREACHABLE, reason: "token", userCode }; }
	let jwks: { keys?: any[] };
	try { jwks = await getJson(disc.jwks_uri); }
	catch { return { ok: false, error: UNREACHABLE, reason: "jwks", userCode }; }
	const verified = await verifyIdToken(idToken, jwks, { iss: gate.issuer, aud: gate.clientId, nonce: row.nonce, subjects: gate.allowedSubjects });
	if ("reason" in verified) return { ok: false, error: FAIL, reason: verified.reason, userCode };
	let payload: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(row.payload_json || "{}");
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed;
	} catch { /* empty payload */ }
	return { ok: true, userCode, payload, subject: verified.subject };
}
