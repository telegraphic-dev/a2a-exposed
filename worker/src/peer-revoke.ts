import { sha256, nowIso } from "./a2a.ts";
import type { TenantContext } from "./tenancy.ts";
type Db = TenantContext["DB"];
const PREFIX = "prv1_";
async function identity(db: Db, label: string): Promise<{peer: string; source: string} | null> {
 return db.prepare(`SELECT e.instance_id AS peer,s.instance_id AS source
 FROM message_event_peers e JOIN peers p ON p.label=e.label CROSS JOIN message_event_source s
 WHERE e.label=? AND e.active=1 AND p.revoked_at IS NULL AND s.singleton=1`).bind(label).first();
}
async function commitment(value: {peer:string;source:string}): Promise<string> {
 return PREFIX + await sha256(JSON.stringify(["a2a-exposed/conditional-peer-revoke/v1",value.source,value.peer]));
}
/** Hash only identities from the same SQL snapshot as the displayed peer metadata. */
export async function peerRevokeSnapshot(peer: unknown, source: unknown): Promise<string | null> {
 return typeof peer === "string" && /^[a-f0-9]{32}$/.test(peer) && typeof source === "string" && /^[a-f0-9]{32}$/.test(source) ? commitment({peer,source}) : null;
}
/** Opaque owner-only capability/version commitment. No raw source/peer ids or credential hashes escape. */
export async function peerRevokeIncarnation(db: Db, label: string): Promise<string | null> {
 const value=await identity(db,label);return value ? commitment(value) : null;
}
/** Every effect is guarded inside one storage transaction, including cleanup before revocation triggers rotate ids.
 * A preflight match alone is insufficient: token replacement can occur before the batch begins. */
export async function conditionalPeerRevoke(db: Db, label: string, expected: string): Promise<{status:number;body:Record<string,unknown>}> {
 const value=await identity(db,label);
 const refused={status:412,body:{revoked:false,error:"Peer incarnation is unavailable or changed. Read GET /owner/peers; do not retry against a replacement."}};
 if(!value || await commitment(value)!==expected)return refused;
 const guard=`EXISTS (SELECT 1 FROM message_event_peers e JOIN peers p ON p.label=e.label CROSS JOIN message_event_source s
 WHERE e.label=? AND e.instance_id=? AND e.active=1 AND p.revoked_at IS NULL AND s.singleton=1 AND s.instance_id=?)`;
 const binds=[label,value.peer,value.source];
 const result=await db.batch([
  db.prepare(`DELETE FROM outbound_peers WHERE alias=? AND source='announce' AND ${guard}`).bind(label,...binds),
  db.prepare(`UPDATE outbound SET push_token_hash=NULL WHERE peer=? AND ${guard}`).bind(label,...binds),
  db.prepare(`UPDATE peers SET revoked_at=?,token_enc=NULL,wake_policy_id=lower(hex(randomblob(16))) WHERE label=? AND revoked_at IS NULL AND ${guard}`).bind(nowIso(),label,...binds),
 ]);
 const last=result[2] as {meta?:{changes?:number}};
 return Number(last?.meta?.changes || 0)>0 ? {status:200,body:{revoked:true,label,incarnation:expected}} : refused;
}
