import { sha256, nowIso, newId } from "./a2a.ts";
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
export type RevokedTaskSnapshot = { id: string; context_id: string; peer: string; protocol: string; status_json: string; artifacts_json: string; metadata_json: string | null; push_configs_json: string; sourceCommitment?: string };
export async function conditionalPeerRevoke(db: Db, label: string, expected: string): Promise<{status:number;body:Record<string,unknown>; tasks?: RevokedTaskSnapshot[]}> {
 const value=await identity(db,label);
 const refused={status:412,body:{revoked:false,error:"Peer incarnation is unavailable or changed. Read GET /owner/peers; do not retry against a replacement."}};
 if(!value || await commitment(value)!==expected)return refused;
 const guard=`EXISTS (SELECT 1 FROM message_event_peers e JOIN peers p ON p.label=e.label CROSS JOIN message_event_source s
 WHERE e.label=? AND e.instance_id=? AND e.active=1 AND p.revoked_at IS NULL AND s.singleton=1 AND s.instance_id=?)`;
 const binds=[label,value.peer,value.source];
 const timestamp=nowIso();
 // Update and capture the exact rows while the credential/source CAS is still valid.
 // The operation-specific message prefix selects only this transaction's transitions.
 const messagePrefix=newId()+"_";
 const captured=`peer=? AND substr(json_extract(status_json,'$.message.messageId'),1,?)=? AND ${guard}`;
 const capturedBinds=[label,messagePrefix.length,messagePrefix,...binds];
 const result=await db.batch([
  db.prepare(`UPDATE tasks SET state='rejected',updated_at=?,status_json=json_object(
   'state','rejected','timestamp',?,'message',json_object('kind','message','role','agent',
   'messageId',?||lower(hex(randomblob(16))),'taskId',id,'contextId',context_id,
   'parts',json_array(json_object('kind','text','text','This peer was revoked.'))))
   WHERE peer=? AND state IN ('submitted','working','input-required') AND ${guard}
   RETURNING id,context_id,peer,protocol,status_json,artifacts_json,metadata_json,push_configs_json`)
   .bind(timestamp,timestamp,messagePrefix,label,...binds),
  db.prepare(`INSERT INTO messages(message_id,task_id,context_id,role,ts,message_json)
   SELECT json_extract(status_json,'$.message.messageId'),id,context_id,'agent',?,json_extract(status_json,'$.message')
   FROM tasks WHERE ${captured}`).bind(timestamp,...capturedBinds),
  db.prepare(`INSERT INTO history(context_id,ts,dir,peer,task_id,role,state,text)
   SELECT context_id,?,'out',peer,id,'agent','rejected','This peer was revoked.' FROM tasks WHERE ${captured}`)
   .bind(timestamp,...capturedBinds),
  db.prepare(`DELETE FROM outbound_peers WHERE alias=? AND source='announce' AND ${guard}`).bind(label,...binds),
  db.prepare(`UPDATE outbound SET push_token_hash=NULL WHERE peer=? AND ${guard}`).bind(label,...binds),
  db.prepare(`UPDATE peers SET revoked_at=?,token_enc=NULL,wake_policy_id=lower(hex(randomblob(16))) WHERE label=? AND revoked_at IS NULL AND ${guard}`).bind(nowIso(),label,...binds),
 ]);
 const last=result[5] as {meta?:{changes?:number}};
 return Number(last?.meta?.changes || 0)>0 ? {status:200,body:{revoked:true,label,incarnation:expected},tasks:await Promise.all(((result[0].results || []) as RevokedTaskSnapshot[]).map(async task=>({...task,sourceCommitment:await sha256(value.source)})))} : refused;
}

/** Refuse a stale snapshot after restore or task replacement. No callback credentials leave the captured row. */
export async function revokeTaskSnapshotCurrent(db:Db,task:RevokedTaskSnapshot):Promise<boolean>{
 const source=await db.prepare("SELECT instance_id FROM message_event_source WHERE singleton=1").first<{instance_id:string}>();
 if(!source || await sha256(source.instance_id)!==task.sourceCommitment)return false;
 return !!await db.prepare("SELECT 1 FROM tasks WHERE id=? AND context_id=? AND peer=? AND state='rejected' AND status_json=? AND push_configs_json=?")
  .bind(task.id,task.context_id,task.peer,task.status_json,task.push_configs_json).first();
}
