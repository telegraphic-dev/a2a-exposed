// Pairing identity and address proofs. Web Crypto only, so this runs in Workers and in Node's test runner.
// The private key never appears in a return value of the HTTP handlers. Callers seal it before storage.

export const IDENTITY_URI = "https://a2a.exposed/ext/peer-identity/v1";
export const MOVED_URI = "https://a2a.exposed/ext/moved/v1";
export const MOVED_CODE = -32011;
export const DEFAULT_GRACE_HOURS = 168;
export const MAX_GRACE_HOURS = 720;
export const IDENTITY_SETTING = "peer_identity";
export const FORWARD_SETTING = "address_forward";
export const ANNOUNCE_SETTING = "announce_status";
/** Additional data for the sealed identity blob. Not a peer label. */
export const IDENTITY_AAD = "peer-identity";

const IDENTITY_TEXT = "a2a-exposed-peer-identity-v1";
const UPDATE_TEXT = "a2a-exposed-address-update-v1";

export function b64urlEncode(b: Uint8Array): string {
	let s = "";
	for (const byte of b) s += String.fromCharCode(byte);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array | null {
	if (typeof s !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(s)) return null;
	try {
		const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
		const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
		const out = new Uint8Array(raw.length);
		for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
		return out;
	} catch {
		return null;
	}
}

/** Canonical base64url of a raw 32-byte Ed25519 public key, or "". */
export function cleanPublicKey(v: unknown): string {
	if (typeof v !== "string") return "";
	const raw = b64urlDecode(v.trim());
	return raw && raw.length === 32 ? b64urlEncode(raw) : "";
}

/** A return token this inbox minted. Anything else is refused so a caller cannot store an arbitrary secret. */
export function cleanReverseToken(v: unknown): string {
	return typeof v === "string" && /^(?:a2aow_|s2a_)[A-Za-z0-9_-]{43}$/.test(v) ? v : "";
}

/** https agent-card URL, no query, no hash, no credentials. */
export function canonicalCardUrl(v: unknown): string {
	if (typeof v !== "string" || !v || v.length > 300) return "";
	try {
		const u = new URL(v);
		if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return "";
		if (u.pathname !== "/.well-known/agent-card.json") return "";
		return u.href;
	} catch {
		return "";
	}
}

/** Card URL for this deployment. Empty unless the public URL is https. */
export function cardUrlFor(publicUrl: string): string {
	try {
		const u = new URL(publicUrl);
		if (u.protocol !== "https:") return "";
		return new URL("/.well-known/agent-card.json", u.origin).href;
	} catch {
		return "";
	}
}

export function originOf(url: string): string {
	try { return new URL(url).origin; } catch { return ""; }
}

export function hostOf(url: string): string {
	try { return new URL(url).host; } catch { return ""; }
}

/** Grace length in hours. `undefined` is the default. Anything else outside 1–720 is refused (`null`). */
export function graceHours(v: unknown): number | null {
	if (v === undefined || v === null || v === "") return DEFAULT_GRACE_HOURS;
	const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,4}$/.test(v) ? Number(v) : NaN;
	if (!Number.isInteger(n) || n < 1 || n > MAX_GRACE_HOURS) return null;
	return n;
}

export function identityMessage(cardUrl: string, publicKey: string): Uint8Array {
	return new TextEncoder().encode(`${IDENTITY_TEXT}\n${cardUrl}\n${publicKey}`);
}

export function updateMessage(cardUrl: string, publicKey: string, reverseHash: string): Uint8Array {
	return new TextEncoder().encode(`${UPDATE_TEXT}\n${cardUrl}\n${publicKey}\n${reverseHash || "-"}`);
}

const ed25519 = { name: "Ed25519" };

export async function generateIdentity(): Promise<{ publicKey: string; privateKey: string }> {
	const kp = await crypto.subtle.generateKey(ed25519 as any, true, ["sign", "verify"]) as CryptoKeyPair;
	const pub = new Uint8Array(await (crypto.subtle.exportKey as any)("raw", kp.publicKey));
	const priv = new Uint8Array(await (crypto.subtle.exportKey as any)("pkcs8", kp.privateKey));
	return { publicKey: b64urlEncode(pub), privateKey: b64urlEncode(priv) };
}

async function importPrivate(pkcs8: string): Promise<CryptoKey | null> {
	const raw = b64urlDecode(pkcs8);
	if (!raw) return null;
	try {
		return await crypto.subtle.importKey("pkcs8", raw, ed25519 as any, false, ["sign"]);
	} catch {
		return null;
	}
}

async function importPublic(publicKey: string): Promise<CryptoKey | null> {
	const raw = b64urlDecode(publicKey);
	if (!raw || raw.length !== 32) return null;
	try {
		return await crypto.subtle.importKey("raw", raw, ed25519 as any, false, ["verify"]);
	} catch {
		return null;
	}
}

export async function signBytes(privateKey: string, message: Uint8Array): Promise<string | null> {
	const key = await importPrivate(privateKey);
	if (!key) return null;
	try {
		return b64urlEncode(new Uint8Array(await crypto.subtle.sign(ed25519 as any, key, message as BufferSource)));
	} catch {
		return null;
	}
}

export async function verifyBytes(publicKey: string, message: Uint8Array, signature: string): Promise<boolean> {
	const key = await importPublic(publicKey);
	const sig = b64urlDecode(signature);
	if (!key || !sig) return false;
	try {
		return await crypto.subtle.verify(ed25519 as any, key, sig as BufferSource, message as BufferSource);
	} catch {
		return false;
	}
}

/** True when this private key produces signatures this public key accepts. */
export async function identityMatches(privateKey: string, publicKey: string): Promise<boolean> {
	const clean = cleanPublicKey(publicKey);
	if (!clean) return false;
	const sig = await signBytes(privateKey, new TextEncoder().encode("a2a-exposed-identity-check-v1"));
	return !!sig && await verifyBytes(clean, new TextEncoder().encode("a2a-exposed-identity-check-v1"), sig);
}

export function identityExtension(publicKey: string, cardUrl: string, signature: string): JsonExt {
	return {
		uri: IDENTITY_URI,
		description: "Proves this card URL is served by this pairing identity",
		params: { publicKey, cardUrl, signature },
	};
}

export function movedExtension(cardUrl: string, until: string): JsonExt {
	return {
		uri: MOVED_URI,
		description: "This inbox answers with a moved pointer until the grace time, and forwards a direct reply when the new inbox accepts it",
		params: { cardUrl, until },
	};
}

type JsonExt = { uri: string; description: string; params: Record<string, string> };

export function extensionParams(card: unknown, uri: string): Record<string, unknown> | null {
	const caps = card && typeof card === "object" ? (card as { capabilities?: { extensions?: unknown } }).capabilities : null;
	const list = caps?.extensions;
	if (!Array.isArray(list)) return null;
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const ext = item as { uri?: unknown; params?: unknown };
		if (ext.uri === uri && ext.params && typeof ext.params === "object" && !Array.isArray(ext.params))
			return ext.params as Record<string, unknown>;
	}
	return null;
}

export function movedFromCard(card: unknown, now = Date.now()): { cardUrl: string; until: string } | null {
	const params = extensionParams(card, MOVED_URI);
	if (!params) return null;
	const cardUrl = canonicalCardUrl(params.cardUrl);
	const until = typeof params.until === "string" ? params.until : "";
	const untilMs = Date.parse(until);
	if (!cardUrl || !Number.isFinite(untilMs) || untilMs <= now) return null;
	return { cardUrl, until };
}

/** The card's identity proof, when the public key and signature match this card URL. */
export async function cardProves(card: unknown, publicKey: string, cardUrl: string): Promise<boolean> {
	const want = cleanPublicKey(publicKey);
	const url = canonicalCardUrl(cardUrl);
	if (!want || !url) return false;
	const params = extensionParams(card, IDENTITY_URI);
	if (!params) return false;
	if (cleanPublicKey(params.publicKey) !== want) return false;
	if (canonicalCardUrl(params.cardUrl) !== url) return false;
	if (typeof params.signature !== "string") return false;
	return verifyBytes(want, identityMessage(url, want), params.signature);
}

export type AnnounceStatus = "updated" | "unsupported" | "rejected" | "failed";

/** What an address announcement got back. Method-not-found keeps the current pairing. */
export function announceOutcome(status: number, body: unknown): { status: AnnounceStatus; detail: string } {
	const obj = body && typeof body === "object" ? body as { result?: { ok?: unknown }; error?: { code?: unknown; message?: unknown } } : null;
	if (status === 200 && obj?.result?.ok === true) return { status: "updated", detail: "Peer stored the address." };
	const code = obj?.error?.code;
	if (code === -32601) return { status: "unsupported", detail: "This peer does not accept address announcements. The current pairing is unchanged." };
	if (status === 401 || status === 403 || code === -32000) return { status: "rejected", detail: "The pairing token was rejected." };
	const message = typeof obj?.error?.message === "string" ? obj.error.message.slice(0, 200) : "";
	return { status: "failed", detail: message || `HTTP ${status}` };
}
