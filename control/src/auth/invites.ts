export interface SqlStatement {
	bind(...values: unknown[]): SqlStatement;
	first<T>(): Promise<T | null>;
	run(): Promise<{ meta?: { changes?: number } }>;
}

export interface Sql {
	prepare(query: string): SqlStatement;
}

const CODE = /^invite_[0-9a-f]{32}$/;

export function newInviteCode(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `invite_${hex}`;
}

export function validInviteCode(code: string): boolean {
	return CODE.test(code);
}

export async function hasAccount(db: Sql, email: string): Promise<boolean> {
	const row = await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email.trim().toLowerCase()).first<{ id: string }>();
	return Boolean(row);
}

export async function insertInvite(db: Sql, input: { code?: string; email?: string; expiresAt?: string | null } = {}): Promise<string> {
	const code = input.code ?? newInviteCode();
	if (!validInviteCode(code)) throw new Error("invalid invite code");
	const email = input.email?.trim().toLowerCase() || null;
	await db.prepare("INSERT INTO invites (code, email, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(
		code,
		email,
		new Date().toISOString(),
		input.expiresAt ?? null,
	).run();
	return code;
}

/** A live code. When `email` is set, a code locked to another address does not pass. */
export async function invitePending(db: Sql, code: string, email?: string): Promise<boolean> {
	if (!validInviteCode(code)) return false;
	const row = await db.prepare(
		`SELECT email FROM invites
		 WHERE code = ? AND used_at IS NULL
		   AND (expires_at IS NULL OR expires_at > ?)`,
	).bind(code, new Date().toISOString()).first<{ email: string | null }>();
	if (!row) return false;
	if (email && row.email && row.email !== email.trim().toLowerCase()) return false;
	return true;
}

/** SHA-256 of a magic-link token, base64url without padding. The plaintext token is not stored. */
export async function tokenHash(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	const bytes = new Uint8Array(digest);
	let raw = "";
	for (const byte of bytes) raw += String.fromCharCode(byte);
	return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * Binds an invite to a magic-link token so the emailed link works in another browser.
 * The row lives in `verification` under `a2a-invite:<hash>` and is not the Better Auth record
 * (that record's schema rejects extra fields).
 */
export async function rememberMagicInvite(db: Sql, token: string, code: string, email: string, ttlSeconds: number): Promise<void> {
	if (!validInviteCode(code) || !token) return;
	const now = new Date();
	const hash = await tokenHash(token);
	await db.prepare(
		`INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
	).bind(
		crypto.randomUUID(),
		`a2a-invite:${hash}`,
		JSON.stringify({ code, email: email.trim().toLowerCase() }),
		new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
		now.toISOString(),
		now.toISOString(),
	).run();
}

/** Reads and deletes the invite bound to this magic-link token. Empty when missing, expired, or for another email. */
export async function takeMagicInvite(db: Sql, token: string, email: string): Promise<string> {
	if (!token) return "";
	const hash = await tokenHash(token);
	const identifier = `a2a-invite:${hash}`;
	const row = await db.prepare(`SELECT value, expiresAt FROM verification WHERE identifier = ?`).bind(identifier).first<{ value: string; expiresAt: string }>();
	await db.prepare(`DELETE FROM verification WHERE identifier = ?`).bind(identifier).run();
	if (!row?.value || !row.expiresAt || new Date(row.expiresAt).getTime() <= Date.now()) return "";
	try {
		const parsed = JSON.parse(row.value) as { code?: unknown; email?: unknown };
		if (parsed.email !== email.trim().toLowerCase() || typeof parsed.code !== "string") return "";
		return parsed.code;
	} catch {
		return "";
	}
}

/** Marks one unused code as used. A second caller gets false. */
export async function consumeInvite(db: Sql, code: string, email: string): Promise<boolean> {
	if (!validInviteCode(code)) return false;
	const result = await db.prepare(
		`UPDATE invites SET used_at = ?, used_email = ?
		 WHERE code = ? AND used_at IS NULL
		   AND (expires_at IS NULL OR expires_at > ?)
		   AND (email IS NULL OR email = ?)`,
	).bind(new Date().toISOString(), email.trim().toLowerCase(), code, new Date().toISOString(), email.trim().toLowerCase()).run();
	return (result.meta?.changes ?? 0) > 0;
}
