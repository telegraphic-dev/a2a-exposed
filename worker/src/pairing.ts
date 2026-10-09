// Device-flow pairing (OAuth 2.0 Device Authorization Grant, RFC 8628): pure helpers (Web Crypto only), so they run
// in Workers and in Node's test runner. The HTTP handlers live in index.ts.
import { isPrivateHost } from "./a2a.ts";

/** How every hint tells an agent to run the CLI: npx, latest release, no global install (agent sandboxes block global
 *  installs as untrusted code). WAKE_CLI_COMMAND overrides it for the owner's own wake hints only. */
export const DEFAULT_CLI = "npx -y a2a-exposed@latest";

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
	lookupsPerIp: 30, lookupsWindowS: 600, // /device code lookups (and password-less denies) per IP per 10 minutes (no enumerating pending requests)
	setupPerIp: 20, setupWindowS: 600, // /device/setup page loads and submissions per IP per 10 minutes
	setupFailures: 5, // invalid submissions (too short, mismatched) before a setup link is burned
};
// Approval password hashing (PBKDF2-SHA256). The iteration count is stored with each hash, so it can be tuned without
// breaking an existing password. 100,000 is the Workers runtime's maximum and the default. On the free plan (10 ms CPU
// per request) one verification costs roughly 17-23 ms CPU locally and has worked in practice; an operator who sees
// Cloudflare error 1102 on /device can deploy with a lower count (not below 50,000) and set the password again. Online
// guessing is bounded by the lockouts (LIMITS.wrong*), not by the iteration count; the count only slows offline cracking
// of a leaked hash, which needs read access to the D1 database (that is, to the Cloudflare account).
export const PBKDF2_MAX_ITERATIONS = 100000; // the Workers runtime refuses more
export const PBKDF2_MIN_ITERATIONS = 50000;
export const PBKDF2_DEFAULT_ITERATIONS = 100000;
export const MIN_PASSWORD_LENGTH = 12;
export const SETUP_LINK_DEFAULT_S = 900; // one-time password setup link (pair set-password --web): 15 minutes
export const SETUP_LINK_MIN_S = 60, SETUP_LINK_MAX_S = 3600;

/** PBKDF2_ITERATIONS from the deployment, clamped to the accepted range (default 100,000). */
export function pbkdf2Iterations(v: string | undefined): number {
	const n = Number(v);
	return Number.isInteger(n) && n >= PBKDF2_MIN_ITERATIONS && n <= PBKDF2_MAX_ITERATIONS ? n : PBKDF2_DEFAULT_ITERATIONS;
}

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

/** True when a (cleaned, https) card URL is on a private network: a Tailnet (*.ts.net, 100.64.0.0/10), LAN or
 *  loopback name. Such a card is accepted as informational (an agent pairing out before it has a public façade) and
 *  flagged on the approval page and in the wake. */
export function cardIsPrivate(v: string): boolean {
	try { return isPrivateHost(new URL(v).hostname); } catch { return false; }
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
export type PasswordRecord = { alg: "pbkdf2-sha256"; iterations: number; salt: string; hash: string; setAt?: string; setVia?: "terminal" | "web" };

export async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

/** A record the CLI computed (the password itself never leaves the owner's machine). Error message when invalid. */
export function checkPasswordRecord(r: any): string {
	if (!r || r.alg !== "pbkdf2-sha256") return "alg must be pbkdf2-sha256";
	if (!Number.isInteger(r.iterations) || r.iterations < PBKDF2_MIN_ITERATIONS || r.iterations > PBKDF2_MAX_ITERATIONS)
		return `iterations must be between ${PBKDF2_MIN_ITERATIONS} and ${PBKDF2_MAX_ITERATIONS}`;
	try {
		if (b64decode(String(r.salt)).length < 16) return "salt must be at least 16 bytes (base64)";
		if (b64decode(String(r.hash)).length !== 32) return "hash must be 32 bytes (base64)";
	} catch { return "salt and hash must be base64"; }
	return "";
}

/** Hash a password on the Worker (the web setup page): the same record the CLI computes. */
export async function makePasswordRecord(password: string, iterations: number): Promise<PasswordRecord> {
	const salt = new Uint8Array(16);
	crypto.getRandomValues(salt);
	const hash = await pbkdf2(password, salt, iterations);
	const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
	return { alg: "pbkdf2-sha256", iterations, salt: b64(salt), hash: b64(hash) };
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

export type PageRequest = { userCode: string; clientName: string; clientId: string; agentCardUrl: string; ip: string; country: string; createdMs: number; expiresMs: number; replacesLabel?: string };
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
		["Agent card (claimed)", r.agentCardUrl ? r.agentCardUrl + (cardIsPrivate(r.agentCardUrl) ? " (private network address, e.g. a Tailnet: not publicly reachable, so this inbox can't check it; informational only)" : "") : "(none given)"],
		["Requested from", [r.ip || "unknown address", r.country].filter(Boolean).join(", ")],
		["Expires", `${Math.max(0, Math.round((r.expiresMs - Date.now()) / 60000))} min`],
		...(r.replacesLabel ? [["Replaces", `the active token "${r.replacesLabel}" (the requester proved it holds it); approving issues a new token under the same label and the old one stops working`]] : []),
	] : [];
	const notice = m.notice ? `<p class="n ${m.notice.kind}">${esc(m.notice.text)}</p>` : "";
	const details = r ? `<table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>
<p class="w">Approve only if you expected this request and the code matches the one you were given. The name and card URL are claimed by the requester. Approving gives it a token to send messages to this inbox; revoke it any time with <code>${esc(m.cli)} token revoke &lt;label&gt;</code>.</p>` : "";
	const noPassword = `<p class="n info">No approval password is set yet. Easiest: ask your agent to run <code>${esc(m.cli)} pair set-password --web</code> and send you the one-time link, then set the password on that page. Or run <code>${esc(m.cli)} pair set-password</code> yourself in a terminal on the owner's machine. Then reload this page. You can deny without a password.</p>`;
	const denyOnly = `<form method="post" action="/device">
<input type="hidden" name="csrf" value="${esc(m.csrf)}"><input type="hidden" name="user_code" value="${esc(r ? formatUserCode(r.userCode) : "")}">
<div class="b"><button name="decision" value="deny" type="submit" class="d">Deny</button></div>
</form>`;
	// Deny needs no password (formnovalidate skips the required field): denying grants nothing
	const form = r && m.passwordSet ? `<form method="post" action="/device">
<input type="hidden" name="csrf" value="${esc(m.csrf)}"><input type="hidden" name="user_code" value="${esc(formatUserCode(r.userCode))}">
<label for="pw">Approval password (needed to approve; deny works without it)</label><input id="pw" name="password" type="password" autocomplete="current-password" required maxlength="1024" autofocus>
<div class="b"><button name="decision" value="approve" type="submit">Approve</button><button name="decision" value="deny" type="submit" class="d" formnovalidate>Deny</button></div>
</form>` : r && !m.passwordSet ? noPassword + denyOnly : "";
	const ask = m.askCode ? `<form method="get" action="/device"><label for="uc">Code</label><input id="uc" name="user_code" value="${esc(m.codeValue || "")}" placeholder="WDJB-4827" autocomplete="off" autocapitalize="characters" required maxlength="16" autofocus><div class="b"><button type="submit">Continue</button></div></form>` : "";
	return pageShell(`Connect an agent to ${m.agentName}`, nonce, `${notice}${details}${form}${ask}`);
}

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fafafa}
h1{font-size:1.3rem}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{text-align:left;padding:.35rem .5rem;border-bottom:1px solid #ddd;vertical-align:top;word-break:break-all}th{width:40%;font-weight:600;word-break:normal}
label{display:block;font-weight:600;margin:.8rem 0 .3rem}input{font:inherit;width:100%;box-sizing:border-box;padding:.5rem;border:1px solid #888;border-radius:4px}
.b{display:flex;gap:.6rem;margin-top:1rem}button{font:inherit;padding:.5rem 1.2rem;border:0;border-radius:4px;background:#1a5fb4;color:#fff;cursor:pointer}button.d{background:#a51d2d}
h2{font-size:1.05rem;margin-top:1.5rem}ul{padding-left:1.2rem}a{color:#1a5fb4}.n{padding:.6rem .8rem;border-radius:4px}.ok{background:#e6f4ea}.error{background:#fce8e6}.info{background:#e8f0fe}.w{font-size:.9rem;color:#444}code{background:#eee;padding:0 .2rem}`;

/** The shared page frame: no scripts, no external assets, one nonce'd style block. `title` is escaped here. */
export function pageShell(title: string, nonce: string, body: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>${esc(title)}</title><style nonce="${nonce}">
${STYLE}
</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;
}

export type LandingModel = {
	name: string;
	description?: string;
	base: string; // PUBLIC_URL (no trailing slash)
	versions: string[]; // A2A protocol versions served over JSON-RPC at base + "/"
	skills: { name: string; description?: string }[];
	pairing: boolean; // device-flow pairing is on (/device exists)
	proxy: boolean; // façade for an existing A2A agent (vs. the webhook inbox)
};

/** GET / in a browser: what this URL is and how to connect. Same frame and CSP as /device (no scripts, no external assets). Everything comes from the public card, so nothing private leaks here either. */
export function landingPage(m: LandingModel, nonce: string): string {
	const card = `${m.base}/.well-known/agent-card.json`;
	const desc = m.description ? `<p>${esc(m.description)}</p>` : "";
	const versions = m.versions.length ? m.versions.map((v) => esc(v)).join(", ") : "1.0, 0.3";
	const skills = m.skills.length
		? `<h2>Skills</h2><ul>${m.skills.slice(0, 20).map((k) => `<li><b>${esc(k.name)}</b>${k.description ? ` &ndash; ${esc(k.description)}` : ""}</li>`).join("")}</ul>${m.skills.length > 20 ? `<p class="w">&hellip;and ${m.skills.length - 20} more in the agent card.</p>` : ""}`
		: "";
	const connect = m.pairing
		? `<h2>Connect your agent</h2><p>Agents get a bearer token through the OAuth device flow: your agent asks, and this agent's owner approves the request on the <a href="/device">pairing page</a>. No secrets go through chat. With the a2a-exposed CLI, your agent runs:</p><p><code>${DEFAULT_CLI} connect ${esc(m.base)}</code></p>`
		: `<h2>Connect your agent</h2><p>Pairing is turned off here: ask this agent's operator for a bearer token.</p>`;
	return pageShell(m.name, nonce, `${desc}
<p class="n info">This is an <a href="https://a2a-protocol.org/">A2A (Agent2Agent)</a> endpoint, meant for agents rather than people.${m.proxy ? "" : " Messages land in its owner's inbox, which wakes the agent."}</p>
<table>
<tr><th>Agent card</th><td><a href="/.well-known/agent-card.json">${esc(card)}</a></td></tr>
<tr><th>JSON-RPC endpoint</th><td><code>POST ${esc(m.base)}/</code></td></tr>
<tr><th>A2A versions</th><td>${versions} (legacy card: <a href="/.well-known/agent.json">agent.json</a>)</td></tr>
<tr><th>Authentication</th><td>Bearer token${m.pairing ? ` (<a href="/device">pairing page</a>)` : ""}</td></tr>
</table>
${skills}${connect}
<p class="w">Served by <a href="https://github.com/telegraphic-dev/a2a-exposed">a2a-exposed</a>.</p>`);
}

/** Security headers for the landing page: the /device CSP minus forms, cacheable for a few minutes (no per-visitor state). */
export function landingHeaders(nonce: string): Record<string, string> {
	return { ...pageHeaders(nonce), "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
		"cache-control": "no-cache", vary: "accept" };
}

export type SetupModel = {
	agentName: string;
	cli: string;
	csrf: string;
	token?: string; // the setup token, when the link is valid (posted back in a hidden field)
	expiresMs?: number;
	passwordSetAt?: string; // a password exists: this page changes it
	notice?: { kind: "ok" | "error" | "info"; text: string };
	done?: boolean; // the password was just set: link to /device
};

/** GET/POST /device/setup: set or change the approval password from a one-time link (pair set-password --web). */
export function setupPage(m: SetupModel, nonce: string): string {
	const notice = m.notice ? `<p class="n ${m.notice.kind}">${esc(m.notice.text)}</p>` : "";
	if (m.done) return pageShell(`Approval password for ${m.agentName}`, nonce,
		`${notice}<p>Pairing requests are approved on the <a href="/device">approval page</a> with this password. Keep it to yourself: never give it to an agent. This link is used up; a later change needs a new one (<code>${esc(m.cli)} pair set-password --web</code>).</p>`);
	if (!m.token) return pageShell(`Approval password for ${m.agentName}`, nonce,
		`${notice}<p>Ask your agent for a new link: <code>${esc(m.cli)} pair set-password --web</code>. Or run <code>${esc(m.cli)} pair set-password</code> yourself in a terminal on the owner's machine.</p>`);
	const mins = m.expiresMs ? Math.max(1, Math.round((m.expiresMs - Date.now()) / 60000)) : 0;
	const intro = m.passwordSetAt
		? `<p>An approval password is already set (since ${esc(m.passwordSetAt)}). Saving here replaces it.</p>`
		: `<p>Choose the password you will use to approve agents that ask to connect to this inbox.</p>`;
	return pageShell(`Approval password for ${m.agentName}`, nonce, `${notice}${intro}
<p class="w">Only you should know it: don't share it with your agent or anyone else. At least ${MIN_PASSWORD_LENGTH} characters; a passphrase of a few words works well. This one-time link expires in ${mins} min.</p>
<form method="post" action="/device/setup">
<input type="hidden" name="csrf" value="${esc(m.csrf)}"><input type="hidden" name="t" value="${esc(m.token)}">
<label for="pw1">New approval password</label><input id="pw1" name="password" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}" maxlength="1024" autofocus>
<label for="pw2">Repeat it</label><input id="pw2" name="password2" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}" maxlength="1024">
<div class="b"><button type="submit">Set approval password</button></div>
</form>`);
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
