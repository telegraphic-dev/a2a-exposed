// Receiver assertions authenticated by the existing inbox owner credential.
// Peers read them only through their existing authenticated task access. No callback token or new trust root.
import { envelopeOf } from "./sealed-keys.ts";
import type { SqlDb } from "./tenancy.ts";

export const RECEIPT_META = "a2a.exposed/wake-receipt";
export const RECEIPT_TTL = 24 * 60 * 60 * 1000;
export const RECEIPT_STAGES = ["signature-verified", "handler-ran", "owner-notified"] as const;
const columns = { "signature-verified": "signature_verified_at", "handler-ran": "handler_ran_at", "owner-notified": "owner_notified_at" };
type Row = Record<string, any>;
export type ReceiptRef = { id: string; expiresAt: string };
export function receiptInput(b: any): b is { stage: typeof RECEIPT_STAGES[number] } {
 return !!b && typeof b === "object" && !Array.isArray(b) && Object.keys(b).length === 1 && RECEIPT_STAGES.includes(b.stage);
}
export function receiptView(r: Row, issuer: string, now = Date.now()) {
 return { id: r.delivery_id, taskId: r.task_id, messageId: r.message_id, issuer,
  issuedAt: new Date(r.issued_ms).toISOString(), expiresAt: new Date(r.expires_ms).toISOString(), expired: r.expires_ms <= now,
  httpAccepted: r.http_status >= 200 && r.http_status < 300, httpStatus: r.http_status,
  reports: { signatureVerifiedAt: r.signature_verified_at, handlerRanAt: r.handler_ran_at, ownerNotifiedAt: r.owner_notified_at },
  authentication: "inbox-owner", semantics: "receiver-assertion" };
}

/** Only real inbound, unencrypted tasks. Bind to the message present before this specific POST. */
export async function beginReceipt(db: SqlDb, payload: Row, now = Date.now()): Promise<ReceiptRef | undefined> {
 if (payload.kind !== "inbound" || !Array.isArray(payload.taskIds)) return;
 const ids = [...new Set(payload.taskIds)].slice(0, 200);
 if (!ids.length) return;
 const rows = await db.prepare(`SELECT t.id, t.peer, t.context_id, m.message_id, m.message_json FROM tasks t
  JOIN messages m ON m.seq = (SELECT MAX(seq) FROM messages WHERE task_id=t.id AND role='user')
  WHERE t.peer=? AND t.context_id=? AND t.id IN (SELECT value FROM json_each(?))`).bind(payload.from, payload.contextId, JSON.stringify(ids)).all<Row>();
 const eligible = (rows.results || []).filter(r => {
  try { return !envelopeOf(JSON.parse(r.message_json)); } catch { return false; }
 });
 // Peers with encryption bundles must not gain a new server-readable receipt surface.
 const peer = await db.prepare("SELECT sealed_requester FROM peers WHERE label=? AND revoked_at IS NULL").bind(payload.from).first<Row>();
 if (!eligible.length || !peer || peer.sealed_requester) return;
 const id = crypto.randomUUID(), expires = now + RECEIPT_TTL;
 await db.batch([
  db.prepare("DELETE FROM wake_receipts WHERE expires_ms <= ?").bind(now - 6 * RECEIPT_TTL),
  ...eligible.map(r => db.prepare("INSERT INTO wake_receipts (delivery_id, task_id, message_id, peer, context_id, issued_ms, expires_ms) VALUES (?, ?, ?, ?, ?, ?, ?)")
   .bind(id, r.id, r.message_id, r.peer, r.context_id, now, expires)),
 ]);
 return { id, expiresAt: new Date(expires).toISOString() };
}

/** Atomic, idempotent stage report. Never infer one stage from another or accept caller timestamps/notes. */
export async function reportReceipt(db: SqlDb, id: string, stage: typeof RECEIPT_STAGES[number], now = Date.now()): Promise<boolean> {
 const col = columns[stage];
 const at = new Date(now).toISOString();
 const [r] = await db.batch([
  db.prepare(`UPDATE wake_receipts SET ${col}=COALESCE(${col}, ?) WHERE delivery_id=? AND expires_ms>?`).bind(at, id, now),
  db.prepare(`INSERT INTO history (context_id, ts, dir, peer, task_id, event, data_json)
   SELECT context_id, ?, 'local', peer, task_id, 'wake-receipt', json_object('wakeReceipt', json_object('id',delivery_id,'stage',?,'at',${col},'messageId',message_id,'authentication','inbox-owner','semantics','receiver-assertion'))
   FROM wake_receipts r WHERE delivery_id=? AND expires_ms>? AND ${col} IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM history h WHERE h.task_id=r.task_id AND h.peer=r.peer AND h.event='wake-receipt'
    AND json_extract(h.data_json,'$.wakeReceipt.id')=r.delivery_id AND json_extract(h.data_json,'$.wakeReceipt.stage')=?)`).bind(at, stage, id, now, stage),
 ]);
 return Number(r.meta.changes) > 0;
}
export async function taskReceipt(db: SqlDb, taskId: string, messageId: string, peer: string, issuer: string) {
 const row = await db.prepare("SELECT * FROM wake_receipts WHERE task_id=? AND message_id=? AND peer=? ORDER BY issued_ms DESC, rowid DESC LIMIT 1")
  .bind(taskId, messageId, peer).first<Row>();
 return row ? receiptView(row, issuer) : undefined;
}
