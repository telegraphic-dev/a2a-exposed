// Hosted owner RPC allowlist. The caller has checked that the account owns the tenant.
// This list is the only paths that call may run, and it is stricter than
// the owner HTTP API: routes that mint a peer token or return a setup secret are not here.
// PUT /owner/outbound-peers/:alias is the one call that accepts a peer token. handleOwner seals it.
// The response is { ok, alias, hasToken } and the token is not logged.
// GET /owner/export is here only because runOwnerRpc redacts it first.
// POST /owner/mcp/send, reply, and mark_working take a checked argument object. A peer token is not one of those arguments.
// Self-host never calls this.

import { ID_RE } from "./a2a.ts";
import { credentialIsMasked, previewHeaderPlain } from "./wake.ts";

/** Account id. Slashes and dots are refused so the value cannot be a path. */
export const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const LABEL = /^[A-Za-z0-9_-]{1,32}$/;
const MCP_LABEL = /^[A-Za-z0-9_-]{1,64}$/;
const ALIAS = /^[A-Za-z0-9_.-]{1,64}$/;
/** Display form WDJB-4827 or the stored form WDJB4827. Vowels and 0/1 are not in a real code. */
const USER_CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-?[2-9]{4}$/i;

/** Peer tokens, MCP tokens, and the hosted owner token (`a2aot_`). */
export const TOKEN_PREFIXES = ["a2aow_", "s2a_", "a2amcp_", "a2amcpr_", "a2aot_"] as const;
const TOKEN_RE = new RegExp(`^(?:${TOKEN_PREFIXES.join("|")})[A-Za-z0-9_-]{20,}$`);
const SETUP_RE = /(?:\?|&)t=[A-Za-z0-9_-]{16,}/;
const USERINFO_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/?\s]*@/i;
/** A non-empty string under one of these keys is a secret, even when it is not a token shape. */
const SECRET_KEYS = new Set([
	"token", "access_token", "refresh_token", "device_code",
	"ownertoken", "owner_token", "secretsenc", "secrets_enc",
	"clientsecret", "client_secret", "pushtoken", "push_token", "authorization",
	"privatekey", "private_key",
]);

/**
 * Header `runOwnerRpc` sets when `actor` is `human`. `handleOwner` honors it only on an in-process call.
 * A request from the network cannot become that decision by sending the header.
 */
export const DASHBOARD_ACTOR_HEADER = "x-a2a-dashboard-actor";

export interface OwnerRpcRequest {
	accountId: string;
	method: string;
	path: string;
	/** Allowlisted query parameters only. */
	query?: Record<string, string>;
	/**
	 * Tool arguments for `POST /owner/mcp/send`, `POST /owner/mcp/reply`, and `POST /owner/mcp/mark_working`,
	 * or `{ url, token }` for `PUT /owner/outbound-peers/:alias`. Any other call refuses a body.
	 */
	body?: unknown;
	/**
	 * Approve or deny after a recent sign-in.
	 * Any other value is refused. Absent keeps the owner HTTP API's actor (`agent` or `owner`).
	 */
	actor?: "human";
}

export interface OwnerRpcResult {
	status: number;
	body: unknown;
	/** Set when `GET /owner/inbox` has another page. The body stays the task array. */
	nextCursor?: string;
}

export interface OwnerRoute {
	method: "GET" | "POST" | "DELETE" | "PUT";
	path: string;
	search: string;
	/** Log name. Ids and codes are not included. */
	name: string;
}

export type OwnerMatch = { ok: true; route: OwnerRoute } | { ok: false; reason: "path" | "query" };

export function accountIdOf(v: unknown): string | null {
	return typeof v === "string" && ACCOUNT_ID_RE.test(v) ? v : null;
}

function segments(path: unknown): string[] | null {
	if (typeof path !== "string" || path.length > 300 || !path.startsWith("/owner/")) return null;
	if (path.includes("%") || path.includes("\\") || path.includes("?") || path.includes("#") || path.includes("//")) return null;
	const seg = path.split("/").filter(Boolean);
	if (seg[0] !== "owner" || seg.some((s) => s === "." || s === "..")) return null;
	return seg;
}

function queryRecord(query: unknown): Record<string, string> | null {
	if (query == null) return {};
	if (typeof query !== "object" || Array.isArray(query)) return null;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(query)) {
		// Inbox cursors are base64url(updated_at, id). An id can be 128 characters, so this is wider than a context id.
		if (typeof v !== "string" || v.length > 256) return null;
		out[k] = v;
	}
	return out;
}

function idOk(s: string): boolean {
	return ID_RE.test(s) && s !== "." && s !== "..";
}

function noQuery(q: Record<string, string>): string | null {
	return Object.keys(q).length === 0 ? "" : null;
}

function inboxQuery(q: Record<string, string>): string | null {
	for (const k of Object.keys(q)) if (k !== "context" && k !== "all" && k !== "limit" && k !== "cursor" && k !== "from") return null;
	if (q.context !== undefined && !idOk(q.context)) return null;
	if (q.all !== undefined && q.all !== "1") return null;
	if (q.limit !== undefined && (!/^[1-9]\d{0,2}$/.test(q.limit) || Number(q.limit) > 200)) return null;
	if (q.cursor !== undefined && !/^[A-Za-z0-9_-]{1,256}$/.test(q.cursor)) return null;
	if (q.from !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(q.from)) return null;
	const sp = new URLSearchParams();
	if (q.context) sp.set("context", q.context);
	if (q.all) sp.set("all", "1");
	if (q.limit) sp.set("limit", q.limit);
	if (q.cursor) sp.set("cursor", q.cursor);
	if (q.from) sp.set("from", q.from);
	const s = sp.toString();
	return s ? `?${s}` : "";
}

function historyQuery(q: Record<string, string>): string | null {
	for (const k of Object.keys(q)) if (k !== "n" && k !== "from") return null;
	if (q.n !== undefined && (!/^[1-9][0-9]{0,3}$/.test(q.n) || Number(q.n) > 1000)) return null;
	if (q.from !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(q.from)) return null;
	const sp = new URLSearchParams();
	if (q.n) sp.set("n", q.n);
	if (q.from) sp.set("from", q.from);
	const s = sp.toString();
	return s ? `?${s}` : "";
}

/** `format=sql` is the only export query. The RPC still calls the JSON handler and redacts before building SQL. */
function exportQuery(q: Record<string, string>): string | null {
	for (const k of Object.keys(q)) if (k !== "format") return null;
	if (q.format === undefined) return "";
	if (q.format !== "sql") return null;
	return "?format=sql";
}

interface RouteDef {
	method: "GET" | "POST" | "DELETE" | "PUT";
	name: string;
	take: (seg: string[]) => boolean;
	search: (q: Record<string, string>) => string | null;
	path: (seg: string[]) => string;
}

const ROUTES: RouteDef[] = [
	{ method: "GET", name: "GET /owner/inbox", take: (s) => s.length === 2 && s[1] === "inbox", search: inboxQuery, path: () => "/owner/inbox" },
	{ method: "GET", name: "GET /owner/summary", take: (s) => s.length === 2 && s[1] === "summary", search: noQuery, path: () => "/owner/summary" },
	{ method: "GET", name: "GET /owner/tasks/:id", take: (s) => s.length === 3 && s[1] === "tasks" && idOk(s[2]!), search: noQuery, path: (s) => `/owner/tasks/${s[2]}` },
	{ method: "GET", name: "GET /owner/history/:id", take: (s) => s.length === 3 && s[1] === "history" && idOk(s[2]!), search: historyQuery, path: (s) => `/owner/history/${s[2]}` },
	{ method: "GET", name: "GET /owner/outbound/:id", take: (s) => s.length === 3 && s[1] === "outbound" && idOk(s[2]!), search: noQuery, path: (s) => `/owner/outbound/${s[2]}` },
	{ method: "GET", name: "GET /owner/address", take: (s) => s.length === 2 && s[1] === "address", search: noQuery, path: () => "/owner/address" },
	{ method: "GET", name: "GET /owner/identity", take: (s) => s.length === 2 && s[1] === "identity", search: noQuery, path: () => "/owner/identity" },
	{ method: "POST", name: "POST /owner/peers/announce", take: (s) => s.length === 3 && s[1] === "peers" && s[2] === "announce", search: noQuery, path: () => "/owner/peers/announce" },
	{ method: "PUT", name: "PUT /owner/address-forward", take: (s) => s.length === 2 && s[1] === "address-forward", search: noQuery, path: () => "/owner/address-forward" },
	{ method: "DELETE", name: "DELETE /owner/address-forward", take: (s) => s.length === 2 && s[1] === "address-forward", search: noQuery, path: () => "/owner/address-forward" },
	{ method: "GET", name: "GET /owner/peers", take: (s) => s.length === 2 && s[1] === "peers", search: noQuery, path: () => "/owner/peers" },
	{ method: "DELETE", name: "DELETE /owner/peers/:label", take: (s) => s.length === 3 && s[1] === "peers" && LABEL.test(s[2]!), search: noQuery, path: (s) => `/owner/peers/${s[2]}` },
	{ method: "GET", name: "GET /owner/pairing", take: (s) => s.length === 2 && s[1] === "pairing", search: noQuery, path: () => "/owner/pairing" },
	{ method: "POST", name: "POST /owner/pairing/:code/approve", take: (s) => s.length === 4 && s[1] === "pairing" && USER_CODE.test(s[2]!) && s[3] === "approve", search: noQuery, path: (s) => `/owner/pairing/${s[2]}/approve` },
	{ method: "POST", name: "POST /owner/pairing/:code/deny", take: (s) => s.length === 4 && s[1] === "pairing" && USER_CODE.test(s[2]!) && s[3] === "deny", search: noQuery, path: (s) => `/owner/pairing/${s[2]}/deny` },
	{ method: "GET", name: "GET /owner/mcp", take: (s) => s.length === 2 && s[1] === "mcp", search: noQuery, path: () => "/owner/mcp" },
	{ method: "DELETE", name: "DELETE /owner/mcp/:label", take: (s) => s.length === 3 && s[1] === "mcp" && MCP_LABEL.test(s[2]!), search: noQuery, path: (s) => `/owner/mcp/${s[2]}` },
	{ method: "POST", name: "POST /owner/mcp/send", take: (s) => s.length === 3 && s[1] === "mcp" && s[2] === "send", search: noQuery, path: () => "/owner/mcp/send" },
	{ method: "POST", name: "POST /owner/mcp/reply", take: (s) => s.length === 3 && s[1] === "mcp" && s[2] === "reply", search: noQuery, path: () => "/owner/mcp/reply" },
	{ method: "POST", name: "POST /owner/mcp/mark_working", take: (s) => s.length === 3 && s[1] === "mcp" && s[2] === "mark_working", search: noQuery, path: () => "/owner/mcp/mark_working" },
	{ method: "POST", name: "POST /owner/mcp/announce_address", take: (s) => s.length === 3 && s[1] === "mcp" && s[2] === "announce_address", search: noQuery, path: () => "/owner/mcp/announce_address" },
	{ method: "GET", name: "GET /owner/outbound-peers", take: (s) => s.length === 2 && s[1] === "outbound-peers", search: noQuery, path: () => "/owner/outbound-peers" },
	{ method: "PUT", name: "PUT /owner/outbound-peers/:alias", take: (s) => s.length === 3 && s[1] === "outbound-peers" && ALIAS.test(s[2]!) && s[2] !== "." && s[2] !== "..", search: noQuery, path: (s) => `/owner/outbound-peers/${s[2]}` },
	{ method: "DELETE", name: "DELETE /owner/outbound-peers/:alias", take: (s) => s.length === 3 && s[1] === "outbound-peers" && ALIAS.test(s[2]!) && s[2] !== "." && s[2] !== "..", search: noQuery, path: (s) => `/owner/outbound-peers/${s[2]}` },
	{ method: "GET", name: "GET /owner/facade", take: (s) => s.length === 2 && s[1] === "facade", search: noQuery, path: () => "/owner/facade" },
	{ method: "POST", name: "POST /owner/facade/verify", take: (s) => s.length === 3 && s[1] === "facade" && s[2] === "verify", search: noQuery, path: () => "/owner/facade/verify" },
	{ method: "GET", name: "GET /owner/wake/preview", take: (s) => s.length === 3 && s[1] === "wake" && s[2] === "preview", search: noQuery, path: () => "/owner/wake/preview" },
	{ method: "POST", name: "POST /owner/wake/test", take: (s) => s.length === 3 && s[1] === "wake" && s[2] === "test", search: noQuery, path: () => "/owner/wake/test" },
	{ method: "GET", name: "GET /owner/contexts", take: (s) => s.length === 2 && s[1] === "contexts", search: noQuery, path: () => "/owner/contexts" },
	{ method: "GET", name: "GET /owner/log", take: (s) => s.length === 2 && s[1] === "log", search: noQuery, path: () => "/owner/log" },
	{ method: "GET", name: "GET /owner/export", take: (s) => s.length === 2 && s[1] === "export", search: exportQuery, path: () => "/owner/export" },
];

/** Method + path (+ query) on the owner RPC allowlist, or why it is not. */
export function matchOwnerRpc(method: unknown, path: unknown, query: unknown): OwnerMatch {
	if (method !== "GET" && method !== "POST" && method !== "DELETE" && method !== "PUT") return { ok: false, reason: "path" };
	const seg = segments(path);
	if (!seg) return { ok: false, reason: "path" };
	const def = ROUTES.find((r) => r.method === method && r.take(seg));
	if (!def) return { ok: false, reason: "path" };
	const q = queryRecord(query);
	if (!q) return { ok: false, reason: "query" };
	const search = def.search(q);
	if (search === null) return { ok: false, reason: "query" };
	return { ok: true, route: { method, path: def.path(seg), search, name: def.name } };
}

/** Send text cap. The owner HTTP body limit is 1 MiB; this keeps one argument inside that. */
const TEXT_MAX = 100_000;
const REPLY_STATES = new Set(["completed", "input-required", "working", "failed", "rejected"]);

const MCP_ARGS: Record<string, { required: readonly string[]; optional: readonly string[] }> = {
	"POST /owner/mcp/send": { required: ["to", "text"], optional: ["contextId", "taskId"] },
	"POST /owner/mcp/reply": { required: ["taskId", "text"], optional: ["state"] },
	"POST /owner/mcp/mark_working": { required: ["taskId"], optional: [] },
};

function mcpArgOk(key: string, value: string): string | null {
	if (key === "to") return ALIAS.test(value) ? null : "to is invalid";
	if (key === "text") {
		if (!value.trim()) return "text is required";
		if (value.length > TEXT_MAX) return "text is too long";
		return null;
	}
	if (key === "taskId" || key === "contextId") return idOk(value) ? null : `${key} is invalid`;
	if (key === "state") return REPLY_STATES.has(value) ? null : "state is invalid";
	return "body is not allowed";
}

const PEER_URL_MAX = 2048;
const PEER_TOKEN_MAX = 4096;

/** `{ url, token }` for a synced outbound peer. `token` may be omitted when the peer takes none. No other keys. */
function outboundPeerBody(body: unknown): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
	if (body == null || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be an object" };
	const keys = Object.keys(body);
	if (keys.length > 2 || keys.some((key) => key !== "url" && key !== "token")) return { ok: false, error: "body is not allowed" };
	const url = (body as Record<string, unknown>).url;
	if (typeof url !== "string" || !url.trim()) return { ok: false, error: "url is required" };
	if (url.length > PEER_URL_MAX) return { ok: false, error: "url is invalid" };
	const value: Record<string, string> = { url };
	if (Object.prototype.hasOwnProperty.call(body, "token")) {
		const token = (body as Record<string, unknown>).token;
		if (typeof token !== "string" || !token || token.length > PEER_TOKEN_MAX) return { ok: false, error: "token is invalid" };
		value.token = token;
	}
	return { ok: true, value };
}

/** `{ to }` or `{ all: true }` for an address announcement. No token, no private key. */
function announceBody(body: unknown): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
	if (body == null || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be an object" };
	const keys = Object.keys(body);
	if (keys.length > 2 || keys.some((key) => key !== "to" && key !== "all")) return { ok: false, error: "body is not allowed" };
	const raw = body as Record<string, unknown>;
	const all = raw.all === true || raw.all === "true";
	const to = raw.to;
	if (to !== undefined && (typeof to !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(to))) return { ok: false, error: "to is invalid" };
	if (all === !!to) return { ok: false, error: "pass to (one alias) or all: true" };
	return { ok: true, value: all ? { all: "true" } : { to: String(to) } };
}

/** `{ cardUrl, hours? }` for the grace forward. The card URL is public. */
function forwardBody(body: unknown): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
	if (body == null || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be an object" };
	const keys = Object.keys(body);
	if (!keys.length || keys.length > 2 || keys.some((key) => key !== "cardUrl" && key !== "hours")) return { ok: false, error: "body is not allowed" };
	const raw = body as Record<string, unknown>;
	if (typeof raw.cardUrl !== "string" || !raw.cardUrl || raw.cardUrl.length > PEER_URL_MAX) return { ok: false, error: "cardUrl is invalid" };
	const value: Record<string, string> = { cardUrl: raw.cardUrl };
	if (raw.hours !== undefined) {
		const hours = typeof raw.hours === "number" ? raw.hours : typeof raw.hours === "string" ? Number(raw.hours) : NaN;
		if (!Number.isInteger(hours) || hours < 1 || hours > 720) return { ok: false, error: "hours is invalid" };
		value.hours = String(hours);
	}
	return { ok: true, value };
}

/**
 * Body allowed on this owner RPC route.
 * MCP send, reply, mark_working, and announce_address receive a flat object of tool arguments.
 * PUT /owner/outbound-peers/:alias receives `{ url, token }`. The token is sealed before any log line.
 * PUT /owner/address-forward receives `{ cardUrl, hours? }`. POST /owner/peers/announce receives `{ to }` or `{ all: true }`.
 * The pairing identity private key is not accepted on this RPC.
 * Every other route accepts only an absent body.
 */
export function ownerRpcBody(routeName: string, body: unknown): { ok: true; value?: Record<string, string> } | { ok: false; error: string } {
	if (routeName === "PUT /owner/outbound-peers/:alias") return outboundPeerBody(body);
	if (routeName === "POST /owner/peers/announce" || routeName === "POST /owner/mcp/announce_address") return announceBody(body);
	if (routeName === "PUT /owner/address-forward") return forwardBody(body);
	const spec = MCP_ARGS[routeName];
	if (!spec) {
		if (body !== undefined && body !== null) return { ok: false, error: "this call takes no body" };
		return { ok: true };
	}
	if (body == null || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be an object" };
	const allowed = new Set([...spec.required, ...spec.optional]);
	const keys = Object.keys(body);
	if (keys.length > allowed.size || keys.some((key) => !allowed.has(key))) return { ok: false, error: "body is not allowed" };
	const value: Record<string, string> = {};
	for (const key of spec.required) {
		const item = (body as Record<string, unknown>)[key];
		if (item == null || item === "") return { ok: false, error: `${key} is required` };
		if (typeof item !== "string") return { ok: false, error: `${key} is invalid` };
		const why = mcpArgOk(key, item);
		if (why) return { ok: false, error: why };
		value[key] = item;
	}
	for (const key of spec.optional) {
		if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
		const item = (body as Record<string, unknown>)[key];
		if (typeof item !== "string" || !item) return { ok: false, error: `${key} is invalid` };
		const why = mcpArgOk(key, item);
		if (why) return { ok: false, error: why };
		value[key] = item;
	}
	return { ok: true, value };
}

function stringLeaks(value: string, key: string | null): boolean {
	if (TOKEN_RE.test(value) || SETUP_RE.test(value) || USERINFO_RE.test(value)) return true;
	return key !== null && SECRET_KEYS.has(key.toLowerCase()) && value.length >= 16;
}

/** Claimed display fields. A token-shaped value is blanked so one request cannot withhold the list. */
const CLAIM_KEYS = new Set(["clientname", "client_name", "clientid", "client_id", "agentcardurl", "agent_card_url"]);

function claimLeaks(value: string): boolean {
	return TOKEN_RE.test(value) || SETUP_RE.test(value) || USERINFO_RE.test(value);
}

/**
 * Replace a claimed name, alias, or card that is shaped like a peer token, a setup secret, or URL
 * userinfo with an empty string. Other keys are left for `ownerResponseLeaks`.
 */
export function scrubOwnerClaims(value: unknown, depth = 0): unknown {
	if (value == null || depth > 20) return value;
	if (Array.isArray(value)) return value.map((item) => scrubOwnerClaims(item, depth + 1));
	if (typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		out[key] = typeof item === "string" && CLAIM_KEYS.has(key.toLowerCase()) && claimLeaks(item)
			? ""
			: scrubOwnerClaims(item, depth + 1);
	}
	return out;
}

/** A rendered wake whose credential header was not masked. The header name is the caller's choice. */
function wakePreviewLeaks(value: object): boolean {
	const headers = (value as { method?: unknown; headers?: unknown }).headers;
	if ((value as { method?: unknown }).method !== "POST" || !headers || typeof headers !== "object" || Array.isArray(headers)) return false;
	for (const [k, v] of Object.entries(headers)) {
		if (typeof v !== "string" || previewHeaderPlain(k) || credentialIsMasked(v)) continue;
		return true;
	}
	return false;
}

/** True when a JSON value carries a peer token, a setup secret, a URL userinfo, or a secret field. */
export function ownerResponseLeaks(value: unknown, depth = 0, key: string | null = null): boolean {
	if (depth > 20) return true;
	if (typeof value === "string") return stringLeaks(value, key);
	if (typeof value === "number" || typeof value === "boolean" || value == null) return false;
	if (Array.isArray(value)) return value.some((v) => ownerResponseLeaks(v, depth + 1, null));
	if (typeof value === "object") {
		if (wakePreviewLeaks(value)) return true;
		for (const [k, v] of Object.entries(value)) {
			if (ownerResponseLeaks(v, depth + 1, k)) return true;
		}
		return false;
	}
	return true;
}
