import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { cronFlush } from "../src/index.ts";
import { sha256 } from "../src/a2a.ts";
import { messageEventIdentity, flushMessageEvents } from "../src/message-events.ts";
import { resolveTenant } from "../src/tenancy.ts";
import { wakeNet } from "../src/wake-target.ts";
import { d1 } from "./d1.ts";
const BASE="https://agent.example.com";
const secret="synthetic-event-secret-".repeat(3);
const ectx:any={waitUntil() {},passThroughOnException(){}};
async function setup(enabled=true) {
 const DB=d1(new URL("../migrations/",import.meta.url));
 const token="s2a_"+"a".repeat(40);
 await DB.prepare("INSERT INTO peers(label,token_hash,created_at) VALUES(?,?,?)").bind("peer",await sha256(token),new Date().toISOString()).run();
 const env:any={DB,ENABLE_CRON:"1",PUBLIC_URL:BASE,OWNER_TOKEN:"owner-test",...(enabled?{MESSAGE_EVENT_URL:"https://callback.example/events",MESSAGE_EVENT_SECRET:secret}: {})};
 const ctx=resolveTenant(env);
 const owner=(path:string,auth="owner-test")=>worker.fetch(new Request(BASE+"/owner/message-events/"+path,{headers:{authorization:"Bearer "+auth}}) as any,env,ectx);
 const send=async(id="message-one",direct=false)=>{
  // Treat waitUntil as durable scheduling only; delivery is driven separately to simulate a crash.
  const res=await worker.fetch(new Request(BASE,{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"message/send",params:{message:{kind:"message",role:"user",messageId:id,parts:[{kind:"text",text:"UNTRUSTED SECRET MESSAGE"}]},...(direct?{metadata:{"a2a.exposed/reply-delivery":{taskId:"outbound-task",messageId:"outbound-message",state:"completed"}}}:{})}})}) as any,env, { ...ectx, waitUntil(p:Promise<unknown>){p.catch(()=>{});} });
  return res.json() as Promise<any>;
 };
 return {DB,env,ctx,owner,send,token};
}
test("identity: owner-only snapshots, permanent tombstones on revoke/rotation/reissue",async()=>{
 const s=await setup();
 assert.equal((await s.owner("source","wrong")).status,401);
 const source:any=await (await s.owner("source")).json();
 const peer:any=await (await s.owner("peers?label=peer")).json();
 assert.equal(peer.sourceInstanceId,source.sourceInstanceId);assert.equal(peer.tenantId,"self");assert.equal(peer.active,true);
 assert.equal(JSON.stringify(peer).includes(await sha256(s.token)),false);
 assert.equal((await s.owner("peers?label=outbound-only")).status,404);
 assert.deepEqual(await messageEventIdentity(resolveTenant(s.env)),source,"restart does not regenerate source");
 await s.DB.prepare("UPDATE peers SET token_hash=? WHERE label='peer'").bind("rotated").run();
 const rotated:any=await (await s.owner("peers?label=peer")).json();assert.notEqual(rotated.peerInstanceId,peer.peerInstanceId);
 const old:any=await (await s.owner("peers/"+peer.peerInstanceId)).json();assert.equal(old.active,false);assert.equal(old.sourceInstanceId,source.sourceInstanceId);assert.equal(old.peerInstanceId,peer.peerInstanceId);
 await s.DB.prepare("UPDATE peers SET revoked_at='revoked' WHERE label='peer'").run();
 assert.equal((await s.owner("peers?label=peer")).status,404);
 await s.DB.prepare("UPDATE peers SET token_hash='reissue',revoked_at=NULL WHERE label='peer'").run();
 const reissued:any=await (await s.owner("peers?label=peer")).json();assert.notEqual(reissued.peerInstanceId,rotated.peerInstanceId);assert.notEqual(reissued.peerInstanceId,old.peerInstanceId);
 assert.equal((await s.owner("peers/"+"0".repeat(32))).status,404);
 await s.DB.prepare("DELETE FROM peers WHERE label='peer'").run();
 assert.equal((await (await s.owner("peers/"+reissued.peerInstanceId)).json() as any).active,false);
});
test("disabled feed has no outbox and no source listing",async()=>{
 const s=await setup(false); assert.equal((await s.owner("source")).status,404);
 await s.send();assert.equal((await s.DB.prepare("SELECT count(*) AS n FROM message_event_outbox").first<any>()).n,0);
});
test("committed outbox is metadata-only, stable on duplicate, retried with signature and discarded on rotation",async()=>{
 const s=await setup();
 const realDeliver=wakeNet.deliver;
 const seen:any[]=[];
 // DNS-independent transport stub; source transport tests exercise DNS/TLS below.
 const realFetch=globalThis.fetch;
 globalThis.fetch=(async(url:any)=>String(url).startsWith("https://cloudflare-dns.com/")?new Response(JSON.stringify({Status:0,Answer:[{type:1,data:"1.2.3.4"}]})):realFetch(url)) as any;
 wakeNet.deliver=async(_url,init)=>{seen.push(init);return new Response(null,{status:503});};
 try {
  const first=await s.send();assert.ok(first.result?.id);
  const before=await s.DB.prepare("SELECT * FROM message_event_outbox").first<any>();assert.ok(before);
  const body=JSON.parse(before.body);assert.equal(body.type,"message_received");assert.equal(body.classification,"inbound");assert.equal(body.role,"user");assert.equal(before.body.includes("UNTRUSTED"),false);assert.equal(before.body.includes("token"),false);
  await s.send();const rows=await s.DB.prepare("SELECT * FROM message_event_outbox").all<any>();assert.equal(rows.results!.length,1);assert.equal(rows.results![0].event_id,before.event_id);assert.equal(rows.results![0].body,before.body);
  await s.DB.prepare("UPDATE message_event_outbox SET next_ms=0").run();await flushMessageEvents(s.ctx);
  assert.ok(seen.length>=1);assert.equal(seen.at(-1).body,before.body);
  const headers=new Headers(seen.at(-1).headers);const ts=headers.get("x-a2a-timestamp")!;
  const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const sig=await crypto.subtle.sign("HMAC",k,new TextEncoder().encode(ts+"."+before.body));
  assert.equal(headers.get("x-a2a-signature"),"sha256="+[...new Uint8Array(sig)].map(b=>b.toString(16).padStart(2,"0")).join(""));
  await s.DB.prepare("UPDATE peers SET token_hash='new' WHERE label='peer'").run();await s.DB.prepare("UPDATE message_event_outbox SET next_ms=0").run();await flushMessageEvents(s.ctx);
  assert.equal((await s.DB.prepare("SELECT count(*) AS n FROM message_event_outbox").first<any>()).n,0);
 } finally {wakeNet.deliver=realDeliver;globalThis.fetch=realFetch;}
});

test("outbox insertion failure rolls back winning message, claim and task",async()=>{
 const s=await setup();
 await s.DB.prepare("CREATE TRIGGER fail_event BEFORE INSERT ON message_event_outbox BEGIN SELECT RAISE(ABORT,'fixture rollback'); END").run();
 const result=await s.send();assert.ok(result.error);
 for(const table of ["tasks","messages","message_claims","message_event_outbox"])assert.equal((await s.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<any>()).n,0,table);
 await s.DB.prepare("DROP TRIGGER fail_event").run();
});
test("direct replies are explicitly classified without claiming task.updated",async()=>{
 const s=await setup();const real=wakeNet.deliver;const fetchImpl=globalThis.fetch;const bodies:string[]=[];
 globalThis.fetch=(async()=>new Response(JSON.stringify({Status:0,Answer:[{type:1,data:"1.2.3.4"}]}))) as any;
 wakeNet.deliver=async(_url,init)=>{bodies.push(String(init.body));return new Response(null,{status:503});};
 try{const result=await s.send("reply-one",true);assert.ok(result.result);await flushMessageEvents(s.ctx);assert.ok(bodies.length);const b=JSON.parse(bodies[0]!);assert.equal(b.classification,"direct_reply");assert.equal(b.type,"message_received");}finally{wakeNet.deliver=real;globalThis.fetch=fetchImpl;}
});

test("platform ingress selects only deploy-pinned service origin/path, never a network fallback",async()=>{
 const {deliverMessageIngress}=await import("../src/message-events.ts");let calls=0;
 const binding={fetch:async(_url:any,init:any)=>{calls++;assert.equal(init.redirect,"manual");assert.ok(init.signal);return new Response(null,{status:202});}};
 const env:any={DB:(await setup()).DB,MESSAGE_EVENT_INGRESS_ORIGIN:"https://platform.example.com",CONTROL_SERVICE:binding};
 const ctx=resolveTenant(env);
 assert.deepEqual(await deliverMessageIngress(ctx,"https://platform.example.com/api/message-events",{method:"POST",body:"{}"}),{ok:true,status:202,body:new Uint8Array()});assert.equal(calls,1);
 for(const url of ["https://platform.example.com/admin","https://platform.example.com/api/message-events?other=1"])assert.deepEqual(await deliverMessageIngress(ctx,url,{method:"POST"}),{ok:false,reason:"target"});assert.equal(calls,1);
 const missing=resolveTenant({...env,CONTROL_SERVICE:undefined});assert.deepEqual(await deliverMessageIngress(missing,"https://platform.example.com/api/message-events",{method:"POST"}),{ok:false,reason:"target"});
 const redirect=resolveTenant({...env,CONTROL_SERVICE:{fetch:async()=>new Response(null,{status:302,headers:{location:"https://other.example.com/"}})}});assert.deepEqual(await deliverMessageIngress(redirect,"https://platform.example.com/api/message-events",{method:"POST"}),{ok:false,reason:"redirect"});
});

test("source GET/HEAD are read-only and never opportunistically flush owner wakes",async()=>{
 const s=await setup();const pending=JSON.stringify({contextId:"pending-context",taskId:"pending-task",from:"peer",preview:"fixture"});
 await s.DB.prepare("INSERT INTO wakes(context_id,peer,last_ms,pending_json) VALUES('pending-context','peer',0,?)").bind(pending).run();
 const promises:Promise<unknown>[]=[];let sent=0;const original=globalThis.fetch;globalThis.fetch=(async()=>{sent++;return new Response();}) as any;
 try{
  const env={...s.env,WAKE_WEBHOOK_URL:"https://hook.example.com/owner-wake",WAKE_PRESET:"generic"};
  for(const method of ["GET","HEAD"]){const res=await worker.fetch(new Request(BASE+"/owner/message-events/source",{method,headers:{authorization:"Bearer owner-test"}}) as any,env,{...ectx,waitUntil(p:Promise<unknown>){promises.push(p);}});assert.equal(res.status,200);if(method==="HEAD")assert.equal(await res.text(),"");}
  await Promise.all(promises);assert.equal(sent,0);assert.equal((await s.DB.prepare("SELECT pending_json FROM wakes WHERE context_id='pending-context'").first<any>()).pending_json,pending);
 }finally{globalThis.fetch=original;}
});
