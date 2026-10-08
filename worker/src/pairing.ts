// Device-flow pairing (OAuth 2.0 Device Authorization Grant, RFC 8628): pure helpers (Web Crypto only), so they run
// in Workers and in Node's test runner. The HTTP handlers live in index.ts.

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const EXPIRES_S = 600; // device / user code lifetime
export const INTERVAL_S = 5; // minimum polling interval (slow_down adds 5 s each time)
export const LIMITS = {
	maxPending: 10, // outstanding (unexpired, undecided) requests, globally: caps approval prompts
	perIp: 5, perIpWindowS: 600, // new requests per IP per 10 minutes
	perHour: 30, // new requests per hour, globally
	wrongPerCode: 5, // wrong approval passwords before a request is denied
	wrongPerIp: 10, wrongPerIpWindowS: 3600, // wrong approval passwords per IP per hour, then locked out
	wrongGlobal: 50, // wrong approval passwords per hour from all IPs, then the page is locked for the hour
	pollsPerMin: 60, // token requests per IP per minute
	lookupsPerIp: 30, lookupsWindowS: 600, // /device code lookups per IP per 10 minutes (no enumerating pending requests)
};
export const PBKDF2_MAX_ITERATIONS = 100000; // the Workers runtime refuses more
export const PBKDF2_MIN_ITERATIONS = 100000;
export const MIN_PASSWORD_LENGTH = 12;

export type Mode = "human" | "agent" | "off";
/** PAIRING_APPROVAL: human (default; also for unknown values, the safe choice), agent, or off. */
export function pairingMode(v: string | undefined): Mode {
	const m = (v || "").trim().toLowerCase();
	return m === "agent" || m === "off" ? m : "human";
}

// RFC 8628 §6.1: base-20 consonants (no vowels: no words; no easily confused letters) plus digits without 0/1
const LETTERS = "BCDFGHJKLMNPQRSTVWXZ";
const DIGITS = "23456789";
function pick(alphabet: string, n: number): string {
	const out: string[] = [];
	const buf = new Uint8Array(n * 4);
	crypto.getRandomValues(buf);
	for (let i = 0; out.length < n; i++) {
		if (i >= buf.length) { crypto.getRandomValues(buf); i = 0; }
		const lim = 256 - (256 % alphabet.length); // reject to avoid modulo bias
		if (buf[i] < lim) out.push(alphabet[buf[i] % alphabet.length]);
	}
	return out.join("");
}
/** "WDJB4827" (stored form); shown as WDJB-4827. About 29 bits: guessing is bounded by expiry, rate limits and approval. */
export const newUserCode = () => pick(LETTERS, 4) + pick(DIGITS, 4);
export const formatUserCode = (c: string) => (c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c);
/** Accepts "wdjb-4827", "WDJB 4827", ...; null when it can't be a user code. */
export function normUserCode(s: unknown): string | null {
	if (typeof s !== "string") return null;
	const c = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
	return /^[BCDFGHJKLMNPQRSTVWXZ]{4}[2-9]{4}$/.test(c) ? c : null;
}

/** device_code: 32 random bytes, base64url. Only its SHA-256 is stored. */
export function newDeviceCode(): string {
	const b = new Uint8Array(32);
	crypto.getRandomValues(b);
	return b64url(b);
}
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64decode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** Requester-supplied text (client_name, client_id): printable, single line, at most 64 chars; "" when unusable. */
export function cleanText(v: unknown, max = 64): string {
	if (typeof v !== "string") return "";
	return v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
/** agent_card_url: an https URL without credentials, at most 300 chars; "" otherwise. */
export function cleanCardUrl(v: unknown): string {
	if (typeof v !== "string" || !v || v.length > 300) return "";
	try {
		const u = new URL(v);
		return u.protocol === "https:" && !u.username && !u.password ? u.href : "";
	} catch { return ""; }
}

/** Peer label for a paired agent: [A-Za-z0-9_-], from client_name, else client_id, else "paired-agent". */
export function labelBase(clientName: string, clientId: string): string {
	for (const s of [clientName, clientId]) {
		const l = (s || "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "");
		if (l) return l;
	}
	return "paired-agent";
}
/** First free label: base, base-2, base-3, ... (never reuses a label, revoked ones included). */
export function dedupeLabel(base: string, taken: Set<string>): string {
	if (!taken.has(base)) return base;
	for (let i = 2; i < 1000; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
	return `${base}-${Date.now().toString(36)}`;
}

/** Body of an OAuth request: application/x-www-form-urlencoded (RFC 8628 / RFC 6749) or JSON. */
export function parseParams(raw: string, contentType: string | null): Record<string, string> {
	const out: Record<string, string> = {};
	if (/json/i.test(contentType || "")) {
		let o: unknown;
		try { o = JSON.parse(raw || "{}"); } catch { throw new Error("body is not valid JSON"); }
		if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("body must be a JSON object");
		for (const [k, v] of Object.entries(o as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
		return out;
	}
	for (const [k, v] of new URLSearchParams(raw)) if (!(k in out)) out[k] = v;
	return out;
}

// ------------------------------------------------------------------ approval password (PBKDF2-SHA256)
export type PasswordRecord = { alg: "pbkdf2-sha256"; iterations: number; salt: string; hash: string; setAt?: string };

export async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

/** A record the CLI computed (the password itself never leaves the owner's machine). Error message when invalid. */
export function checkPasswordRecord(r: any): string {
	if (!r || r.alg !== "pbkdf2-sha256") return "alg must be pbkdf2-sha256";
	if (!Number.isInteger(r.iterations) || r.iterations < PBKDF2_MIN_ITERATIONS || r.iterations > PBKDF2_MAX_ITERATIONS)
		return `iterations must be ${PBKDF2_MIN_ITERATIONS}`;
	try {
		if (b64decode(String(r.salt)).length < 16) return "salt must be at least 16 bytes (base64)";
		if (b64decode(String(r.hash)).length !== 32) return "hash must be 32 bytes (base64)";
	} catch { return "salt and hash must be base64"; }
	return "";
}

export async function verifyPassword(password: string, rec: PasswordRecord): Promise<boolean> {
	if (typeof password !== "string" || !password || password.length > 1024) return false;
	const got = await pbkdf2(password, b64decode(rec.salt), Math.min(rec.iterations, PBKDF2_MAX_ITERATIONS));
	const want = b64decode(rec.hash);
	if (got.length !== want.length) return false;
	let d = 0;
	for (let i = 0; i < got.length; i++) d |= got[i] ^ want[i];
	return d === 0;
}

// ------------------------------------------------------------------ /device page (no scripts, no external assets)
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export type PageRequest = { userCode: string; clientName: string; clientId: string; agentCardUrl: string; ip: string; country: string; createdMs: number; expiresMs: number };
export type PageModel = {
	agentName: string;
	mode: Mode;
	cli: string;
	csrf: string;
	notice?: { kind: "ok" | "error" | "info"; text: string };
	request?: PageRequest | null;
	askCode?: boolean; // show the code entry form
	passwordSet: boolean;
	codeValue?: string;
};

export function devicePage(m: PageModel, nonce: string): string {
	const r = m.request;
	const rows = r ? [
		["Code", formatUserCode(r.userCode)],
		["Agent (as it calls itself)", r.clientName || r.clientId || "(no name given)"],
		...(r.clientId && r.clientName && r.clientId !== r.clientName ? [["Client id", r.clientId]] : []),
		["Agent card (claimed)", r.agentCardUrl || "(none given)"],
		["Requested from", [r.ip || "unknown address", r.country].filter(Boolean).join(", ")],
		["Expires", `${Math.max(0, Math.round((r.expiresMs - Date.now()) / 60000))} min`],
	] : [];
	const notice = m.notice ? `<p class="n ${m.notice.kind}">${esc(m.notice.text)}</p>` : "";
	const details = r ? `<table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>
<p class="w">Approve only if you expected this request and the code matches the one you were given. The name and card URL are claimed by the requester. Approving gives it a token to send messages to this inbox; revoke it any time with <code>${esc(m.cli)} token revoke &lt;label&gt;</code>.</p>` : "";
	const noPassword = `<p class="n info">No approval password is set yet. In a terminal on the owner's machine run <code>${esc(m.cli)} pair set-password</code>, then reload this page.</p>`;
	const form = r && m.passwordSet ? `<form method="post" action="/device">
<input type="hidden" name="csrf" value="${esc(m.csrf)}"><input type="hidden" name="user_code" value="${esc(formatUserCode(r.userCode))}">
<label for="pw">Approval password</label><input id="pw" name="password" type="password" autocomplete="current-password" required maxlength="1024" autofocus>
<div class="b"><button name="decision" value="approve" type="submit">Approve</button><button name="decision" value="deny" type="submit" class="d">Deny</button></div>
</form>` : r && !m.passwordSet ? noPassword : "";
	const ask = m.askCode ? `<form method="get" action="/device"><label for="uc">Code</label><input id="uc" name="user_code" value="${esc(m.codeValue || "")}" placeholder="WDJB-4827" autocomplete="off" autocapitalize="characters" required maxlength="16" autofocus><div class="b"><button type="submit">Continue</button></div></form>` : "";
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>Connect an agent to ${esc(m.agentName)}</title><style nonce="${nonce}">
body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fafafa}
h1{font-size:1.3rem}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{text-align:left;padding:.35rem .5rem;border-bottom:1px solid #ddd;vertical-align:top;word-break:break-all}th{width:40%;font-weight:600;word-break:normal}
label{display:block;font-weight:600;margin:.8rem 0 .3rem}input{font:inherit;width:100%;box-sizing:border-box;padding:.5rem;border:1px solid #888;border-radius:4px}
.b{display:flex;gap:.6rem;margin-top:1rem}button{font:inherit;padding:.5rem 1.2rem;border:0;border-radius:4px;background:#1a5fb4;color:#fff;cursor:pointer}button.d{background:#a51d2d}
.n{padding:.6rem .8rem;border-radius:4px}.ok{background:#e6f4ea}.error{background:#fce8e6}.info{background:#e8f0fe}.w{font-size:.9rem;color:#444}code{background:#eee;padding:0 .2rem}
</style></head><body><h1>Connect an agent to ${esc(m.agentName)}</h1>${notice}${details}${form}${ask}</body></html>`;
}

/** Security headers for the /device page: strict CSP (no scripts; only this page's own style), no framing, no caching. */
export function pageHeaders(nonce: string): Record<string, string> {
	return {
		"content-type": "text/html; charset=utf-8",
		"content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
		"x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
		"cache-control": "no-store", "cross-origin-opener-policy": "same-origin",
	};
}

/** Random nonce / CSRF token (base64url). */
export function randomB64(bytes = 18): string {
	const b = new Uint8Array(bytes);
	crypto.getRandomValues(b);
	return b64url(b);
}
