// a2a-over-webhook Worker: public A2A endpoint (JSON-RPC; A2A 1.0 primary, 0.3 compatible),
// D1-backed inbox, wake webhooks (presets), and an owner API for the local CLI.
import * as A from "./a2a.ts";
import { renderWake, redact, cloudflareErrorHint, defaultDebounceSeconds, defaultMaxPerHour, type WakeConfig, type WakeEvent } from "./wake.ts";
import * as P from "./pairing.ts";
type Json = any;

interface Env {
	DB: D1Database;
	PUBLIC_URL: string; // may be empty on a first workers.dev deploy (request origin is used then; see A.publicOrigin)
	RETIRED_HOSTNAMES?: string; // old custom domains (comma-separated): 301 for the card, 410 for everything else
	AGENT_NAME?: string;
	AGENT_DESCRIPTION?: string;
	AGENT_VERSION?: string;
	AGENT_SKILLS?: string; // JSON array of AgentSkill
	PROVIDER_ORGANIZATION?: string;
	PROVIDER_URL?: string;
	DOCUMENTATION_URL?: string;
	// secrets
	OWNER_TOKEN?: string;
	WAKE_WEBHOOK_URL?: string;
	WAKE_WEBHOOK_KEY?: string;
	WAKE_HMAC_SECRET?: string;
	WAKE_ACCESS_CLIENT_ID?: string; // Cloudflare Access service token (wake URL behind Access, e.g. `tunnel create`)
	WAKE_ACCESS_CLIENT_SECRET?: string;
	// wake config (plain vars)
	WAKE_PRESET?: string;
	WAKE_AGENT_ID?: string;
	WAKE_KEY_HEADER?: string;
	WAKE_KEY_PREFIX?: string;
	WAKE_BODY_TEMPLATE?: string;
	WAKE_CLI_COMMAND?: string;
	WAKE_DEBOUNCE_SECONDS?: string;
	WAKE_MAX_PER_HOUR?: string;
	// limits
	MAX_BODY?: string;
	RATE_PER_MIN?: string;
	// device-flow pairing: human (default) | agent | off
	PAIRING_APPROVAL?: string;
	PBKDF2_ITERATIONS?: string; // approval password hashing (default 100000, the Workers maximum; at least 50000)
}

class RpcError extends Error {
	code: number;
	constructor(code: number, msg: string) { super(msg); this.code = code; }
}
class HttpError extends Error {
	status: number;
	constructor(status: number, msg: string) { super(msg); this.status = status; }
}

const json = (obj: Json, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

const log = (event: string, kw: Json = {}) => console.log(JSON.stringify({ ts: A.nowIso(), event, ...kw }));

// ------------------------------------------------------------------ storage
async function loadTask(env: Env, id: string): Promise<Json | null> {
	const r: Json = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
	if (!r) return null;
	const msgs = await env.DB.prepare("SELECT message_json FROM messages WHERE task_id = ? ORDER BY seq").bind(id).all();
	return {
		id: r.id, contextId: r.context_id, status: JSON.parse(r.status_json), artifacts: JSON.parse(r.artifacts_json),
		metadata: r.metadata_json ? JSON.parse(r.metadata_json) : undefined,
		history: (msgs.results || []).map((m: Json) => JSON.parse(m.message_json)),
		_peer: r.peer, _protocol: r.protocol, _createdAt: r.created_at, _push: JSON.parse(r.push_configs_json),
	};
}

function saveTaskStmt(env: Env, t: Json) {
	return env.DB.prepare(
		`INSERT INTO tasks (id, context_id, peer, state, protocol, created_at, updated_at, status_json, artifacts_json, metadata_json, push_configs_json)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
		 ON CONFLICT(id) DO UPDATE SET state=?4, updated_at=?7, status_json=?8, artifacts_json=?9, metadata_json=?10, push_configs_json=?11`,
	).bind(t.id, t.contextId, t._peer, t.status.state, t._protocol, t._createdAt, A.nowIso(), JSON.stringify(t.status),
		JSON.stringify(t.artifacts || []), t.metadata ? JSON.stringify(t.metadata) : null, JSON.stringify(t._push || []));
}

const msgStmt = (env: Env, t: Json, m: Json) =>
	env.DB.prepare("INSERT INTO messages (message_id, task_id, context_id, role, ts, message_json) VALUES (?, ?, ?, ?, ?, ?)")
		.bind(m.messageId, t.id, t.contextId, m.role, A.nowIso(), JSON.stringify(m));

function histStmt(env: Env, ctx: string, e: Json) {
	return env.DB.prepare(
		"INSERT INTO history (context_id, ts, dir, peer, task_id, role, state, event, text, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).bind(ctx, e.ts || A.nowIso(), e.dir || "local", e.peer ?? null, e.taskId ?? null, e.role ?? null, e.state ?? null,
		e.event ?? null, e.text ?? null, e.data !== undefined ? JSON.stringify(e.data) : null);
}

// ------------------------------------------------------------------ self-aware fetch (a Worker cannot reliably fetch its own custom domain)
async function doFetch(env: Env, ectx: ExecutionContext, url: string, init: RequestInit): Promise<Response> {
	if (env.PUBLIC_URL && new URL(url).host === new URL(env.PUBLIC_URL).host) return handle(new Request(url, init), env, ectx);
	return fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
}

// ------------------------------------------------------------------ wake webhook (presets), debounced per context via D1
const preset = (env: Env) => (env.WAKE_PRESET || "generic").trim();

function wakeConfig(env: Env): WakeConfig {
	return {
		preset: preset(env), url: env.WAKE_WEBHOOK_URL, key: env.WAKE_WEBHOOK_KEY, hmacSecret: env.WAKE_HMAC_SECRET,
		agentId: env.WAKE_AGENT_ID, keyHeader: env.WAKE_KEY_HEADER, keyPrefix: env.WAKE_KEY_PREFIX,
		bodyTemplate: env.WAKE_BODY_TEMPLATE, cliCommand: env.WAKE_CLI_COMMAND,
		accessClientId: env.WAKE_ACCESS_CLIENT_ID, accessClientSecret: env.WAKE_ACCESS_CLIENT_SECRET,
	};
}

const debounceMs = (env: Env) => Number(env.WAKE_DEBOUNCE_SECONDS || defaultDebounceSeconds(preset(env))) * 1000;
const maxPerHour = (env: Env) => Number(env.WAKE_MAX_PER_HOUR || defaultMaxPerHour(preset(env)));

async function wakeBudgetOk(env: Env): Promise<boolean> {
	const cap = maxPerHour(env);
	if (!cap) return true;
	const hour = Math.floor(Date.now() / 3600000);
	const r: Json = await env.DB.prepare(
		"INSERT INTO wake_budget (hour, count) VALUES (?, 1) ON CONFLICT(hour) DO UPDATE SET count = count + 1 RETURNING count",
	).bind(hour).first();
	return (r?.count ?? 0) <= cap;
}

async function sendWake(env: Env, ectx: ExecutionContext, payload: Json): Promise<{ status: number | null; info: string }> {
	const ev: WakeEvent = { ...payload, publicUrl: env.PUBLIC_URL };
	let req;
	try { req = await renderWake(wakeConfig(env), ev); } catch (e) {
		log("wake_render_failed", { preset: preset(env), error: String(e).slice(0, 200) });
		return { status: null, info: "render failed: " + String(e).slice(0, 200) };
	}
	if (!req) { log("wake_skipped", { contextId: ev.contextId, reason: "WAKE_WEBHOOK_URL unset" }); return { status: null, info: "WAKE_WEBHOOK_URL unset" }; }
	try {
		const r = await doFetch(env, ectx, req.url, { method: "POST", headers: req.headers, body: req.body });
		// explain Cloudflare edge errors (tunnel connector down, Access block) without echoing the body
		const hint = r.ok ? "" : cloudflareErrorHint(r.status, (await r.text().catch(() => "")).slice(0, 4096));
		log("wake_sent", { preset: preset(env), contextId: ev.contextId, taskId: ev.taskId, status: r.status, ...(hint ? { hint } : {}) });
		return { status: r.status, info: `HTTP ${r.status}${hint ? ` (${hint})` : ""}` };
	} catch (e) {
		log("wake_failed", { preset: preset(env), contextId: ev.contextId, error: String(e).slice(0, 200) });
		return { status: null, info: String(e).slice(0, 200) };
	}
}

async function wake(env: Env, ectx: ExecutionContext, ctx: string, taskId: string, from: string, preview: string, kind = "inbound") {
	const payload: Json = { contextId: ctx, taskId, taskIds: [taskId], from, preview: preview.slice(0, 300), kind };
	const now = Date.now(), deb = debounceMs(env);
	const row: Json = await env.DB.prepare("SELECT * FROM wakes WHERE context_id = ?").bind(ctx).first();
	let claimed = false;
	if (!row) {
		const r = await env.DB.prepare("INSERT INTO wakes (context_id, last_sent_ms) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(ctx, now).run();
		claimed = r.meta.changes === 1;
	} else if (!row.pending_json && now - row.last_sent_ms >= deb) {
		const r = await env.DB.prepare("UPDATE wakes SET last_sent_ms = ? WHERE context_id = ? AND last_sent_ms = ? AND pending_json IS NULL")
			.bind(now, ctx, row.last_sent_ms).run();
		claimed = r.meta.changes === 1;
	}
	if (claimed && (await wakeBudgetOk(env))) { ectx.waitUntil(sendWake(env, ectx, payload)); return; }
	// debounce window (or hourly cap reached): merge into the pending wake and flush it later
	const cur: Json = await env.DB.prepare("SELECT * FROM wakes WHERE context_id = ?").bind(ctx).first();
	const prev = cur?.pending_json ? JSON.parse(cur.pending_json) : null;
	payload.taskIds = [...new Set([...(prev?.taskIds || []), taskId])];
	await env.DB.prepare("UPDATE wakes SET pending_json = ?, pending_since_ms = COALESCE(pending_since_ms, ?) WHERE context_id = ?")
		.bind(JSON.stringify(payload), now, ctx).run();
	const delay = Math.max(0, (cur?.last_sent_ms || now) + deb - now) + 100;
	// waitUntil can outlive the response by ~30s; longer windows are flushed by later requests or the optional cron
	if (delay <= 25000) ectx.waitUntil(new Promise((res) => setTimeout(res, delay)).then(() => flushWake(env, ectx, ctx)));
}

async function flushWake(env: Env, ectx: ExecutionContext, ctx: string) {
	const row: Json = await env.DB.prepare("SELECT * FROM wakes WHERE context_id = ?").bind(ctx).first();
	if (!row || !row.pending_json) return;
	const now = Date.now();
	if (now - row.last_sent_ms < debounceMs(env)) return;
	if (maxPerHour(env)) {
		const hour = Math.floor(now / 3600000);
		const b: Json = await env.DB.prepare("SELECT count FROM wake_budget WHERE hour = ?").bind(hour).first();
		if ((b?.count ?? 0) >= maxPerHour(env)) return; // keep pending until the next hour
	}
	const r = await env.DB.prepare(
		"UPDATE wakes SET pending_json = NULL, pending_since_ms = NULL, last_sent_ms = ? WHERE context_id = ? AND last_sent_ms = ? AND pending_json IS NOT NULL",
	).bind(now, ctx, row.last_sent_ms).run();
	if (r.meta.changes === 1 && (await wakeBudgetOk(env))) await sendWake(env, ectx, JSON.parse(row.pending_json));
}

/** Flush every pending wake whose debounce window has passed (called opportunistically and from cron). */
async function flushDue(env: Env, ectx: ExecutionContext) {
	const rows = await env.DB.prepare("SELECT context_id FROM wakes WHERE pending_json IS NOT NULL AND last_sent_ms <= ? LIMIT 20")
		.bind(Date.now() - debounceMs(env)).all();
	for (const r of rows.results as Json[]) await flushWake(env, ectx, r.context_id);
}

// ------------------------------------------------------------------ auth + rate limit
async function peerLabel(env: Env, header: string | null): Promise<string | null> {
	if (!header || !/^bearer /i.test(header)) return null;
	const h = await A.sha256(header.slice(7).trim());
	const r: Json = await env.DB.prepare("SELECT label FROM peers WHERE token_hash = ? AND revoked_at IS NULL").bind(h).first();
	return r ? r.label : null;
}

async function isOwner(env: Env, header: string | null): Promise<boolean> {
	if (!env.OWNER_TOKEN || !header || !/^bearer /i.test(header)) return false;
	return A.timingSafeEqualStr(await A.sha256(header.slice(7).trim()), await A.sha256(env.OWNER_TOKEN));
}

async function rateOk(env: Env, key: string): Promise<boolean> {
	const minute = Math.floor(Date.now() / 60000);
	const r: Json = await env.DB.prepare(
		"INSERT INTO rate (peer, minute, count) VALUES (?, ?, 1) ON CONFLICT(peer, minute) DO UPDATE SET count = count + 1 RETURNING count",
	).bind(key, minute).first();
	return (r?.count ?? 0) <= Number(env.RATE_PER_MIN || "60");
}

async function readBody(req: Request, env: Env): Promise<string> {
	const max = Number(env.MAX_BODY || "1048576");
	const cl = Number(req.headers.get("content-length") || "0");
	if (cl > max) throw new HttpError(413, "Body too large");
	const buf = await req.arrayBuffer();
	if (buf.byteLength > max) throw new HttpError(413, "Body too large");
	return new TextDecoder().decode(buf);
}

// ------------------------------------------------------------------ agent card (A2A 1.0 shape)
function agentSkills(env: Env): Json[] {
	if (env.AGENT_SKILLS) {
		try { const v = JSON.parse(env.AGENT_SKILLS); if (Array.isArray(v) && v.length) return v; } catch { /* fall through */ }
	}
	return [{
		id: "general", name: "General requests",
		description: "Accepts requests from other agents and replies asynchronously (poll GetTask or register a push notification config).",
		tags: ["assistant", "async"],
	}];
}

const pairingMode = (env: Env) => P.pairingMode(env.PAIRING_APPROVAL);
const pairingOn = (env: Env) => pairingMode(env) !== "off";
const oauthUrls = (env: Env) => {
	const base = env.PUBLIC_URL.replace(/\/$/, "");
	return { issuer: base, device: `${base}/oauth/device_authorization`, token: `${base}/oauth/token`, page: `${base}/device`,
		setup: `${base}/device/setup`, metadata: `${base}/.well-known/oauth-authorization-server`,
		resource: `${base}/.well-known/oauth-protected-resource` };
};
const cliCommand = (env: Env) => env.WAKE_CLI_COMMAND || "npx a2a-over-webhook";

/** Bearer (every token, however issued) plus, unless pairing is off, the A2A 1.0 OAuth2 device-code flow that issues one. */
function securitySchemes(env: Env): Json {
	const u = oauthUrls(env);
	const schemes: Json = {
		bearer: { httpAuthSecurityScheme: { scheme: "Bearer", description: pairingOn(env)
			? "Per-peer bearer token: from the device-flow pairing below (the access_token), or issued by the agent's operator"
			: "Per-peer bearer token issued by the agent's operator" } },
	};
	if (pairingOn(env)) schemes.pairing = { oauth2SecurityScheme: {
		description: "Get a bearer token without exchanging secrets in chat: OAuth 2.0 Device Authorization Grant (RFC 8628). " +
			"POST client_name (your agent's name) and agent_card_url (your card) form-encoded to deviceAuthorizationUrl; show the user_code and " +
			"verification_uri_complete to your human, who confirms the code with this agent's owner; poll tokenUrl with grant_type=" + P.DEVICE_GRANT +
			" every `interval` seconds. The owner approves every request" + (pairingMode(env) === "human" ? " on the verification page." : ".") +
			" The access_token is a per-peer token for Authorization: Bearer (no refresh token; the owner can revoke it).",
		flows: { deviceCode: { deviceAuthorizationUrl: u.device, tokenUrl: u.token, scopes: { a2a: "Send messages to this agent and read the tasks you created" } } },
		oauth2MetadataUrl: u.metadata,
	} };
	return schemes;
}

function agentCard(env: Env): Json {
	const base = env.PUBLIC_URL.replace(/\/$/, "");
	const card: Json = {
		name: env.AGENT_NAME || "A2A Agent",
		description: env.AGENT_DESCRIPTION ||
			"An AI agent reachable over A2A. Messages are queued and handled asynchronously; poll GetTask or register a push notification config.",
		version: env.AGENT_VERSION || "1.0.0",
		supportedInterfaces: [
			{ url: base + "/", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
			{ url: base + "/", protocolBinding: "JSONRPC", protocolVersion: "0.3" },
		],
		securitySchemes: securitySchemes(env),
		securityRequirements: [{ schemes: { bearer: { list: [] } } }, ...(pairingOn(env) ? [{ schemes: { pairing: { list: [] } } }] : [])],
		capabilities: { streaming: false, pushNotifications: true, extendedAgentCard: false },
		defaultInputModes: ["text/plain", "application/json"],
		defaultOutputModes: ["text/plain", "application/json"],
		skills: agentSkills(env),
	};
	if (env.PROVIDER_ORGANIZATION && env.PROVIDER_URL) card.provider = { organization: env.PROVIDER_ORGANIZATION, url: env.PROVIDER_URL };
	if (env.DOCUMENTATION_URL) card.documentationUrl = env.DOCUMENTATION_URL;
	return card;
}

/** The same agent as an A2A 0.3 AgentCard (served at the legacy /.well-known/agent.json for 0.2/0.3 clients): top-level
 *  url + preferredTransport + protocolVersion, OpenAPI-style securitySchemes and `security`. 0.3 has no device-code
 *  flow, so the pairing scheme only points to the RFC 8414 metadata (oauth2MetadataUrl) and is not a requirement. */
function agentCard03(env: Env): Json {
	const c = agentCard(env);
	const base = env.PUBLIC_URL.replace(/\/$/, "");
	const schemes: Json = { bearer: { type: "http", scheme: "bearer", description: c.securitySchemes.bearer.httpAuthSecurityScheme.description } };
	if (pairingOn(env)) schemes.pairing = { type: "oauth2", description: c.securitySchemes.pairing.oauth2SecurityScheme.description,
		flows: {}, oauth2MetadataUrl: oauthUrls(env).metadata };
	const card: Json = {
		protocolVersion: "0.3.0", name: c.name, description: c.description, url: base + "/", preferredTransport: "JSONRPC",
		additionalInterfaces: [{ url: base + "/", transport: "JSONRPC" }], version: c.version,
		capabilities: { streaming: false, pushNotifications: true, stateTransitionHistory: false },
		securitySchemes: schemes, security: [{ bearer: [] }],
		defaultInputModes: c.defaultInputModes, defaultOutputModes: c.defaultOutputModes,
		skills: c.skills.map((k: Json) => ({ ...k, tags: Array.isArray(k.tags) ? k.tags : [] })), supportsAuthenticatedExtendedCard: false,
	};
	if (c.provider) card.provider = c.provider;
	if (c.documentationUrl) card.documentationUrl = c.documentationUrl;
	return card;
}

/** RFC 9728 protected-resource metadata: which authorization server issues tokens for this A2A endpoint. */
function protectedResourceMetadata(env: Env): Json {
	const u = oauthUrls(env);
	return { resource: u.issuer + "/", authorization_servers: [u.issuer], bearer_methods_supported: ["header"], scopes_supported: ["a2a"],
		resource_name: env.AGENT_NAME || "A2A Agent", resource_documentation: "https://github.com/telegraphic-dev/a2a-over-webhook#connecting-agents-device-flow" };
}

// ------------------------------------------------------------------ JSON-RPC
const V1: Record<string, string> = {
	SendMessage: "send", GetTask: "get", CancelTask: "cancel", CreateTaskPushNotificationConfig: "pushset",
	SetTaskPushNotificationConfig: "pushset", GetTaskPushNotificationConfig: "pushget", ListTasks: "list",
	SendStreamingMessage: "stream", SubscribeToTask: "stream",
};
const V03: Record<string, string> = {
	"message/send": "send", "tasks/get": "get", "tasks/cancel": "cancel", "tasks/pushNotificationConfig/set": "pushset",
	"tasks/pushNotificationConfig/get": "pushget", "message/stream": "stream", "tasks/resubscribe": "stream",
};

async function ownedTask(env: Env, id: unknown, label: string): Promise<Json> {
	if (typeof id !== "string" || !A.ID_RE.test(id)) throw new RpcError(-32001, "Task not found");
	const t = await loadTask(env, id);
	if (!t || t._peer !== label) throw new RpcError(-32001, "Task not found");
	return t;
}

function normPushCfg(cfg: Json, version: string): Json {
	if (!cfg || typeof cfg !== "object" || typeof cfg.url !== "string") throw new RpcError(-32602, "push notification config needs url");
	const out: Json = { id: typeof cfg.id === "string" && cfg.id ? cfg.id.slice(0, 128) : A.newId(), url: cfg.url, _version: version };
	if (cfg.token) out.token = String(cfg.token).slice(0, 512);
	if (cfg.authentication && typeof cfg.authentication === "object") out.authentication = cfg.authentication;
	const [ok, why] = A.pushUrlAllowed(out.url);
	if (!ok) throw new RpcError(-32602, `push url rejected: ${why}`);
	return out;
}

function pubCfg(taskId: string, cfg: Json, version: string): Json {
	const c: Json = {};
	for (const [k, v] of Object.entries(cfg)) if (!k.startsWith("_")) c[k] = v;
	return version.startsWith("1") ? { taskId, ...c } : { taskId, pushNotificationConfig: c };
}

type Rpc = (p: Json, label: string, version: string, env: Env, ectx: ExecutionContext) => Promise<Json>;

const rpcSend: Rpc = async (params, label, version, env, ectx) => {
	const msg = A.normMessage(params.message);
	if (msg.role !== "user") throw new RpcError(-32602, "message.role must be user");
	const conf = params.configuration || {};
	const push = conf.taskPushNotificationConfig || conf.pushNotificationConfig;
	const pushCfg = push ? normPushCfg(push, version) : null;
	let task: Json = null;
	if (msg.taskId) {
		task = await ownedTask(env, msg.taskId, label);
		if (A.TERMINAL.has(task.status.state)) throw new RpcError(-32004, "Task is in a terminal state");
		if (msg.contextId && msg.contextId !== task.contextId) throw new RpcError(-32602, "contextId does not match task");
	}
	const ctx = task ? task.contextId : msg.contextId ? A.checkId(msg.contextId, "contextId") : A.newId();
	const ts = A.nowIso();
	if (!task) task = { id: A.newId(), contextId: ctx, status: { state: "submitted", timestamp: ts }, artifacts: [], history: [], _peer: label, _protocol: version, _createdAt: ts, _push: [] };
	msg.contextId = ctx; msg.taskId = task.id;
	task.history.push(msg);
	task.status = { state: "submitted", timestamp: ts };
	if (pushCfg) task._push = [...task._push.filter((c: Json) => c.id !== pushCfg.id), pushCfg];
	if (params.metadata && typeof params.metadata === "object") task.metadata = { ...(task.metadata || {}), ...params.metadata };
	const preview = A.textOf(msg);
	await env.DB.batch([
		saveTaskStmt(env, task), msgStmt(env, task, msg),
		histStmt(env, ctx, { dir: "in", peer: label, taskId: task.id, role: "user", text: preview, data: { messageId: msg.messageId } }),
	]);
	log("message_received", { peer: label, contextId: ctx, taskId: task.id, chars: preview.length, version });
	await wake(env, ectx, ctx, task.id, label, preview);
	const pt = A.publicTask(task, version, conf.historyLength);
	return version.startsWith("1") ? { task: pt } : pt;
};

const rpcGet: Rpc = async (p, label, version, env) => A.publicTask(await ownedTask(env, p.id, label), version, p.historyLength);

const rpcCancel: Rpc = async (p, label, version, env) => {
	const t = await ownedTask(env, p.id, label);
	if (A.TERMINAL.has(t.status.state)) throw new RpcError(-32002, "Task cannot be canceled");
	t.status = { state: "canceled", timestamp: A.nowIso() };
	await env.DB.batch([saveTaskStmt(env, t), histStmt(env, t.contextId, { dir: "in", peer: label, taskId: t.id, event: "canceled_by_peer", state: "canceled" })]);
	return A.publicTask(t, version);
};

const rpcPushSet: Rpc = async (p, label, version, env) => {
	let taskId: string, cfg: Json;
	if (p.pushNotificationConfig && typeof p.pushNotificationConfig === "object") { taskId = p.taskId; cfg = p.pushNotificationConfig; }
	else if (p.config && typeof p.config === "object") { taskId = p.taskId || String(p.parent || "").split("/").pop(); cfg = p.config; }
	else { taskId = p.taskId; cfg = { id: p.id, url: p.url, token: p.token, authentication: p.authentication }; }
	const t = await ownedTask(env, taskId, label);
	const c = normPushCfg(cfg, version);
	t._push = [...t._push.filter((x: Json) => x.id !== c.id), c];
	await saveTaskStmt(env, t).run();
	return pubCfg(t.id, c, version);
};

const rpcPushGet: Rpc = async (p, label, version, env) => {
	const t = await ownedTask(env, p.taskId || p.id, label);
	const want = p.pushNotificationConfigId || (p.taskId ? p.id : undefined);
	for (const c of t._push) if (!want || c.id === want) return pubCfg(t.id, c, version);
	throw new RpcError(-32001, "Push notification config not found");
};

const rpcList: Rpc = async (p, label, version, env) => {
	const size = Math.min(Math.max(Number(p.pageSize) || 50, 1), 100);
	const where = p.contextId ? "peer = ? AND context_id = ?" : "peer = ?";
	const args = p.contextId ? [label, p.contextId] : [label];
	const total: Json = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${where}`).bind(...args).first();
	const rows = await env.DB.prepare(`SELECT id FROM tasks WHERE ${where} ORDER BY updated_at DESC LIMIT ?`).bind(...args, size).all();
	const tasks = [];
	for (const r of rows.results as Json[]) {
		const t = A.publicTask(await loadTask(env, r.id), version, p.historyLength ?? 0);
		if (!p.includeArtifacts) delete t.artifacts;
		tasks.push(t);
	}
	return { tasks, nextPageToken: "", pageSize: size, totalSize: total?.n ?? tasks.length };
};

const HANDLERS: Record<string, Rpc> = { send: rpcSend, get: rpcGet, cancel: rpcCancel, pushset: rpcPushSet, pushget: rpcPushGet, list: rpcList };

/** 401 for A2A calls. Unless pairing is off, the error says how to get a token (device flow), so a generic agent can follow it.
 *  The JSON-RPC id is echoed when the request body parses (JSON-RPC 2.0); WWW-Authenticate points to RFC 9728 metadata. */
function unauthorized(env: Env, hadToken: boolean, rid: Json = null): Response {
	const u = oauthUrls(env);
	const www = `Bearer realm="a2a"${pairingOn(env) ? `, resource_metadata="${u.resource}"` : ""}${hadToken ? ', error="invalid_token", error_description="the bearer token is not valid (revoked, rotated or mistyped)"' : ""}`;
	const what = hadToken ? "Unauthorized: the bearer token is not valid (revoked, rotated or mistyped)." : "Unauthorized: send Authorization: Bearer <token>.";
	if (!pairingOn(env))
		return json({ jsonrpc: "2.0", id: rid, error: { code: -32000, message: `${what} Ask this agent's operator for a token.` } }, 401, { "www-authenticate": www });
	return json({ jsonrpc: "2.0", id: rid, error: {
		code: -32000,
		message: `${what} ${hadToken ? "Get a new one" : "No token? Get one"} with the OAuth 2.0 device flow (RFC 8628): POST client_name and agent_card_url to ${u.device}, show the user_code and verification_uri_complete to your human, then poll ${u.token} until this agent's owner approves.`,
		data: { pairing: { grant_type: P.DEVICE_GRANT, device_authorization_endpoint: u.device, token_endpoint: u.token,
			authorization_server_metadata: u.metadata, approval: pairingMode(env), cli: "npx a2a-over-webhook connect " + u.issuer } },
	} }, 401, { "www-authenticate": www });
}

async function handleRpc(req: Request, env: Env, ectx: ExecutionContext): Promise<Response> {
	const ip = req.headers.get("cf-connecting-ip") || "";
	const label = await peerLabel(env, req.headers.get("authorization"));
	if (!label) {
		log("auth_failed", { ip });
		// echo the JSON-RPC id when the (small) body parses; never more than 64 KiB is read for an unauthenticated call
		let rid: Json = null;
		try { const b = JSON.parse(await readBody(req, { ...env, MAX_BODY: "65536" })); if (b && typeof b === "object" && !Array.isArray(b) && ["string", "number"].includes(typeof b.id)) rid = b.id; } catch { /* id stays null */ }
		return unauthorized(env, !!req.headers.get("authorization"), rid);
	}
	if (!(await rateOk(env, label))) {
		log("rate_limited", { peer: label, ip });
		return json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Rate limit exceeded" } }, 429, { "retry-after": "60" });
	}
	let raw: string;
	try { raw = await readBody(req, env); } catch (e) {
		return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Body too large" } }, 413);
	}
	let rq: Json;
	try { rq = JSON.parse(raw); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
	if (Array.isArray(rq)) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch not supported" } }, 400);
	const rid = rq && typeof rq === "object" ? rq.id ?? null : null;
	const err = (code: number, message: string) => json({ jsonrpc: "2.0", id: rid, error: { code, message } });
	if (!rq || typeof rq !== "object" || rq.jsonrpc !== "2.0" || typeof rq.method !== "string") return err(-32600, "Invalid Request");
	const method: string = rq.method;
	let op: string, version: string;
	if (V1[method]) { op = V1[method]; version = "1.0"; }
	else if (V03[method]) { op = V03[method]; version = "0.3"; }
	else return err(-32601, "Method not found");
	const hv = (req.headers.get("a2a-version") || "").trim();
	if (hv && !/^(0\.3|1|1\.0)(\.\d+)?$/.test(hv)) return err(-32009, `A2A version ${hv} not supported (supported: 0.3, 1.0)`);
	if (op === "stream") return err(-32004, "Streaming is not supported");
	const params = rq.params ?? {};
	if (typeof params !== "object" || Array.isArray(params)) return err(-32602, "Invalid params");
	try {
		const result = await HANDLERS[op](params, label, version, env, ectx);
		log("rpc_ok", { peer: label, method, ip });
		return json({ jsonrpc: "2.0", id: rid, result });
	} catch (e: any) {
		if (e instanceof RpcError) { log("rpc_error", { peer: label, method, code: e.code, msg: e.message }); return err(e.code, e.message); }
		if (e instanceof A.InvalidParams) { log("rpc_invalid", { peer: label, method, msg: e.message }); return err(-32602, `Invalid params: ${e.message}`); }
		log("rpc_exception", { peer: label, method, error: String(e?.stack || e).slice(0, 500) });
		return err(-32603, "Internal error");
	}
}

// ------------------------------------------------------------------ push delivery (to peers) and receipt (from peers)
async function sendPush(env: Env, ectx: ExecutionContext, task: Json, cfg: Json): Promise<[boolean, string]> {
	const [ok, why] = A.pushUrlAllowed(cfg.url);
	if (!ok) return [false, why];
	const v1 = String(cfg._version || "0.3").startsWith("1");
	const headers: Record<string, string> = { "content-type": v1 ? "application/a2a+json" : "application/json", "user-agent": "a2a-over-webhook" };
	if (v1) headers["a2a-version"] = "1.0";
	if (cfg.token) headers["x-a2a-notification-token"] = cfg.token;
	const auth = cfg.authentication || {};
	const scheme = auth.scheme || (Array.isArray(auth.schemes) ? auth.schemes[0] : undefined);
	if (scheme && auth.credentials) headers["authorization"] = `${scheme} ${auth.credentials}`;
	const body = v1 ? { task: A.publicTask(task, "1.0") } : A.publicTask(task, "0.3");
	try {
		const r = await doFetch(env, ectx, cfg.url, { method: "POST", headers, body: JSON.stringify(body) });
		return [r.status >= 200 && r.status < 300, `HTTP ${r.status}`];
	} catch (e) {
		return [false, String(e).slice(0, 200)];
	}
}

async function notifyPeer(env: Env, ectx: ExecutionContext, t: Json): Promise<Json[]> {
	const results = [];
	for (const cfg of t._push || []) {
		const [ok, info] = await sendPush(env, ectx, t, cfg);
		results.push({ url: cfg.url, ok, info });
		await histStmt(env, t.contextId, { dir: "out", peer: t._peer, taskId: t.id, event: "push", state: t.status.state, text: `${ok ? "ok" : "FAILED"} ${info}` }).run();
	}
	return results;
}

async function handlePush(req: Request, env: Env, ectx: ExecutionContext): Promise<Response> {
	let body: Json;
	try { body = JSON.parse(await readBody(req, env)); } catch (e) {
		return json({ error: e instanceof HttpError ? e.message : "parse error" }, e instanceof HttpError ? e.status : 400);
	}
	if (!body || typeof body !== "object") return json({ error: "bad body" }, 400);
	const inner = body.task || body.statusUpdate || body.artifactUpdate || body.message || body;
	const taskId = "status" in inner && "id" in inner && inner.kind !== "status-update" ? inner.id : inner.taskId || inner.id;
	if (typeof taskId !== "string" || !A.ID_RE.test(taskId)) return json({ error: "no task id" }, 400);
	let given = req.headers.get("x-a2a-notification-token") || "";
	const a = req.headers.get("authorization") || "";
	if (!given && /^bearer /i.test(a)) given = a.slice(7).trim();
	const rec: Json = await env.DB.prepare("SELECT * FROM outbound WHERE task_id = ?").bind(taskId).first();
	if (!rec || !rec.push_token_hash || !given || !A.timingSafeEqualStr(rec.push_token_hash, await A.sha256(given))) {
		log("push_rejected", { taskId });
		return json({ error: "unauthorized" }, 401);
	}
	// normalised copy only for state/text; the task is stored exactly as the peer sent it (1.0 or 0.3 shape)
	const t = "status" in inner ? A.taskFromAny(inner) : null;
	const updates = JSON.parse(rec.updates_json || "[]");
	updates.push({ receivedAt: A.nowIso(), payload: body });
	const state = t?.status?.state ?? null;
	let text = A.textOf(t?.status?.message || {});
	if (t?.artifacts?.length) {
		const at = t.artifacts.map((x: Json) => A.textOf(x)).join("\n");
		if (at && at !== text) text = text ? `${text}\n${at}` : at;
	}
	await env.DB.batch([
		env.DB.prepare("UPDATE outbound SET updates_json = ?, task_json = COALESCE(?, task_json) WHERE task_id = ?")
			.bind(JSON.stringify(updates.slice(-20)), t && t.id ? JSON.stringify(inner) : null, taskId),
		histStmt(env, rec.context_id, { dir: "in", peer: rec.peer, taskId, event: "push", state, text }),
	]);
	log("push_received", { peer: rec.peer, taskId, state });
	await wake(env, ectx, rec.context_id, taskId, rec.peer, `[update on outbound task: ${state}] ${text}`, "outbound_update");
	return json({ ok: true });
}

// ------------------------------------------------------------------ owner API (local CLI)
function ownerTaskView(t: Json): Json {
	const { _push, _peer, _protocol, _createdAt, ...rest } = t;
	return {
		...rest, from: _peer, protocol: _protocol, createdAt: _createdAt,
		pushConfigs: (_push || []).map((c: Json) => ({ id: c.id, url: c.url, version: c._version, hasToken: !!c.token, hasAuth: !!c.authentication })),
	};
}

async function handleOwner(req: Request, env: Env, ectx: ExecutionContext, path: string, url: URL): Promise<Response> {
	if (!(await isOwner(env, req.headers.get("authorization")))) return json({ error: "unauthorized" }, 401);
	const m = req.method;
	const seg = path.split("/").filter(Boolean).slice(1); // after "owner"
	const body = async () => { const raw = await readBody(req, env); return raw ? JSON.parse(raw) : {}; };

	if (seg[0] === "inbox" && m === "GET") {
		const ctx = url.searchParams.get("context");
		const all = url.searchParams.get("all") === "1";
		let q = "SELECT id FROM tasks WHERE 1=1";
		const args: Json[] = [];
		if (!all) q += " AND state IN ('submitted','working')";
		if (ctx) { q += " AND context_id = ?"; args.push(ctx); }
		q += " ORDER BY updated_at LIMIT 200";
		const rows = await env.DB.prepare(q).bind(...args).all();
		const out = [];
		for (const r of rows.results as Json[]) {
			const t = await loadTask(env, r.id);
			const lastUser = [...t.history].reverse().find((x: Json) => x.role === "user") || {};
			out.push({ taskId: t.id, contextId: t.contextId, from: t._peer, state: t.status.state, updated: t.status.timestamp, text: A.textOf(lastUser) });
		}
		// the owner has now seen these tasks: drop pending wakes that only cover them
		const seen = new Set(out.map((o) => o.taskId));
		const pend = await env.DB.prepare("SELECT context_id, pending_json FROM wakes WHERE pending_json IS NOT NULL").all();
		for (const p of pend.results as Json[]) {
			const ids: string[] = JSON.parse(p.pending_json).taskIds || [];
			if (ids.length && ids.every((i) => seen.has(i)))
				await env.DB.prepare("UPDATE wakes SET pending_json = NULL, pending_since_ms = NULL WHERE context_id = ? AND pending_json = ?").bind(p.context_id, p.pending_json).run();
		}
		return json(out);
	}
	if (seg[0] === "tasks" && seg[1]) {
		const t = await loadTask(env, A.checkId(seg[1], "taskId"));
		if (!t) return json({ error: "task not found" }, 404);
		if (!seg[2] && m === "GET") return json(ownerTaskView(t));
		if (seg[2] === "working" && m === "POST") {
			if (A.TERMINAL.has(t.status.state)) return json({ error: `task is already ${t.status.state}` }, 409);
			t.status = { state: "working", timestamp: A.nowIso() };
			await env.DB.batch([saveTaskStmt(env, t), histStmt(env, t.contextId, { dir: "local", taskId: t.id, event: "state", state: "working" })]);
			return json({ task: ownerTaskView(t), push: await notifyPeer(env, ectx, t) });
		}
		if (seg[2] === "reply" && m === "POST") {
			const b = await body();
			const state = b.state || "completed";
			if (!["completed", "input-required", "failed", "rejected", "working"].includes(state)) return json({ error: "bad state" }, 400);
			if (typeof b.text !== "string" || !b.text) return json({ error: "text required" }, 400);
			if (A.TERMINAL.has(t.status.state) && !b.force) return json({ error: `task is already ${t.status.state}` }, 409);
			const msg = { kind: "message", role: "agent", messageId: A.newId(), contextId: t.contextId, taskId: t.id, parts: [{ kind: "text", text: b.text }] };
			if (state === "completed" || b.artifact) t.artifacts.push({ artifactId: A.newId(), name: b.artifactName || "response", parts: [{ kind: "text", text: b.text }] });
			t.history.push(msg);
			t.status = { state, timestamp: A.nowIso(), message: msg };
			await env.DB.batch([saveTaskStmt(env, t), msgStmt(env, t, msg),
				histStmt(env, t.contextId, { dir: "out", peer: t._peer, taskId: t.id, role: "agent", state, text: b.text })]);
			return json({ task: ownerTaskView(t), push: await notifyPeer(env, ectx, t) });
		}
	}
	if (seg[0] === "history" && seg[1] && m === "GET") {
		const n = Math.min(Number(url.searchParams.get("n") || "50"), 1000);
		const rows = await env.DB.prepare("SELECT * FROM (SELECT * FROM history WHERE context_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq").bind(seg[1], n).all();
		return json((rows.results as Json[]).map((r) => ({ ...r, data: r.data_json ? JSON.parse(r.data_json) : undefined, data_json: undefined })));
	}
	if (seg[0] === "history" && !seg[1] && m === "POST") {
		const b = await body();
		A.checkId(b.contextId, "contextId");
		await histStmt(env, b.contextId, b).run();
		return json({ ok: true });
	}
	if (seg[0] === "outbound" && !seg[1] && m === "POST") {
		const b = await body();
		A.checkId(b.taskId, "taskId"); A.checkId(b.contextId, "contextId");
		await env.DB.prepare(
			`INSERT INTO outbound (task_id, context_id, peer, endpoint, protocol, push_token_hash, sent_at, task_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(task_id) DO UPDATE SET task_json = excluded.task_json, push_token_hash = COALESCE(excluded.push_token_hash, outbound.push_token_hash)`,
		).bind(b.taskId, b.contextId, String(b.peer || "?"), b.endpoint || null, b.protocol || null,
			b.pushToken ? await A.sha256(b.pushToken) : null, A.nowIso(), b.task ? JSON.stringify(b.task) : null).run();
		return json({ ok: true });
	}
	if (seg[0] === "outbound" && seg[1]) {
		const id = A.checkId(seg[1], "taskId");
		if (m === "GET") {
			const r: Json = await env.DB.prepare("SELECT * FROM outbound WHERE task_id = ?").bind(id).first();
			if (!r) return json({ error: "not found" }, 404);
			return json({ taskId: r.task_id, contextId: r.context_id, peer: r.peer, endpoint: r.endpoint, protocol: r.protocol, sentAt: r.sent_at,
				task: r.task_json ? JSON.parse(r.task_json) : null, updates: JSON.parse(r.updates_json) });
		}
		if (m === "PUT") {
			const b = await body();
			await env.DB.prepare("UPDATE outbound SET task_json = ? WHERE task_id = ?").bind(JSON.stringify(b.task ?? null), id).run();
			return json({ ok: true });
		}
	}
	if (seg[0] === "peers") {
		if (m === "GET") {
			const rows = await env.DB.prepare("SELECT label, created_at, revoked_at, source, user_code, client_name FROM peers ORDER BY created_at").all();
			return json((rows.results as Json[]).map((r) => ({ ...r, user_code: r.user_code ? P.formatUserCode(r.user_code) : null })));
		}
		if (m === "POST" && !seg[1]) {
			const b = await body();
			if (typeof b.label !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(b.label)) return json({ error: "label must be [A-Za-z0-9_-]{1,32}" }, 400);
			const ex: Json = await env.DB.prepare("SELECT revoked_at FROM peers WHERE label = ?").bind(b.label).first();
			if (ex && !ex.revoked_at && !b.rotate) return json({ error: "label exists (pass rotate:true to replace its token)" }, 409);
			if (!ex && b.mustExist) return json({ error: `no token with label ${b.label} (see token list; \`token issue ${b.label}\` creates one)` }, 404);
			const token = A.randomToken();
			await env.DB.prepare(
				"INSERT INTO peers (label, token_hash, created_at) VALUES (?, ?, ?) ON CONFLICT(label) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at, revoked_at = NULL",
			).bind(b.label, await A.sha256(token), A.nowIso()).run();
			return json({ label: b.label, token, card: env.PUBLIC_URL + "/.well-known/agent-card.json" });
		}
		if (m === "DELETE" && seg[1]) {
			const label = decodeURIComponent(seg[1]);
			const r = await env.DB.prepare("UPDATE peers SET revoked_at = ? WHERE label = ? AND revoked_at IS NULL").bind(A.nowIso(), label).run();
			if (r.meta.changes !== 1) {
				const ex: Json = await env.DB.prepare("SELECT revoked_at FROM peers WHERE label = ?").bind(label).first();
				return json({ revoked: false, error: ex ? `the token with label ${label} was already revoked (${ex.revoked_at})` : `no active token with label ${label} (see token list)` }, 404);
			}
			log("token_revoked", { label });
			return json({ revoked: true, label });
		}
	}
	if (seg[0] === "pairing") return await ownerPairing(req, env, m, seg.slice(1), body);
	if (seg[0] === "wake" && seg[1] === "preview" && m === "GET") {
		// rendered wake request for a sample event, partially masked, plus short sha256 fingerprints of the
		// uploaded secrets so the owner can compare them with local values without revealing them
		const ev: WakeEvent = { contextId: "ctx-preview", taskId: "task-preview", taskIds: ["task-preview"], from: "example-peer",
			preview: "Example message preview", kind: "test", publicUrl: env.PUBLIC_URL };
		const req = await renderWake(wakeConfig(env), ev, { requestId: "preview" });
		return json({ preset: preset(env), configured: !!req, debounceSeconds: debounceMs(env) / 1000, maxPerHour: maxPerHour(env),
			hasKey: !!env.WAKE_WEBHOOK_KEY, hasHmacSecret: !!env.WAKE_HMAC_SECRET,
			hasAccessServiceToken: !!(env.WAKE_ACCESS_CLIENT_ID && env.WAKE_ACCESS_CLIENT_SECRET),
			fingerprints: { url: await A.fingerprint(env.WAKE_WEBHOOK_URL), key: await A.fingerprint(env.WAKE_WEBHOOK_KEY),
				hmacSecret: await A.fingerprint(env.WAKE_HMAC_SECRET),
				accessClientId: await A.fingerprint(env.WAKE_ACCESS_CLIENT_ID), accessClientSecret: await A.fingerprint(env.WAKE_ACCESS_CLIENT_SECRET) },
			request: req ? redact(req) : null });
	}
	if (seg[0] === "wake" && seg[1] === "test" && m === "POST") {
		const res = await sendWake(env, ectx, { contextId: "a2a-wake-test", taskId: "none", taskIds: [], from: "owner", preview: "", kind: "test" });
		return json({ preset: preset(env), configured: !!env.WAKE_WEBHOOK_URL, ...res });
	}
	if (seg[0] === "purge" && m === "POST") {
		// delete conversation data for the given contexts (test cleanup)
		const b = await body();
		if (!Array.isArray(b.contexts) || !b.contexts.length) return json({ error: "contexts[] required" }, 400);
		let n = 0;
		for (const c of b.contexts) {
			A.checkId(c, "contextId");
			const res = await env.DB.batch([
				env.DB.prepare("DELETE FROM messages WHERE context_id = ?").bind(c),
				env.DB.prepare("DELETE FROM tasks WHERE context_id = ?").bind(c),
				env.DB.prepare("DELETE FROM history WHERE context_id = ?").bind(c),
				env.DB.prepare("DELETE FROM outbound WHERE context_id = ?").bind(c),
				env.DB.prepare("DELETE FROM wakes WHERE context_id = ?").bind(c),
			]);
			n += res.reduce((s, r) => s + (r.meta.changes || 0), 0);
		}
		return json({ deletedRows: n });
	}
	if (seg[0] === "contexts" && m === "GET") {
		const rows = await env.DB.prepare("SELECT context_id, COUNT(*) AS entries, MAX(ts) AS last FROM history GROUP BY context_id ORDER BY last DESC LIMIT 100").all();
		return json(rows.results);
	}
	return json({ error: "not found" }, 404);
}

// ------------------------------------------------------------------ device-flow pairing (RFC 8628; the inbox is the authorization server)
const oauthError = (error: string, description: string, status = 400, headers: Record<string, string> = {}) =>
	json({ error, error_description: description }, status, { pragma: "no-cache", ...headers });

/** RFC 8414 metadata, for generic OAuth clients. */
function oauthMetadata(env: Env): Json {
	const u = oauthUrls(env);
	return {
		issuer: u.issuer, device_authorization_endpoint: u.device, token_endpoint: u.token,
		grant_types_supported: [P.DEVICE_GRANT], response_types_supported: [], token_endpoint_auth_methods_supported: ["none"],
		scopes_supported: ["a2a"], service_documentation: "https://github.com/telegraphic-dev/a2a-over-webhook#connecting-agents-device-flow",
	};
}

/** Rows to drop: requests a day past expiry (until then a poll still gets expired_token, not invalid_grant) and old rate windows. */
const pairingCleanup = (env: Env, now: number) => [
	env.DB.prepare("DELETE FROM device_requests WHERE expires_ms < ?").bind(now - 86400000),
	env.DB.prepare("DELETE FROM pairing_rate WHERE expires_ms < ?").bind(now),
];

/** Fixed-window counter: increments and returns the count for `key` in the current window (peek: no increment). */
async function bump(env: Env, key: string, windowS: number, peek = false): Promise<number> {
	const now = Date.now(), start = Math.floor(now / (windowS * 1000));
	if (peek) {
		const r: Json = await env.DB.prepare("SELECT count FROM pairing_rate WHERE key = ? AND window_start = ?").bind(key, start).first();
		return r?.count ?? 0;
	}
	const r: Json = await env.DB.prepare(
		"INSERT INTO pairing_rate (key, window_start, count, expires_ms) VALUES (?, ?, 1, ?) ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1 RETURNING count",
	).bind(key, start, (start + 1) * windowS * 1000).first();
	return r?.count ?? 0;
}

const clientIp = (req: Request) => req.headers.get("cf-connecting-ip") || "";
const clientCountry = (req: Request) => String(((req as Json).cf || {}).country || "");

async function deviceAuthorization(req: Request, env: Env, ectx: ExecutionContext): Promise<Response> {
	const now = Date.now(), ip = clientIp(req);
	let p: Record<string, string>;
	try {
		const raw = await readBody(req, { ...env, MAX_BODY: "4096" });
		p = P.parseParams(raw, req.headers.get("content-type"));
	} catch (e: any) { return oauthError("invalid_request", e instanceof HttpError ? "request too large" : e.message); }
	const clientName = P.cleanText(p.client_name), clientId = P.cleanText(p.client_id);
	const cardUrl = P.cleanCardUrl(p.agent_card_url);
	if (p.agent_card_url && !cardUrl) return oauthError("invalid_request", "agent_card_url must be an https URL (at most 300 characters)");
	await env.DB.batch(pairingCleanup(env, now));
	// flood control: approval prompts (wakes, pending requests) must stay few
	const retry = { "retry-after": "600" };
	if ((await bump(env, `dev:ip:${ip || "?"}`, P.LIMITS.perIpWindowS)) > P.LIMITS.perIp) {
		log("pairing_rate_limited", { ip, scope: "ip" });
		return oauthError("slow_down", "too many pairing requests from this address; try again in 10 minutes", 429, retry);
	}
	const pending: Json = await env.DB.prepare("SELECT COUNT(*) AS n FROM device_requests WHERE status = 'pending' AND expires_ms > ?").bind(now).first();
	if ((pending?.n ?? 0) >= P.LIMITS.maxPending || (await bump(env, "dev:global", 3600)) > P.LIMITS.perHour) {
		log("pairing_rate_limited", { ip, scope: "global" });
		return oauthError("slow_down", "this inbox has too many pairing requests waiting; try again later", 429, retry);
	}
	const deviceCode = P.newDeviceCode();
	let userCode = "";
	for (let i = 0; i < 5 && !userCode; i++) {
		const c = P.newUserCode();
		const r = await env.DB.prepare(
			`INSERT INTO device_requests (device_hash, user_code, client_id, client_name, agent_card_url, ip, country, status, created_ms, expires_ms, interval_s)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT DO NOTHING`,
		).bind(await A.sha256(deviceCode), c, clientId || null, clientName || null, cardUrl || null, ip || null, clientCountry(req) || null,
			now, now + P.EXPIRES_S * 1000, P.INTERVAL_S).run();
		if (r.meta.changes === 1) userCode = c;
	}
	if (!userCode) return oauthError("temporarily_unavailable", "could not allocate a user code; try again", 503);
	// Re-pairing: a requester that sends its current, still active token for this inbox (Authorization: Bearer) asks to
	// replace it. Approval then issues the new token under the same label and the old one stops working (no orphan token,
	// no "-2" label). Anything else in the header is ignored: the request is an ordinary new pairing.
	const replaces = await peerLabel(env, req.headers.get("authorization"));
	if (replaces) await env.DB.prepare("UPDATE device_requests SET replaces_label = ? WHERE user_code = ?").bind(replaces, userCode).run();
	const u = oauthUrls(env);
	const shown = P.formatUserCode(userCode);
	const complete = `${u.page}?user_code=${shown}`;
	log("pairing_requested", { ip, userCode: shown, clientName, clientId, ...(replaces ? { replaces } : {}) });
	const mode = pairingMode(env) as "human" | "agent";
	ectx.waitUntil((async () => {
		if (!(await wakeBudgetOk(env))) return log("wake_skipped", { reason: "hourly cap", kind: "pairing_request" });
		await sendWake(env, ectx, { contextId: "pairing", taskId: "none", taskIds: [], from: clientName || clientId || "unknown agent", preview: "",
			kind: "pairing_request", pairing: { userCode: shown, verificationUriComplete: complete, approval: mode, clientName, clientId, agentCardUrl: cardUrl, expiresIn: P.EXPIRES_S,
				...(replaces ? { replacesLabel: replaces } : {}) } });
	})());
	return json({ device_code: deviceCode, user_code: shown, verification_uri: u.page, verification_uri_complete: complete,
		expires_in: P.EXPIRES_S, interval: P.INTERVAL_S, ...(replaces ? { replaces_label: replaces } : {}) }, 200, { pragma: "no-cache" });
}

async function tokenEndpoint(req: Request, env: Env): Promise<Response> {
	const now = Date.now(), ip = clientIp(req);
	let p: Record<string, string>;
	try { p = P.parseParams(await readBody(req, { ...env, MAX_BODY: "4096" }), req.headers.get("content-type")); }
	catch (e: any) { return oauthError("invalid_request", e instanceof HttpError ? "request too large" : e.message); }
	if (p.grant_type !== P.DEVICE_GRANT) return oauthError("unsupported_grant_type", `only grant_type=${P.DEVICE_GRANT} is supported`);
	if (!p.device_code) return oauthError("invalid_request", "device_code is required");
	if ((await bump(env, `tok:ip:${ip || "?"}`, 60)) > P.LIMITS.pollsPerMin) return oauthError("slow_down", "too many token requests from this address", 429, { "retry-after": "60" });
	const hash = await A.sha256(p.device_code);
	const r: Json = await env.DB.prepare("SELECT * FROM device_requests WHERE device_hash = ?").bind(hash).first();
	if (!r) return oauthError("invalid_grant", "unknown, already used, or expired device_code");
	if (now >= r.expires_ms) return oauthError("expired_token", "the device_code expired; start again");
	if (r.status === "denied") {
		await env.DB.prepare("DELETE FROM device_requests WHERE device_hash = ?").bind(hash).run();
		return oauthError("access_denied", "the inbox owner denied this request");
	}
	if (r.status === "pending") {
		// RFC 8628 §3.5: polling faster than the interval -> slow_down, and the interval grows by 5 s for good
		if (r.last_poll_ms && now - r.last_poll_ms < r.interval_s * 1000) {
			await env.DB.prepare("UPDATE device_requests SET interval_s = interval_s + 5, last_poll_ms = ? WHERE device_hash = ?").bind(now, hash).run();
			return oauthError("slow_down", `polling too fast; wait at least ${r.interval_s + 5} seconds between requests`);
		}
		await env.DB.prepare("UPDATE device_requests SET last_poll_ms = ? WHERE device_hash = ?").bind(now, hash).run();
		return oauthError("authorization_pending", "waiting for the inbox owner to approve");
	}
	// approved: single use. Only the request that flips the row gets the token; the row is then deleted.
	const claimed = await env.DB.prepare("UPDATE device_requests SET status = 'redeemed' WHERE device_hash = ? AND status = 'approved'").bind(hash).run();
	if (claimed.meta.changes !== 1) return oauthError("invalid_grant", "unknown, already used, or expired device_code");
	const token = A.randomToken();
	// re-pairing (approved as a replacement): the new token takes over the label, if its token is still active
	if (r.replaces_label && r.label === r.replaces_label) {
		const u = await env.DB.prepare("UPDATE peers SET token_hash = ?, created_at = ?, source = 'pairing', user_code = ?, client_name = ? WHERE label = ? AND revoked_at IS NULL")
			.bind(await A.sha256(token), A.nowIso(), r.user_code, r.client_name || r.client_id || null, r.replaces_label).run();
		if (u.meta.changes === 1) {
			await env.DB.prepare("DELETE FROM device_requests WHERE device_hash = ?").bind(hash).run();
			log("pairing_redeemed", { ip, label: r.replaces_label, userCode: P.formatUserCode(r.user_code), replaced: true });
			return json({ access_token: token, token_type: "Bearer", peer_label: r.replaces_label, replaced: true }, 200, { pragma: "no-cache" });
		}
	}
	// the replaced token was revoked meanwhile: an ordinary new label
	let label = r.label && r.label !== r.replaces_label ? r.label
		: r.label ? await freeLabel(env, P.labelBase(r.client_name || "", r.client_id || "")) : P.labelBase(r.client_name || "", r.client_id || "");
	for (let i = 0; i < 5; i++) {
		try {
			await env.DB.prepare("INSERT INTO peers (label, token_hash, created_at, source, user_code, client_name) VALUES (?, ?, ?, 'pairing', ?, ?)")
				.bind(label, await A.sha256(token), A.nowIso(), r.user_code, r.client_name || r.client_id || null).run();
			break;
		} catch (e) {
			if (i === 4) throw e;
			label = await freeLabel(env, P.labelBase(r.client_name || "", r.client_id || "")); // taken meanwhile
		}
	}
	await env.DB.prepare("DELETE FROM device_requests WHERE device_hash = ?").bind(hash).run();
	log("pairing_redeemed", { ip, label, userCode: P.formatUserCode(r.user_code) });
	return json({ access_token: token, token_type: "Bearer", peer_label: label }, 200, { pragma: "no-cache" });
}

async function freeLabel(env: Env, base: string): Promise<string> {
	const rows = await env.DB.prepare("SELECT label FROM peers WHERE label = ? OR label LIKE ?").bind(base, `${base}-%`).all();
	const pend = await env.DB.prepare("SELECT label FROM device_requests WHERE label IS NOT NULL").all();
	return P.dedupeLabel(base, new Set([...(rows.results as Json[]), ...(pend.results as Json[])].map((x) => x.label)));
}

const pendingRequest = async (env: Env, code: string): Promise<Json | null> =>
	env.DB.prepare("SELECT * FROM device_requests WHERE user_code = ?").bind(code).first();

/** Approve or deny a pending request. Returns the label (approve) or an error message. */
async function decide(env: Env, code: string, approve: boolean, by: string): Promise<{ ok: boolean; label?: string; error?: string; request?: Json; replaced?: boolean }> {
	const r = await pendingRequest(env, code);
	if (!r) return { ok: false, error: "no pairing request with that code" };
	if (r.status !== "pending") return { ok: false, error: `that request was already ${r.status === "denied" ? "denied" : "approved"}` };
	if (Date.now() >= r.expires_ms) return { ok: false, error: "that request has expired" };
	const replacing = approve && r.replaces_label
		? !!(await env.DB.prepare("SELECT 1 FROM peers WHERE label = ? AND revoked_at IS NULL").bind(r.replaces_label).first()) : false;
	const label = !approve ? null : replacing ? r.replaces_label : await freeLabel(env, P.labelBase(r.client_name || "", r.client_id || ""));
	const u = await env.DB.prepare("UPDATE device_requests SET status = ?, label = ?, decided_ms = ?, decided_by = ? WHERE device_hash = ? AND status = 'pending'")
		.bind(approve ? "approved" : "denied", label, Date.now(), by, r.device_hash).run();
	if (u.meta.changes !== 1) return { ok: false, error: "that request was decided meanwhile" };
	log(approve ? "pairing_approved" : "pairing_denied", { userCode: P.formatUserCode(code), by, label, ...(replacing ? { replaces: label } : {}) });
	return { ok: true, label: label || undefined, request: r, replaced: replacing };
}

const pageRequest = (r: Json): P.PageRequest => ({ userCode: r.user_code, clientName: r.client_name || "", clientId: r.client_id || "",
	agentCardUrl: r.agent_card_url || "", ip: r.ip || "", country: r.country || "", createdMs: r.created_ms, expiresMs: r.expires_ms,
	replacesLabel: r.replaces_label || undefined });

async function approvalPassword(env: Env): Promise<P.PasswordRecord | null> {
	const r: Json = await env.DB.prepare("SELECT value FROM settings WHERE key = 'approval_password'").first();
	try { return r ? JSON.parse(r.value) : null; } catch { return null; }
}

function cookie(req: Request, name: string): string {
	for (const part of (req.headers.get("cookie") || "").split(";")) {
		const [k, ...v] = part.trim().split("=");
		if (k === name) return v.join("=");
	}
	return "";
}

/** GET/POST /device: the owner approves or denies a request with the approval password (no scripts, strict CSP). */
async function devicePage(req: Request, env: Env, url: URL): Promise<Response> {
	const nonce = P.randomB64(), ip = clientIp(req);
	const csrfName = "a2a_device_csrf";
	let csrf = cookie(req, csrfName);
	const fresh = !/^[A-Za-z0-9_-]{24}$/.test(csrf);
	if (fresh) csrf = P.randomB64();
	const pw = await approvalPassword(env);
	const model: P.PageModel = { agentName: env.AGENT_NAME || "this A2A inbox", mode: pairingMode(env), cli: cliCommand(env), csrf, passwordSet: !!pw };
	const send = (status = 200) => {
		const h: Record<string, string> = P.pageHeaders(nonce);
		h["set-cookie"] = `${csrfName}=${csrf}; Path=/device; Secure; HttpOnly; SameSite=Strict; Max-Age=3600`;
		return new Response(P.devicePage(model, nonce), { status, headers: h });
	};
	const show = async (raw: string | null, notice?: P.PageModel["notice"]) => {
		model.notice = notice;
		if (raw && (await bump(env, `look:ip:${ip || "?"}`, P.LIMITS.lookupsWindowS)) > P.LIMITS.lookupsPerIp) {
			model.askCode = true;
			model.notice = { kind: "error", text: "Too many code lookups from this address. Try again in a few minutes." };
			return;
		}
		const code = P.normUserCode(raw);
		const r = code ? await pendingRequest(env, code) : null;
		if (r && r.status === "pending" && Date.now() < r.expires_ms) model.request = pageRequest(r);
		else {
			model.askCode = true;
			model.codeValue = raw || "";
			if (raw && !notice) model.notice = { kind: "error", text: !code ? "That is not a valid code (it looks like WDJB-4827)." :
				!r ? "No pairing request with that code (it may have expired or been used)." :
				r.status !== "pending" ? `That request was already ${r.status === "denied" ? "denied" : "approved"}.` : "That request has expired." };
		}
	};
	if (req.method === "GET") {
		await show(url.searchParams.get("user_code"));
		return send();
	}
	// POST: same-origin form only (Origin check + double-submit cookie); the approval password is the real gate
	const origin = req.headers.get("origin");
	let form: Record<string, string> = {};
	try { form = P.parseParams(await readBody(req, { ...env, MAX_BODY: "4096" }), "application/x-www-form-urlencoded"); } catch { /* empty */ }
	if ((origin && origin !== "null" && origin !== new URL(env.PUBLIC_URL).origin && origin !== url.origin) || fresh || !form.csrf || !A.timingSafeEqualStr(form.csrf, csrf)) {
		await show(form.user_code || null, { kind: "error", text: "This form expired or came from another site. Reload the page and try again." });
		return send(403);
	}
	const code = P.normUserCode(form.user_code);
	if (!code) { await show(form.user_code || null); return send(400); }
	// Deny needs no password: it grants nothing, and the worst a holder of the code can do is cancel a pending request
	// (the requester can ask again). No PBKDF2 runs; each deny counts against the per-IP code-lookup limit, so codes
	// can't be enumerated this way either.
	if (form.decision === "deny") {
		if ((await bump(env, `look:ip:${ip || "?"}`, P.LIMITS.lookupsWindowS)) > P.LIMITS.lookupsPerIp) {
			await show(null, { kind: "error", text: "Too many code lookups from this address. Try again in a few minutes." });
			return send(429);
		}
		const r0 = await pendingRequest(env, code);
		if (!r0 || r0.status !== "pending" || Date.now() >= r0.expires_ms) { await show(form.user_code); return send(404); }
		const d0 = await decide(env, code, false, "page");
		if (!d0.ok) { await show(null, { kind: "error", text: d0.error! }); return send(409); }
		model.notice = { kind: "ok", text: `Denied. ${r0.client_name || r0.client_id || "the agent"} gets no token.` };
		return send();
	}
	if (!pw) { await show(form.user_code); return send(409); }
	// an empty password is a slip, not a guess: no PBKDF2, no attempt counted
	if (!form.password) { await show(form.user_code, { kind: "error", text: "Enter the approval password to approve (deny works without it)." }); return send(400); }
	const ipKey = `pw:ip:${ip || "?"}`;
	if ((await bump(env, ipKey, P.LIMITS.wrongPerIpWindowS, true)) >= P.LIMITS.wrongPerIp || (await bump(env, "pw:global", 3600, true)) >= P.LIMITS.wrongGlobal) {
		log("pairing_locked_out", { ip });
		await show(form.user_code, { kind: "error", text: "Too many wrong passwords. Approvals from this address are locked for up to an hour." });
		return send(429);
	}
	const r = await pendingRequest(env, code);
	if (!r || r.status !== "pending" || Date.now() >= r.expires_ms) { await show(form.user_code); return send(404); }
	if (!(await P.verifyPassword(form.password || "", pw))) {
		await bump(env, ipKey, P.LIMITS.wrongPerIpWindowS);
		await bump(env, "pw:global", 3600);
		const res: Json = await env.DB.prepare("UPDATE device_requests SET failed_attempts = failed_attempts + 1 WHERE device_hash = ? RETURNING failed_attempts").bind(r.device_hash).first();
		const left = P.LIMITS.wrongPerCode - (res?.failed_attempts ?? P.LIMITS.wrongPerCode);
		log("pairing_wrong_password", { ip, userCode: P.formatUserCode(code), left });
		if (left <= 0) {
			await decide(env, code, false, "lockout");
			await show(null, { kind: "error", text: "Wrong password. Too many wrong attempts for this code: the request was denied." });
			return send(403);
		}
		await show(form.user_code, { kind: "error", text: `Wrong password. ${left} attempt${left === 1 ? "" : "s"} left for this code.` });
		return send(403);
	}
	const d = await decide(env, code, true, "human");
	if (!d.ok) { await show(null, { kind: "error", text: d.error! }); return send(409); }
	const who = r.client_name || r.client_id || "the agent";
	model.notice = { kind: "ok", text: `Approved. ${who} can now collect its token (label "${d.label}"${d.replaced ? ", replacing its old token" : ""}). Revoke it any time: ${cliCommand(env)} token revoke ${d.label}` };
	return send();
}

// ------------------------------------------------------------------ one-time password setup link (pair set-password --web)
type SetupRecord = { hash: string; createdMs: number; expiresMs: number; failures: number };

async function setupRecord(env: Env): Promise<{ rec: SetupRecord; raw: string } | null> {
	const r: Json = await env.DB.prepare("SELECT value FROM settings WHERE key = 'password_setup'").first();
	if (!r) return null;
	try { return { rec: JSON.parse(r.value), raw: r.value }; } catch { return null; }
}

/** The stored setup record when `token` is its live token (unexpired, not burned), else null. */
async function liveSetup(env: Env, token: string): Promise<{ rec: SetupRecord; raw: string } | null> {
	if (!token || token.length > 128) return null;
	const s = await setupRecord(env);
	if (!s || Date.now() >= s.rec.expiresMs || s.rec.failures >= P.LIMITS.setupFailures) return null;
	return A.timingSafeEqualStr(await A.sha256(token), s.rec.hash) ? s : null;
}

/** GET/POST /device/setup: set or change the approval password from a one-time link. Same frame, CSP and CSRF as /device. */
async function setupPage(req: Request, env: Env, url: URL): Promise<Response> {
	const nonce = P.randomB64(), ip = clientIp(req);
	const csrfName = "a2a_device_csrf";
	let csrf = cookie(req, csrfName);
	const fresh = !/^[A-Za-z0-9_-]{24}$/.test(csrf);
	if (fresh) csrf = P.randomB64();
	const pw = await approvalPassword(env);
	const model: P.SetupModel = { agentName: env.AGENT_NAME || "this A2A inbox", cli: cliCommand(env), csrf, passwordSetAt: pw?.setAt };
	const send = (status = 200) => {
		const h: Record<string, string> = P.pageHeaders(nonce);
		h["set-cookie"] = `${csrfName}=${csrf}; Path=/device; Secure; HttpOnly; SameSite=Strict; Max-Age=3600`;
		return new Response(P.setupPage(model, nonce), { status, headers: h });
	};
	const invalid = (status: number, text = "This setup link is invalid, expired or already used.") => {
		model.token = undefined;
		model.notice = { kind: "error", text };
		return send(status);
	};
	if ((await bump(env, `setup:ip:${ip || "?"}`, P.LIMITS.setupWindowS)) > P.LIMITS.setupPerIp) {
		log("password_setup_rate_limited", { ip });
		return invalid(429, "Too many attempts from this address. Try again in a few minutes.");
	}
	if (req.method === "GET") {
		const t = url.searchParams.get("t") || "";
		const s = await liveSetup(env, t);
		if (!s) return invalid(t ? 404 : 400);
		model.token = t; model.expiresMs = s.rec.expiresMs;
		return send();
	}
	const origin = req.headers.get("origin");
	let form: Record<string, string> = {};
	try { form = P.parseParams(await readBody(req, { ...env, MAX_BODY: "8192" }), "application/x-www-form-urlencoded"); } catch { /* empty */ }
	const s = await liveSetup(env, form.t || "");
	if ((origin && origin !== "null" && origin !== new URL(env.PUBLIC_URL).origin && origin !== url.origin) || fresh || !form.csrf || !A.timingSafeEqualStr(form.csrf, csrf)) {
		if (s) { model.token = form.t; model.expiresMs = s.rec.expiresMs; }
		model.notice = { kind: "error", text: "This form expired or came from another site. Reload the page and try again." };
		return send(403);
	}
	if (!s) return invalid(404);
	const a = form.password || "", b = form.password2 || "";
	const problem = a.length < P.MIN_PASSWORD_LENGTH ? `Too short: use at least ${P.MIN_PASSWORD_LENGTH} characters (a passphrase of a few words works well).`
		: a.length > 1024 ? "Too long: at most 1024 characters." : a !== b ? "The two entries differ." : "";
	if (problem) {
		const failures = s.rec.failures + 1;
		const burned = failures >= P.LIMITS.setupFailures;
		await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'password_setup' AND value = ?").bind(JSON.stringify({ ...s.rec, failures }), s.raw).run();
		log("password_setup_rejected", { ip, failures, burned });
		if (burned) return invalid(403, `${problem} Too many attempts: this link is now used up. Ask your agent for a new one.`);
		model.token = form.t; model.expiresMs = s.rec.expiresMs;
		model.notice = { kind: "error", text: `${problem} Nothing was changed.` };
		return send(400);
	}
	// hash on the Worker (a one-off), then burn the token; only the request that burns it stores the password
	const rec = await P.makePasswordRecord(a, P.pbkdf2Iterations(env.PBKDF2_ITERATIONS));
	const burn = await env.DB.prepare("DELETE FROM settings WHERE key = 'password_setup' AND value = ?").bind(s.raw).run();
	if (burn.meta.changes !== 1) return invalid(409);
	const setAt = A.nowIso();
	await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('approval_password', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
		.bind(JSON.stringify({ ...rec, setAt, setVia: "web" })).run();
	log("pairing_password_set", { via: "web", setAt, iterations: rec.iterations, ip });
	model.done = true;
	model.notice = { kind: "ok", text: `Approval password ${pw ? "changed" : "set"} (${setAt}). Only its salted PBKDF2-SHA256 hash is stored.` };
	return send();
}

/** Owner API: /owner/pairing (list, mode), /owner/pairing/password (set), /owner/pairing/<code>/approve|deny. */
async function ownerPairing(req: Request, env: Env, m: string, seg: string[], body: () => Promise<Json>): Promise<Response> {
	const mode = pairingMode(env);
	if (!seg[0] && m === "GET") {
		const now = Date.now();
		const rows = await env.DB.prepare("SELECT * FROM device_requests WHERE status = 'pending' AND expires_ms > ? ORDER BY created_ms").bind(now).all();
		const pw = await approvalPassword(env);
		const setup = await setupRecord(env);
		const linkLive = setup && now < setup.rec.expiresMs && setup.rec.failures < P.LIMITS.setupFailures;
		// with pairing off, leftover requests can't be approved or redeemed (every pairing endpoint is 404): don't list them
		const pending = mode === "off" ? [] : (rows.results as Json[]);
		return json({ mode, passwordSet: !!pw, passwordSetAt: pw?.setAt || null, passwordSetVia: pw ? pw.setVia || "terminal" : null,
			passwordIterations: pw?.iterations || null, pbkdf2Iterations: P.pbkdf2Iterations(env.PBKDF2_ITERATIONS),
			setupLinkExpiresAt: linkLive ? new Date(setup!.rec.expiresMs).toISOString() : null, verificationUri: oauthUrls(env).page,
			pending: pending.map((r) => ({ userCode: P.formatUserCode(r.user_code), clientName: r.client_name, clientId: r.client_id,
				agentCardUrl: r.agent_card_url, ip: r.ip, country: r.country, createdAt: new Date(r.created_ms).toISOString(),
				expiresAt: new Date(r.expires_ms).toISOString(), verificationUriComplete: `${oauthUrls(env).page}?user_code=${P.formatUserCode(r.user_code)}`,
				replacesLabel: r.replaces_label || null })) });
	}
	if (seg[0] === "password-link" && m === "POST" && !seg[1]) {
		if (mode === "off") return json({ error: "device-flow pairing is disabled (PAIRING_APPROVAL=off): there is nothing to approve, so no approval password is needed" }, 409);
		const b = await body();
		const ttl = b.ttlSeconds === undefined ? P.SETUP_LINK_DEFAULT_S : Number(b.ttlSeconds);
		if (!Number.isInteger(ttl) || ttl < P.SETUP_LINK_MIN_S || ttl > P.SETUP_LINK_MAX_S)
			return json({ error: `ttlSeconds must be a whole number from ${P.SETUP_LINK_MIN_S} to ${P.SETUP_LINK_MAX_S}` }, 400);
		const token = P.randomB64(32), now = Date.now();
		// one live link at a time: storing a new record replaces (invalidates) the previous link
		await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('password_setup', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
			.bind(JSON.stringify({ hash: await A.sha256(token), createdMs: now, expiresMs: now + ttl * 1000, failures: 0 })).run();
		log("password_setup_link_created", { expiresAt: new Date(now + ttl * 1000).toISOString() });
		return json({ url: `${oauthUrls(env).setup}?t=${token}`, expiresAt: new Date(now + ttl * 1000).toISOString(), expiresIn: ttl, mode,
			passwordSet: !!(await approvalPassword(env)) });
	}
	if (seg[0] === "password" && m === "PUT") {
		const b = await body();
		const rec = { alg: b.alg, iterations: b.iterations, salt: b.salt, hash: b.hash };
		const err = P.checkPasswordRecord(rec);
		if (err) return json({ error: err }, 400);
		const setAt = A.nowIso();
		await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('approval_password', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
			.bind(JSON.stringify({ ...rec, setAt, setVia: "terminal" })).run();
		log("pairing_password_set", { via: "terminal", setAt, iterations: rec.iterations });
		return json({ ok: true, mode, setAt });
	}
	if (seg[0] && (seg[1] === "approve" || seg[1] === "deny") && m === "POST" && !seg[2]) {
		if (mode === "off") return json({ error: "device-flow pairing is disabled (PAIRING_APPROVAL=off)" }, 404);
		const code = P.normUserCode(decodeURIComponent(seg[0]));
		if (!code) return json({ error: "not a valid code (it looks like WDJB-4827)" }, 400);
		const approve = seg[1] === "approve";
		if (approve && mode !== "agent")
			return json({ error: `approval mode is human: the owner approves on ${oauthUrls(env).page}?user_code=${P.formatUserCode(code)} with the approval password. \`pair approve\` works only after \`${cliCommand(env)} deploy --pairing-approval agent\`, and only if your human wants the agent to approve. \`pair deny\` works in every mode.` }, 403);
		const d = await decide(env, code, approve, approve ? "agent" : "owner");
		if (!d.ok) return json({ error: d.error }, 409);
		return json({ ok: true, decision: approve ? "approved" : "denied", userCode: P.formatUserCode(code), label: d.label || null,
			clientName: d.request.client_name || d.request.client_id || null, replaced: !!d.replaced });
	}
	return json({ error: "not found" }, 404);
}

// ------------------------------------------------------------------ router
async function handle(req: Request, env: Env, ectx: ExecutionContext): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;
	try {
		if (req.method === "GET" && path === "/.well-known/agent-card.json")
			return json(agentCard(env), 200, { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" });
		// legacy discovery path (A2A 0.2): the 0.3-shaped card that clients of that era parse
		if (req.method === "GET" && path === "/.well-known/agent.json")
			return json(agentCard03(env), 200, { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" });
		if (req.method === "GET" && path === "/health") return json({ ok: true, publicUrl: env.PUBLIC_URL });
		if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-protected-resource" || path.startsWith("/oauth/") || path === "/device" || path === "/device/setup") {
			if (!pairingOn(env)) return json({ error: "not_found", error_description: "device-flow pairing is disabled on this inbox (PAIRING_APPROVAL=off); ask its operator for a token" }, 404);
			if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") return json(oauthMetadata(env), 200, { "access-control-allow-origin": "*" });
			if (req.method === "GET" && path === "/.well-known/oauth-protected-resource") return json(protectedResourceMetadata(env), 200, { "access-control-allow-origin": "*" });
			if (req.method === "POST" && path === "/oauth/device_authorization") return await deviceAuthorization(req, env, ectx);
			if (req.method === "POST" && path === "/oauth/token") return await tokenEndpoint(req, env);
			if (path === "/device" && (req.method === "GET" || req.method === "POST")) return await devicePage(req, env, url);
			if (path === "/device/setup" && (req.method === "GET" || req.method === "POST")) return await setupPage(req, env, url);
			return json({ error: "not found" }, 404);
		}
		if (req.method === "POST" && (path === "/" || path === "/a2a" || path === "/a2a/v1")) return await handleRpc(req, env, ectx);
		if (req.method === "POST" && path === "/push") return await handlePush(req, env, ectx);
		if (path === "/owner" || path.startsWith("/owner/")) return await handleOwner(req, env, ectx, path, url);
		if (req.method === "GET" && path === "/") return json({ name: env.AGENT_NAME, agentCard: env.PUBLIC_URL + "/.well-known/agent-card.json" });
		return json({ error: "not found" }, 404);
	} catch (e: any) {
		if (e instanceof HttpError) return json({ error: e.message }, e.status);
		if (e instanceof A.InvalidParams || e instanceof SyntaxError) return json({ error: e.message }, 400);
		log("exception", { path, error: String(e?.stack || e).slice(0, 500) });
		return json({ error: "internal error" }, 500);
	}
}

export default {
	async fetch(req, env: Env, ectx) {
		// PUBLIC_URL comes from the deployment (custom hostname or workers.dev). Unknown on a first workers.dev deploy,
		// or not a public https origin: use the origin the request reached the Worker on (always public).
		env = { ...env, PUBLIC_URL: A.publicOrigin(env.PUBLIC_URL, req.url) };
		const moved = A.movedResponse(req.url, env.PUBLIC_URL, env.RETIRED_HOSTNAMES);
		if (moved) return new Response(moved.body || null, { status: moved.status, headers: moved.headers });
		const res = await handle(req, env, ectx);
		// opportunistic flush of debounced wakes whose window has passed (no cron needed)
		ectx.waitUntil(flushDue(env, ectx).catch((e) => log("flush_failed", { error: String(e).slice(0, 200) })));
		return res;
	},
	// optional: enable with A2A_ENABLE_CRON=1 at deploy time (needs a workers.dev subdomain on the account)
	async scheduled(_ev, env: Env, ectx) {
		await flushDue(env, ectx);
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare("DELETE FROM rate WHERE minute < ?").bind(Math.floor(now / 60000) - 5),
			env.DB.prepare("DELETE FROM wake_budget WHERE hour < ?").bind(Math.floor(now / 3600000) - 24),
			...pairingCleanup(env, now),
		]);
	},
} satisfies ExportedHandler<Env>;
