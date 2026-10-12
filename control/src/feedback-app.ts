// GitHub App auth for feedback issues. The app id and private key turn the path on.
// FEEDBACK_GITHUB_TOKEN stays the fallback when the app id or the private key is unset.
// A set id with a key that is not a PEM does not use that token.
// None of these names use the GITHUB_* prefix: that prefix is the sign-in OAuth app.
import type { ControlEnv } from "./env.ts";

export interface GithubCallDeps {
	fetch?: typeof fetch;
	now?: () => number;
	githubTimeoutMs?: number;
	githubCache?: GithubTokenCache;
}

/** One entry per app id, installation id, and private-key fingerprint. The key itself is not stored. */
const tokenCaches = new Map<string, GithubTokenCache>();

const APP_ID_RE = /^\d{1,20}$/;
const GITHUB_ACCEPT = "application/vnd.github+json";
const GITHUB_API = "2022-11-28";
const TOKEN_SKEW_MS = 60_000;
const FALLBACK_TTL_MS = 50 * 60 * 1000;
// AlgorithmIdentifier for rsaEncryption (1.2.840.113549.1.1.1) with NULL parameters.
const RSA_ALG = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);

export interface GithubTokenCache {
	installationId?: string;
	token?: string;
	expiresAt?: number;
}

export interface GithubAccess {
	token: string;
	secrets: string[];
}

/** A numeric app id and a PEM private key, PKCS#1 or PKCS#8. */
export function feedbackAppReady(env: ControlEnv): boolean {
	return Boolean(appId(env) && pemKind(normalizePem(env.FEEDBACK_GITHUB_APP_PRIVATE_KEY ?? "")));
}

/**
 * Both the app id and the private key are set, but they are not a numeric id plus a PEM.
 * That is a broken app, not an unset one: the personal access token must not file the issue.
 */
export function feedbackAppBroken(env: ControlEnv): boolean {
	const id = (env.FEEDBACK_GITHUB_APP_ID ?? "").trim();
	const key = (env.FEEDBACK_GITHUB_APP_PRIVATE_KEY ?? "").trim();
	if (!id || !key) return false;
	return !feedbackAppReady(env);
}

export function feedbackPat(env: ControlEnv): string {
	return (env.FEEDBACK_GITHUB_TOKEN ?? "").trim();
}

function appId(env: ControlEnv): string {
	const id = (env.FEEDBACK_GITHUB_APP_ID ?? "").trim();
	return APP_ID_RE.test(id) ? id : "";
}

/** Real newlines, or a one-line secret that stores them as the two characters \n. */
export function normalizePem(value: string): string {
	const pem = value.trim();
	return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}

function pemKind(pem: string): "pkcs1" | "pkcs8" | "" {
	if (/-----BEGIN RSA PRIVATE KEY-----/.test(pem) && /-----END RSA PRIVATE KEY-----/.test(pem)) return "pkcs1";
	if (/-----BEGIN PRIVATE KEY-----/.test(pem) && /-----END PRIVATE KEY-----/.test(pem)) return "pkcs8";
	return "";
}

function derLen(length: number): Uint8Array {
	if (length < 0x80) return Uint8Array.of(length);
	const bytes: number[] = [];
	let left = length;
	while (left > 0) {
		bytes.unshift(left & 0xff);
		left = Math.floor(left / 256);
	}
	return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function der(tag: number, content: Uint8Array): Uint8Array {
	const len = derLen(content.length);
	const out = new Uint8Array(1 + len.length + content.length);
	out[0] = tag;
	out.set(len, 1);
	out.set(content, 1 + len.length);
	return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

/**
 * A GitHub App auth failure. `code` is safe to log: `key_parse`, `jwt_rejected:<status>`,
 * `installation:<status>`, or `token:<status>`. It never contains the key, the JWT, or a token.
 * `status` is the HTTP status from GitHub, or 0 when GitHub was not called.
 */
export class GithubAuthError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, status = 0) {
		super(code);
		this.name = "GithubAuthError";
		this.code = code;
		this.status = status;
	}
}

function authError(code: string, status = 0): GithubAuthError {
	return new GithubAuthError(code, status);
}

/** 401 means GitHub rejected the app JWT. Any other status belongs to the call that failed. */
function httpAuthFailure(step: "installation" | "token", status: number): GithubAuthError {
	const http = Number.isInteger(status) && status >= 0 && status <= 999 ? status : 0;
	if (http === 401) return authError(`jwt_rejected:${http}`, http);
	return authError(`${step}:${http}`, http);
}

/** GitHub's downloaded key is PKCS#1. WebCrypto imports PKCS#8. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
	const version = Uint8Array.of(0x02, 0x01, 0x00);
	const privateKey = der(0x04, pkcs1);
	return der(0x30, concat([version, RSA_ALG, privateKey]));
}

/**
 * Base64 between the PEM banners only. Text outside those lines is ignored, including an HCL
 * heredoc marker (`<<-EOT` / `EOT`). Whitespace, CRLF, and a literal `\n` inside the body are ignored.
 */
function pemBytes(pem: string): Uint8Array {
	const text = pem.replace(/\\n/g, "\n");
	const match = text.match(/-----BEGIN [^-]*KEY-----([\s\S]*?)-----END [^-]*KEY-----/);
	const body = (match?.[1] ?? "").replace(/\s+/g, "");
	if (!body) throw authError("key_parse");
	let binary: string;
	try {
		binary = atob(body);
	} catch {
		throw authError("key_parse");
	}
	if (!binary) throw authError("key_parse");
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function b64url(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function appJwt(env: ControlEnv, nowMs: number): Promise<string> {
	const id = appId(env);
	const pem = normalizePem(env.FEEDBACK_GITHUB_APP_PRIVATE_KEY ?? "");
	const kind = pemKind(pem);
	if (!id || !kind) throw authError("key_parse");
	try {
		const raw = pemBytes(pem);
		const pkcs8 = kind === "pkcs1" ? pkcs1ToPkcs8(raw) : raw;
		const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
		const iat = Math.floor(nowMs / 1000) - 60;
		const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
		const payload = b64url(new TextEncoder().encode(JSON.stringify({ iat, exp: iat + 600, iss: id })));
		const signing = new TextEncoder().encode(`${header}.${payload}`);
		const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, signing));
		return `${header}.${payload}.${b64url(signature)}`;
	} catch (error) {
		if (error instanceof GithubAuthError) throw error;
		throw authError("key_parse");
	}
}

function githubHeaders(bearer: string): Record<string, string> {
	return {
		authorization: `Bearer ${bearer}`,
		accept: GITHUB_ACCEPT,
		"user-agent": "a2a-exposed",
		"x-github-api-version": GITHUB_API,
	};
}

async function githubJson(call: typeof fetch, url: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> {
	const response = await call(url, init);
	let body: Record<string, unknown> | null = null;
	try {
		const parsed = await response.json();
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
	} catch {
		body = null;
	}
	return { ok: response.ok, status: response.status, body };
}

function installationIdOf(env: ControlEnv): string {
	const id = (env.FEEDBACK_GITHUB_APP_INSTALLATION_ID ?? "").trim();
	if (!id) return "";
	// Not an HTTP failure: GitHub is not called, so the status in the code is 0.
	if (!APP_ID_RE.test(id)) throw authError("installation:0", 0);
	return id;
}

function cacheFresh(cache: GithubTokenCache, now: number): boolean {
	return Boolean(cache.token && cache.expiresAt !== undefined && cache.expiresAt - TOKEN_SKEW_MS > now);
}

async function cacheFor(env: ControlEnv, deps: GithubCallDeps): Promise<GithubTokenCache> {
	if (deps.githubCache) return deps.githubCache;
	const pem = normalizePem(env.FEEDBACK_GITHUB_APP_PRIVATE_KEY ?? "");
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pem));
	const fingerprint = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	const id = `${appId(env)}\0${(env.FEEDBACK_GITHUB_APP_INSTALLATION_ID ?? "").trim()}\0${fingerprint}`;
	let cache = tokenCaches.get(id);
	if (!cache) {
		cache = {};
		tokenCaches.set(id, cache);
	}
	return cache;
}

function secretsFor(token: string, pat: string, jwt: string): string[] {
	return [token, pat, jwt].filter((value) => value.length >= 8);
}

/**
 * Installation token when the app is configured, otherwise the personal access token.
 * The installation token is cached until a minute before it expires. Failures throw GithubAuthError.
 */
export async function githubAccessToken(env: ControlEnv, repo: string, deps: GithubCallDeps): Promise<GithubAccess> {
	const pat = feedbackPat(env);
	if (feedbackAppBroken(env)) throw authError("key_parse");
	if (!feedbackAppReady(env)) {
		if (!pat) throw new Error("github app auth failed");
		return { token: pat, secrets: secretsFor(pat, "", "") };
	}
	const cache = await cacheFor(env, deps);
	const now = (deps.now ?? Date.now)();
	if (cacheFresh(cache, now) && cache.token) return { token: cache.token, secrets: secretsFor(cache.token, pat, "") };
	const timeout = deps.githubTimeoutMs ?? 5000;
	const call = deps.fetch ?? fetch;
	const pinned = installationIdOf(env);
	const jwt = await appJwt(env, now);
	const headers = githubHeaders(jwt);
	let installationId = pinned || cache.installationId || "";
	if (!installationId) {
		const found = await githubJson(call, `https://api.github.com/repos/${repo}/installation`, {
			method: "GET", redirect: "error", signal: AbortSignal.timeout(timeout), headers,
		});
		const id = found.body?.id;
		const text = typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? String(id) : "";
		if (!found.ok || !APP_ID_RE.test(text)) throw httpAuthFailure("installation", found.status);
		installationId = text;
		cache.installationId = text;
	}
	const minted = await githubJson(call, `https://api.github.com/app/installations/${installationId}/access_tokens`, {
		method: "POST", redirect: "error", signal: AbortSignal.timeout(timeout), headers,
	});
	const token = typeof minted.body?.token === "string" ? minted.body.token : "";
	if (!minted.ok || token.length < 8) throw httpAuthFailure("token", minted.status);
	let expiresAt = now + FALLBACK_TTL_MS;
	if (typeof minted.body?.expires_at === "string") {
		const parsed = Date.parse(minted.body.expires_at);
		if (Number.isFinite(parsed)) expiresAt = parsed;
	}
	cache.token = token;
	cache.expiresAt = expiresAt;
	return { token, secrets: secretsFor(token, pat, jwt) };
}
