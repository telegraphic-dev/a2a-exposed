// The setup consent stores the latest Cloudflare refresh token encrypted.
// Cloudflare treats that token as single-use: refreshing again with the old
// token gets 401 from the token endpoint. The stored value is the refresh token.

import type { Sql } from "../core/sql.ts";

const TOKEN = "https://dash.cloudflare.com/oauth2/token";
const INFO = "cloudflare-refresh v1";
const SALT = "a2a-exposed";
const MAX_REFRESH = 4096;
const LOCK_MS = 15_000;

export interface CloudflareGrantRow {
	userId: string;
	/** Cloudflare user id from GET /user. The account chosen on the consent screen is not in the token response. */
	accountId: string;
	choice: string;
	host: string;
	requested_scope: string;
	granted_scope: string | null;
	refresh_enc: string | null;
	access_expires_at: string | null;
}

export type RefreshResult =
	| { ok: true; accessToken: string; scope: string }
	| { ok: false; error: "no_grant" | "no_refresh" | "busy" | "invalid_grant" | "uncertain" | "failed" | "unreadable" };

function b64(bytes: Uint8Array): string {
	let raw = "";
	for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(raw);
}

function unb64(value: string): Uint8Array {
	return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function derive(secret: string, userId: string): Promise<CryptoKey | null> {
	if (secret.length < 32 || !userId) return null;
	const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode(SALT), info: new TextEncoder().encode(`${INFO}\0${userId}`) },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

/** `v1.<iv>.<ciphertext>`, or null when the secret or the token cannot be sealed. */
export async function sealCloudflareRefresh(secret: string, userId: string, token: string): Promise<string | null> {
	if (!token || token.length > MAX_REFRESH) return null;
	const key = await derive(secret, userId);
	if (!key) return null;
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(userId) },
		key,
		new TextEncoder().encode(token),
	));
	return `v1.${b64(iv)}.${b64(ct)}`;
}

export async function openCloudflareRefresh(secret: string, userId: string, sealed: string | null | undefined): Promise<string | null> {
	if (!sealed) return null;
	const key = await derive(secret, userId);
	if (!key) return null;
	const [version, iv, ct, extra] = sealed.split(".");
	if (version !== "v1" || !iv || !ct || extra !== undefined) return null;
	try {
		const plain = new TextDecoder().decode(await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: unb64(iv), additionalData: new TextEncoder().encode(userId) },
			key,
			unb64(ct),
		));
		if (!plain || plain.length > MAX_REFRESH) return null;
		return plain;
	} catch {
		return null;
	}
}

function expiresAt(expiresIn: unknown, now: number): string | null {
	const seconds = typeof expiresIn === "number" ? expiresIn : typeof expiresIn === "string" ? Number(expiresIn) : NaN;
	if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 365 * 24 * 60 * 60) return null;
	return new Date(now + seconds * 1000).toISOString();
}

export async function saveCloudflareGrant(db: Sql, secret: string, input: {
	userId: string;
	accountId: string;
	choice: string;
	host: string;
	requestedScope: string;
	/** Token `scope` string, or null when Cloudflare omitted it. */
	grantedScope: string | null;
	refreshToken: string | null;
	expiresIn: unknown;
	now?: number;
}): Promise<void> {
	const now = input.now ?? Date.now();
	const stamp = new Date(now).toISOString();
	const refresh = input.refreshToken ? await sealCloudflareRefresh(secret, input.userId, input.refreshToken) : null;
	await db.prepare(
		`INSERT INTO cloudflare_grant ("userId", "accountId", choice, host, requested_scope, granted_scope, refresh_enc, access_expires_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT ("userId") DO UPDATE SET
		   "accountId" = excluded."accountId",
		   choice = excluded.choice,
		   host = excluded.host,
		   requested_scope = excluded.requested_scope,
		   granted_scope = excluded.granted_scope,
		   refresh_enc = excluded.refresh_enc,
		   access_expires_at = excluded.access_expires_at,
		   updated_at = excluded.updated_at`,
	).bind(
		input.userId,
		input.accountId,
		input.choice,
		input.host,
		input.requestedScope,
		input.grantedScope,
		refresh,
		expiresAt(input.expiresIn, now),
		stamp,
		stamp,
	).run();
}

export async function readCloudflareGrant(db: Sql, userId: string): Promise<CloudflareGrantRow | null> {
	if (!userId) return null;
	return db.prepare(
		`SELECT "userId" AS userId, "accountId" AS accountId, choice, host, requested_scope, granted_scope, refresh_enc, access_expires_at
		 FROM cloudflare_grant WHERE "userId" = ?`,
	).bind(userId).first<CloudflareGrantRow>();
}

export async function deleteCloudflareGrant(db: Sql, userId: string): Promise<void> {
	if (!userId) return;
	await db.prepare(`DELETE FROM cloudflare_grant WHERE "userId" = ?`).bind(userId).run();
}

function randomId(): string {
	const buf = new Uint8Array(16);
	crypto.getRandomValues(buf);
	return [...buf].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function claimLock(db: Sql, userId: string, holder: string, now: number): Promise<boolean> {
	const result = await db.prepare(
		`INSERT INTO control_locks (name, holder, expires_ms) VALUES (?, ?, ?)
		 ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_ms = excluded.expires_ms
		 WHERE control_locks.expires_ms <= ?`,
	).bind(`cf-refresh:${userId}`, holder, now + LOCK_MS, now).run();
	return result.meta?.changes === 1;
}

async function releaseLock(db: Sql, userId: string, holder: string): Promise<void> {
	await db.prepare(
		`UPDATE control_locks SET holder = '', expires_ms = 0 WHERE name = ? AND holder = ?`,
	).bind(`cf-refresh:${userId}`, holder).run();
}

async function clearRefresh(db: Sql, userId: string, now: number): Promise<void> {
	await db.prepare(
		`UPDATE cloudflare_grant SET refresh_enc = NULL, updated_at = ? WHERE "userId" = ?`,
	).bind(new Date(now).toISOString(), userId).run();
}

type TokenRead =
	| { kind: "ok"; body: unknown }
	| { kind: "rejected"; status: number }
	| { kind: "deadline" }
	| { kind: "failed" };

async function postRefresh(body: URLSearchParams, fetchMs: number, fetchImpl: typeof fetch): Promise<TokenRead> {
	const timeout = AbortSignal.timeout(fetchMs);
	let rejectDeadline: (error: unknown) => void = () => {};
	const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
	const timer = setTimeout(() => rejectDeadline(new DOMException("The operation was aborted", "TimeoutError")), fetchMs);
	try {
		const request = fetchImpl(TOKEN, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
			body,
			signal: timeout,
		}).then(
			(response) => ({ response, failed: false as const }),
			() => ({ response: null, failed: true as const }),
		);
		let winner: { response: Response | null; failed: boolean };
		try {
			winner = await Promise.race([request, deadline]);
		} catch {
			return { kind: "deadline" };
		}
		if (winner.failed || !winner.response) return timeout.aborted ? { kind: "deadline" } : { kind: "failed" };
		if (!winner.response.ok) {
			const status = winner.response.status;
			void winner.response.body?.cancel().catch(() => {});
			return status === 400 || status === 401 ? { kind: "rejected", status } : { kind: "failed" };
		}
		try {
			const parsed = await Promise.race([
				winner.response.json().then((body) => ({ body, failed: false as const }), () => ({ body: undefined, failed: true as const })),
				deadline,
			]);
			if (parsed.failed) return timeout.aborted ? { kind: "deadline" } : { kind: "failed" };
			return { kind: "ok", body: parsed.body };
		} catch {
			return { kind: "deadline" };
		}
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Exchanges the stored refresh token and replaces it with the new one.
 * A 400 or 401 drops the stored token: a single-use token is already dead.
 * A timeout or a network error keeps it and returns `uncertain` or `failed`.
 * Do not call this twice in parallel for the same user; the second waits on
 * the lock and then sees the new token, or gets `busy` if the lock is still held.
 */
export async function refreshCloudflareGrant(input: {
	database: Sql;
	secret: string;
	clientId: string;
	clientSecret: string;
	userId: string;
	fetchMs?: number;
	now?: number;
	fetchImpl?: typeof fetch;
}): Promise<RefreshResult> {
	const now = input.now ?? Date.now();
	const row = await readCloudflareGrant(input.database, input.userId);
	if (!row) return { ok: false, error: "no_grant" };
	if (!row.refresh_enc) return { ok: false, error: "no_refresh" };
	const holder = randomId();
	const claimed = await claimLock(input.database, input.userId, holder, now);
	if (!claimed) return { ok: false, error: "busy" };
	try {
		const current = await readCloudflareGrant(input.database, input.userId);
		const token = await openCloudflareRefresh(input.secret, input.userId, current?.refresh_enc);
		if (!token) return { ok: false, error: "no_refresh" };
		const read = await postRefresh(new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: token,
			client_id: input.clientId,
			client_secret: input.clientSecret,
		}), input.fetchMs ?? 5_000, input.fetchImpl ?? fetch);
		if (read.kind === "deadline") return { ok: false, error: "uncertain" };
		if (read.kind === "rejected") {
			await clearRefresh(input.database, input.userId, now);
			return { ok: false, error: "invalid_grant" };
		}
		if (read.kind === "failed") return { ok: false, error: "failed" };
		const body = read.body && typeof read.body === "object" ? read.body as {
			access_token?: unknown;
			refresh_token?: unknown;
			scope?: unknown;
			expires_in?: unknown;
		} : null;
		const accessToken = typeof body?.access_token === "string" ? body.access_token : "";
		if (!accessToken) return { ok: false, error: "failed" };
		const next = typeof body?.refresh_token === "string" ? body.refresh_token : "";
		const sealed = next ? await sealCloudflareRefresh(input.secret, input.userId, next) : null;
		if (next && !sealed) {
			await clearRefresh(input.database, input.userId, now);
			return { ok: false, error: "unreadable" };
		}
		const scope = typeof body?.scope === "string" ? body.scope : current?.requested_scope ?? "";
		await input.database.prepare(
			`UPDATE cloudflare_grant SET refresh_enc = ?, granted_scope = COALESCE(?, granted_scope), access_expires_at = ?, updated_at = ? WHERE "userId" = ?`,
		).bind(
			sealed,
			typeof body?.scope === "string" ? body.scope : null,
			expiresAt(body?.expires_in, now),
			new Date(now).toISOString(),
			input.userId,
		).run();
		return { ok: true, accessToken, scope };
	} finally {
		await releaseLock(input.database, input.userId, holder).catch(() => {});
	}
}
