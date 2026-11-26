import {test} from "node:test";
import assert from "node:assert/strict";
import worker, {runOwnerRpc} from "../src/index.ts";
import {conditionalPeerRevoke,peerRevokeIncarnation,revokeTaskSnapshotCurrent} from "../src/peer-revoke.ts";
import {ownerRpcBody} from "../src/owner-rpc.ts";
import {exportRows,toSql} from "../src/export.ts";
import {hostedTenantContext} from "../src/tenancy.ts";
import {sha256} from "../src/a2a.ts";
import {d1} from "./d1.ts";
import {mockPushTransport} from "./push-transport-mock.ts";
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

function seedOpenTasks(DB:ReturnType<typeof d1>){
 for(const [id,peer,state] of [["submitted","alpha","submitted"],["working","alpha","working"],["waiting","alpha","input-required"],["done","alpha","completed"],["foreign","beta","submitted"]]){
  DB.db.prepare("INSERT INTO tasks(id,context_id,peer,state,protocol,created_at,updated_at,status_json,push_configs_json) VALUES(?,?,?,?, '0.3','2026-01-01','2026-01-01',?,?)")
   .run(id,"context-"+id,peer,state,JSON.stringify({state,timestamp:"2026-01-01"}),JSON.stringify([{url:"https://hooks.example.net/old-"+id,token:"dummy-private-callback"}]));
 }
}
test("conditional transaction rejects every open state and captures only immutable affected rows",async()=>{
 const {DB}=setup();seedOpenTasks(DB);const version=(await peerRevokeIncarnation(DB as any,"alpha"))!;
 const result=await conditionalPeerRevoke(DB as any,"alpha",version);assert.equal(result.status,200);
 assert.deepEqual(result.tasks!.map(x=>x.id).sort(),["submitted","waiting","working"]);
 for(const row of result.tasks!){const status=JSON.parse(row.status_json);assert.equal(status.state,"rejected");assert.equal(status.message.parts[0].text,"This peer was revoked.");assert.equal(status.message.taskId,row.id);
  const message:any=DB.db.prepare("SELECT message_json FROM messages WHERE task_id=?").get(row.id);assert.deepEqual(JSON.parse(message.message_json),status.message);
  assert.equal((DB.db.prepare("SELECT state FROM history WHERE task_id=?").get(row.id) as any).state,"rejected");}
 assert.equal((DB.db.prepare("SELECT state FROM tasks WHERE id='done'").get() as any).state,"completed");
 assert.equal((DB.db.prepare("SELECT state FROM tasks WHERE id='foreign'").get() as any).state,"submitted");
 assert.equal(JSON.stringify(result.body).includes("callback"),false);assert.equal(JSON.stringify(result.body).includes("tasks"),false);
 DB.db.prepare("UPDATE peers SET token_hash='replacement',revoked_at=NULL WHERE label='alpha'").run();
 DB.db.prepare("INSERT INTO tasks(id,context_id,peer,state,protocol,created_at,updated_at,status_json) VALUES('replacement','context-new','alpha','submitted','0.3','2026-01-01','2026-01-01','{\"state\":\"submitted\"}')").run();
 assert.equal((await conditionalPeerRevoke(DB as any,"alpha",version)).status,412);
 assert.equal((DB.db.prepare("SELECT state FROM tasks WHERE id='replacement'").get() as any).state,"submitted");
 assert.equal((DB.db.prepare("SELECT count(*) AS n FROM messages").get() as any).n,3);
});
test("task, message and history changes roll back with failed revoke; stale CAS changes none",async()=>{
 const {DB}=setup();seedOpenTasks(DB);const version=(await peerRevokeIncarnation(DB as any,"alpha"))!;
 const tasks=()=>DB.db.prepare("SELECT * FROM tasks ORDER BY id").all();const before=tasks();
 DB.db.prepare("CREATE TRIGGER refuse_task_revoke BEFORE UPDATE OF revoked_at ON peers BEGIN SELECT RAISE(ABORT,'fixture-refusal'); END;").run();
 await assert.rejects(conditionalPeerRevoke(DB as any,"alpha",version));assert.deepEqual(tasks(),before);
 assert.equal((DB.db.prepare("SELECT count(*) AS n FROM messages").get() as any).n,0);assert.equal((DB.db.prepare("SELECT count(*) AS n FROM history").get() as any).n,0);
 DB.db.prepare("DROP TRIGGER refuse_task_revoke").run();
 const batch=DB.batch.bind(DB);const raced={...DB,batch:async(stmts:any[])=>{DB.db.prepare("UPDATE peers SET token_hash='replacement' WHERE label='alpha'").run();return batch(stmts);}};
 assert.equal((await conditionalPeerRevoke(raced as any,"alpha",version)).status,412);assert.deepEqual(tasks(),before);
 assert.equal((DB.db.prepare("SELECT count(*) AS n FROM messages").get() as any).n,0);assert.equal((DB.db.prepare("SELECT count(*) AS n FROM history").get() as any).n,0);
});

test("owner route pushes captured rejections once, never replacement task rows or callback secrets",async(t)=>{
 const {DB}=setup();seedOpenTasks(DB);const version=(await peerRevokeIncarnation(DB as any,"alpha"))!;
 const sent:{url:string;body:any}[]=[];const jobs:Promise<unknown>[]=[];
 mockPushTransport(t,async(url,init)=>{sent.push({url:String(url),body:JSON.parse(String(init?.body))});return new Response(null,{status:200});});
 const batch=DB.batch.bind(DB);let replaced=false;
 const racing={...DB,batch:async(stmts:any[])=>{const result=await batch(stmts);
  if(!replaced && stmts.some(x=>x.__sql?.includes("UPDATE peers SET revoked_at="))){replaced=true;
   DB.db.prepare("UPDATE peers SET token_hash='replacement',revoked_at=NULL WHERE label='alpha'").run();
   DB.db.prepare("UPDATE tasks SET state='working',status_json='{\"state\":\"working\"}',push_configs_json='[{\"url\":\"https://hooks.example.net/new\"}]' WHERE id='submitted'").run();
   DB.db.prepare("INSERT INTO tasks(id,context_id,peer,state,protocol,created_at,updated_at,status_json) VALUES('new','context-new','alpha','submitted','0.3','2026-01-01','2026-01-01','{\"state\":\"submitted\"}')").run();
   DB.db.prepare("INSERT INTO wakes(context_id,peer,pending_json,pending_since_ms,last_sent_ms,busy_until_ms) VALUES('context-submitted','alpha','{\"contextId\":\"context-submitted\",\"taskId\":\"submitted\",\"busy\":1}',777,888,9999999999999)").run();
  }return result;}};
 const response=await worker.fetch(new Request("https://agent.example.com/owner/peers/alpha/revoke",{method:"POST",headers:{authorization:"Bearer fixture-owner","content-type":"application/json"},body:JSON.stringify({expectedIncarnation:version})}),{DB:racing,OWNER_TOKEN:"fixture-owner",PUBLIC_URL:"https://agent.example.com"} as any,{waitUntil(job:Promise<unknown>){jobs.push(job);},passThroughOnException(){}} as any);
 assert.equal(response.status,200);const receipt=await response.text();await Promise.all(jobs);
 assert.deepEqual(sent.map(x=>x.body.id).sort(),["waiting","working"]);assert.ok(sent.every(x=>x.body.status.state==="rejected" && x.url.includes("/old-")));
 assert.equal((DB.db.prepare("SELECT state FROM tasks WHERE id='submitted'").get() as any).state,"working");assert.equal((DB.db.prepare("SELECT state FROM tasks WHERE id='new'").get() as any).state,"submitted");
 assert.equal(receipt.includes("callback"),false);assert.equal(receipt.includes("push_configs"),false);
 assert.deepEqual({...DB.db.prepare("SELECT pending_json,pending_since_ms,last_sent_ms,busy_until_ms FROM wakes WHERE context_id='context-submitted' AND peer='alpha'").get()},
  {pending_json:'{"contextId":"context-submitted","taskId":"submitted","busy":1}',pending_since_ms:777,last_sent_ms:888,busy_until_ms:9999999999999});
 const again=await conditionalPeerRevoke(DB as any,"alpha",version);assert.equal(again.status,412);assert.equal(sent.length,2);
});

test("restored source cannot deliver captured task callbacks",async()=>{
 const {DB}=setup();seedOpenTasks(DB);const version=(await peerRevokeIncarnation(DB as any,"alpha"))!;
 const result=await conditionalPeerRevoke(DB as any,"alpha",version);assert.equal(await revokeTaskSnapshotCurrent(DB as any,result.tasks![0]),true);
 DB.db.prepare("UPDATE message_event_source SET instance_id=lower(hex(randomblob(16)))").run();
 assert.equal(await revokeTaskSnapshotCurrent(DB as any,result.tasks![0]),false);
});

function seedRevokeWakes(DB:ReturnType<typeof d1>){
 DB.db.prepare("UPDATE tasks SET context_id='shared' WHERE id IN ('submitted','working')").run();
 const add=(context:string,peer:string,payload:unknown)=>DB.db.prepare("INSERT INTO wakes(context_id,peer,pending_json,pending_since_ms,last_sent_ms,busy_until_ms) VALUES(?,?,?,123,456,9999999999999)").run(context,peer,typeof payload==="string"?payload:JSON.stringify(payload));
 add("shared","alpha",{contextId:"shared",taskIds:["submitted","unrelated-id","working"],taskId:"working",kind:"inbound",busy:1,extra:{keep:true}});
 add("context-waiting","alpha",{contextId:"context-waiting",taskId:"waiting",busy:1});
 add("shared","",{contextId:"shared",taskIds:[null,"",7],taskId:"submitted"});
 add("shared","beta",{contextId:"shared",taskId:"submitted",kind:"inbound",extra:"other peer"});
 add("context-waiting","",{contextId:"context-waiting",taskId:"waiting",kind:"outbound_update"});
 add("context-done","alpha",{contextId:"context-done",taskId:"done"});
 add("wrong-context","alpha",{contextId:"shared",taskId:"submitted"});
 add("broken","alpha","{broken");
 return()=>DB.db.prepare("SELECT * FROM wakes ORDER BY context_id,peer").all() as any[];
}
test("conditional revoke acknowledges only captured pending wake IDs and preserves unrelated data/cooldowns",async()=>{
 const {DB}=setup();seedOpenTasks(DB);const wakes=seedRevokeWakes(DB);const before=wakes();const version=(await peerRevokeIncarnation(DB as any,"alpha"))!;
 assert.equal((await conditionalPeerRevoke(DB as any,"alpha",version)).status,200);
 const rows=wakes();for(const row of rows){const old=before.find(x=>x.context_id===row.context_id && x.peer===row.peer);assert.equal(row.busy_until_ms,old.busy_until_ms);assert.equal(row.last_sent_ms,old.last_sent_ms);
  if(row.context_id==="shared" && row.peer==="alpha"){assert.equal(row.pending_since_ms,old.pending_since_ms);assert.deepEqual(JSON.parse(row.pending_json),{...JSON.parse(old.pending_json),taskIds:["unrelated-id"],taskId:"unrelated-id"});}
  else if((row.context_id==="context-waiting" && row.peer==="alpha") || (row.context_id==="shared" && row.peer==="")){assert.equal(row.pending_json,null);assert.equal(row.pending_since_ms,null);}
  else assert.deepEqual(row,old);
 }
 DB.db.prepare("UPDATE peers SET token_hash='new-wake-authority',revoked_at=NULL WHERE label='alpha'").run();
 DB.db.prepare("UPDATE wakes SET pending_json='{\"contextId\":\"shared\",\"taskId\":\"new-task\",\"taskIds\":[\"new-task\",\"unrelated-id\"]}',pending_since_ms=777 WHERE context_id='shared' AND peer='alpha'").run();
 const replacement=wakes();assert.equal((await conditionalPeerRevoke(DB as any,"alpha",version)).status,412);assert.deepEqual(wakes(),replacement);
});
test("wake acknowledgements roll back with revoke and a source race acknowledges nothing",async()=>{
 const {DB}=setup();seedOpenTasks(DB);const wakes=seedRevokeWakes(DB);const before=wakes();const version=(await peerRevokeIncarnation(DB as any,"alpha"))!;
 DB.db.prepare("CREATE TRIGGER refuse_wake_revoke BEFORE UPDATE OF revoked_at ON peers BEGIN SELECT RAISE(ABORT,'fixture-refusal'); END;").run();
 await assert.rejects(conditionalPeerRevoke(DB as any,"alpha",version));assert.deepEqual(wakes(),before);
 DB.db.prepare("DROP TRIGGER refuse_wake_revoke").run();const batch=DB.batch.bind(DB);
 const raced={...DB,batch:async(stmts:any[])=>{DB.db.prepare("UPDATE message_event_source SET instance_id=lower(hex(randomblob(16)))").run();return batch(stmts);}};
 assert.equal((await conditionalPeerRevoke(raced as any,"alpha",version)).status,412);assert.deepEqual(wakes(),before);
});
