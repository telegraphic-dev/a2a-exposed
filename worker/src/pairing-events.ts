// Dashboard notice for a pairing request. Posted only when EVENT_URL and EVENT_SECRET are both set.
// The signature matches control/src/tenants/events.ts `verifyEventSignature`.

export const EVENT_TIMEOUT_MS = 3000;

export type PairingEventType = "pairing_requested" | "pairing_decided";

export interface PairingEvent {
	type: PairingEventType;
	agent: string;
	requestId: string;
	code: string;
	name: string;
	alias: string;
	ip: string;
	country: string;
	createdAt: string;
	expiresAt: string;
	pending: number;
	decision?: "approved" | "denied";
}

const URL_MAX = 2000;
const SECRET_MAX = 512;

function httpsEventUrl(value: string | undefined): string {
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

function eventSecretText(value: string | undefined): string {
	const text = (value || "").trim();
	if (!text || text.length > SECRET_MAX || /[\u0000-\u001f]/.test(text)) return "";
	return text;
}

/** Public host, or the tenant id when the public URL has no host. */
export function pairingAgent(publicUrl: string, tenantId: string): string {
	try {
		const host = new URL(publicUrl).host;
		if (host) return host;
	} catch { /* tenant id below */ }
	return tenantId || "";
}

/** The post target, or null when either value is missing or unusable. */
export function pairingEventTarget(url: string | undefined, secret: string | undefined): { url: string; secret: string } | null {
	const target = httpsEventUrl(url);
	const key = eventSecretText(secret);
	if (!target || !key) return null;
	return { url: target, secret: key };
}

/** Stable JSON. `decision` is present only on a decided request. */
export function serializePairingEvent(event: PairingEvent): string {
	const body: Record<string, string | number> = {
		type: event.type,
		agent: event.agent,
		requestId: event.requestId,
		code: event.code,
		name: event.name,
		alias: event.alias,
		ip: event.ip,
		country: event.country,
		createdAt: event.createdAt,
		expiresAt: event.expiresAt,
		pending: event.pending,
	};
	if (event.type === "pairing_decided" && (event.decision === "approved" || event.decision === "denied")) body.decision = event.decision;
	return JSON.stringify(body);
}

async function hmacHex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const log = (event: string, kw: Record<string, unknown> = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...kw }));

/**
 * POST the event. One retry after a timeout or a failed response. The promise settles
 * on its own: a network error stays inside this function.
 */
export async function postPairingEvent(
	target: { url: string; secret: string },
	event: PairingEvent,
	opts: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: number } = {},
): Promise<void> {
	try {
		const body = serializePairingEvent(event);
		const timestamp = String(Math.floor((opts.now ?? Date.now()) / 1000));
		const signature = `sha256=${await hmacHex(target.secret, `${timestamp}.${body}`)}`;
		const fetchImpl = opts.fetchImpl ?? fetch;
		const timeoutMs = opts.timeoutMs ?? EVENT_TIMEOUT_MS;
		const headers = { "content-type": "application/json", "x-a2a-timestamp": timestamp, "x-a2a-signature": signature };
		for (let attempt = 1; attempt <= 2; attempt++) {
			try {
				const res = await fetchImpl(target.url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
				try { await res.body?.cancel(); } catch { /* the status is enough */ }
				if (res.ok) {
					log("pairing_event_sent", { type: event.type });
					return;
				}
				log("pairing_event_failed", { type: event.type, attempt, status: res.status });
			} catch (error) {
				log("pairing_event_failed", { type: event.type, attempt, error: String(error).slice(0, 200) });
			}
		}
	} catch (error) {
		log("pairing_event_failed", { type: event.type, error: String(error).slice(0, 200) });
	}
}
