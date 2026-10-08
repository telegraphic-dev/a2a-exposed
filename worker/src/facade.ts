// Public façade helpers: agent card rewriting (the card a public caller sees must only name the façade's public
// https URL) and the proxy-mode plumbing for an agent that already speaks A2A on a private network (Tailnet, LAN,
// localhost) behind a Cloudflare Tunnel + Access. Pure functions (no Worker globals), so Node's test runner covers them.
import { isPrivateHost } from "./a2a.ts";

export type Json = any;

export type RewriteOptions = {
	/** The façade's public https origin (PUBLIC_URL), without a trailing slash. */
	publicBase: string;
	/** Origins of the private upstream (UPSTREAM_URL, UPSTREAM_CARD_URL and every interface URL the upstream card names). */
	upstreamOrigins?: string[];
};

export const REMOVED_URL = "[private URL removed]";
export const REMOVED_HOST = "[private host removed]";

/** True when a URL must never appear in a public card: not https, credentials in it, a private-network host
 *  (localhost, RFC 1918, CGNAT/Tailscale 100.64/10, private IPv6 incl. IPv4-mapped, *.ts.net, *.local, single-label
 *  names, ...), the upstream, or an http(s)/ws(s) URL that doesn't parse. */
export function isHiddenUrl(raw: string, o: RewriteOptions): boolean {
	let u: URL;
	// an http(s)/ws(s) URL that doesn't parse (e.g. an IPv6 zone id, http://[fe80::1%eth0]/) is hidden: fail closed
	try { u = new URL(raw); } catch { return /^(?:https?|wss?):\/\//i.test(raw); }
	if (!/^(https?|wss?):$/.test(u.protocol)) return false; // urn:, mailto:, ... are not network endpoints
	// the façade's own origin is what the card is about (always public on Cloudflare; http://127.0.0.1 only in local dev)
	if (o.publicBase && sameOrigin(o.publicBase, u.origin)) return false;
	if (u.protocol !== "https:" && u.protocol !== "wss:") return true;
	if (u.username || u.password) return true;
	if (isPrivateHost(u.hostname)) return true;
	return (o.upstreamOrigins || []).some((x) => sameOrigin(x, u.origin));
}

/** Same origin (scheme, host and port; default ports and host case normalised). False when either is not a URL. */
export function sameOrigin(a: string, b: string): boolean {
	try { return new URL(a).origin.toLowerCase() === new URL(b).origin.toLowerCase(); } catch { return false; }
}

const escapeRe = (s: string) => s.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");

// a bracketed IPv6 literal (http://[::1]:8080/x) counts as part of the URL; other brackets end it
const URL_IN_TEXT = /\b(?:https?|wss?):\/\/(?:\[[0-9A-Za-z:.%_-]*\]|[^\s"'<>()\[\]{}])+/gi;

/** Free text (descriptions, examples, ...): private / upstream URLs are replaced by a marker, and bare upstream or
 *  *.ts.net host names too. Public URLs stay as they are. */
export function scrubText(s: string, o: RewriteOptions): string {
	let out = s.replace(URL_IN_TEXT, (m) => {
		const trimmed = m.replace(/[.,;:!?]+$/, ""); // sentence punctuation is not part of the URL
		return isHiddenUrl(trimmed, o) ? REMOVED_URL + m.slice(trimmed.length) : m;
	});
	const hosts = new Set<string>();
	for (const x of o.upstreamOrigins || []) try { const h = new URL(x).hostname; if (h) hosts.add(h.toLowerCase()); } catch { /* skip */ }
	for (const h of hosts) out = out.replace(new RegExp("(^|[^A-Za-z0-9.-])" + escapeRe(h) + "(?::\\d+)?(?![A-Za-z0-9-])", "gi"), `$1${REMOVED_HOST}`);
	return out.replace(/(^|[^A-Za-z0-9.-])[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.ts\.net(?::\d+)?(?![A-Za-z0-9-])/gi, `$1${REMOVED_HOST}`);
}

/** Every string inside a JSON value scrubbed with scrubText, property names included (objects and arrays copied).
 *  Keys are defined, not assigned, so a "__proto__" key from upstream JSON stays a plain property. */
export function scrubDeep(v: Json, o: RewriteOptions, depth = 0): Json {
	if (depth > 20) return undefined;
	if (typeof v === "string") return scrubText(v, o);
	if (Array.isArray(v)) return v.map((x) => scrubDeep(x, o, depth + 1));
	if (v && typeof v === "object") {
		const out: Json = {};
		for (const [k, x] of Object.entries(v))
			Object.defineProperty(out, scrubText(k, o), { value: scrubDeep(x, o, depth + 1), enumerable: true, writable: true, configurable: true });
		return out;
	}
	return v;
}

/** A URL field (documentationUrl, iconUrl, provider.url): kept when public, else undefined (dropped). */
export function publicUrlOrNothing(v: unknown, o: RewriteOptions): string | undefined {
	if (typeof v !== "string" || !v) return undefined;
	try { new URL(v); } catch { return undefined; }
	return isHiddenUrl(v, o) ? undefined : v;
}

/** Origins named by an upstream card (1.0 supportedInterfaces, 0.3 url / additionalInterfaces): all are private
 *  as far as the public card is concerned, because callers only ever reach the upstream through the façade. */
export function upstreamCardOrigins(card: Json): string[] {
	const urls: unknown[] = [];
	if (card && typeof card === "object") {
		urls.push(card.url);
		for (const i of [...(Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : []), ...(Array.isArray(card.additionalInterfaces) ? card.additionalInterfaces : [])])
			if (i && typeof i === "object") urls.push(i.url);
	}
	const out = new Set<string>();
	for (const u of urls) if (typeof u === "string") try { out.add(new URL(u).origin); } catch { /* skip */ }
	return [...out];
}

/** JSON-RPC protocol versions the upstream card advertises ("1.0", "0.3"); empty when it names none we can proxy. */
export function upstreamJsonRpcVersions(card: Json): string[] {
	const out = new Set<string>();
	if (!card || typeof card !== "object") return [];
	const norm = (v: unknown) => { const m = String(v ?? "").match(/^(\d+)\.(\d+)/); return m ? `${m[1]}.${m[2]}` : ""; };
	if (Array.isArray(card.supportedInterfaces))
		for (const i of card.supportedInterfaces)
			if (i && /^jsonrpc$/i.test(String(i.protocolBinding || i.transport || ""))) { const v = norm(i.protocolVersion); if (v) out.add(v); }
	// 0.3 card: top-level protocolVersion + preferredTransport (default JSONRPC) or a JSONRPC additional interface
	if (card.protocolVersion && (!card.preferredTransport || /^jsonrpc$/i.test(card.preferredTransport) ||
		(Array.isArray(card.additionalInterfaces) && card.additionalInterfaces.some((i: Json) => i && /^jsonrpc$/i.test(String(i.transport || "")))))) {
		const v = norm(card.protocolVersion); if (v) out.add(v);
	}
	return [...out].filter((v) => v === "1.0" || v === "0.3").sort().reverse();
}

export type CardConfig = {
	name?: string; description?: string; version?: string; skills?: Json[];
	providerOrganization?: string; providerUrl?: string; documentationUrl?: string;
};

export type FacadeCardInput = {
	upstream: Json | null; // the upstream's own card (1.0 or 0.3 shape), or null when unavailable
	config: CardConfig; // operator overrides (AGENT_* vars): win over upstream values
	publicBase: string;
	upstreamOrigins: string[];
	securitySchemes: Json; // the façade's (bearer + pairing): never the upstream's
	securityRequirements: Json[];
	defaults: { description: string; skills: Json[] };
};

/** The public A2A 1.0 card for a façade in front of a private upstream.
 *
 *  Rewrite rules (documented in the README and the setup skill):
 *  - supportedInterfaces: one JSONRPC interface per protocol version the upstream advertises (1.0 / 0.3; both when the
 *    upstream card is unavailable), every one at `${publicBase}/`. Upstream interface URLs, gRPC / HTTP+JSON
 *    interfaces, `url`, `additionalInterfaces` and `preferredTransport` are never copied.
 *  - securitySchemes / securityRequirements: the façade's (per-peer bearer + device-flow pairing on the façade); the
 *    upstream's schemes describe the credential the façade holds, not what a caller needs.
 *  - capabilities: extensions from the upstream; streaming, pushNotifications and extendedAgentCard are false (the
 *    façade does not proxy SSE or the extended card yet, and refuses push configs: see wantsPush).
 *  - name, description, version, skills, default modes, provider, documentationUrl, iconUrl: operator config first,
 *    then the upstream card, then defaults. Every string is scrubbed: private / upstream URLs become
 *    "[private URL removed]", bare upstream and *.ts.net host names "[private host removed]"; documentationUrl,
 *    iconUrl and provider.url are dropped instead when private (provider is dropped without a public url).
 *  - signatures are dropped (the rewritten card no longer matches them); unknown top-level fields are not copied. */
export function facadeCard(i: FacadeCardInput): Json {
	const up: Json = i.upstream && typeof i.upstream === "object" ? i.upstream : {};
	const o: RewriteOptions = { publicBase: i.publicBase, upstreamOrigins: i.upstreamOrigins };
	const base = i.publicBase.replace(/\/$/, "");
	const str = (...vs: unknown[]) => { for (const v of vs) if (typeof v === "string" && v.trim()) return v; return undefined; };
	const versions = i.upstream ? upstreamJsonRpcVersions(up) : [];
	// media types only (type/subtype[;params]); anything else in the upstream's mode lists is dropped
	const modes = (v: unknown) => {
		const ok = Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.length <= 128 && /^[\w.+-]+\/[\w.+*-]+(?:\s*;[^/]*)?$/.test(x)) : [];
		return ok.length ? ok.slice(0, 32) : ["text/plain", "application/json"];
	};
	const upSkills = Array.isArray(up.skills) && up.skills.length ? up.skills.filter((s: Json) => s && typeof s === "object") : null;
	const card: Json = {
		name: scrubText(str(i.config.name, up.name) || "A2A Agent", o),
		description: scrubText(str(i.config.description, up.description) || i.defaults.description, o),
		version: scrubText(str(i.config.version, up.version) || "1.0.0", o),
		supportedInterfaces: (versions.length ? versions : ["1.0", "0.3"]).map((v) => ({ url: base + "/", protocolBinding: "JSONRPC", protocolVersion: v })),
		securitySchemes: i.securitySchemes,
		securityRequirements: i.securityRequirements,
		capabilities: {
			streaming: false,
			pushNotifications: false,
			extendedAgentCard: false,
			...(Array.isArray(up.capabilities?.extensions) && up.capabilities.extensions.length ? { extensions: scrubDeep(up.capabilities.extensions, o) } : {}),
		},
		defaultInputModes: modes(up.defaultInputModes),
		defaultOutputModes: modes(up.defaultOutputModes),
		skills: scrubDeep(i.config.skills?.length ? i.config.skills : upSkills || i.defaults.skills, o),
	};
	const provOrg = str(i.config.providerOrganization, up.provider?.organization);
	const provUrl = publicUrlOrNothing(i.config.providerOrganization ? i.config.providerUrl : up.provider?.url, o);
	if (provOrg && provUrl) card.provider = { organization: scrubText(provOrg, o), url: provUrl };
	const doc = publicUrlOrNothing(str(i.config.documentationUrl, up.documentationUrl), o);
	if (doc) card.documentationUrl = doc;
	const icon = publicUrlOrNothing(up.iconUrl, o);
	if (icon) card.iconUrl = icon;
	// catch-all: one more scrub over the finished card (keys included), so a field added above can't leak by mistake;
	// the façade's own URLs are public https and pass through unchanged
	return scrubDeep(card, o);
}

/** Final pass over any card the Worker serves (inbox or façade): the interface URLs must be the public base, and no
 *  string may name a private network. Returns the problems found (empty = clean); tests assert on it. */
export function cardLeaks(card: Json, publicBase: string, upstreamOrigins: string[] = []): string[] {
	const out: string[] = [];
	const o: RewriteOptions = { publicBase, upstreamOrigins };
	const walk = (v: Json, p: string) => {
		if (typeof v === "string") {
			for (const m of v.match(URL_IN_TEXT) || []) if (isHiddenUrl(m.replace(/[.,;:!?]+$/, ""), o)) out.push(`${p}: ${m}`);
			if (/\.ts\.net\b/i.test(v)) out.push(`${p}: ${v}`);
		} else if (Array.isArray(v)) v.forEach((x, k) => walk(x, `${p}[${k}]`));
		else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { walk(k, `${p || "."} (key)`); walk(x, p ? `${p}.${k}` : k); }
	};
	walk(card, "");
	return out;
}

// ------------------------------------------------------------------ proxy mode

/** UPSTREAM_URL as the Worker will call it: an https URL without credentials on a public hostname (a Tunnel hostname
 *  behind Access); a Worker cannot reach a Tailnet, LAN or loopback address. Returns [url, ""] or ["", why]. */
export function upstreamEndpoint(v: string | undefined): [string, string] {
	const s = (v || "").trim();
	if (!s) return ["", "UPSTREAM_URL is not set"];
	let u: URL;
	try { u = new URL(s); } catch { return ["", "UPSTREAM_URL is not a URL"]; }
	if (u.protocol !== "https:") return ["", "UPSTREAM_URL must be https"];
	if (u.username || u.password) return ["", "UPSTREAM_URL must not carry credentials"];
	if (isPrivateHost(u.hostname))
		return ["", "UPSTREAM_URL is a private-network address the Worker cannot reach: publish the agent through a Cloudflare Tunnel hostname behind Access"];
	return [u.href, ""];
}

/** Where the upstream's own card is: UPSTREAM_CARD_URL, else <upstream origin>/.well-known/agent-card.json.
 *  The card fetch carries the façade's upstream credentials (UPSTREAM_TOKEN, the Access service token), so a
 *  configured card URL must be on the UPSTREAM_URL origin; anything else (another origin, not https, not a URL) is
 *  refused and never fetched, rather than silently replaced. Returns [url, ""] or ["", why]. */
export function upstreamCardUrl(endpoint: string, configured: string | undefined): [string, string] {
	const c = (configured || "").trim();
	if (!c) return [new URL("/.well-known/agent-card.json", endpoint).href, ""];
	const [u, why] = upstreamEndpoint(c);
	if (!u) return ["", why.replace(/^UPSTREAM_URL/, "UPSTREAM_CARD_URL")];
	if (!sameOrigin(u, endpoint))
		return ["", `UPSTREAM_CARD_URL must be on the UPSTREAM_URL origin (${new URL(endpoint).origin}), not ${new URL(u).origin}: the card fetch carries the upstream credentials`];
	return [u, ""];
}

/** Task / context ids the upstream returned for a SendMessage (1.0 { task } / { message }, 0.3 Task / Message). */
export function idsFromResult(result: Json): { taskId?: string; contextId?: string } {
	if (!result || typeof result !== "object") return {};
	const isMsg = !!result.message || result.kind === "message";
	const r = result.task || result.message || result;
	if (!r || typeof r !== "object") return {};
	const taskId = isMsg ? r.taskId : r.id;
	return { taskId: typeof taskId === "string" ? taskId : undefined, contextId: typeof r.contextId === "string" ? r.contextId : undefined };
}

/** The task a JSON-RPC call (other than SendMessage) is about, from the 1.0 or 0.3 params shapes. */
export function taskIdOf(op: string, p: Json): unknown {
	if (!p || typeof p !== "object") return undefined;
	const fromName = (n: unknown) => (typeof n === "string" && n.startsWith("tasks/") ? n.split("/")[1] : undefined);
	if (op === "get" || op === "cancel") return p.id ?? fromName(p.name);
	if (op === "pushset") return p.taskId ?? fromName(p.parent);
	// pushget / pushlist / pushdel: 1.0 { taskId, id }, 0.3 { id: taskId, pushNotificationConfigId }
	return p.taskId ?? fromName(p.parent) ?? fromName(p.name) ?? p.id;
}

/** The request asks the upstream for push notifications: a push config call, or SendMessage with a push config in
 *  its configuration (1.0 taskPushNotificationConfig, 0.3 pushNotificationConfig, any spelling). Proxy mode refuses
 *  these: the upstream would call the URL from inside the private network, where a public-looking name can resolve to a
 *  private address (127.0.0.1.nip.io, split-horizon DNS), so no check at the façade can make that safe. */
export function wantsPush(op: string, p: Json): boolean {
	if (op.startsWith("push")) return true;
	if (op !== "send" || !p || typeof p !== "object" || !p.configuration || typeof p.configuration !== "object") return false;
	return Object.entries(p.configuration).some(([k, v]) => /push/i.test(k) && v !== undefined && v !== null);
}

// ------------------------------------------------------------------ upstream auth + failure diagnosis (proxy mode)

/** How an upstream security scheme authenticates: "bearer" (HTTP bearer; OAuth 2.0 and OpenID Connect also send
 *  `Authorization: Bearer`), "basic" / "http" (other HTTP schemes), "apiKey", "mtls", or "unknown". Accepts the A2A 1.0
 *  shape ({ httpAuthSecurityScheme: { scheme } }, { oauth2SecurityScheme }, ...) and the 0.3 / OpenAPI shape
 *  ({ type: "http", scheme: "bearer" }, { type: "oauth2" }, ...). */
export function schemeKind(s: Json): string {
	if (!s || typeof s !== "object") return "unknown";
	const http = (scheme: unknown) => { const v = String(scheme || "").toLowerCase(); return v === "bearer" ? "bearer" : v === "basic" ? "basic" : "http"; };
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

export type UpstreamAuth = {
	/** true: the card asks for a bearer token (UPSTREAM_TOKEN); false: it declares no bearer / HTTP auth (no schemes, or
	 *  anonymous access allowed, or only schemes the façade can't present); null: no card to tell. */
	bearer: boolean | null;
	/** Declared schemes as "name: kind" (names and kinds only, never values). */
	schemes: string[];
	/** Required schemes the façade can't present (it only sends `Authorization: Bearer <UPSTREAM_TOKEN>`). */
	unsupported: string[];
};

/** What the upstream card says about authenticating to it. Security requirements are read from A2A 1.0
 *  `securityRequirements` ([{ schemes: { name: { list: [] } } }]) or 0.3 `security` ([{ name: [] }]); without
 *  requirements every declared scheme counts. An empty requirement ({}) means anonymous access is allowed. */
export function upstreamAuth(card: Json): UpstreamAuth {
	if (!card || typeof card !== "object" || Array.isArray(card)) return { bearer: null, schemes: [], unsupported: [] };
	const defs: Record<string, Json> = card.securitySchemes && typeof card.securitySchemes === "object" && !Array.isArray(card.securitySchemes) ? card.securitySchemes : {};
	const kinds: Record<string, string> = {};
	for (const [n, s] of Object.entries(defs)) kinds[n] = schemeKind(s);
	const schemes = Object.entries(kinds).map(([n, k]) => `${n}: ${k}`);
	const raw = Array.isArray(card.securityRequirements) ? card.securityRequirements : Array.isArray(card.security) ? card.security : [];
	const alts: string[][] = raw.filter((r: Json) => r && typeof r === "object" && !Array.isArray(r))
		.map((r: Json) => Object.keys(r.schemes && typeof r.schemes === "object" && !Array.isArray(r.schemes) ? r.schemes : r));
	const kindOf = (n: string) => kinds[n] || "unknown";
	if (!alts.length) {
		const all = Object.keys(kinds);
		return { bearer: all.some((n) => kinds[n] === "bearer"), schemes, unsupported: all.some((n) => kinds[n] === "bearer") ? [] : all.filter((n) => kinds[n] !== "unknown").map((n) => `${n}: ${kinds[n]}`) };
	}
	if (alts.some((a) => a.length === 0)) return { bearer: false, schemes, unsupported: [] }; // anonymous allowed
	const bearer = alts.some((a) => a.some((n) => kindOf(n) === "bearer"));
	const unsupported = bearer ? [] : [...new Set(alts.flat())].map((n) => `${n}: ${kindOf(n)}`);
	return { bearer, schemes, unsupported };
}

/** Why a call to the upstream did not produce a JSON-RPC answer, as a stable reason code (Worker logs, the owner
 *  diagnostics, `status`). Never shown to peers: their 502 stays generic. */
export type UpstreamReason =
	| "reachable" // a JSON-RPC response came back (any result or error): Access, the tunnel and the bearer all passed
	| "access_credentials_missing" // Cloudflare Access refused the request and the façade has no Access service token
	| "access_rejected" // Cloudflare Access refused the façade's service token (wrong token, or not admitted by the app's policy)
	| "upstream_auth_missing" // the agent answered 401/403 and the façade has no UPSTREAM_TOKEN
	| "upstream_auth_rejected" // the agent answered 401/403 to the façade's UPSTREAM_TOKEN
	| "tunnel_down" // Cloudflare could not reach the tunnel / origin (error 1033, 1016, 530, ...)
	| "upstream_unavailable" // a 5xx without JSON-RPC (cloudflared up, the agent's server not answering)
	| "network" // the fetch itself failed (DNS, TLS, timeout)
	| "unexpected_response" // anything else that is not JSON-RPC (a 404 page, HTML, a redirect elsewhere)
	| "misconfigured"; // UPSTREAM_URL unusable

export type UpstreamVerdict = { reason: UpstreamReason; status: number | null; cloudflareError?: string; rpcErrorCode?: number; detail: string };

/** Classify one upstream HTTP answer (or a fetch failure: status null + error). Pure; `bearerSent` says whether the
 *  façade sent UPSTREAM_TOKEN, `accessSent` whether it sent an Access service token (false turns an Access refusal into
 *  access_credentials_missing). Access is recognised by its login redirect (<team>.cloudflareaccess.com,
 *  /cdn-cgi/access/), its CF-Access-* response headers, or its error page. */
export function classifyUpstream(i: { status: number | null; headers?: Headers | Record<string, string>; body?: string; error?: string; bearerSent: boolean; accessSent?: boolean }): UpstreamVerdict {
	if (i.status === null) return { reason: "network", status: null, detail: `request failed: ${String(i.error || "unknown error").slice(0, 200)}` };
	const status = i.status;
	const body = String(i.body || "");
	const get = (k: string): string => {
		const h: any = i.headers;
		if (!h) return "";
		if (typeof h.get === "function") return h.get(k) || "";
		for (const [n, v] of Object.entries(h)) if (n.toLowerCase() === k) return String(v);
		return "";
	};
	const names: string[] = [];
	const h: any = i.headers;
	if (h && typeof h.forEach === "function" && typeof h.get === "function") h.forEach((_v: string, k: string) => names.push(k.toLowerCase()));
	else if (h) names.push(...Object.keys(h).map((k) => k.toLowerCase()));
	let rpc: Json = null;
	try { rpc = JSON.parse(body); } catch { /* not JSON */ }
	if (rpc && typeof rpc === "object" && !Array.isArray(rpc) && rpc.jsonrpc === "2.0" && status !== 401 && status !== 403) {
		const code = rpc.error && typeof rpc.error === "object" && typeof rpc.error.code === "number" ? rpc.error.code : undefined;
		return { reason: "reachable", status, ...(code !== undefined ? { rpcErrorCode: code } : {}),
			detail: code !== undefined ? `JSON-RPC error ${code} (HTTP ${status})` : `JSON-RPC result (HTTP ${status})` };
	}
	const location = get("location");
	const accessPage = /cloudflareaccess\.com|\/cdn-cgi\/access\//i.test(location) || /cloudflareaccess\.com|\/cdn-cgi\/access\/|Cloudflare Access/i.test(body.slice(0, 8192));
	const accessHeader = names.some((n) => n.startsWith("cf-access-"));
	if ((status >= 300 && status < 400 && /cloudflareaccess\.com|\/cdn-cgi\/access\//i.test(location)) || ((status === 401 || status === 403) && (accessPage || accessHeader)))
		return { reason: i.accessSent === false ? "access_credentials_missing" : "access_rejected", status,
			detail: `${status >= 300 && status < 400 ? `HTTP ${status} redirect to the Cloudflare Access login` : `HTTP ${status} from Cloudflare Access`}: ${i.accessSent === false
				? "the façade has no Access service token (UPSTREAM_ACCESS_CLIENT_ID / _SECRET)" : "Access refused the façade's service token (wrong token, or the app's policy doesn't admit it)"}` };
	if (status === 401 || status === 403)
		return i.bearerSent
			? { reason: "upstream_auth_rejected", status, detail: `HTTP ${status} from the agent: it refused the façade's UPSTREAM_TOKEN` }
			: { reason: "upstream_auth_missing", status, detail: `HTTP ${status} from the agent: it wants a credential and the façade has no UPSTREAM_TOKEN` };
	const m = /error code:?\s*(\d{4})|\bError\s+(\d{4})\b|errorCode:?\s*(\d{4})|cf-error-code[^>]*>\s*(\d{4})/i.exec(body.slice(0, 8192));
	const cf = m ? m[1] || m[2] || m[3] || m[4] : "";
	if (cf === "1033" || cf === "1016" || status === 530)
		return { reason: "tunnel_down", status, ...(cf ? { cloudflareError: cf } : {}), detail: `HTTP ${status}${cf ? `, Cloudflare error ${cf}` : ""}: Cloudflare can't reach the tunnel (is cloudflared running?)` };
	if (status >= 500)
		return { reason: "upstream_unavailable", status, ...(cf ? { cloudflareError: cf } : {}), detail: `HTTP ${status}${cf ? `, Cloudflare error ${cf}` : ""} without a JSON-RPC answer: the agent's server behind the tunnel is not answering` };
	return { reason: "unexpected_response", status, ...(cf ? { cloudflareError: cf } : {}),
		detail: `HTTP ${status} without a JSON-RPC answer${status >= 300 && status < 400 && location ? " (a redirect)" : ""}: is UPSTREAM_URL the agent's JSON-RPC endpoint?` };
}
