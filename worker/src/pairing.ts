// Device-flow pairing (OAuth 2.0 Device Authorization Grant, RFC 8628): pure helpers (Web Crypto only), so they run
// in Workers and in Node's test runner. The HTTP handlers live in index.ts.
import { isPrivateHost } from "./a2a.ts";
import { pageStyle } from "./theme.ts";

/** How every hint tells an agent to run the CLI: npx, latest release, no global install (agent sandboxes block global
 *  installs as untrusted code). WAKE_CLI_COMMAND overrides it for the owner's own wake hints only. */
export const DEFAULT_CLI = "npx -y a2a-exposed@latest";

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const EXPIRES_S = 3600; // device / user code lifetime (60 minutes)
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

/** "Expires" cell. Clock time in the visitor's time zone, then how long is left. An unknown zone uses UTC. */
export function expiresText(expiresMs: number, now = Date.now(), timeZone?: string): string {
	const left = expiresMs - now;
	if (left <= 0) return "expired";
	const relative = left < 60_000 ? "less than a minute" : `${Math.round(left / 60000)} min`;
	const { zone, suffix } = clockZone(timeZone);
	return `${clockTime(expiresMs, zone)}${suffix} (${relative})`;
}

function clockZone(timeZone: string | undefined): { zone: string; suffix: string } {
	const zone = (timeZone || "").trim();
	if (!zone || zone.toUpperCase() === "UTC" || zone === "Etc/UTC" || zone === "Etc/GMT") return { zone: "UTC", suffix: " UTC" };
	try {
		new Intl.DateTimeFormat("en-GB", { timeZone: zone }).format(0);
		return { zone, suffix: "" };
	} catch {
		return { zone: "UTC", suffix: " UTC" };
	}
}

function clockTime(ms: number, timeZone: string): string {
	const parts = new Intl.DateTimeFormat("en-GB", {
		hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone,
	}).formatToParts(new Date(ms));
	const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
	const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
	return `${hour}:${minute}`;
}

export type PageRequest = { userCode: string; clientName: string; clientId: string; agentCardUrl: string; ip: string; country: string; createdMs: number; expiresMs: number; replacesLabel?: string; tokenLabel?: string; identityFingerprint?: string;
	/** Set when the request carries public encryption keys (a key pairing). Never holds key material. */
	sealed?: { safetyCode: string | null; safetyEmoji?: { emoji: string; name: string }[] | null } };
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
	/** Set only when OpenID Connect approval is offered. Absent keeps the page HTML unchanged. */
	oidc?: { label: string };
	/** False hides the password field. Absent means the password field is shown as before. */
	passwordEnabled?: boolean;
	/** IANA time zone from the request, when Cloudflare provides one. The expiry clock uses it. */
	timeZone?: string;
	/** Set after Approve or Deny: the page shows that result and no code form. */
	settled?: "approved" | "denied";
};

export function devicePage(m: PageModel, nonce: string): string {
	const errorAttrs = m.notice?.kind === "error" ? ` aria-invalid="true" aria-describedby="device-error"` : "";
	const notice = m.notice ? `<p${errorAttrs ? ` id="device-error" role="alert"` : ""} class="n ${m.notice.kind}">${esc(m.notice.text)}</p>` : "";
	if (m.settled) {
		const title = m.settled === "approved" ? "Approved" : "Denied";
		return pageShell(title, nonce, `${notice}<p>You can close this page.</p>`);
	}
	const r = m.request;
	const rows = r ? [
		["Code", formatUserCode(r.userCode)],
		["Agent (as it calls itself)", r.clientName || r.clientId || "(no name given)"],
		...(r.clientId && r.clientName && r.clientId !== r.clientName ? [["Alias (claimed)", r.clientId]] : []),
		["Agent card (claimed)", r.agentCardUrl ? r.agentCardUrl + (cardIsPrivate(r.agentCardUrl) ? " (private network address, e.g. a Tailnet: not publicly reachable, so this A2A endpoint can't check it; informational only)" : "") : "(none given)"],
		["Requested from", `${[r.ip || "unknown address", r.country].filter(Boolean).join(", ")} (IP address of the machine that asked to connect)`],
		["Expires", expiresText(r.expiresMs, Date.now(), m.timeZone)],
		...(r.replacesLabel ? [["Replaces", `the active token "${r.replacesLabel}" (the requester proved it holds it); approving issues a new token under the same label and the old one stops working`]] : []),
		...(r.identityFingerprint ? [["Pairing identity", r.identityFingerprint]] : []),
		...(r.sealed ? [["Encryption", "Encrypted key pairing (the requester sent public encryption keys)"], ["Safety emoji", r.sealed.safetyEmoji?.map(x => `${x.emoji} ${x.name}`).join(" · ") || (r.sealed.safetyCode ? "Emoji unavailable. Compare the full safety code below through another trusted channel." : "Safety comparison unavailable. Do not approve this pairing.")]] : []),
	] : [];
	const sealedNote = r?.sealed ? `<p>${r.sealed.safetyEmoji?.length ? "Compare all seven emoji and their names, in order, with the other owner through another trusted channel. If any differ, do not approve this pairing." : r.sealed.safetyCode ? "Emoji are unavailable. Compare the full safety code with the other owner through another trusted channel. If it differs, do not approve this pairing." : "The safety comparison is unavailable. Do not approve this pairing; inspect the selected pairing and keys first."}</p><details><summary>Full safety code</summary><p>${esc(r.sealed.safetyCode || "Unavailable. Inspect the selected pairing and keys before approving.")}</p></details>${r.sealed.safetyEmoji?.length ? `<p>This emoji sequence is a shorter comparison. Compare the full safety code for stronger assurance. This quick 42-bit check is weaker than the full 60-digit code. Without commit-reveal, an attacker repeatedly generating keys could match the short display. Compare the full code for high-stakes pairings.</p>` : ""}<p class="w">Trust on first use: this page can't verify the keys. Emoji agreement alone does not record independent verification; keys verify still requires the full numeric code. Approving doesn't turn on encryption for any other peer.</p>` : "";
	const tokenLabel = r?.tokenLabel || "<label>";
	const revoke = `${m.cli} token revoke ${tokenLabel}`;
	const details = r ? `<table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td${k === "Safety emoji" ? ' class="safety-comparison"' : ""}>${k === "Safety emoji" && r.sealed?.safetyEmoji?.length ? r.sealed.safetyEmoji.map(x => `<span class="safety-pair">${esc(x.emoji)} ${esc(x.name)}</span>`).join(" · ") : esc(v)}</td></tr>`).join("")}</table>
<p class="w">Approve only if you expected this request and the code matches the one you were given. The name, alias and card URL are claimed by the requester. Approving gives it a token that can send messages and trigger wakes. Message text from peers is untrusted. Revoke the token ${esc(tokenLabel)} any time with <code>${esc(revoke)}</code>.</p>${sealedNote}${r.identityFingerprint ? `<p class="w">This request includes a pairing identity (<code>${esc(r.identityFingerprint)}</code>). Approving lets this inbox call that agent back at an address the same identity later proves, without a second pairing approval. The return credential is an ordinary peer token you can revoke. A change of host is shown to you.</p>` : ""}${r && !r.agentCardUrl ? `<p class="w">No agent card was given. This agent can send messages after approval. Replies stay stored on the task until it announces an address.</p>` : ""}` : "";
	const noPassword = `<p class="n info">No approval password is set yet. Easiest: ask your agent to run <code>${esc(m.cli)} pair set-password --web</code> and send you the one-time link, then set the password on that page. Or run <code>${esc(m.cli)} pair set-password</code> yourself in a terminal on the owner's machine. Then reload this page. You can deny without a password.</p>`;
	const denyOnly = `<form method="post" action="/device">
<input type="hidden" name="csrf" value="${esc(m.csrf)}"><input type="hidden" name="user_code" value="${esc(r ? formatUserCode(r.userCode) : "")}">
<div class="b"><button name="decision" value="deny" type="submit" class="d">Deny</button></div>
</form>`;
	// Deny needs no password (formnovalidate skips the required field): denying grants nothing
	const passwordOn = m.passwordEnabled !== false;
	const form = r && passwordOn && m.passwordSet ? `<form method="post" action="/device">
<input type="hidden" name="csrf" value="${esc(m.csrf)}"><input type="hidden" name="user_code" value="${esc(formatUserCode(r.userCode))}">
<label for="pw">Approval password (needed to approve; deny works without it)</label><input id="pw" name="password" type="password"${errorAttrs} autocomplete="current-password" required maxlength="1024" autofocus>
<div class="b"><button name="decision" value="approve" type="submit">Approve</button><button name="decision" value="deny" type="submit" class="d" formnovalidate>Deny</button></div>
</form>` : r && passwordOn && !m.passwordSet ? noPassword + denyOnly : r ? denyOnly : "";
	const oidcForm = m.oidc && r ? `<form method="post" action="/device">
<input type="hidden" name="csrf" value="${esc(m.csrf)}"><input type="hidden" name="user_code" value="${esc(formatUserCode(r.userCode))}">
<div class="b"><button name="decision" value="oidc" type="submit">Approve with ${esc(m.oidc.label)}</button></div>
</form>` : "";
	const ask = m.askCode ? `<p class="w">The connecting agent prints this code when it runs <code>${esc(`${m.cli} connect <url>`)}</code>. Use four consonants, a hyphen, and four digits.</p><form method="post" action="/device"><input type="hidden" name="csrf" value="${esc(m.csrf)}"><input type="hidden" name="decision" value="lookup"><label for="uc">Code</label><input id="uc" name="user_code" value="${esc(m.codeValue || "")}" placeholder="XXXX-0000"${errorAttrs} spellcheck="false" autocomplete="off" autocapitalize="characters" required maxlength="16" autofocus><div class="b"><button type="submit">Continue</button></div></form>` : "";
	return pageShell(`Connect an agent to ${m.agentName}`, nonce, `${notice}${details}${form}${oidcForm}${ask}`);
}

/** The shared page frame: no scripts, no external assets, one nonce'd style block. `title` is escaped here.
 * The heading and content sit in one `<main>` landmark so screen readers can jump to the page content. */
export function pageShell(title: string, nonce: string, body: string, head = ""): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">${head}
<title>${esc(title)}</title><style nonce="${nonce}">
${pageStyle()}
</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

export type LandingModel = {
	name: string;
	description?: string;
	card?: unknown; // already scrubbed public card snapshot, exposed only as inert attribute data
	base: string; // PUBLIC_URL (no trailing slash)
	versions: string[]; // A2A protocol versions served over JSON-RPC at base + "/"
	skills: { name: string; description?: string }[];
	pairing: boolean; // device-flow pairing is on (/device exists)
	proxy: boolean; // façade for an existing A2A agent (vs. the webhook inbox)
	connectDoc?: string; // the connect playbook (https)
	exposeDoc?: string; // the setup skill: get your own A2A address (https)
	socialImage?: string; // per-agent card URL (hosted); unset means the shared /og-card-v1.png
};

/** Public HTML is for people; protocol and connection instructions live in the Markdown representation. */
export function landingPage(m: LandingModel, nonce: string): string {
	const address = m.base.replace(/^https?:\/\//, "");
	const prompt = `Connect to ${address}`;
	const visibleAddress = address.split(".").map(esc).join("<wbr>.");
	const ownAddress = m.exposeDoc ? new URL(m.exposeDoc).origin : "https://a2a.exposed";
	const technicalDefault = m.description === "An AI agent reachable over A2A. Messages are queued and handled asynchronously; poll GetTask or register a push notification config." || m.description === "An AI agent reachable over A2A through a public façade.";
	const description = !technicalDefault && m.description || (m.proxy ? "An agent you can connect with." : "Send a message to this agent through its public address.");
	const socialDescription = `${m.description && !technicalDefault ? m.description + " " : ""}Tell your agent: ${prompt}. ${m.pairing ? "The owner approves every connection." : "New connection requests are turned off."}`;
	const socialImage = m.socialImage || `${m.base}/og-card-v1.png`;
	// The alt text reads what the image shows: the per-agent card has the address and the pairing footer.
	const socialAlt = m.socialImage
		? `Connect your agent to this one. Tell your agent: ${prompt}. ${m.pairing ? "The owner approves every connection." : "New connection requests are turned off."}`
		: "Connect your agent to this one. Tell your agent: Connect to this agent’s address.";
	const social = `<meta property="og:type" content="website"><meta property="og:url" content="${esc(m.base)}"><meta property="og:title" content="${esc(prompt)}"><meta property="og:description" content="${esc(socialDescription)}"><meta property="og:image" content="${esc(socialImage)}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${esc(socialAlt)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(prompt)}"><meta name="twitter:description" content="${esc(socialDescription)}"><meta name="twitter:image" content="${esc(socialImage)}"><meta name="twitter:image:alt" content="${esc(socialAlt)}">`;
	const happens = m.pairing
		? `<ol><li>Your agent asks to connect.</li><li>This agent’s owner approves the request.</li><li>Your agents can exchange messages.</li></ol><p class="hint">The owner decides who can connect. Copying this prompt does not grant access.</p>`
		: `<p>New connection requests are turned off. Ask this agent’s owner how to get access. Existing connections can still exchange messages.</p>`;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><link rel="alternate" type="text/markdown" href="/index.md"><title>${esc(m.name)}</title>${social}<style nonce="${nonce}">${landingStyle()}</style><script defer nonce="${nonce}" src="/landing-webmcp.js" data-agent-card="${esc(JSON.stringify(m.card || {}))}" data-agent-base="${esc(m.base)}" data-pairing="${m.pairing ? "1" : "0"}"></script></head><body><a class="skip" href="#main">Skip to content</a><header><a class="brand" href="${esc(ownAddress)}">a2a.exposed<span aria-hidden="true">_</span></a><a href="/index.md">For AI agents</a></header><main id="main"><p class="eyebrow">${esc(address)}</p><h1>${esc(m.name)}</h1><p class="description">${esc(description)}</p><section aria-labelledby="connect-heading"><h2 id="connect-heading">Tell your agent:</h2><div class="prompt"><div class="prompt-scroll"><code id="connect-prompt">Connect to <span>${visibleAddress}</span></code></div><button type="button" id="copy-connect" data-copy="${esc(prompt)}" aria-label="Copy prompt for your agent" hidden><svg class="copy-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg><svg class="check-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg></button></div><p class="hint" id="copy-help">Select the prompt, copy it, and paste it into your agent’s chat.</p><p id="copy-status" role="status" aria-live="polite"></p></section><section aria-labelledby="happens-heading"><h2 id="happens-heading">What happens next</h2>${happens}</section><footer><a href="${esc(ownAddress)}">Get your own address</a><p>Served by <a href="https://github.com/telegraphic-dev/a2a-exposed">a2a-exposed</a>.</p></footer></main></body></html>`;
}

function landingStyle(): string {
	return `:root{
color-scheme:dark;
 --bg:#0a0f0a;
 --surface:#111a13;
 --text:#e6ede7;
 --muted:#9baa9e;
 --line:#2a3a2d;
 --accent:#4ade80;
 --ink:#0a0f0a;
 --danger:#f87171;
 --space-1:.25rem;
 --space-2:.5rem;
 --space-3:.75rem;
 --space-4:1rem;
 --space-5:1.5rem;
 --space-6:2rem;
 --radius:.75rem;
 --touch:2.75rem;
 --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
 --sans:system-ui,-apple-system,sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:1rem/1.65 var(--sans)}
a{color:var(--accent);text-underline-offset:var(--space-1)}
a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:var(--space-1)}
header,main{max-width:48rem;margin:auto;padding:var(--space-5)}
header{display:flex;justify-content:space-between;gap:var(--space-4);border-bottom:1px solid var(--line);font-family:var(--mono)}
header a,footer a{display:inline-flex;align-items:center;min-height:var(--touch)}
main{padding-top:var(--space-6)}
h1{font:700 clamp(2rem,7vw,3.5rem)/1.15 var(--mono);overflow-wrap:anywhere;margin:var(--space-4) 0}
.eyebrow{font: .875rem/1.6 var(--mono);color:var(--accent);overflow-wrap:anywhere}
.description{font-size:1.125rem;color:var(--muted);overflow-wrap:anywhere}
section{margin-top:var(--space-6)}
h2{font:600 1.125rem/1.5 var(--mono);margin:0 0 var(--space-3)}
.prompt{position:relative;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);padding:var(--space-5);min-width:0}
.prompt code{display:block;font:1.125rem/1.8 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;user-select:all;padding-right:calc(var(--touch) + var(--space-2))}
.prompt-scroll{min-width:0;max-width:100%}


.check-icon{display:none}
button[data-state=copied] .copy-icon{display:none}
button[data-state=copied] .check-icon{display:inline}
.prompt code span{color:var(--accent)}
button{position:absolute;top:var(--space-3);right:var(--space-3);width:var(--touch);height:var(--touch);border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);color:var(--accent);cursor:pointer}
button[hidden]{display:none}
button svg{width:1.25rem;height:1.25rem;fill:none;stroke:currentColor;stroke-width:1.75}
.hint,footer{color:var(--muted);font-size:.875rem}
#copy-status:empty{display:none}
#copy-status{color:var(--accent)}
#copy-status[data-state=failed],button[data-state=failed]{color:var(--danger)}
ol{padding-left:var(--space-5)}
li{padding:var(--space-2) 0}
footer{margin-top:var(--space-6);padding-top:var(--space-5);border-top:1px solid var(--line)}
footer>a{display:flex;width:fit-content;max-width:100%;overflow-wrap:anywhere}
.skip{position:absolute;left:var(--space-4);top:var(--space-4);transform:translateY(-200%);background:var(--bg);padding:var(--space-2)}
.skip:focus{transform:none}
@media(max-width:375px){header,main{padding:var(--space-4)}
.prompt{padding:var(--space-3)}
.prompt code{font-size:.875rem}
}
`;
}

/** Security headers for the landing page: the /device CSP minus forms, plus one nonce-authorized script; no network requests. */
export function landingHeaders(nonce: string): Record<string, string> {
	return { ...pageHeaders(nonce), "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
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
		: `<p>Choose the password you will use to approve agents that ask to connect to this A2A endpoint.</p>`;
	return pageShell(`Approval password for ${m.agentName}`, nonce, `${notice}${intro}
<p class="w">Only you should know it: don't share it with your agent or anyone else. Use ${MIN_PASSWORD_LENGTH} to 1024 characters. A passphrase of several unrelated words is stronger than one short word. This one-time link expires in ${mins} min.</p>
<form method="post" action="/device/setup">
<input type="hidden" name="csrf" value="${esc(m.csrf)}"><input type="hidden" name="t" value="${esc(m.token)}">
<label for="pw1">New approval password</label><input id="pw1" name="password" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}" maxlength="1024" autofocus>
<label for="pw2">Repeat the password</label><input id="pw2" name="password2" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}" maxlength="1024">
<div class="b"><button type="submit">Set approval password</button></div>
</form>`);
}

/** An http(s) origin (scheme, host, and port) with no userinfo. Anything else, including a path, is dropped. */
export function cspFormOrigin(raw: string): string {
	try {
		const u = new URL(raw);
		if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) return "";
		if (u.origin !== raw) return "";
		return u.origin;
	} catch { return ""; }
}

/**
 * Security headers for the /device page: strict CSP (no scripts; only this page's own style), no framing, no caching.
 * `formOrigins` are extra `form-action` origins. Chrome applies `form-action` to a form POST's redirect target,
 * so a page whose POST answers 302 to another origin must list that origin here. With none, the directive stays `form-action 'self'`.
 */
export function pageHeaders(nonce: string, formOrigins: readonly string[] = []): Record<string, string> {
	const extra: string[] = [];
	for (const raw of formOrigins) {
		const origin = cspFormOrigin(raw);
		if (origin && !extra.includes(origin)) extra.push(origin);
	}
	const form = ["'self'", ...extra].join(" ");
	return {
		"content-type": "text/html; charset=utf-8",
		"content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; form-action ${form}; frame-ancestors 'none'; base-uri 'none'`,
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
