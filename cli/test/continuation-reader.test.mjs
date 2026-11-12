import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {initializePairingAuthority,inspectPairingAuthority,mutatePairingAuthority,withPairingAuthorityLease,readContinuationSourceSnapshot,planPairingAuthorityRecovery,quarantinePairingAuthority} from '../lib/pairing-authority.mjs';
const posix={skip:process.platform==='win32'};
function fixture(t,{config='PEER_SYNTHETIC_TOKEN=synthetic-original\n',peers='{"synthetic":{"url":"https://example.com/rpc","token_env":"PEER_SYNTHETIC_TOKEN"}}'}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-continuation-reader-')),configIdentity=randomUUID();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 if(config!==null)fs.writeFileSync(path.join(dir,'config.env'),config,{mode:0o600});if(peers!==null)fs.writeFileSync(path.join(dir,'peers.json'),peers,{mode:0o600});initializePairingAuthority(dir,{configIdentity});return{dir,configIdentity};
}
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const select=view=>view.select({selected:['synthetic'],excluded:[]},{});
function writer(f){
 const script=`import fs from 'node:fs';import path from 'node:path';import{mutatePairingAuthority}from ${JSON.stringify(new URL('../lib/pairing-authority.mjs',import.meta.url).href)};let result;try{result=mutatePairingAuthority(process.argv[1],{configIdentity:process.argv[2],expectedRevision:0},()=>fs.writeFileSync(path.join(process.argv[1],'config.env'),'PEER_SYNTHETIC_TOKEN=synthetic-updated\\n',{mode:0o600}));}catch(e){result={ok:false,code:e.code};}process.stdout.write(JSON.stringify(result));`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',script,f.dir,f.configIdentity],{encoding:'utf8',timeout:5000,env:{TZ:process.env.TZ||'UTC',DO_NOT_TRACK:'1',A2A_NO_UPDATE_CHECK:'1'}});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}

test('physical protected source bytes are read under authority revision without database/source writes',posix,t=>{
 const f=fixture(t),db=path.join(f.dir,'pairing-authority.sqlite'),before=digest(db),source=digest(path.join(f.dir,'config.env'));let escaped;
 const result=readContinuationSourceSnapshot(f.dir,f,(view,revision)=>{escaped=view;assert.equal(revision,0);return select(view);});assert.equal(result.revision,0);assert.equal(result.value[0].token,'synthetic-original');assert.equal(result.value[0].credential_source,'file');assert.equal(digest(db),before);assert.equal(digest(path.join(f.dir,'config.env')),source);
 for(const method of ['inspectInventory','sourceTexts','select','abandonmentValues'])assert.throws(()=>escaped[method](),{code:'authority_snapshot_expired'});
 assert.equal(inspectPairingAuthority(f.dir).revision,0);
});
test('borrowed outer authority lease excludes real child writer throughout reads and until lease release',{...posix,timeout:10000},async t=>{
 const f=fixture(t);await withPairingAuthorityLease(f.dir,f,async()=>{
  const first=readContinuationSourceSnapshot(f.dir,f,view=>{assert.deepEqual(writer(f),{ok:false,code:'authority_busy'});return select(view);});assert.equal(first.value[0].token,'synthetic-original');
  assert.deepEqual(writer(f),{ok:false,code:'authority_busy'});assert.equal(readContinuationSourceSnapshot(f.dir,f,select).revision,0);
 });assert.deepEqual(writer(f),{ok:true,revision:1});const next=readContinuationSourceSnapshot(f.dir,f,select);assert.equal(next.revision,1);assert.equal(next.value[0].token,'synthetic-updated');
});
test('pending, suspended and wrong-identity reads refuse before any callback',posix,t=>{
 const f=fixture(t);let calls=0;assert.throws(()=>readContinuationSourceSnapshot(f.dir,{configIdentity:randomUUID()},()=>calls++),{code:'authority_identity_mismatch'});
 assert.throws(()=>mutatePairingAuthority(f.dir,{...f,expectedRevision:0},()=>{throw Error('synthetic interruption');}));assert.throws(()=>readContinuationSourceSnapshot(f.dir,f,()=>calls++),{code:'authority_write_pending'});
 const p=planPairingAuthorityRecovery(f.dir,f);quarantinePairingAuthority(f.dir,{...f,expectedRevision:p.revision,expectedIntent:p.pendingIntent,...p.choices[0],ownerApproved:true});assert.throws(()=>readContinuationSourceSnapshot(f.dir,f,()=>calls++),{code:'authority_reverification_required'});assert.equal(calls,0);
});
test('unsafe owner modes, symlinks, nonregular files and oversized sources refuse without callbacks',posix,t=>{
 let calls=0;
 for(const mutation of [f=>fs.chmodSync(f.dir,0o755),f=>fs.chmodSync(path.join(f.dir,'config.env'),0o644),f=>{const file=path.join(f.dir,'peers.json');fs.renameSync(file,file+'.retained');fs.symlinkSync(file+'.retained',file);},f=>{const file=path.join(f.dir,'peers.json');fs.unlinkSync(file);fs.mkdirSync(file,{mode:0o700});},f=>fs.writeFileSync(path.join(f.dir,'config.env'),Buffer.alloc(1024*1024+1),{mode:0o600})]){
  const f=fixture(t);mutation(f);assert.throws(()=>readContinuationSourceSnapshot(f.dir,f,()=>calls++),{code:'authority_permissions'});
 }assert.equal(calls,0);
});
test('malformed initialized sources refuse before callback and preserve state bytes',posix,t=>{
 for(const opts of [{config:'BAD PRIVATE SYNTHETIC TEXT'},{peers:'{"synthetic":{},"synthetic":{}}'},{config:'PEER_SYNTHETIC_TOKEN="\\ud800"'}]){
  const f=fixture(t,opts),db=path.join(f.dir,'pairing-authority.sqlite'),before=digest(db);let calls=0;
  assert.throws(()=>readContinuationSourceSnapshot(f.dir,f,()=>calls++),e=>e.code==='authority_source_invalid'&&!String(e).includes('PRIVATE'));assert.equal(calls,0);assert.equal(digest(db),before);
 }
});
test('actual bytes changed during read then restored cannot masquerade as the authority baseline',posix,t=>{
 const f=fixture(t),file=path.join(f.dir,'config.env'),original=fs.readFileSync(file),ino=fs.statSync(file).ino,read=fs.readSync;let reads=0,calls=0;
 fs.readSync=function(fd,...args){if(fs.fstatSync(fd).ino===ino&&++reads===3){fs.writeFileSync(file,'PEER_SYNTHETIC_TOKEN=synthetic-temporary\n',{mode:0o600});try{return read.call(fs,fd,...args);}finally{fs.writeFileSync(file,original,{mode:0o600});}}return read.call(fs,fd,...args);};
 try{assert.throws(()=>readContinuationSourceSnapshot(f.dir,f,()=>calls++),{code:'authority_external_change'});}finally{fs.readSync=read;}
 assert.ok(reads>=3);assert.equal(calls,0);assert.deepEqual(fs.readFileSync(file),original);assert.equal(inspectPairingAuthority(f.dir).sourceMismatch,false);
});
test('callback source effects are retained on refusal, never promised rolled back',posix,t=>{
 const f=fixture(t);assert.throws(()=>readContinuationSourceSnapshot(f.dir,f,view=>{const value=select(view);fs.writeFileSync(path.join(f.dir,'config.env'),'PEER_SYNTHETIC_TOKEN=synthetic-changed\n',{mode:0o600});return value;}),{code:'authority_external_change'});assert.equal(inspectPairingAuthority(f.dir).sourceMismatch,true);assert.match(fs.readFileSync(path.join(f.dir,'config.env'),'utf8'),/synthetic-changed/);
});
test('safely absent files support no-grant extraction only; async read callbacks refuse',posix,async t=>{
 const f=fixture(t,{config:null,peers:null});const value=readContinuationSourceSnapshot(f.dir,f,view=>view.abandonmentValues(['PEER_SYNTHETIC_TOKEN'],{}));assert.deepEqual(value.value,{environment:{},fileValues:{}});
 let escaped;assert.throws(()=>readContinuationSourceSnapshot(f.dir,f,async view=>{escaped=view;await Promise.resolve();return view.inspectInventory();}),{code:'authority_async_reader'});await Promise.resolve();assert.throws(()=>escaped.inspectInventory(),{code:'authority_snapshot_expired'});
});

test('a source replaced by a FIFO after lstat refuses promptly rather than blocking open',{...posix,timeout:10000},t=>{
 const f=fixture(t),root=fs.realpathSync(f.dir),file=path.join(root,'config.env'),fifo=path.join(root,'synthetic.fifo'),backup=path.join(root,'synthetic.retained');
 const made=spawnSync('mkfifo',[fifo],{encoding:'utf8',timeout:5000});assert.equal(made.status,0,made.stderr);
 const script=`import fs from 'node:fs';import{readContinuationSourceSnapshot}from ${JSON.stringify(new URL('../lib/pairing-authority.mjs',import.meta.url).href)};const [dir,identity,file,fifo,backup]=process.argv.slice(1),open=fs.openSync;let swapped=false,calls=0;fs.openSync=function(p,...args){if(p===file&&!swapped){swapped=true;fs.renameSync(file,backup);fs.renameSync(fifo,file);try{return open.call(fs,p,...args);}finally{fs.renameSync(file,fifo);fs.renameSync(backup,file);}}return open.call(fs,p,...args);};let code;try{readContinuationSourceSnapshot(dir,{configIdentity:identity},()=>calls++);}catch(e){code=e.code;}process.stdout.write(JSON.stringify({code,calls,swapped}));`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script,f.dir,f.configIdentity,file,fifo,backup],{encoding:'utf8',timeout:3000,env:{DO_NOT_TRACK:'1',A2A_NO_UPDATE_CHECK:'1'}});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{code:'authority_permissions',calls:0,swapped:true});assert.match(fs.readFileSync(file,'utf8'),/synthetic-original/);
});
test('configuration directory replacement inside a callback refuses its result',posix,t=>{
 const f=fixture(t),retained=f.dir+'.retained';t.after(()=>fs.rmSync(retained,{recursive:true,force:true}));
 assert.throws(()=>readContinuationSourceSnapshot(f.dir,f,view=>{const value=select(view);fs.renameSync(f.dir,retained);fs.mkdirSync(f.dir,{mode:0o700});return value;}),{code:'authority_changed'});assert.match(fs.readFileSync(path.join(retained,'config.env'),'utf8'),/synthetic-original/);
});

function replacingRoots(t){
 const f=fixture(t),g=fixture(t);f.dir=fs.realpathSync(f.dir);g.dir=fs.realpathSync(g.dir);const retained=f.dir+'.retained';t.after(()=>fs.rmSync(retained,{recursive:true,force:true}));let swapped=false;
 return{f,g,retained,swap(){assert.equal(swapped,false);swapped=true;fs.renameSync(f.dir,retained);fs.renameSync(g.dir,f.dir);},check(){assert.equal(swapped,true);assert.equal(inspectPairingAuthority(f.dir).configIdentity,g.configIdentity);assert.equal(inspectPairingAuthority(retained).configIdentity,f.configIdentity);assert.equal(fs.readFileSync(path.join(f.dir,'config.env'),'utf8'),fs.readFileSync(path.join(retained,'config.env'),'utf8'));}};
}
test('both original AX directory-rename constructions refuse instead of returning an old authority result',posix,t=>{
 for(const edge of ['before-start-root-check','after-end-root-check']){
  const p=replacingRoots(t),realpath=fs.realpathSync,lstat=fs.lstatSync;let rootChecks=0,realCalls=0;
  fs.lstatSync=function(file,...args){if(file===p.f.dir&&++rootChecks===2&&edge==='before-start-root-check')p.swap();return lstat.call(fs,file,...args);};
  fs.realpathSync=function(file,...args){const result=realpath.call(fs,file,...args);if(file===p.f.dir&&++realCalls===2&&edge==='after-end-root-check')p.swap();return result;};
  try{assert.throws(()=>readContinuationSourceSnapshot(p.f.dir,p.f,select),e=>e.code?.startsWith('authority_'));}finally{fs.lstatSync=lstat;fs.realpathSync=realpath;}
  p.check();
 }
});
test('replacement after initial matching or during final source I/O still refuses at the original anchor',posix,t=>{
 for(const edge of ['initial','final']){
  const p=replacingRoots(t),ino=fs.statSync(path.join(p.f.dir,'peers.json')).ino,read=fs.readSync;let entered=false,swapped=false,calls=0;
  fs.readSync=function(fd,...args){const result=read.call(fs,fd,...args);if(!swapped&&result===0&&fs.fstatSync(fd).ino===ino&&(edge==='initial'||entered)){swapped=true;p.swap();}return result;};
  try{assert.throws(()=>readContinuationSourceSnapshot(p.f.dir,p.f,view=>{entered=true;calls++;return select(view);}),{code:'authority_changed'});}finally{fs.readSync=read;}
  assert.equal(calls,edge==='initial'?0:1);p.check();
 }
});
test('borrowed snapshot carries the outer acquisition root identity across a real replacement',posix,async t=>{
 const p=replacingRoots(t);let calls=0;
 await assert.rejects(withPairingAuthorityLease(p.f.dir,p.f,async()=>{p.swap();assert.throws(()=>readContinuationSourceSnapshot(p.f.dir,p.f,()=>calls++),{code:'authority_changed'});}),{code:'authority_changed'});
 assert.equal(calls,0);p.check();
});
test('borrowed reads refuse replaced marker or DB instances even with identical configuration bytes',posix,async t=>{
 for(const name of ['pairing-authority.json','pairing-authority.sqlite']){
  const f=fixture(t),file=path.join(f.dir,name),retained=file+'.retained';let calls=0;
  await assert.rejects(withPairingAuthorityLease(f.dir,f,async()=>{fs.renameSync(file,retained);fs.copyFileSync(retained,file);assert.throws(()=>readContinuationSourceSnapshot(f.dir,f,()=>calls++),{code:'authority_changed'});}),{code:'authority_changed'});
  assert.equal(calls,0);assert.ok(fs.existsSync(retained));assert.equal(digest(file),digest(retained));assert.equal(inspectPairingAuthority(f.dir).configIdentity,f.configIdentity);
 }
});
