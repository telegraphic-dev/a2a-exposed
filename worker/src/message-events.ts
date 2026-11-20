import type { TenantContext } from "./tenancy.ts";
import { sha256 } from "./a2a.ts";
import { withDeadline } from "./deadline.ts";
import { fetchCheckedCallback, type CallbackResult } from "./wake-target.ts";

/** No content or token hashes leave this boundary. IDs from the peer remain untrusted filter data. */
export type MessageEvent = {
	version: 1; type: "message_received"; eventId: string;
	sourceInstanceId: string; tenantId: string; peerInstanceId: string; peerLabel: string;
	messageId: string; taskId: string; contextId: string; receivedAt: string;
	role: "user"; classification: "inbound" | "direct_reply";
};

export function messageEventTarget(ctx: TenantContext): { url: string; secret: string } | null {
	if (ctx.mode === "single" && ctx.ENABLE_CRON !== "1") return null;
	const secret = ctx.MESSAGE_EVENT_SECRET || "";
	try {
		if ((ctx.MESSAGE_EVENT_URL || "").length > 2000) return null;
		const u = new URL(ctx.MESSAGE_EVENT_URL || "");
		if (u.protocol !== "https:" || u.username || u.password || u.hash || secret.length < 32 || secret.length > 512 || /[\x00-\x1f]/.test(secret)) return null;
		return { url: u.href, secret };
	} catch { return null; }
}

/** One query is a snapshot of source plus the requested active label or exact tombstone. */
export async function messageEventIdentity(ctx: TenantContext, query?: { label?: string; instance?: string }) {
	if (!messageEventTarget(ctx) || ctx.status !== "active") return null;
	const peer = query?.label !== undefined ? "p.label=? AND p.active=1" : "p.instance_id=?";
	const authority = ctx.mode === "host" ? " AND EXISTS(SELECT 1 FROM tenant_config WHERE tenant_id=? AND version=? AND status='active')" : "";
 const args = [...(query ? [query.label ?? query.instance] : []), ...(ctx.mode === "host" ? [ctx.id, ctx.configVersion] : [])];
 const statement = ctx.DB.prepare(query
  ? `SELECT s.instance_id AS sourceInstanceId,p.instance_id AS peerInstanceId,p.label,p.active FROM message_event_source s JOIN message_event_peers p ON ${peer} WHERE s.singleton=1${authority}`
  : `SELECT instance_id AS sourceInstanceId FROM message_event_source WHERE singleton=1${authority}`);
 const row = await (args.length ? statement.bind(...args) : statement).first<{sourceInstanceId:string;peerInstanceId?:string;label?:string;active?:number}>();
	if (!row) return null;
	return { version: 1, tenantId: ctx.id || "self", ...row, ...("active" in row ? { active: row.active === 1 } : {}) };
}

/** Append to the SAME transaction as the message winner. A duplicate claim cannot enqueue. */
export async function messageEventStatement(ctx: TenantContext, input: { peer: string; messageId: string; taskId: string; contextId: string; receivedAt: string; claimToken: string; authHash: string; directReply: boolean }) {
	const target = messageEventTarget(ctx);
	if (!target) return null;
	const eventId = crypto.randomUUID();
	const fingerprint = await sha256(`${target.url}\n${target.secret}`);
	return ctx.DB.prepare(`INSERT INTO message_event_outbox(event_id,source_instance,peer_instance,body,target_fingerprint,next_ms)
	 SELECT ?1,s.instance_id,p.instance_id,json_object('version',1,'type','message_received','eventId',?1,
	 'sourceInstanceId',s.instance_id,'tenantId',?2,'peerInstanceId',p.instance_id,'peerLabel',?3,
	 'role','user','messageId',?4,'taskId',?5,'contextId',?6,'receivedAt',?7,'classification',?8),?9,?10
	 FROM message_event_source s JOIN message_event_peers p ON p.label=?3 AND p.active=1
	 WHERE s.singleton=1 AND EXISTS(SELECT 1 FROM message_claims WHERE peer=?3 AND message_id=?4 AND claim_token=?11)
	 AND EXISTS(SELECT 1 FROM messages WHERE message_id=?4 AND task_id=?5)
	 AND EXISTS(SELECT 1 FROM tasks WHERE id=?5 AND peer=?3 AND context_id=?6)
	 AND EXISTS(SELECT 1 FROM peers WHERE label=?3 AND token_hash=?12 AND revoked_at IS NULL)`)
		.bind(eventId, ctx.id || "self", input.peer, input.messageId, input.taskId, input.contextId, input.receivedAt,
			input.directReply ? "direct_reply" : "inbound", fingerprint, Date.now(), input.claimToken, input.authHash);
}

/** At-least-once bounded outbox: 8 attempts, exponential backoff capped at 1h, no replay API. */
export async function flushMessageEvents(ctx: TenantContext): Promise<void> {
	const target = messageEventTarget(ctx);
	if (ctx.status !== "active" || !target) {
		await ctx.DB.prepare("DELETE FROM message_event_outbox").run();
		return;
	}
	const fingerprint = await sha256(`${target.url}\n${target.secret}`);
	const rows = await ctx.DB.prepare(`SELECT o.* FROM message_event_outbox o WHERE next_ms<=? ORDER BY next_ms LIMIT 16`).bind(Date.now()).all<{ event_id: string; body: string; source_instance: string; peer_instance: string; target_fingerprint: string; attempts: number }>();
 const current = async () => {
  if (ctx.mode !== "host") return true;
  const live = await ctx.DB.prepare("SELECT version,status FROM tenant_config WHERE tenant_id=?").bind(ctx.id).first<{version:number;status:string}>();
  return !!live && live.version === ctx.configVersion && live.status === "active";
 };
	for (const row of rows.results || []) {
  // A background flush must not keep sending using a pre-suspend/rotation config snapshot.
  if (!await current()) return;
		const source = await messageEventIdentity(ctx, { instance: row.peer_instance });
		if (!source && !await current()) return;
		if (!source || !("active" in source) || !source.active || source.sourceInstanceId !== row.source_instance || row.target_fingerprint !== fingerprint) {
			await ctx.DB.prepare("DELETE FROM message_event_outbox WHERE event_id=?").bind(row.event_id).run(); continue;
		}
		const timestamp = String(Math.floor(Date.now() / 1000));
		const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(target.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${row.body}`));
		const signature = "sha256=" + [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
		const init: RequestInit = { method: "POST", body: row.body, headers: { "content-type": "application/json", "x-a2a-timestamp": timestamp, "x-a2a-signature": signature }, redirect: "manual" };
  const result = await deliverMessageIngress(ctx, target.url, init);
		if (result.ok && result.status >= 200 && result.status < 300 || row.attempts + 1 >= 8) {
			await ctx.DB.prepare("DELETE FROM message_event_outbox WHERE event_id=?").bind(row.event_id).run();
		} else {
			await ctx.DB.prepare("UPDATE message_event_outbox SET attempts=attempts+1,next_ms=? WHERE event_id=?").bind(Date.now() + Math.min(3600000, 1000 * 2 ** row.attempts), row.event_id).run();
		}
	}
}

/** Explicit capability-bound platform ingress, never a fallback after a failed pinned request.
 * Only the deploy-level origin and fixed path can select this service. Tenant config cannot supply the binding.
 */
export async function deliverMessageIngress(ctx: TenantContext, url: string, init: RequestInit): Promise<CallbackResult> {
 const u = new URL(url);
 if (ctx.messageEventIngressOrigin && u.origin === ctx.messageEventIngressOrigin) {
  const binding = ctx.controlService();
  if (!binding || u.pathname !== "/api/message-events" || u.search || u.hash || u.username || u.password) return { ok: false, reason: "target" };
  try {
   return await withDeadline(10000, async signal => {
    const response = await binding.fetch(url, { ...init, redirect: "manual", signal });
    await response.body?.cancel(); signal.throwIfAborted();
    if (response.status >= 300 && response.status < 400) return { ok: false, reason: "redirect" } as CallbackResult;
    return { ok: true, status: response.status, body: new Uint8Array() } as CallbackResult;
   });
  } catch { return { ok: false, reason: "transport" }; }
 }
 return fetchCheckedCallback(url, init);
}
