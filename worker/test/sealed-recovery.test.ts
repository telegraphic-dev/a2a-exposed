// Real CLI processes + real Worker/storage: original-ID send recovery (#382), local pin
// revocation (#381) and protected backup/archive-only restore (#383). Fixtures only.
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
const root=fileURLToPath(new URL("../../",import.meta.url));
test("unconfirmed encrypted sends recover by original ID; revoke holds a pin; backups restore archive-only",async t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"sealed-recovery-"));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const envs:Record<string,any>={},dirs:Record<string,string>={},ids:Record<string,string>={},records:any[]=[],wakes:any[]=[],runs:any[]=[];
 const originalFetch=globalThis.fetch;
 globalThis.fetch=(async(input:any,init:any={})=>{const request=new Request(input,init);if(new URL(request.url).hostname==="hook.example.net"){wakes.push(await request.text());return new Response("accepted",{status:202});}return originalFetch(request);}) as typeof fetch;
 t.after(()=>{globalThis.fetch=originalFetch;});
 const install=(dir:string)=>{fs.mkdirSync(path.join(dir,"node_modules/@a2a-exposed"),{recursive:true});fs.symlinkSync(path.join(root,"encryption"),path.join(dir,"node_modules/@a2a-exposed/encryption"));};
 for(const name of ["alice","bob"]){
  envs[name]={DB:d1(new URL("../migrations/",import.meta.url)),PUBLIC_URL:`https://${name}.example.com`,OWNER_TOKEN:"dummy-owner",AGENT_NAME:name,A2A_SEALED_ENABLED:"1",WAKE_BUSY_SECONDS:"0",WAKE_DEBOUNCE_SECONDS:"0",WAKE_PRESET:"generic",WAKE_WEBHOOK_URL:"https://hook.example.net/wake",WAKE_WEBHOOK_KEY:"dummy-hook-key",RATE_PER_MIN:"1000"};
  dirs[name]=path.join(tmp,name);fs.mkdirSync(dirs[name],{mode:0o700});install(dirs[name]);
  fs.writeFileSync(path.join(dirs[name],"config.env"),`A2A_BASE_URL=https://${name}.example.com\nA2A_OWNER_TOKEN=dummy-owner\n`,{mode:0o600});
 }
 const dispatch=async(name:string,request:Request)=>{const pending:Promise<any>[]=[];const res=await worker.fetch(request,envs[name],{waitUntil:(p:Promise<any>)=>pending.push(p),passThroughOnException(){}} as any);await Promise.allSettled(pending);return res;};
 const owner=(name:string,route:string,method="GET",body?:any)=>dispatch(name,new Request(`https://${name}.example.com${route}`,{method,headers:{authorization:"Bearer dummy-owner","content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 // drop-after: the recipient stores the message, then the connection dies before any response.
 // drop-before: the connection dies before the recipient sees the message.
 let fault:"drop-after"|"drop-before"|null=null;
 const server=http.createServer(async(req,res)=>{try{
  const name=String(req.headers["x-test-agent"]);let body="";for await(const chunk of req)body+=chunk;records.push({name,path:req.url,body});
  const sending=req.url==="/"&&req.method==="POST"&&["SendMessage","message/send"].includes(JSON.parse(body||"{}").method);
  if(sending&&fault==="drop-before"){req.socket.destroy();return;}
  const headers=new Headers();for(const [k,v]of Object.entries(req.headers))if(typeof v==="string"&&!["host","x-test-agent","connection"].includes(k))headers.set(k,v);
  const result=await dispatch(name,new Request(`https://${name}.example.com${req.url}`,{method:req.method,headers,...(["GET","HEAD"].includes(req.method!)?{}:{body})}));
  const text=await result.text();
  if(sending&&fault==="drop-after"){req.socket.destroy();return;}
  res.writeHead(result.status,Object.fromEntries(result.headers));res.end(text);
 }catch(error){res.writeHead(500);res.end(String(error));}});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(()=>{server.closeAllConnections();server.close();});
 const hook=path.join(tmp,"fetch.mjs"),port=(server.address()as any).port;
 fs.writeFileSync(hook,`if(process.env.FIXTURE_OLD_INIT){const now=Date.now()-40*86400000;Date.now=()=>now;}const original=globalThis.fetch;globalThis.fetch=(url,init={})=>{const u=new URL(url);if(!/^(alice|bob)\\.example\\.com$/.test(u.hostname))throw Error('nonfixture network refused');const headers=new Headers(init.headers);headers.set('x-test-agent',u.hostname.split('.')[0]);return original('http://127.0.0.1:${port}'+u.pathname+u.search,{...init,headers});};`);
 const clean=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(A2A_|PEER_|WAKE_|CF_|CLOUDFLARE_|UPSTREAM_|APPROVAL_|EVENT_|HOSTED_)/.test(k)));
 const run=(dir:string,args:string[],input?:string,extra:Record<string,string>={}):Promise<any>=>new Promise(resolve=>{
  const ch=spawn(process.execPath,["--import",hook,path.join(root,"cli/bin/a2a-exposed.mjs"),...args],{env:{...clean,A2A_CONFIG_DIR:dir,A2A_SEALED_ENABLED:"1",DO_NOT_TRACK:"1",A2A_NO_UPDATE_CHECK:"1",...(args[0]==="keys"&&args[1]==="init"?{FIXTURE_OLD_INIT:"1"}:{}),...extra},stdio:[input===undefined?"ignore":"pipe","pipe","pipe"]});
  if(input!==undefined){ch.stdin?.on("error",()=>{});ch.stdin?.end(input);}
  let out="",err="";ch.stdout.setEncoding("utf8");ch.stderr.setEncoding("utf8");ch.stdout.on("data",b=>out+=b);ch.stderr.on("data",b=>err+=b);ch.on("close",code=>{runs.push({args,code,out,err});resolve({code,out,err});});
 });
 const cli=(name:string,args:string[],input?:string)=>run(dirs[name],args,input);
 for(const name of ["alice","bob"]){
  const init=await cli(name,["keys","init","--store","file","--card-url",`https://${name}.example.com/.well-known/agent-card.json`,"--json"]);assert.equal(init.code,0,init.err);ids[name]=JSON.parse(init.out).id;
  assert.equal((await cli(name,["keys","publish","--id",ids[name],"--json"])).code,0);
 }
 const connectArgs=["connect","https://bob.example.com","--alias","bob","--sealed-key-id",ids.alice,"--no-wait","--json"];
 const pending=await cli("alice",connectArgs);assert.equal(pending.code,0,pending.err);
 const userCode=pending.out.trim().split("\n").map((s:string)=>JSON.parse(s)).find((x:any)=>x.status==="authorization_pending").user_code;
 assert.equal((await owner("bob",`/owner/pairing/${userCode}/approve`,"POST",{})).status,200);
 assert.equal((await cli("alice",connectArgs)).code,0);
 const pairing=JSON.parse((await cli("bob",["keys","pairings","--json"])).out).pairings[0];
 assert.equal((await cli("bob",["keys","pin","--id",ids.bob,"--peer",pairing.peer,"--user-code",pairing.userCode,"--json"])).code,0);
 const tasks=async()=>Number((await envs.bob.DB.prepare("SELECT COUNT(*) AS n FROM tasks").first()).n);
 const posts=()=>records.filter(r=>r.name==="bob"&&r.path==="/"&&r.body.includes('"message"')).length;
 const outboxFile=(id:string)=>path.join(dirs.alice,"sealed-outbox",id+".json");
 const secrets:string[]=[];
 const unconfirmed=async(text:string,mode:"drop-after"|"drop-before",context:string)=>{
  secrets.push(text);fault=mode;
  try{
   const sent=await cli("alice",["send","--to","bob","--context",context,"--text",text,"--json"]);
   assert.equal(sent.code,1,sent.out);assert.match(sent.err,/outcome is unknown.*Do not send a new message.*send --to bob --recover [\w-]+.*at most once/);
   return sent.err.match(/--recover ([\w-]+)/)[1];
  }finally{fault=null;}
 };
 // 1. The message arrived but the response was lost. Recovery returns the original task once.
 const before=await tasks(),wakesBefore=wakes.length;
 const lostReply=await unconfirmed("recovery-fixture-delivered","drop-after","recover-after");
 assert.equal(await tasks(),before+1,"the recipient stored the original once");
 const listed=JSON.parse((await cli("alice",["keys","outbox","--json"])).out);
 const entry=listed.records.find((r:any)=>r.messageId===lostReply);assert.equal(entry.state,"unknown");assert.equal(entry.taskId,null);assert.match(entry.next,/--recover/);
 assert.equal(JSON.stringify(listed).includes('"envelope"'),false,"listing shows public fields only");
 const wakesAfterFirst=wakes.length;assert.ok(wakesAfterFirst>wakesBefore);
 const recovered=await cli("alice",["send","--to","bob","--recover",lostReply,"--json"]);
 assert.equal(recovered.code,0,recovered.err);const r1=JSON.parse(recovered.out);
 assert.equal(r1.recovered,true);assert.equal(r1.messageId,lostReply);assert.equal(r1.contextId,"recover-after");assert.equal(r1.sendRecordSaved,true);
 assert.equal(await tasks(),before+1,"recovery stored nothing new");assert.equal(wakes.length,wakesAfterFirst,"recovery woke nobody again");
 const inbox=await cli("bob",["history","recover-after","--json"]);assert.equal(inbox.code,0,inbox.err);
 assert.equal(JSON.parse(inbox.out).filter((x:any)=>x.text==="recovery-fixture-delivered"&&x.dir==="in").length,1,"recipient sees one copy");
 // A confirmed record never makes another request.
 const postsBefore=posts();
 const again=await cli("alice",["send","--to","bob","--recover",lostReply,"--json"]);assert.equal(again.code,0,again.err);
 assert.equal(JSON.parse(again.out).requestMade,false);assert.equal(JSON.parse(again.out).state,"delivered");assert.equal(posts(),postsBefore);
 // 2. The connection died before the recipient saw it. Recovery delivers the original exactly once.
 const lostRequest=await unconfirmed("recovery-fixture-undelivered","drop-before","recover-before");
 assert.equal(await tasks(),before+1,"nothing stored yet");
 const delivered=await cli("alice",["send","--to","bob","--recover",lostRequest,"--json"]);assert.equal(delivered.code,0,delivered.err);
 assert.equal(JSON.parse(delivered.out).messageId,lostRequest);assert.equal(await tasks(),before+2);
 const read=await cli("bob",["history","recover-before","--json"]);assert.ok(JSON.parse(read.out).some((x:any)=>x.text==="recovery-fixture-undelivered"&&x.messageId===lostRequest&&x.messageIdAuthenticated));
 // 3. Recovery takes no new content, routing or alias; nothing is sent.
 const third=await unconfirmed("recovery-fixture-held","drop-before","recover-held");
 for(const extra of [["--text","replacement"],["--context","other"],["--task","other"],["--proto","1.0"]]){
  const p0=posts(),refused=await cli("alice",["send","--to","bob","--recover",third,...extra]);
  assert.equal(refused.code,1);assert.match(refused.err,/does not accept.*Nothing was sent/);assert.equal(posts(),p0);
 }
 assert.equal((await cli("alice",["send","--to","carol","--recover",third])).code,1);
 assert.match((await cli("alice",["send","--to","bob","--recover","no-such-message"])).err,/No local send record.*keys outbox --json/);
 // 4. A damaged record is quarantined in place: refused, untouched, never resent.
 const file=outboxFile(third),original=fs.readFileSync(file);
 for(const damage of [Buffer.from("{not json"),Buffer.from(JSON.stringify({...JSON.parse(String(original)),messageId:"retargeted"})),Buffer.from(JSON.stringify({...JSON.parse(String(original)),contextId:"moved-context"}))]){
  fs.writeFileSync(file,damage);
  const p0=posts(),refused=await cli("alice",["send","--to","bob","--recover",third]);
  assert.equal(refused.code,1);assert.match(refused.err,/damaged or unreadable.*left unchanged.*cannot be recovered/);assert.equal(posts(),p0);
  assert.deepEqual(fs.readFileSync(file),damage,"damaged bytes stay in place");
  assert.ok(JSON.parse((await cli("alice",["keys","outbox","--json"])).out).records.some((x:any)=>x.messageId===third&&x.state==="damaged"));
 }
 fs.writeFileSync(file,original);
 // Records hold ciphertext and public IDs only; the folder is private.
 assert.equal(fs.statSync(path.join(dirs.alice,"sealed-outbox")).mode&0o777,0o700);
 for(const name of fs.readdirSync(path.join(dirs.alice,"sealed-outbox"))){
  const p=path.join(dirs.alice,"sealed-outbox",name);assert.equal(fs.statSync(p).mode&0o777,0o600);
  for(const text of secrets)assert.equal(fs.readFileSync(p,"utf8").includes(text),false,`${name} holds plaintext`);
 }
 // 5. Protected backup: passphrase only from piped stdin, then an archive-only restore.
 const backup=path.join(tmp,"alice.backup"),restored=path.join(tmp,"alice-restored");
 for(const input of [undefined,"","short\n"]){
  const refused=await cli("alice",["keys","backup","--to",backup,"--json"],input);
  assert.equal(refused.code,1);assert.match(refused.err,input==="short\n"?/passphrase_input/:/Pipe the backup passphrase on stdin.*never read from a terminal prompt, a command argument or an environment variable/);
  assert.equal(fs.existsSync(backup),false);
 }
 const passphrase="fixture backup passphrase "+crypto.randomUUID();
 const made=await cli("alice",["keys","backup","--to",backup,"--json"],passphrase+"\n");assert.equal(made.code,0,made.err);
 assert.equal(JSON.parse(made.out).identities,1);assert.match(JSON.parse(made.out).next,/archive-only/);
 assert.equal(fs.statSync(backup).mode&0o777,0o600);
 const aliceKey=JSON.parse(fs.readFileSync(path.join(dirs.alice,"encryption",ids.alice+".key"),"utf8"));
 const backupText=fs.readFileSync(backup,"utf8");for(const secret of [aliceKey.signing,aliceKey.encryption,passphrase,...secrets])assert.equal(backupText.includes(secret),false);
 assert.equal((await cli("alice",["keys","backup","--to",backup,"--json"],passphrase)).code,1,"never overwrites a backup");
 assert.match((await cli("alice",["keys","restore","--from",backup,"--to",restored,"--json"],passphrase)).err,/--acknowledge-replay-rollback/);
 assert.match((await cli("alice",["keys","restore","--from",backup,"--to",restored,"--acknowledge-replay-rollback","--json"],"wrong passphrase value\n")).err,/backup_unreadable/);
 assert.equal(fs.existsSync(restored),false,"a wrong passphrase creates nothing");
 const restoredRun=await cli("alice",["keys","restore","--from",backup,"--to",restored,"--acknowledge-replay-rollback","--json"],passphrase);
 assert.equal(restoredRun.code,0,restoredRun.err);const restoredOut=JSON.parse(restoredRun.out);assert.equal(restoredOut.archive_only,true);assert.notEqual(restoredOut.config_identity,restoredOut.source_config_identity);
 assert.equal((await cli("alice",["keys","restore","--from",backup,"--to",restored,"--acknowledge-replay-rollback","--json"],passphrase)).err.includes("restore_destination_exists"),true,"never merges into an existing directory");
 // The restored copy reads verified history but cannot send, read live or recover.
 install(restored);fs.copyFileSync(path.join(dirs.alice,"config.env"),path.join(restored,"config.env"));fs.copyFileSync(path.join(dirs.alice,"peers.json"),path.join(restored,"peers.json"));
 const archived=await run(restored,["history","recover-before","--json"]);assert.equal(archived.code,0,archived.err);
 assert.ok(JSON.parse(archived.out).some((x:any)=>x.text==="recovery-fixture-undelivered"&&x.historical&&x.locallyOpened));
 const p1=posts();
 const restoredSend=await run(restored,["send","--to","bob","--text","restored-copy-must-not-send"]);assert.equal(restoredSend.code,1);assert.match(restoredSend.err,/restored archive-only copy/);
 assert.equal(posts(),p1);
 const status=JSON.parse((await run(restored,["keys","status","--json"])).out);assert.equal(status.archive_only,true);
 // Inbox and poll refuse before any request: reading the live inbox would acknowledge its wakes.
 assert.equal(restoredOut.archive_marker,true);assert.equal(fs.statSync(path.join(restored,"archive-only.json")).mode&0o777,0o600);
 const liveReads=()=>records.filter(r=>r.name==="alice"&&(String(r.path).startsWith("/owner/inbox")||String(r.path).startsWith("/owner/outbound"))).length+posts();
 const guarded=async(label:string,extra:Record<string,string>)=>{
  for(const args of [["inbox","--json"],["poll","--to","bob",r1.taskId,"--json"]]){
   const n=liveReads(),refused=await run(restored,args,undefined,extra);
   assert.equal(refused.code,1,`${label} ${args[0]}`);assert.match(refused.err,/restored archive-only copy/,`${label} ${args[0]}`);assert.equal(liveReads(),n,`${label} ${args[0]} made no request`);
  }
 };
 await guarded("marker, encryption off",{A2A_SEALED_ENABLED:""});
 await guarded("marker, encryption on",{});
 const marker=path.join(restored,"archive-only.json"),markerBytes=fs.readFileSync(marker);fs.rmSync(marker);
 await guarded("store flag only",{});
 fs.writeFileSync(marker,markerBytes,{mode:0o600});
 // --recover never falls through to an ordinary send, even in a config without local keys.
 const plain=path.join(tmp,"plain");fs.mkdirSync(plain,{mode:0o700});fs.copyFileSync(path.join(dirs.alice,"config.env"),path.join(plain,"config.env"));
 const plainPeers=JSON.parse(fs.readFileSync(path.join(dirs.alice,"peers.json"),"utf8"));for(const peer of Object.values(plainPeers) as any[])delete peer.sealed;
 fs.writeFileSync(path.join(plain,"peers.json"),JSON.stringify(plainPeers),{mode:0o600});
 for(const [extra,args,expected] of [
  [{A2A_SEALED_ENABLED:""},["--text","plain-recover-must-not-send"],/send --recover reconciles only encrypted sends.*Nothing was sent/],
  [{A2A_SEALED_ENABLED:""},[],/send --recover reconciles only encrypted sends.*Nothing was sent/],
  [{},["--text","plain-recover-must-not-send"],/send --recover does not accept --text.*Nothing was sent/],
  [{},[],/send --recover requires --to with the original pinned alias.*Nothing was sent/],
 ] as [Record<string,string>,string[],RegExp][]){
  const p0=posts(),t0=await tasks(),refused=await run(plain,["send","--to","bob","--recover",third,...args],"plain-recover-stdin-must-not-send",extra);
  assert.equal(refused.code,1);assert.match(refused.err,expected);
  assert.equal(posts(),p0);assert.equal(await tasks(),t0);
 }
 // 6. Local revoke: fail closed for this pin; history and records stay unchanged.
 const held=await unconfirmed("recovery-fixture-revoked","drop-before","recover-revoked");
 const heldBytes=fs.readFileSync(outboxFile(held));
 const revoked=await cli("alice",["keys","revoke","--peer","bob","--json"]);assert.equal(revoked.code,0,revoked.err);
 assert.equal(JSON.parse(revoked.out).revoked,true);assert.equal(JSON.parse(revoked.out).changed,true);assert.match(JSON.parse(revoked.out).next,/token revoke LABEL/);
 assert.equal(JSON.parse((await cli("alice",["keys","revoke","--peer","bob","--json"])).out).changed,false);
 const p2=posts();
 for(const args of [["send","--to","bob","--text","after-revoke"],["send","--to","bob","--recover",held]]){
  const refused=await cli("alice",args);assert.equal(refused.code,1);assert.match(refused.err,/revoked with keys revoke.*stay held/);
 }
 const plaintext=await cli("alice",["send","--to","bob","--text","after-revoke-plain"]);assert.equal(plaintext.code,1);
 assert.equal(posts(),p2,"a revoked pin sends nothing");
 const history=await cli("alice",["history","recover-before","--json"]);assert.equal(history.code,1);assert.ok(JSON.parse(history.out).every((x:any)=>x.reason==="pin_revoked"));
 assert.deepEqual(fs.readFileSync(outboxFile(held)),heldBytes,"revocation leaves send records unchanged");
 assert.equal(await tasks(),before+2,"held messages were never stored");
 // No plaintext or private key in any command output.
 for(const r of runs){for(const s of [aliceKey.signing,aliceKey.encryption,passphrase])assert.equal((r.out+r.err).includes(s),false,`${r.args.join(" ")} printed a secret`);
  if(!["history","inbox"].includes(r.args[0]))for(const text of secrets)assert.equal((r.out+r.err).includes(text),false,`${r.args.slice(0,2).join(" ")} printed plaintext`);}
 assert.equal(JSON.stringify(records).includes("recovery-fixture"),false,"plaintext never enters a request body");
});
