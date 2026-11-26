import {test} from "node:test";
import assert from "node:assert/strict";
import worker, {runOwnerRpc} from "../src/index.ts";
import {conditionalPeerRevoke,peerRevokeIncarnation} from "../src/peer-revoke.ts";
import {ownerRpcBody} from "../src/owner-rpc.ts";
import {exportRows,toSql} from "../src/export.ts";
import {hostedTenantContext} from "../src/tenancy.ts";
import {sha256} from "../src/a2a.ts";
import {d1} from "./d1.ts";
function setup(){
 const DB=d1(new URL("../migrations/",import.meta.url));
 DB.db.prepare("INSERT INTO peers(label,token_hash,created_at) VALUES('alpha','fixture-hash','2026-01-01')").run();
 DB.db.prepare("INSERT INTO outbound(task_id,context_id,peer,push_token_hash,sent_at) VALUES('t','c','alpha','fixture-push','2026-01-01')").run();
 DB.db.prepare("INSERT INTO outbound_peers(alias,url,created_at,updated_at,source) VALUES('alpha','https://example.com','2026-01-01','2026-01-01','announce')").run();
 const snapshot=()=>({peer:DB.db.prepare("SELECT * FROM peers WHERE label='alpha'").get(),push:DB.db.prepare("SELECT push_token_hash FROM outbound WHERE task_id='t'").get(),alias:DB.db.prepare("SELECT * FROM outbound_peers WHERE alias='alpha'").get()});
 return{DB,snapshot};
}
test("opaque version rotates on credential replacement, same-label recreation and source restore",async()=>{
 const {DB}=setup();const first=await peerRevokeIncarnation(DB as any,"alpha");assert.match(first!,/^prv1_[a-f0-9]{64}$/);
 DB.db.prepare("UPDATE peers SET token_hash='fixture-rotated' WHERE label='alpha'").run();const rotated=await peerRevokeIncarnation(DB as any,"alpha");assert.notEqual(first,rotated);
 DB.db.prepare("DELETE FROM peers WHERE label='alpha'").run();DB.db.prepare("INSERT INTO peers(label,token_hash,created_at) VALUES('alpha','fixture-rotated','2026-01-01')").run();
 const recreated=await peerRevokeIncarnation(DB as any,"alpha");assert.notEqual(rotated,recreated);
 DB.db.prepare("UPDATE message_event_source SET instance_id=lower(hex(randomblob(16)))").run();assert.notEqual(await peerRevokeIncarnation(DB as any,"alpha"),recreated);
 const raw:any=DB.db.prepare("SELECT instance_id FROM message_event_source").get();assert.equal(first!.includes(raw.instance_id),false);assert.equal(first!.includes("fixture-hash"),false);
});
test("stale and raced commitments change none of the three effect sets",async()=>{
 const {DB,snapshot}=setup();const version=(await peerRevokeIncarnation(DB as any,"alpha"))!;
 const batch=DB.batch.bind(DB);let raced=false;
 const racedDb={...DB,batch:async(statements:any[])=>{if(!raced){raced=true;DB.db.prepare("UPDATE peers SET token_hash='replacement' WHERE label='alpha'").run();}return batch(statements);}};
 const result=await conditionalPeerRevoke(racedDb as any,"alpha",version);assert.equal(result.status,412);
 const before=snapshot();assert.equal(before.push.push_token_hash,"fixture-push");assert.ok(before.alias);assert.equal(before.peer.revoked_at,null);
 assert.equal((await conditionalPeerRevoke(DB as any,"alpha",version)).status,412);assert.deepEqual(snapshot(),before);
 assert.equal((await conditionalPeerRevoke(DB as any,"missing",version)).status,412);assert.deepEqual(snapshot(),before);
});
test("one concurrent winner; stale/delayed receipts never affect replacement",async()=>{
 const {DB,snapshot}=setup();const version=(await peerRevokeIncarnation(DB as any,"alpha"))!;
 const result=await Promise.all([conditionalPeerRevoke(DB as any,"alpha",version),conditionalPeerRevoke(DB as any,"alpha",version)]);assert.deepEqual(result.map(x=>x.status).sort(),[200,412]);
 const receipt=result.find(x=>x.status===200)!.body;assert.equal(receipt.incarnation,version);
 assert.ok(snapshot().peer.revoked_at);assert.equal(snapshot().push.push_token_hash,null);assert.equal(snapshot().alias,undefined);
 assert.equal(await peerRevokeIncarnation(DB as any,"alpha"),null);assert.equal((await conditionalPeerRevoke(DB as any,"alpha",version)).status,412);
 DB.db.prepare("UPDATE peers SET token_hash='replacement',revoked_at=NULL WHERE label='alpha'").run();DB.db.prepare("UPDATE outbound SET push_token_hash='replacement-push'").run();
 const before=snapshot();assert.notEqual(await peerRevokeIncarnation(DB as any,"alpha"),receipt.incarnation);assert.equal((await conditionalPeerRevoke(DB as any,"alpha",String(receipt.incarnation))).status,412);assert.deepEqual(snapshot(),before);
});
test("transaction failure rolls back cleanup and push clearing",async()=>{
 const {DB,snapshot}=setup();const version=(await peerRevokeIncarnation(DB as any,"alpha"))!;const before=snapshot();
 DB.db.prepare("CREATE TRIGGER refuse_revoke BEFORE UPDATE OF revoked_at ON peers BEGIN SELECT RAISE(ABORT,'fixture-refusal'); END;").run();
 await assert.rejects(conditionalPeerRevoke(DB as any,"alpha",version));assert.deepEqual(snapshot(),before);
});
test("conditional route requires exact commitment; legacy delete remains available",async()=>{
 const {DB}=setup();const version=(await peerRevokeIncarnation(DB as any,"alpha"))!;
 assert.equal(ownerRpcBody("POST /owner/peers/:label/revoke",{}).ok,false);assert.equal(ownerRpcBody("POST /owner/peers/:label/revoke",{expectedIncarnation:version,extra:true}).ok,false);
 const call=(method:string,path:string,body?:unknown)=>worker.fetch(new Request("https://agent.example.com"+path,{method,headers:{authorization:"Bearer fixture-owner","content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})}) as any,{DB,OWNER_TOKEN:"fixture-owner",PUBLIC_URL:"https://agent.example.com"} as any,{waitUntil(){},passThroughOnException(){}} as any);
 const list=await call("GET","/owner/peers");const text=await list.text();assert.ok(text.includes(version));assert.equal(text.includes("fixture-hash"),false);assert.equal(text.includes("instance_id"),false);
 assert.equal((await call("POST","/owner/peers/alpha/revoke",{})).status,400);
 const done=await call("POST","/owner/peers/alpha/revoke",{expectedIncarnation:version});assert.equal(done.status,200);assert.equal((await done.json() as any).incarnation,version);
 assert.equal((await call("POST","/owner/peers/alpha/revoke",{expectedIncarnation:version})).status,412);
 DB.db.prepare("INSERT INTO peers(label,token_hash,created_at) VALUES('legacy','fixture-legacy','2026-01-01')").run();assert.equal((await call("DELETE","/owner/peers/legacy")).status,200);
});

test("SQL restore invalidates the old commitment and preserves new peer effects",async()=>{
 const {DB,snapshot}=setup();const version=(await peerRevokeIncarnation(DB as any,"alpha"))!;
 const file=await exportRows(DB as any);for(const line of toSql(file).split("\n"))if(line.trim() && !line.startsWith("--"))DB.db.prepare(line).run();const restored=await peerRevokeIncarnation(DB as any,"alpha");assert.notEqual(restored,version);
 const before=snapshot();assert.equal((await conditionalPeerRevoke(DB as any,"alpha",version)).status,412);assert.deepEqual(snapshot(),before);
});
test("source change between preflight and batch prevents all effects",async()=>{
 const {DB,snapshot}=setup();const version=(await peerRevokeIncarnation(DB as any,"alpha"))!;const before=snapshot();const batch=DB.batch.bind(DB);
 const racing={...DB,batch:async(s:any[])=>{DB.db.prepare("UPDATE message_event_source SET instance_id=lower(hex(randomblob(16)))").run();return batch(s);}};
 assert.equal((await conditionalPeerRevoke(racing as any,"alpha",version)).status,412);assert.deepEqual(snapshot(),before);
});
test("hosted owner RPC carries the checked conditional contract without leaking internals",async()=>{
 const {DB}=setup();const version=(await peerRevokeIncarnation(DB as any,"alpha"))!;
 const ctx=await hostedTenantContext({TENANCY:"host",TENANT_SECRETS_KEY:"fixture-platform"} as any,{id:"ten_conditional",db:DB,publicUrl:"https://agent.example.com",ownerTokenHash:await sha256("fixture-owner"),status:"active",config:{AGENT_NAME:"Fixture"}} as any);
 const result=await runOwnerRpc(ctx,{waitUntil(){},passThroughOnException(){}} as any,{accountId:"fixture_account",method:"POST",path:"/owner/peers/alpha/revoke",body:{expectedIncarnation:version}});
 assert.equal(result.status,200);assert.deepEqual(result.body,{revoked:true,label:"alpha",incarnation:version});
 assert.equal(JSON.stringify(result).includes("fixture-hash"),false);
});
