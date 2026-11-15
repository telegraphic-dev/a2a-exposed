// Owner inspection reads (docs/owner-inspection.md): counts, read-only task lists, and paged history.
// Every function here is read-only. None clears a wake or marks a reply seen.
// The caller (handleOwner) has already checked owner authorization.

import * as A from "./a2a.ts";
import * as SealedKeys from "./sealed-keys.ts";
import { scrubSecretText } from "./export.ts";
import type { SqlDb } from "./tenancy.ts";

type Json = any;

export const STATES = ["submitted", "working", "input-required", "completed", "failed", "rejected", "canceled"] as const;
export const GROUPS: Record<string, readonly string[]> = {
	open: ["submitted", "working"],
	waiting: ["input-required"],
	terminal: ["completed", "failed", "rejected", "canceled"],
};
export const LIST_DEFAULT = 50;
export const LIST_MAX = 200;
export const PREVIEW_MAX = 280;
const PEER_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
/** Cursor text: base64url. The longest one (a 128-character id) stays under 512 characters. */
export const CURSOR_RE = /^[A-Za-z0-9_-]{1,512}$/;

const bad = (msg: string) => new A.InvalidParams(msg);

function b64url(s: string): string {
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
	const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
	return atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

function countOf(v: unknown): number {
	const n = Number(v ?? 0);
	return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function emptyStates(): Record<string, number> {
	const out: Record<string, number> = {};
	for (const s of STATES) out[s] = 0;
	return out;
}

function groupsOf(tasks: Record<string, number>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [g, states] of Object.entries(GROUPS)) out[g] = states.reduce((sum, s) => sum + (tasks[s] || 0), 0);
	return out;
}

/** The filter key a cursor is bound to. A cursor from another query does not match it. */
async function bindingOf(parts: unknown[]): Promise<string> {
	return (await A.sha256(JSON.stringify(parts))).slice(0, 16);
}

function parseLimit(raw: string | null): number {
	if (raw === null) return LIST_DEFAULT;
	if (!/^[1-9]\d{0,2}$/.test(raw) || Number(raw) > LIST_MAX) throw bad(`limit must be 1-${LIST_MAX}`);
	return Number(raw);
}

function parseOrder(raw: string | null, fallback: "newest" | "oldest"): "newest" | "oldest" {
	if (raw === null) return fallback;
	if (raw !== "newest" && raw !== "oldest") throw bad("order must be newest or oldest");
	return raw;
}

function parsePeer(raw: string | null, name: string): string | null {
	if (raw === null) return null;
	if (!PEER_RE.test(raw)) throw bad(`${name} is invalid`);
	return raw;
}

function parseContext(raw: string | null): string | null {
	if (raw === null) return null;
	if (!A.ID_RE.test(raw)) throw bad("context is invalid");
	return raw;
}

function parseStates(raw: string | null): { key: string; states: readonly string[] | null } {
	if (raw === null || raw === "all") return { key: "all", states: null };
	if (GROUPS[raw]) return { key: raw, states: GROUPS[raw]! };
	if ((STATES as readonly string[]).includes(raw)) return { key: raw, states: [raw] };
	throw bad("state must be a task state, open, waiting, terminal, or all");
}

/** Decode `binding \n field \n ...` and check the binding. */
function openCursor(raw: string | null, binding: string, fields: number): string[] | null {
	if (raw === null) return null;
	if (!CURSOR_RE.test(raw)) throw bad("cursor is invalid");
	let text = "";
	try { text = b64urlDecode(raw); } catch { throw bad("cursor is invalid"); }
	const parts = text.split("\n");
	if (parts.length !== fields + 1) throw bad("cursor is invalid");
	if (parts[0] !== binding) throw bad("cursor does not match");
	return parts.slice(1);
}

/** Last user message as a list preview: secrets scrubbed, at most PREVIEW_MAX characters. A sealed message has none. */
function previewOf(messageJson: unknown): { preview: string | null; sealed: boolean } {
	if (typeof messageJson !== "string") return { preview: null, sealed: false };
	let msg: Json;
	try { msg = JSON.parse(messageJson); } catch { return { preview: null, sealed: false }; }
	if (SealedKeys.envelopeOf(msg)) return { preview: null, sealed: true };
	const text = scrubSecretText(A.textOf(msg) || "");
	return { preview: text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX - 1) + "…" : text, sealed: false };
}

/** GET /owner/summary. Counts are tasks, never messages. No message text. */
export async function summary(db: SqlDb): Promise<Json> {
	const tasks = emptyStates();
	const rows = await db.prepare("SELECT state, COUNT(*) AS n FROM tasks GROUP BY state").all();
	for (const r of rows.results as Json[]) if (typeof r.state === "string" && r.state in tasks) tasks[r.state] = countOf(r.n);

	const peers = new Map<string, Json>();
	const perPeer = await db.prepare(`SELECT t.peer AS peer, t.state AS state, COUNT(*) AS n, MAX(t.updated_at) AS updated,
		MAX(CASE WHEN p.revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked
		FROM tasks t LEFT JOIN peers p ON p.label = t.peer GROUP BY t.peer, t.state ORDER BY t.peer`).all();
	for (const r of perPeer.results as Json[]) {
		if (typeof r.peer !== "string" || !r.peer) continue;
		let p = peers.get(r.peer);
		if (!p) { p = { peer: r.peer, revoked: false, tasks: emptyStates(), updated: null }; peers.set(r.peer, p); }
		if (typeof r.state === "string" && r.state in p.tasks) p.tasks[r.state] = countOf(r.n);
		if (Number(r.revoked) === 1) p.revoked = true;
		if (typeof r.updated === "string" && (!p.updated || r.updated > p.updated)) p.updated = r.updated;
	}

	const outbound = { tasks: 0, unseenReplies: 0 };
	const out = await db.prepare(`SELECT peer, COUNT(*) AS n,
		SUM(CASE WHEN updates_seen = 0 AND updates_json != '[]' THEN 1 ELSE 0 END) AS unseen
		FROM outbound GROUP BY peer`).all();
	for (const r of out.results as Json[]) {
		const n = countOf(r.n), unseen = countOf(r.unseen);
		outbound.tasks += n; outbound.unseenReplies += unseen;
		const p = typeof r.peer === "string" ? peers.get(r.peer) : undefined;
		if (p) p.outbound = { tasks: n, unseenReplies: unseen };
	}
	return { tasks, groups: groupsOf(tasks), peers: [...peers.values()], outbound };
}

/**
 * GET /owner/tasks: inbound tasks, read-only. The cursor carries the filters, the order, `asOf` and the position.
 * `updatedSince` counts tasks under the same filters updated after `asOf`.
 */
export async function listTasks(db: SqlDb, q: URLSearchParams, now: string): Promise<Json> {
	const { key: stateKey, states } = parseStates(q.get("state"));
	const from = parsePeer(q.get("from"), "from");
	const context = parseContext(q.get("context"));
	const order = parseOrder(q.get("order"), "newest");
	const limit = parseLimit(q.get("limit"));
	const binding = await bindingOf(["tasks", stateKey, from, context, order]);
	const cur = openCursor(q.get("cursor"), binding, 3);
	const asOf = cur ? cur[0]! : now;
	if (!STAMP_RE.test(asOf)) throw bad("cursor is invalid");
	if (cur && (!STAMP_RE.test(cur[1]!) || !A.ID_RE.test(cur[2]!))) throw bad("cursor is invalid");

	let where = "1=1";
	const args: Json[] = [];
	if (states) { where += ` AND t.state IN (${states.map(() => "?").join(",")})`; args.push(...states); }
	if (from) { where += " AND t.peer = ?"; args.push(from); }
	if (context) { where += " AND t.context_id = ?"; args.push(context); }
	const filterArgs = [...args];
	const newest = order === "newest";
	let pageWhere = where;
	if (cur) {
		pageWhere += newest
			? " AND (t.updated_at < ? OR (t.updated_at = ? AND t.id < ?))"
			: " AND (t.updated_at > ? OR (t.updated_at = ? AND t.id > ?))";
		args.push(cur[1], cur[1], cur[2]);
	}
	const dir = newest ? "DESC" : "ASC";
	const rows = await db.prepare(`SELECT t.id, t.context_id, t.peer, t.state, t.created_at, t.updated_at, t.status_json,
		(SELECT COUNT(*) FROM messages m WHERE m.task_id = t.id) AS message_count,
		(SELECT message_json FROM messages m WHERE m.task_id = t.id AND m.role = 'user' ORDER BY m.seq DESC LIMIT 1) AS last_user,
		(SELECT CASE WHEN p.revoked_at IS NOT NULL THEN 1 ELSE 0 END FROM peers p WHERE p.label = t.peer) AS revoked
		FROM tasks t WHERE ${pageWhere} ORDER BY t.updated_at ${dir}, t.id ${dir} LIMIT ?`).bind(...args, limit + 1).all();
	const found = rows.results as Json[];
	const page = found.slice(0, limit);
	const items = page.map((r) => {
		let status: Json = null;
		try { status = JSON.parse(r.status_json); } catch { status = null; }
		const ownerWait = status ? A.ownerWaitOf({ status }) : undefined;
		const { preview, sealed } = previewOf(r.last_user);
		return {
			taskId: r.id, contextId: r.context_id, from: r.peer, peerRevoked: Number(r.revoked) === 1, state: r.state,
			createdAt: r.created_at, updated: r.updated_at, messageCount: countOf(r.message_count), preview, sealed,
			...(ownerWait ? { ownerWait } : {}),
		};
	});
	const changed: Json = await db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${where} AND t.updated_at > ?`).bind(...filterArgs, asOf).first();
	let nextCursor: string | null = null;
	if (found.length > limit && page.length) {
		const last = page[page.length - 1];
		if (STAMP_RE.test(String(last.updated_at)) && A.ID_RE.test(String(last.id)))
			nextCursor = b64url(`${binding}\n${asOf}\n${last.updated_at}\n${last.id}`);
	}
	return { items, nextCursor, asOf, updatedSince: countOf(changed?.n) };
}

/** State and time of the newest stored update on an outbound task, else its sent task. */
function outboundState(r: Json, viewOf: (payload: Json) => { state: string | null }): { state: string | null; updated: string } {
	let updates: Json[] = [];
	try { updates = JSON.parse(r.updates_json || "[]"); } catch { updates = []; }
	const last = updates[updates.length - 1];
	if (last && typeof last === "object") {
		const view = viewOf(last.payload);
		if (view.state) return { state: view.state, updated: typeof last.receivedAt === "string" ? last.receivedAt : r.sent_at };
	}
	let task: Json = null;
	try { task = r.task_json ? JSON.parse(r.task_json) : null; } catch { task = null; }
	const state = typeof task?.status?.state === "string" ? task.status.state : null;
	return { state, updated: typeof last?.receivedAt === "string" ? last.receivedAt : r.sent_at };
}

/**
 * GET /owner/outbound: tasks this agent sent, read-only. Ordered by send time, which does not change,
 * so `updatedSince` counts tasks sent after `asOf`. There is no `state` filter: an outbound state is
 * read from the peer's last update, not stored as a column.
 */
export async function listOutbound(db: SqlDb, q: URLSearchParams, now: string, viewOf: (payload: Json) => { state: string | null }): Promise<Json> {
	if (q.has("state")) throw bad("state is not supported on outbound; filter by to or context");
	const to = parsePeer(q.get("to"), "to");
	const context = parseContext(q.get("context"));
	const order = parseOrder(q.get("order"), "newest");
	const limit = parseLimit(q.get("limit"));
	const binding = await bindingOf(["outbound", to, context, order]);
	const cur = openCursor(q.get("cursor"), binding, 3);
	const asOf = cur ? cur[0]! : now;
	if (!STAMP_RE.test(asOf)) throw bad("cursor is invalid");
	if (cur && (!STAMP_RE.test(cur[1]!) || !A.ID_RE.test(cur[2]!))) throw bad("cursor is invalid");

	let where = "1=1";
	const args: Json[] = [];
	if (to) { where += " AND peer = ?"; args.push(to); }
	if (context) { where += " AND context_id = ?"; args.push(context); }
	const filterArgs = [...args];
	const newest = order === "newest";
	let pageWhere = where;
	if (cur) {
		pageWhere += newest ? " AND (sent_at < ? OR (sent_at = ? AND task_id < ?))" : " AND (sent_at > ? OR (sent_at = ? AND task_id > ?))";
		args.push(cur[1], cur[1], cur[2]);
	}
	const dir = newest ? "DESC" : "ASC";
	const rows = await db.prepare(`SELECT task_id, context_id, peer, sent_at, task_json, updates_json, updates_seen
		FROM outbound WHERE ${pageWhere} ORDER BY sent_at ${dir}, task_id ${dir} LIMIT ?`).bind(...args, limit + 1).all();
	const found = rows.results as Json[];
	const page = found.slice(0, limit);
	const items = page.map((r) => {
		const { state, updated } = outboundState(r, viewOf);
		let updates: Json[] = [];
		try { updates = JSON.parse(r.updates_json || "[]"); } catch { updates = []; }
		return {
			taskId: r.task_id, contextId: r.context_id, to: r.peer, state, sentAt: r.sent_at, updated,
			updateCount: updates.length, unseen: updates.length > 0 && Number(r.updates_seen) === 0,
		};
	});
	const changed: Json = await db.prepare(`SELECT COUNT(*) AS n FROM outbound WHERE ${where} AND sent_at > ?`).bind(...filterArgs, asOf).first();
	let nextCursor: string | null = null;
	if (found.length > limit && page.length) {
		const last = page[page.length - 1];
		if (STAMP_RE.test(String(last.sent_at)) && A.ID_RE.test(String(last.task_id)))
			nextCursor = b64url(`${binding}\n${asOf}\n${last.sent_at}\n${last.task_id}`);
	}
	return { items, nextCursor, asOf, updatedSince: countOf(changed?.n) };
}

/** True when GET /owner/history/<id> asks for the paged form. `n` alone keeps the array form. */
export function historyPaged(q: URLSearchParams): boolean {
	return q.has("limit") || q.has("cursor") || q.has("order");
}

/** Paging arguments for history. The cursor is bound to the context id, `from` and the order. */
export async function historyPage(q: URLSearchParams, contextId: string, from: string | null): Promise<{ limit: number; newest: boolean; after: number | null; binding: string }> {
	if (q.has("n")) throw bad("use n or limit, not both");
	const order = parseOrder(q.get("order"), "oldest");
	const limit = parseLimit(q.get("limit"));
	const binding = await bindingOf(["history", contextId, from, order]);
	const cur = openCursor(q.get("cursor"), binding, 1);
	let after: number | null = null;
	if (cur) {
		if (!/^[1-9]\d{0,15}$/.test(cur[0]!)) throw bad("cursor is invalid");
		after = Number(cur[0]);
	}
	return { limit, newest: order === "newest", after, binding };
}

export function historyCursor(binding: string, seq: unknown): string | null {
	const n = Number(seq);
	return Number.isSafeInteger(n) && n > 0 ? b64url(`${binding}\n${n}`) : null;
}

/** A history row for the paged list: a sealed row keeps `sealed: true` and loses its envelope. */
export function pagedHistoryRow(row: Json): Json {
	const data = row.data;
	if (!data || typeof data !== "object" || !("sealed" in data)) return row;
	const { sealed: _envelope, ...rest } = data;
	return { ...row, text: "[encrypted message]", sealed: true, data: Object.keys(rest).length ? rest : undefined };
}
