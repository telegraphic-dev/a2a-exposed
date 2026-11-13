// Real CLI processes + real Worker/storage. All credentials and networking are fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { d1 } from "./d1.ts";
import { EXPORT_TABLES } from "../src/export.ts";
import { verifyPublicBundle } from "../src/sealed-keys.ts";
const root=fileURLToPath(new URL("../../",import.meta.url));
test("two local CLIs pair, seal and locally open messages while both servers store only ciphertext",async t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"sealed-pairing-"));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const envs:Record<string,any>={},dirs:Record<string,string>={},ids:Record<string,string>={},bundles:Record<string,any>={},records:any[]=[];
 for(const name of ["alice","bob"]){
  envs[name]={DB:d1(new URL("../migrations/",import.meta.url)),PUBLIC_URL:`https://${name}.example.com`,OWNER_TOKEN:"dummy-owner",AGENT_NAME:name,A2A_SEALED_ENABLED:"1"};
  dirs[name]=path.join(tmp,name);fs.mkdirSync(dirs[name],{mode:0o700});fs.mkdirSync(path.join(dirs[name],"node_modules/@a2a-exposed"),{recursive:true});
  fs.symlinkSync(path.join(root,"encryption"),path.join(dirs[name],"node_modules/@a2a-exposed/encryption"));
  fs.writeFileSync(path.join(dirs[name],"config.env"),`A2A_BASE_URL=https://${name}.example.com\nA2A_OWNER_TOKEN=dummy-owner\n`,{mode:0o600});
 }
 const dispatch=async(name:string,request:Request)=>{const pending:Promise<any>[]=[];const res=await worker.fetch(request,envs[name],{waitUntil:(p:Promise<any>)=>pending.push(p),passThroughOnException(){}} as any);await Promise.allSettled(pending);return res;};
 const owner=(name:string,route:string,method="GET",body?:any)=>dispatch(name,new Request(`https://${name}.example.com${route}`,{method,headers:{authorization:"Bearer dummy-owner","content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 let publishError:{status:number,error:string}|null=null;
 const server=http.createServer(async(req,res)=>{try{
  const name=String(req.headers["x-test-agent"]);let body="";for await(const chunk of req)body+=chunk;records.push({name,path:req.url,body});
  if(publishError && req.url==="/owner/sealed-key" && req.method==="PUT"){res.writeHead(publishError.status,{"content-type":"application/json"});res.end(JSON.stringify({error:publishError.error}));return;}
  const headers=new Headers();for(const [k,v]of Object.entries(req.headers))if(typeof v==="string"&&!["host","x-test-agent","connection"].includes(k))headers.set(k,v);
  const result=await dispatch(name,new Request(`https://${name}.example.com${req.url}`,{method:req.method,headers,...(["GET","HEAD"].includes(req.method!)?{}:{body})}));
  res.writeHead(result.status,Object.fromEntries(result.headers));res.end(await result.text());
 }catch(error){res.writeHead(500);res.end(String(error));}});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(()=>{server.closeAllConnections();server.close();});
 const hook=path.join(tmp,"fetch.mjs"),port=(server.address()as any).port;
 fs.writeFileSync(hook,`if(process.env.FIXTURE_OLD_INIT){const now=Date.now()-40*86400000;Date.now=()=>now;}const original=globalThis.fetch;globalThis.fetch=(url,init={})=>{const u=new URL(url);if(!/^(alice|bob)\\.example\\.com$/.test(u.hostname))throw Error('nonfixture network refused');const headers=new Headers(init.headers);headers.set('x-test-agent',u.hostname.split('.')[0]);return original('http://127.0.0.1:${port}'+u.pathname+u.search,{...init,headers});};`);
 const clean=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(A2A_|PEER_|WAKE_|CF_|CLOUDFLARE_|UPSTREAM_|APPROVAL_|EVENT_|HOSTED_)/.test(k)));
 const cli=(name:string,args:string[],enabled=true):Promise<any>=>new Promise(resolve=>{
  const ch=spawn(process.execPath,["--import",hook,path.join(root,"cli/bin/a2a-exposed.mjs"),...args],{env:{...clean,A2A_CONFIG_DIR:dirs[name],A2A_SEALED_ENABLED:enabled?"1":"",DO_NOT_TRACK:"1",A2A_NO_UPDATE_CHECK:"1",...(args[0]==="keys"&&args[1]==="init"?{FIXTURE_OLD_INIT:"1"}:{})},stdio:["ignore","pipe","pipe"]});let out="",err="";ch.stdout.on("data",b=>out+=b);ch.stderr.on("data",b=>err+=b);ch.on("close",code=>resolve({code,out,err}));
 });
 for(const name of ["alice","bob"]){
  const stores=await cli(name,["keys","stores","--json"]);assert.equal(stores.code,0,stores.err);
  const noConsent=await cli(name,["keys","init","--store","keychain","--card-url",`https://${name}.example.com/.well-known/agent-card.json`,"--json"]);assert.equal(noConsent.code,1);assert.match(noConsent.err,/consent/);
  const off=await cli(name,["keys","stores","--json"],false);assert.equal(off.code,1);assert.match(off.err,/disabled/);
  const init=await cli(name,["keys","init","--store","file","--card-url",`https://${name}.example.com/.well-known/agent-card.json`,"--json"]);assert.equal(init.code,0,init.err);
  const data=JSON.parse(init.out);ids[name]=data.id;bundles[name]=data.bundle;
  assert.equal((await owner(name,"/owner/sealed-key","PUT",{...data.bundle,privateKey:"reject-this-field"})).status,400);
  const pub=await cli(name,["keys","publish","--id",data.id,"--json"]);assert.equal(pub.code,0,pub.err);
  assert.equal((await owner(name,"/owner/identity").then(r=>r.json())as any).publicKey,null);
 }
 for(const error of [{status:409,error:"sealed key already exists; rotation is not supported"},{status:400,error:"send public fields only"},{status:404,error:"not found"}]){
  publishError=error;const result=await cli("alice",["keys","publish","--id",ids.alice,"--json"]);
  assert.equal(result.code,1);assert.ok(result.err.includes(error.error),result.err);
  assert.equal(result.err.includes("matching Worker version"),error.status===404);
 }
 publishError=null;
 const storeOnly=await cli("alice",["send","--to","unpaired","--text","never sent"],false);
 assert.equal(storeOnly.code,1);assert.match(storeOnly.err,/disabled/);
 const args=["connect","https://bob.example.com","--alias","bob","--sealed-key-id",ids.alice,"--no-wait","--json"];
 const pending=await cli("alice",args);assert.equal(pending.code,0,pending.err);
 const lines=pending.out.trim().split("\n").map((s:string)=>JSON.parse(s)),code=lines.find((x:any)=>x.status==="authorization_pending").user_code;
 assert.equal(lines.find((x:any)=>x.status==="key_comparison").independently_verified,false);
 assert.match(lines.find((x:any)=>x.status==="key_comparison").next,/token revoke LABEL/);
 const resumed=await cli("alice",args);assert.equal(resumed.code,0,resumed.err);
 const resumedLines=resumed.out.trim().split("\n").map((s:string)=>JSON.parse(s));
 assert.equal(resumedLines[0].status,"key_comparison");assert.equal(resumedLines[0].safety_code,lines[0].safety_code);
 assert.equal(fs.existsSync(path.join(dirs.alice,"peers.json")),false);
 assert.equal((await owner("bob",`/owner/pairing/${code}/approve`,"POST",{})).status,200);
 // A changed discovery bundle must not redeem the approved token or change local trust.
 const originalKey:any=await envs.bob.DB.prepare("SELECT value FROM settings WHERE key='sealed_public_bundle'").first();
 await envs.bob.DB.prepare("UPDATE settings SET value=? WHERE key='sealed_public_bundle'").bind(JSON.stringify({...bundles.bob,signature:bundles.alice.signature})).run();
 assert.equal((await cli("alice",args)).code,1);
 assert.equal(fs.existsSync(path.join(dirs.alice,"peers.json")),false);
 await envs.bob.DB.prepare("UPDATE settings SET value=? WHERE key='sealed_public_bundle'").bind(originalKey.value).run();
 const connected=await cli("alice",args);assert.equal(connected.code,0,connected.err);
 const pin=connected.out.trim().split("\n").map((s:string)=>JSON.parse(s)).find((s:any)=>s.status==="keys_pinned");assert.equal(pin.verification,"tofu");
 const pairings=await cli("bob",["keys","pairings","--json"]);assert.equal(pairings.code,0,pairings.err);const p=JSON.parse(pairings.out).pairings[0];
 assert.deepEqual(p.requester,bundles.alice);assert.deepEqual(p.responder,bundles.bob);
 const pinned=await cli("bob",["keys","pin","--id",ids.bob,"--peer",p.peer,"--user-code",p.userCode,"--json"]);assert.equal(pinned.code,0,pinned.err);assert.equal(JSON.parse(pinned.out).safety_code,pin.safety_code);
 const restart=await cli("bob",["keys","code","--id",ids.bob,"--peer",p.peer,"--json"]);assert.equal(restart.code,0,restart.err);assert.equal(JSON.parse(restart.out).code,pin.safety_code);
 const send=await cli("alice",["send","--to","bob","--text","must not leave this process"],false);assert.equal(send.code,1);assert.match(send.err,/disabled/);assert.match(send.err,/No plaintext was sent/);assert.match(send.err,/separate --config-dir/);
 // Both supported wire versions use the same HPKE envelope and local pins.
 for(const proto of ["0.3","1.0"]){
  const secret="fixture-private-text-"+proto+"-"+crypto.randomUUID();
  const result=await cli("alice",["send","--to","bob","--text",secret,"--proto",proto]);
  assert.equal(result.code,0,result.err);const sent=JSON.parse(result.out);
  assert.equal(sent.serverReadable,false);assert.equal(sent.senderHistorySaved,true);
  const inbox=await cli("bob",["inbox","--json"]);assert.equal(inbox.code,0,inbox.err);
  const opened=JSON.parse(inbox.out).find((x:any)=>x.taskId===sent.taskId);
  assert.equal(opened.text,secret);assert.equal(opened.locallyOpened,true);assert.equal(opened.taskStateAuthenticated,false);
  for(const name of ["alice","bob"]){
   const history=await cli(name,["history",sent.contextId,"--json"]);assert.equal(history.code,0,history.err);
   assert.ok(JSON.parse(history.out).some((x:any)=>x.text===secret&&x.locallyOpened));
   // Inspect every application table through the supported export allowlist.
   for(const table of EXPORT_TABLES){
    const rows=await envs[name].DB.prepare(`SELECT * FROM "${table}"`).all();
    assert.equal(JSON.stringify(rows).includes(secret),false,`${name}.${table} leaked plaintext`);
   }
  }
  assert.equal(JSON.stringify(records).includes(secret),false,"plaintext never enters a request body");
  const wire=records.findLast((x:any)=>x.name==="bob"&&x.path==="/"&&JSON.parse(x.body||"{}").params?.message)?.body;
  const request=JSON.parse(wire),message=request.params.message;
  const token=fs.readFileSync(path.join(dirs.alice,"config.env"),"utf8").match(/^PEER_BOB_TOKEN=(.+)$/m)![1];
  const call=async(payload:any,enabled=true)=>{envs.bob.A2A_SEALED_ENABLED=enabled?"1":"";const res=await dispatch("bob",new Request("https://bob.example.com/",{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json","A2A-Version":proto,"A2A-Extensions":"https://a2a.exposed/ext/sealed/v1"},body:JSON.stringify(payload)}));return res.json()as any;};
  assert.ok(!(await call(request)).error,"same bytes are idempotent");
  const mutated=structuredClone(request);mutated.params.message.parts.push(proto==="0.3"?{kind:"text",text:"leak"}:{text:"leak"});assert.ok((await call(mutated)).error);
  const tampered=structuredClone(request);tampered.params.message.parts[0].data.signature="A".repeat(86);assert.ok((await call(tampered)).error);
  const wrongContext=structuredClone(request);wrongContext.params.message.contextId="another-context";assert.ok((await call(wrongContext)).error);
  const downgradeRequest=structuredClone(request);downgradeRequest.params.message={messageId:crypto.randomUUID(),role:"user",parts:[{kind:"text",text:"leak"}]};assert.ok((await call(downgradeRequest)).error);
  assert.ok((await call(request,false)).error);envs.bob.A2A_SEALED_ENABLED="1";
  assert.equal((await owner("bob",`/owner/tasks/${sent.taskId}/reply`,"POST",{text:"must not leak",state:"completed"})).status,409);
  const offInbox=await cli("bob",["inbox","--json"],false);assert.equal(offInbox.code,1);assert.equal(offInbox.out.includes(secret),false);
  // Ciphertext alteration at rest refuses opening; never returns a partial plaintext result.
  const stored:any=await envs.bob.DB.prepare("SELECT seq,message_json FROM messages WHERE task_id=?").bind(sent.taskId).first();
  const corrupt=JSON.parse(stored.message_json);corrupt.parts[0].data.sender.ct="AAAA";
  await envs.bob.DB.prepare("UPDATE messages SET message_json=? WHERE seq=?").bind(JSON.stringify(corrupt),stored.seq).run();
  const bad=await cli("bob",["inbox","--json"]);assert.equal(bad.code,1);assert.equal(bad.out.includes(secret),false);
  const refused=JSON.parse(bad.out).find((x:any)=>x.taskId===sent.taskId);assert.equal(refused.locallyOpened,false);assert.equal(refused.reason,"verification_failed");assert.equal(refused.contextId,sent.contextId);
  await envs.bob.DB.prepare("UPDATE messages SET message_json=? WHERE seq=?").bind(stored.message_json,stored.seq).run();
  // Archive reads keep cryptographic verification but do not use the live replay clock.
  const {LocalState}=await import("../../encryption/local-state.mjs"),api=await import("../../encryption/index.mjs");
  const local=new LocalState(dirs.alice);let identity;try{identity=await local.loadIdentity(ids.alice);}finally{local.close();}
  const b={contextId:sent.contextId,messageId:crypto.randomUUID(),taskId:sent.taskId,role:"user",state:null,kind:"message"};
  const old=await api.seal({identity,recipient:bundles.bob,binding:b,content:{kind:"message",authorRole:"user",parts:[{kind:"text",text:"old fixture content",mediaType:null,metadata:{}}],metadata:{},extensions:[],referenceTaskIds:[]},now:Date.now()-31*86400000});
  assert.equal((await owner("bob","/owner/history","POST",{contextId:sent.contextId,dir:"in",peer:p.peer,taskId:sent.taskId,role:"user",text:"[encrypted message]",data:{sealed:old}})).status,200);
  const archive=await cli("bob",["history",sent.contextId,"--json"]);assert.equal(archive.code,0,archive.err);assert.ok(JSON.parse(archive.out).some((x:any)=>x.text==="old fixture content"&&x.historical));
  const oldCarrier=JSON.parse(stored.message_json);oldCarrier.parts[0].data=old;
  await envs.bob.DB.prepare("UPDATE messages SET message_json=? WHERE seq=?").bind(JSON.stringify(oldCarrier),stored.seq).run();
  const tooOld=await cli("bob",["inbox","--json"]);assert.equal(tooOld.code,1);assert.ok(JSON.parse(tooOld.out).some((x:any)=>x.taskId===sent.taskId&&x.reason==="too_old"));
  await envs.bob.DB.prepare("UPDATE messages SET message_json=? WHERE seq=?").bind(stored.message_json,stored.seq).run();
  // Mixed rows: a refused plaintext downgrade cannot hide the valid encrypted history.
  assert.equal((await owner("bob","/owner/history","POST",{contextId:sent.contextId,dir:"in",peer:p.peer,taskId:sent.taskId,text:"untrusted plaintext downgrade"})).status,200);
  const mixed=await cli("bob",["history",sent.contextId,"--json"]);assert.equal(mixed.code,1);const mixedRows=JSON.parse(mixed.out);assert.ok(mixedRows.some((x:any)=>x.text===secret&&x.locallyOpened));assert.ok(mixedRows.some((x:any)=>x.reason==="plaintext_from_pinned_peer"));assert.equal(mixed.out.includes("untrusted plaintext downgrade"),false);

 }
 const downgrade=await cli("alice",["connect","https://bob.example.com","--alias","bob","--no-wait"]);assert.equal(downgrade.code,1);assert.match(downgrade.err,/pinned encryption keys/);
 assert.equal((await cli("bob",["keys","pin","--id",ids.bob,"--peer",p.peer,"--user-code","WRONG","--json"])).code,1);
 for(const name of ["alice","bob"]){const value=JSON.parse(fs.readFileSync(path.join(dirs[name],"encryption",ids[name]+".key"),"utf8"));for(const secret of [value.signing,value.encryption]){assert.equal(JSON.stringify(records).includes(secret),false);assert.equal(JSON.stringify([pending,connected,pinned,restart]).includes(secret),false);}}
 await assert.rejects(verifyPublicBundle({...bundles.alice,privateKey:"never accepted"}));await assert.rejects(verifyPublicBundle({...bundles.alice,keyId:bundles.bob.keyId}));
 const {generateIdentity}=await import("../../encryption/index.mjs");
 const replacement=await generateIdentity(bundles.bob.cardUrl);
 assert.equal((await owner("bob","/owner/sealed-key","PUT",replacement.bundle)).status,409);
 assert.equal((await owner("bob",`/owner/peers/${p.peer}`,"DELETE")).status,200);
 assert.equal((await cli("bob",["keys","pin","--id",ids.bob,"--peer",p.peer,"--user-code",p.userCode,"--json"])).code,1);
 envs.bob.A2A_SEALED_ENABLED="";assert.equal((await owner("bob","/owner/sealed-key")).status,404);
});
