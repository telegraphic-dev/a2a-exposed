// Minimal A2A client helpers (0.3 + 1.0) and HTTP utilities.
import crypto from "node:crypto";

export const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** The one way docs, hints and CLI output tell people (and agents) to run the CLI: npx, always the latest release, no
 *  global install (agent sandboxes block global installs as untrusted code). A global install is an optional speed-up. */
export const CLI = "npx -y a2a-exposed@latest";

export class CliError extends Error {}
export const die = (msg) => { throw new CliError(msg); };

export function checkId(v, what = "id") {
	if (typeof v !== "string" || !ID_RE.test(v)) die(`invalid ${what}`);
	return v;
}

export const newId = () => crypto.randomUUID();

/** Hosts that only resolve on a private network (Tailnet, LAN, loopback). Same rules as the Worker's isPrivateHost. */
export function isPrivateHost(host) {
	const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (!h.includes(".") && !h.includes(":")) return true; // single-label names (localhost, MagicDNS short names)
	if (/(^|\.)(localhost|local|lan|home|internal|intranet|corp|home\.arpa|ts\.net)$/.test(h)) return true;
	const m = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
	if (m) {
		const [a, b] = [Number(m[1]), Number(m[2])];
		return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
	}
	if (!h.includes(":")) return false;
	if (h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^fec/.test(h)) return true; // unspecified, loopback, ULA, link-/site-local
	// IPv4 embedded in IPv6 (mapped ::ffff:a.b.c.d, NAT64 64:ff9b::, deprecated compatible ::a.b.c.d): judge the IPv4.
	// URL parsing normalizes the dotted tail to hex (::ffff:7f00:1), so both spellings are handled.
	const e = h.match(/^(?:::ffff:|64:ff9b::|::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
	if (e) {
		const v4 = e[1] || [parseInt(e[2], 16) >> 8, parseInt(e[2], 16) & 255, parseInt(e[3], 16) >> 8, parseInt(e[3], 16) & 255].join(".");
		return isPrivateHost(v4);
	}
	return false;
}

/** Problem with an upstream URL for proxy mode ("" when fine): the Worker calls it from Cloudflare, so it must be https
 *  on a public hostname (a Cloudflare Tunnel hostname behind Access), never a Tailnet / LAN / localhost address. */
export function upstreamUrlProblem(v) {
	let u;
	try { u = new URL(v); } catch { return "is not a URL"; }
	if (u.protocol !== "https:") return "must be https";
	if (u.username || u.password) return "must not contain credentials (export UPSTREAM_TOKEN instead)";
	if (isPrivateHost(u.hostname))
		return `is a private-network address (${u.hostname}) that the Worker cannot reach: publish the agent through a Cloudflare Tunnel hostname behind Access and pass that (setup skill: "Already have A2A on a Tailnet or LAN")`;
	return "";
}
/** Problem with an upstream card URL ("" when fine): an upstream URL (see above) on the same origin (scheme, host,
 *  port) as the upstream endpoint, because the Worker fetches the card with UPSTREAM_TOKEN and the Access service
 *  token; a card on any other origin would receive those credentials. */
export function upstreamCardUrlProblem(card, upstream) {
	const why = upstreamUrlProblem(card);
	if (why) return why;
	let up;
	try { up = new URL(upstream).origin; } catch { return ""; } // the upstream URL's own problem is reported for --upstream
	const got = new URL(card).origin;
	if (got !== up)
		return `must be on the upstream's origin (${up}), not ${got}: the Worker fetches the card with UPSTREAM_TOKEN and the Access service token, which only ever go to the upstream itself`;
	return "";
}
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

export async function httpJson(url, { method, body, headers = {}, timeout = 30000 } = {}) {
	const init = { method: method || (body === undefined ? "GET" : "POST"), headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeout) };
	if (body !== undefined) {
		init.headers["content-type"] = "application/json";
		init.body = JSON.stringify(body);
	}
	let r;
	try { r = await fetch(url, init); }
	catch (e) { die(`request to ${new URL(url).origin} failed: ${e?.cause?.code || e?.cause?.message || e?.message || e}`); }
	const text = await r.text();
	let data = text;
	try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
	return { status: r.status, data };
}

// Cloudflare edge errors (HTML or "error code: NNNN" bodies, not the Worker's own JSON): code -> what it means here
const CF_ERRORS = {
	1042: "no Worker answers on this workers.dev host yet: a new deployment takes up to ~30 s to propagate; try again shortly",
	1101: "the Worker threw an exception (see the Worker's logs)",
	1102: "the Worker exceeded its CPU or memory limit",
	1015: "rate limited by Cloudflare",
	1033: "the Cloudflare Tunnel has no running connector",
	1016: "origin DNS error",
};

/** Cloudflare edge error code (1042, 1101, ...) in a response body, or null. */
export function cfErrorCode(data) {
	if (typeof data !== "string") return null;
	const m = /error(?:\s+code)?[:\s]+(1\d{3})\b/i.exec(data);
	return m ? Number(m[1]) : null;
}

/** One readable line for a failed HTTP response: the Worker's JSON error, a Cloudflare error code and title, or a short
 *  excerpt (never a raw HTML page). */
export function describeHttp(status, data) {
	const code = cfErrorCode(data);
	if (code) return `HTTP ${status}, Cloudflare error ${code}${CF_ERRORS[code] ? `: ${CF_ERRORS[code]}` : ""}`;
	if (data && typeof data === "object") {
		const e = data.error;
		const msg = typeof e === "string" ? e : e && typeof e === "object" ? `${e.code !== undefined ? `${e.code} ` : ""}${e.message || ""}`.trim() : "";
		if (msg) return `HTTP ${status}: ${msg}${data.error_description ? ` (${data.error_description})` : ""}`;
		return `HTTP ${status}: ${JSON.stringify(data).slice(0, 200)}`;
	}
	const text = String(data ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
	return `HTTP ${status}${text ? `: ${text.slice(0, 160)}${text.length > 160 ? "..." : ""}` : ""}`;
}

/** Lowercase A2A task state ("completed", "input-required", ...) from a 0.3 or 1.0 task. */
export const plainState = (t) => {
	const s = t && t.status && t.status.state;
	return typeof s === "string" && s.startsWith("TASK_STATE_") ? s.slice(11).toLowerCase().replace(/_/g, "-") : s;
};

/** First 12 hex chars of sha256(value), or null when unset (same as the Worker's `wake preview` fingerprints). */
export const fingerprint = (v) => (v ? crypto.createHash("sha256").update(String(v), "utf8").digest("hex").slice(0, 12) : null);

export function textOf(msgOrParts) {
	const parts = Array.isArray(msgOrParts) ? msgOrParts : (msgOrParts && msgOrParts.parts) || [];
	const out = [];
	for (const x of parts) {
		if (!x || typeof x !== "object") continue;
		if ("text" in x) out.push(String(x.text));
		else if ("data" in x) out.push(JSON.stringify(x.data));
		else if (x.kind === "file" || "url" in x || "raw" in x) {
			const f = x.file || {};
			out.push(`[file ${f.name || x.filename || f.uri || x.url || ""}]`);
		}
	}
	return out.join("\n");
}

export async function fetchCard(base) {
	for (const p of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
		try {
			const { status, data } = await httpJson(base + p, { timeout: 15000 });
			if (status === 200 && data && typeof data === "object") return data;
		} catch { /* try next */ }
	}
	return null;
}

/** Does an agent card send peers to `base`? "" when it does, else what it advertises instead. */
export function cardUrlProblem(card, base) {
	const norm = (u) => { try { const x = new URL(u); return x.origin + x.pathname.replace(/\/+$/, ""); } catch { return null; } };
	const want = norm(base);
	const urls = [...new Set([...((card && card.supportedInterfaces) || []).map((i) => i && i.url), card && card.url].filter(Boolean))];
	if (!urls.length) return "it advertises no endpoint URL (supportedInterfaces[].url)";
	const wrong = urls.filter((u) => norm(u) !== want);
	return wrong.length ? `it advertises ${wrong.join(", ")} instead of ${base.replace(/\/$/, "")}/` : "";
}

/** Choose the JSON-RPC endpoint + protocol version from an agent card (prefers 1.0). */
export function pickEndpoint(base, card, force) {
	const ifaces = ((card && card.supportedInterfaces) || []).filter((i) => String(i.protocolBinding || "").toUpperCase() === "JSONRPC");
	if (force) {
		const hit = ifaces.find((i) => String(i.protocolVersion || "").startsWith(force));
		if (hit) return [hit.url, force];
		return [(card && card.url) || base + "/", force];
	}
	const v1 = ifaces.find((i) => String(i.protocolVersion || "").startsWith("1"));
	if (v1) return [v1.url, "1.0"];
	if (card && card.url) return [card.url, "0.3"];
	if (ifaces.length) return [ifaces[0].url, String(ifaces[0].protocolVersion || "0.3")];
	return [base + "/", "0.3"];
}

/** JSON-RPC call to a peer. `peer` ({ alias, base }) makes a 401 say how to re-pair with that peer. */
export async function rpc(url, version, token, method03, method1, params, peer = null) {
	const v1 = version.startsWith("1");
	const headers = { "A2A-Version": v1 ? "1.0" : "0.3" };
	if (token) headers.authorization = `Bearer ${token}`;
	const body = { jsonrpc: "2.0", id: newId(), method: v1 ? method1 : method03, params };
	const { status, data } = await httpJson(url, { body, headers });
	if (status === 401) {
		const who = peer && peer.alias ? `peer "${peer.alias}"` : new URL(url).origin;
		const base = (peer && peer.base) || new URL(url).origin;
		die(token
			? `${who} rejected our token (HTTP 401: revoked, rotated, or never valid there). Re-pair: ${CLI} connect ${base}${peer && peer.alias ? ` --alias ${peer.alias}` : ""} (its owner approves), or ask its owner for a new token`
			: `${who} needs a token (HTTP 401): ${CLI} connect ${base}${peer && peer.alias ? ` --alias ${peer.alias}` : ""} (its owner approves)`);
	}
	if (status !== 200 || !data || typeof data !== "object" || "error" in data)
		die(`peer returned ${data && typeof data === "object" && data.error ? `JSON-RPC error ${describeHttp(status, data).replace(/^HTTP \d+: /, "")} (HTTP ${status})` : describeHttp(status, data)}`);
	return data.result;
}

// ---------------------------------------------------------------- proxy mode: what the upstream card asks for
// Same rules as the Worker's facade.ts (schemeKind / upstreamAuth); keep the two in step.

/** "bearer" (HTTP bearer; OAuth 2.0 / OpenID Connect also send `Authorization: Bearer`), "basic", "http", "apiKey",
 *  "mtls" or "unknown", for an A2A 1.0 ({ httpAuthSecurityScheme: ... }) or 0.3 / OpenAPI ({ type: "http", ... }) scheme. */
export function schemeKind(s) {
	if (!s || typeof s !== "object") return "unknown";
	const http = (scheme) => { const v = String(scheme || "").toLowerCase(); return v === "bearer" ? "bearer" : v === "basic" ? "basic" : "http"; };
	if (s.httpAuthSecurityScheme) return http(s.httpAuthSecurityScheme.scheme);
	if (s.oauth2SecurityScheme || s.openIdConnectSecurityScheme) return "bearer";
	if (s.apiKeySecurityScheme) return "apiKey";
	if (s.mtlsSecurityScheme || s.mutualTlsSecurityScheme) return "mtls";
	switch (String(s.type || "").toLowerCase()) {
		case "http": return http(s.scheme);
		case "oauth2": case "openidconnect": return "bearer";
		case "apikey": return "apiKey";
		case "mutualtls": return "mtls";
	}
	return "unknown";
}

/** { bearer: true | false | null, schemes: ["name: kind"], unsupported: [...] } for an upstream card. bearer: true when
 *  the card asks for a bearer token (UPSTREAM_TOKEN), false when it declares no bearer / HTTP auth (no schemes,
 *  anonymous allowed, or only schemes the façade can't present), null without a card. Requirements come from 1.0
 *  `securityRequirements` or 0.3 `security`; without requirements every declared scheme counts. */
export function upstreamAuth(card) {
	if (!card || typeof card !== "object" || Array.isArray(card)) return { bearer: null, schemes: [], unsupported: [] };
	const defs = card.securitySchemes && typeof card.securitySchemes === "object" && !Array.isArray(card.securitySchemes) ? card.securitySchemes : {};
	const kinds = {};
	for (const [n, s] of Object.entries(defs)) kinds[n] = schemeKind(s);
	const schemes = Object.entries(kinds).map(([n, k]) => `${n}: ${k}`);
	const raw = Array.isArray(card.securityRequirements) ? card.securityRequirements : Array.isArray(card.security) ? card.security : [];
	const alts = raw.filter((r) => r && typeof r === "object" && !Array.isArray(r))
		.map((r) => Object.keys(r.schemes && typeof r.schemes === "object" && !Array.isArray(r.schemes) ? r.schemes : r));
	const kindOf = (n) => kinds[n] || "unknown";
	if (!alts.length) {
		const all = Object.keys(kinds);
		const bearer = all.some((n) => kinds[n] === "bearer");
		return { bearer, schemes, unsupported: bearer ? [] : all.filter((n) => kinds[n] !== "unknown").map((n) => `${n}: ${kinds[n]}`) };
	}
	if (alts.some((a) => a.length === 0)) return { bearer: false, schemes, unsupported: [] };
	const bearer = alts.some((a) => a.some((n) => kindOf(n) === "bearer"));
	return { bearer, schemes, unsupported: bearer ? [] : [...new Set(alts.flat())].map((n) => `${n}: ${kindOf(n)}`) };
}

/** Fetch the upstream's card from this machine (setup check), with the Access service token from the environment
 *  when exported; only ever to the upstream origin (the caller checked it). Never sends UPSTREAM_TOKEN. Returns
 *  { card } or { card: null, error }. Redirects are not followed (an Access login redirect is reported as such). */
export async function fetchUpstreamCard(cardUrl, env = process.env) {
	const headers = { accept: "application/json", "user-agent": "a2a-exposed-cli" };
	if (env.UPSTREAM_ACCESS_CLIENT_ID && env.UPSTREAM_ACCESS_CLIENT_SECRET) {
		headers["cf-access-client-id"] = env.UPSTREAM_ACCESS_CLIENT_ID;
		headers["cf-access-client-secret"] = env.UPSTREAM_ACCESS_CLIENT_SECRET;
	}
	let r;
	try { r = await fetch(cardUrl, { headers, redirect: "manual", signal: AbortSignal.timeout(15000) }); }
	catch (e) { return { card: null, error: `request failed: ${e?.cause?.code || e?.cause?.message || e?.message || e}` }; }
	const text = (await r.text().catch(() => "")).slice(0, 262144);
	const loc = r.headers.get("location") || "";
	if (r.status >= 300 && r.status < 400)
		return { card: null, error: /cloudflareaccess\.com|\/cdn-cgi\/access\//i.test(loc) ? `HTTP ${r.status}: redirected to the Cloudflare Access login (export UPSTREAM_ACCESS_CLIENT_ID / UPSTREAM_ACCESS_CLIENT_SECRET so this check can pass Access)` : `HTTP ${r.status} redirect` };
	let data = null;
	try { data = JSON.parse(text); } catch { /* not JSON */ }
	if (r.status === 200 && data && typeof data === "object" && !Array.isArray(data)) return { card: data };
	return { card: null, error: describeHttp(r.status, data ?? text) };
}
