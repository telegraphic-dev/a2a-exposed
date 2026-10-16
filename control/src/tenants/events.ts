// Pairing events the inbox posts to a dashboard. The Worker signs the same bytes
// this module checks. Keep the construction in step with worker/src/pairing-events.ts.

/** How far `x-a2a-timestamp` may sit from the check, in seconds. */
export const EVENT_REPLAY_WINDOW_S = 300;

const URL_MAX = 2000;
const SECRET_MAX = 512;

/** https URL with no userinfo, at most 2000 characters. Any other value returns "". */
export function httpsEventUrl(value: string | undefined): string {
	const raw = (value || "").trim();
	if (!raw || raw.length > URL_MAX) return "";
	try {
		const url = new URL(raw);
		if (url.protocol !== "https:" || url.username || url.password) return "";
		return raw;
	} catch {
		return "";
	}
}

/** Shared secret for the HMAC. Empty when missing, too long, or it contains a control character. */
export function eventSecretText(value: string | undefined): string {
	const text = (value || "").trim();
	if (!text || text.length > SECRET_MAX || /[\u0000-\u001f]/.test(text)) return "";
	return text;
}

/**
 * Tenant config fields for pairing events. Null unless the URL is https and the secret has a value,
 * so a partial pair is left out of the push.
 */
export function pairingEventConfig(eventUrl: string, eventSecret: string): { EVENT_URL: string; EVENT_SECRET: string } | null {
	const url = httpsEventUrl(eventUrl);
	const secret = eventSecretText(eventSecret);
	if (!url || !secret) return null;
	return { EVENT_URL: url, EVENT_SECRET: secret };
}

function headerValue(headers: Headers | Record<string, string | null | undefined>, name: string): string {
	if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) || "";
	const record = headers as Record<string, string | null | undefined>;
	const direct = record[name];
	if (typeof direct === "string") return direct;
	const found = Object.keys(record).find((key) => key.toLowerCase() === name.toLowerCase());
	const value = found ? record[found] : "";
	return typeof value === "string" ? value : "";
}

async function hmacHex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
	const left = new TextEncoder().encode(a);
	const right = new TextEncoder().encode(b);
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
	return diff === 0;
}

/**
 * True when `x-a2a-signature` is the HMAC-SHA256 of the timestamp, a period, and the raw body,
 * and `x-a2a-timestamp` is within 5 minutes of `now`. The header value is `sha256=<hex>`.
 */
export async function verifyEventSignature(
	body: string,
	headers: Headers | Record<string, string | null | undefined>,
	secret: string,
	now = Date.now(),
): Promise<boolean> {
	const key = eventSecretText(secret);
	const timestamp = headerValue(headers, "x-a2a-timestamp").trim();
	const presented = headerValue(headers, "x-a2a-signature").trim();
	if (!key || !/^\d{1,12}$/.test(timestamp) || !presented.startsWith("sha256=")) return false;
	const skew = Math.abs(Math.floor(now / 1000) - Number(timestamp));
	if (skew > EVENT_REPLAY_WINDOW_S) return false;
	const expected = `sha256=${await hmacHex(key, `${timestamp}.${body}`)}`;
	return timingSafeEqual(expected, presented);
}
