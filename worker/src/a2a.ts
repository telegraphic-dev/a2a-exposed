// A2A data-model helpers. Internal storage uses the A2A 0.3 JSON shape
// (lowercase states, role user/agent, parts with "kind"); converters emit A2A 1.0.

export type Json = any;
export const TERMINAL = new Set(["completed", "failed", "canceled", "rejected"]);
export const OPEN = new Set(["submitted", "working"]);
export const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export class InvalidParams extends Error {}

/** Response for a request on a hostname this agent moved away from (RETIRED_HOSTNAMES, comma-separated), else null.
 *  Custom domains are not detached by a deploy, so after `--workers-dev` (or a hostname change) the old hostname
 *  would keep serving: instead it redirects agent-card discovery (301) and answers everything else with 410 Gone. */
export function movedResponse(reqUrl: string, publicUrl: string, retiredCsv: string | undefined): { status: number; headers: Record<string, string>; body: string } | null {
	const retired = (retiredCsv || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
	if (!retired.length) return null;
	const u = new URL(reqUrl);
	if (!retired.includes(u.hostname.toLowerCase())) return null;
	const base = (publicUrl || "").replace(/\/$/, "");
	if (base && new URL(base).hostname.toLowerCase() === u.hostname.toLowerCase()) return null; // never retire the live URL
	const card = base ? `${base}/.well-known/agent-card.json` : "";
	if (card && (u.pathname === "/.well-known/agent-card.json" || u.pathname === "/.well-known/agent.json"))
		return { status: 301, headers: { location: card, "cache-control": "no-store" }, body: "" };
	return {
		status: 410, headers: { "content-type": "application/json" },
		body: JSON.stringify({ error: "moved", message: `this agent moved${base ? ` to ${base}` : ""}; update the URL you use for it`, ...(card ? { agentCard: card } : {}) }),
	};
}

/** Hosts that only resolve on a private network (Tailnet, LAN, loopback): never a public agent URL. */
export function isPrivateHost(host: string): boolean {
	const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (!h.includes(".") && !h.includes(":")) return true; // single-label names (localhost, MagicDNS short names)
	if (/(^|\.)(localhost|local|lan|home|internal|intranet|corp|home\.arpa|ts\.net)$/.test(h)) return true;
	const m = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
	if (m) {
		const [a, b] = [Number(m[1]), Number(m[2])];
		return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
	}
	return h.includes(":") && (h === "::1" || /^f[cd]/.test(h) || h.startsWith("fe80"));
}

/** The base URL the agent card advertises: the deployment's PUBLIC_URL (custom hostname or workers.dev, set at deploy
 *  time) when it is a public https origin, else the origin the request reached the Worker on. A local, Tailnet or
 *  plain-http URL is never advertised to peers. */
export function publicOrigin(configured: string | undefined, reqUrl: string): string {
	try {
		const u = new URL((configured || "").trim());
		if (u.protocol === "https:" && !u.username && !u.password && !isPrivateHost(u.hostname)) return u.origin;
	} catch { /* empty or not a URL */ }
	return new URL(reqUrl).origin;
}

export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();

export function checkId(v: unknown, what = "id"): string {
	if (typeof v !== "string" || !ID_RE.test(v)) throw new InvalidParams(`invalid ${what}`);
	return v;
}

const v1State = (s: string) => "TASK_STATE_" + s.toUpperCase().replace(/-/g, "_");
export const fromV1State = (s: string) =>
	typeof s === "string" && s.startsWith("TASK_STATE_") ? s.slice(11).toLowerCase().replace(/_/g, "-") : s;
const normRole = (r: unknown) => (String(r || "").toLowerCase().includes("agent") ? "agent" : "user");

export function normPart(part: Json): Json {
	if (!part || typeof part !== "object" || Array.isArray(part)) throw new InvalidParams("part must be an object");
	const kind = part.kind;
	let out: Json;
	if (kind === "text" || (kind === undefined && "text" in part)) {
		if (typeof part.text !== "string") throw new InvalidParams("text part needs string text");
		out = { kind: "text", text: part.text };
	} else if (kind === "data" || (kind === undefined && "data" in part)) {
		out = { kind: "data", data: part.data };
	} else if (kind === "file" || (kind === undefined && ("raw" in part || "url" in part))) {
		const f: Json = { ...(part.file || {}) };
		if ("raw" in part) f.bytes = part.raw;
		if ("url" in part) f.uri = part.url;
		if (part.filename) f.name = part.filename;
		if (part.mediaType) f.mimeType = part.mediaType;
		out = { kind: "file", file: f };
	} else throw new InvalidParams("unsupported part type");
	if (part.metadata !== undefined) out.metadata = part.metadata;
	return out;
}

export function normMessage(msg: Json): Json {
	if (!msg || typeof msg !== "object") throw new InvalidParams("message must be an object");
	if (!Array.isArray(msg.parts) || msg.parts.length === 0) throw new InvalidParams("message.parts must be a non-empty array");
	const out: Json = {
		kind: "message",
		role: normRole(msg.role),
		messageId: typeof msg.messageId === "string" && msg.messageId ? msg.messageId.slice(0, 200) : newId(),
		parts: msg.parts.slice(0, 100).map(normPart),
	};
	for (const k of ["contextId", "taskId", "metadata", "referenceTaskIds", "extensions"])
		if (msg[k] !== undefined && msg[k] !== null) out[k] = msg[k];
	return out;
}

function partToV1(p: Json): Json {
	let out: Json;
	if (p.kind === "text") out = { text: p.text };
	else if (p.kind === "data") out = { data: p.data };
	else {
		const f = p.file || {};
		out = {};
		if ("bytes" in f) out.raw = f.bytes;
		if ("uri" in f) out.url = f.uri;
		if (f.name) out.filename = f.name;
		if (f.mimeType) out.mediaType = f.mimeType;
	}
	if (p.metadata !== undefined) out.metadata = p.metadata;
	return out;
}

export function messageToV1(m: Json): Json {
	const { kind, parts, role, ...rest } = m;
	return { ...rest, role: role === "agent" ? "ROLE_AGENT" : "ROLE_USER", parts: (parts || []).map(partToV1) };
}

/** Serialise an internal task for the given protocol version. */
export function publicTask(task: Json, version: string, historyLength?: number | null): Json {
	const t: Json = { kind: "task", id: task.id, contextId: task.contextId, status: task.status, artifacts: task.artifacts || [] };
	if (task.metadata) t.metadata = task.metadata;
	let hist: Json[] = task.history || [];
	if (historyLength !== undefined && historyLength !== null) hist = historyLength > 0 ? hist.slice(-historyLength) : [];
	if (hist.length) t.history = hist;
	if (version.startsWith("1")) {
		delete t.kind;
		const st: Json = { ...t.status, state: v1State(t.status.state) };
		if (st.message) st.message = messageToV1(st.message);
		t.status = st;
		if (t.history) t.history = t.history.map(messageToV1);
		t.artifacts = t.artifacts.map((a: Json) => ({ ...a, parts: a.parts.map(partToV1) }));
	}
	return t;
}

/** Peer task (0.3 or 1.0) -> internal-ish shape (used only to read state/text; store and show the wire shape). */
export function taskFromAny(t: Json): Json {
	if (!t || typeof t !== "object") return t;
	const out = { ...t };
	if (out.status && typeof out.status === "object") {
		const st = { ...out.status, state: fromV1State(out.status.state) };
		if (st.message) try { st.message = normMessage(st.message); } catch { /* keep */ }
		out.status = st;
	}
	return out;
}

export function textOf(m: Json): string {
	const parts = Array.isArray(m) ? m : (m && m.parts) || [];
	const out: string[] = [];
	for (const x of parts) {
		if (!x || typeof x !== "object") continue;
		if ("text" in x) out.push(String(x.text));
		else if ("data" in x) out.push(JSON.stringify(x.data));
		else {
			const f = x.file || {};
			out.push(`[file ${f.name || x.filename || f.uri || x.url || ""}]`);
		}
	}
	return out.join("\n");
}

export async function sha256(s: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** First 12 hex chars of sha256(value), or null when unset: lets the owner compare secrets without revealing them. */
export async function fingerprint(v: string | undefined | null): Promise<string | null> {
	return v ? (await sha256(v)).slice(0, 12) : null;
}

/** Peer token: "a2aow_" + 43 base64url chars (32 random bytes). Only the SHA-256 hash is stored and
 *  lookups are by hash, so tokens issued with the earlier "s2a_" prefix keep working. */
export const PEER_TOKEN_PREFIX = "a2aow_";

export function randomToken(prefix = PEER_TOKEN_PREFIX): string {
	const b = new Uint8Array(32);
	crypto.getRandomValues(b);
	return prefix + btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function timingSafeEqualStr(a: string, b: string): boolean {
	const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
	if (ea.length !== eb.length) return false;
	let r = 0;
	for (let i = 0; i < ea.length; i++) r |= ea[i] ^ eb[i];
	return r === 0;
}

/** Push URLs must be https and not obvious private/loopback literals. */
export function pushUrlAllowed(url: string): [boolean, string] {
	let u: URL;
	try { u = new URL(url); } catch { return [false, "bad url"]; }
	if (u.protocol !== "https:") return [false, "https required"];
	const h = u.hostname.replace(/^\[|\]$/g, "");
	if (/^(localhost|.*\.local|.*\.internal)$/i.test(h)) return [false, "private host not allowed"];
	if (/^\d+\.\d+\.\d+\.\d+$/.test(h) && /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h))
		return [false, "private address not allowed"];
	if (h.includes(":") && /^(::1?$|fc|fd|fe80|::ffff:)/i.test(h)) return [false, "private address not allowed"];
	return [true, ""];
}
