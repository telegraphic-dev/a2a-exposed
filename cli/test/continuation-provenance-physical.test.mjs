import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {initializeFreshContinuationProvenanceAuthority as initialize,inspectFreshContinuationProvenanceAuthority as inspect,initializePairingAuthority,initializeContinuationAuthority,inspectPairingAuthority,inspectContinuationAuthority,mutatePairingAuthority,withContinuationAuthorityMaintenance} from '../lib/pairing-authority.mjs';
const options={configIdentity:'00000000-0000-4000-8000-000000000001'};
const posix={skip:process.platform==='win32'};
function fixture(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'a2a-provenance-physical-')));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'config.env'),'TOKEN=synthetic-token\n',{mode:0o600});fs.writeFileSync(path.join(dir,'peers.json'),JSON.stringify({peer:{url:'https://example.com/',token_env:'TOKEN'}}),{mode:0o600});return dir;
}
const file=dir=>path.join(dir,'pairing-authority.sqlite');
function raw(dir,fn){const db=new DatabaseSync(file(dir));try{return fn(db);}finally{db.close();}}
const bytes=dir=>fs.readFileSync(file(dir));
function edit(dir,patch){raw(dir,db=>{
 const triggers=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='authority'").all();for(const r of triggers)db.exec(`DROP TRIGGER ${r.name}`);patch(db);for(const r of triggers)db.exec(r.sql);
});}
function onEOF(target,action,run){const ino=fs.statSync(target).ino,read=fs.readSync;let hit=false;fs.readSync=function(fd,...args){const n=read.call(fs,fd,...args);if(!hit&&n===0&&fs.fstatSync(fd).ino===ino){hit=true;action();}return n;};try{return run();}finally{fs.readSync=read;assert.equal(hit,true);}}

test('fresh physical schema 4 starts private, suspended, empty and without a selected signer',posix,t=>{
 const dir=fixture(t);assert.deepEqual(initialize(dir,options),{ok:true,...options,revision:0});const status=inspect(dir,options);
 assert.equal(Object.isFrozen(status),true);assert.equal(status.schema,4);assert.equal(status.revision,0);assert.equal(status.suspended,true);assert.equal(status.sourceMismatch,false);assert.equal(status.currentSigner,null);assert.equal(status.intentId,null);assert.equal(status.activeSet,null);assert.match(status.epoch,/^[a-f0-9-]{36}$/);
 for(const name of ['pairing-authority.sqlite','pairing-authority.json'])assert.equal(fs.statSync(path.join(dir,name)).mode&0o777,0o600);
 raw(dir,db=>{assert.equal(db.prepare('PRAGMA user_version').get().user_version,4);const r=db.prepare('SELECT * FROM authority').get();assert.equal(r.canonical_root,dir);assert.match(r.recovery_key,/^[A-Za-z0-9_-]{43}$/);assert.ok(!JSON.stringify(status).includes(r.recovery_key));assert.ok(!JSON.stringify(status).includes(r.source_hash));assert.ok(!JSON.stringify(status).includes(dir));});
 const before=bytes(dir);assert.deepEqual(inspect(dir,options),status);assert.deepEqual(bytes(dir),before);assert.throws(()=>initialize(dir,options),{code:'authority_already_exists'});assert.deepEqual(bytes(dir),before);
 const module=new URL('../lib/pairing-authority.mjs',import.meta.url).href;
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import{inspectFreshContinuationProvenanceAuthority as inspect}from ${JSON.stringify(module)};console.log(JSON.stringify(inspect(process.argv[1],${JSON.stringify(options)})));`,dir],{encoding:'utf8',timeout:10000,env:{DO_NOT_TRACK:'1'}});assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),status);
});
test('schema 2 and 3 stores refuse without migration or byte changes',posix,t=>{
 for(const init of [initializePairingAuthority,initializeContinuationAuthority]){const dir=fixture(t);init(dir,options);const before=bytes(dir);assert.throws(()=>initialize(dir,options),{code:'authority_already_exists'});assert.throws(()=>inspect(dir,options),{code:'authority_schema'});assert.deepEqual(bytes(dir),before);}
});
test('schema 4 refuses legacy diagnostics, mutations and maintenance without invoking callbacks',posix,async t=>{
 const dir=fixture(t);initialize(dir,options);const before=bytes(dir);assert.throws(()=>inspectPairingAuthority(dir),{code:'authority_schema'});assert.throws(()=>inspectContinuationAuthority(dir,options),{code:'authority_schema'});assert.throws(()=>mutatePairingAuthority(dir,{...options,expectedRevision:0},()=>assert.fail()),{code:'authority_schema'});await assert.rejects(withContinuationAuthorityMaintenance(dir,options,()=>assert.fail()),{code:'authority_schema'});assert.deepEqual(bytes(dir),before);
});
test('source parsing and identity validation fail before reserving physical files',posix,t=>{
 const dir=fixture(t);assert.throws(()=>initialize(dir,{configIdentity:'bad'}),{code:'authority_identity_required'});fs.writeFileSync(path.join(dir,'config.env'),'TOKEN=$(forbidden)\n');assert.throws(()=>initialize(dir,options),{code:'authority_source_invalid'});assert.equal(fs.existsSync(file(dir)),false);assert.equal(fs.existsSync(path.join(dir,'pairing-authority.json')),false);
});
test('source drift is diagnostic only and never rewrites hashes or accepts history',posix,t=>{
 const dir=fixture(t);initialize(dir,options);const before=bytes(dir);fs.appendFileSync(path.join(dir,'config.env'),'# drift\n');assert.equal(inspect(dir,options).sourceMismatch,true);assert.deepEqual(bytes(dir),before);
});
test('wrong identity, moved canonical root and identical-byte marker replacement during reads refuse',posix,t=>{
 const dir=fixture(t);initialize(dir,options);assert.throws(()=>inspect(dir,{configIdentity:'00000000-0000-4000-8000-000000000002'}),{code:'authority_identity_mismatch'});
 const marker=path.join(dir,'pairing-authority.json');onEOF(path.join(dir,'peers.json'),()=>{fs.renameSync(marker,marker+'.retained');fs.copyFileSync(marker+'.retained',marker);},()=>assert.throws(()=>inspect(dir,options),{code:'authority_changed'}));
 const moved=path.join(fixture(t),'moved');fs.renameSync(dir,moved);assert.throws(()=>inspect(moved,options),{code:'authority_fresh_required'});
});
for(const sql of ["UPDATE authority SET revision=1","UPDATE authority SET recovery_key='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB'","UPDATE authority SET source_hash='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB'","UPDATE authority SET canonical_root='/synthetic/other'","UPDATE authority SET canonical_root=CAST(x'ff' AS TEXT)","UPDATE authority SET suspension_epoch='invalid'"])
 test('fresh diagnostics refuse tampered rows even with exact restored schema: '+sql,posix,t=>{
  const dir=fixture(t);initialize(dir,options);edit(dir,db=>{db.exec('PRAGMA ignore_check_constraints=ON');db.exec(sql);});const before=bytes(dir);assert.throws(()=>inspect(dir,options),e=>['authority_fresh_required','authority_state_invalid'].includes(e.code));assert.deepEqual(bytes(dir),before);
 });
test('fresh diagnostics reject syntactically shaped but unauthenticated retained signer history',posix,t=>{
 const dir=fixture(t);initialize(dir,options);raw(dir,db=>db.prepare('INSERT INTO continuation_signer_enrollments VALUES(?,?,?,?,?,?)').run('00000000-0000-4000-8000-000000000003',options.configIdentity,dir,'00000000-0000-4000-8000-000000000004',Buffer.alloc(44).toString('base64url'),Buffer.alloc(32).toString('base64url')));const before=bytes(dir);assert.throws(()=>inspect(dir,options),{code:'authority_fresh_required'});assert.deepEqual(bytes(dir),before);
});
test('inventory mismatch refuses without repair',posix,t=>{
 const dir=fixture(t);initialize(dir,options);raw(dir,db=>db.exec('DROP TRIGGER authority_pending'));const before=bytes(dir);assert.throws(()=>inspect(dir,options));assert.deepEqual(bytes(dir),before);
});
test('pre/post COMMIT and partial marker failures retain original incomplete files on retry',posix,t=>{
 for(const when of ['before','after','marker']){
  const dir=fixture(t),exec=DatabaseSync.prototype.exec,write=fs.writeFileSync;
  DatabaseSync.prototype.exec=function(sql,...args){if(sql==='COMMIT'&&when==='before')throw Error('synthetic commit');const r=exec.call(this,sql,...args);if(sql==='COMMIT'&&when==='after')throw Error('synthetic committed return');return r;};
  fs.writeFileSync=function(fd,value,...args){if(when==='marker'&&typeof fd==='number'&&typeof value==='string'&&value.startsWith('{"v":1')){write.call(fs,fd,'{');throw Error('synthetic marker');}return write.call(fs,fd,value,...args);};
  try{assert.throws(()=>initialize(dir,options),{code:'authority_unavailable'});}finally{DatabaseSync.prototype.exec=exec;fs.writeFileSync=write;}
  const before=bytes(dir);assert.throws(()=>initialize(dir,options),{code:'authority_already_exists'});assert.deepEqual(bytes(dir),before);assert.throws(()=>inspect(dir,options));
 }
});
test('source-read root replacement refuses before authority reservation',posix,t=>{
 const dir=fixture(t),retained=path.join(fixture(t),'retained'),next=fixture(t);
 onEOF(path.join(dir,'peers.json'),()=>{fs.renameSync(dir,retained);fs.renameSync(next,dir);},()=>assert.throws(()=>initialize(dir,options),{code:'authority_changed'}));for(const root of [dir,retained])assert.equal(fs.existsSync(file(root)),false);
});
test('a post-publication authority change cannot become a successful fresh setup',posix,t=>{
 const dir=fixture(t),marker=path.join(dir,'pairing-authority.json'),sync=fs.fsyncSync;let changed=false;
 fs.fsyncSync=function(fd){const result=sync.call(fs,fd);if(!changed&&fs.existsSync(marker)&&fs.fstatSync(fd).ino===fs.statSync(marker).ino){changed=true;edit(dir,db=>db.prepare('UPDATE authority SET recovery_key=?').run(Buffer.alloc(32,9).toString('base64url')));}return result;};
 try{assert.throws(()=>initialize(dir,options),{code:'authority_changed'});}finally{fs.fsyncSync=sync;}
 assert.equal(changed,true);assert.throws(()=>initialize(dir,options),{code:'authority_already_exists'});
});
test('independent initializers reserve exactly one schema-4 store', {...posix,timeout:15000},async t=>{
 const dir=fixture(t),module=new URL('../lib/pairing-authority.mjs',import.meta.url).href,script=`import{initializeFreshContinuationProvenanceAuthority as init}from ${JSON.stringify(module)};process.send('ready');process.once('message',()=>{try{init(process.argv[1],${JSON.stringify(options)});process.send('ok');}catch(e){process.send(e.code);}process.disconnect();});`;
 const children=[0,1].map(()=>{const child=spawn(process.execPath,['--input-type=module','-e',script,dir],{stdio:['ignore','ignore','ignore','ipc']});t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});const ready=new Promise((r,j)=>{child.once('message',r);child.once('error',j);}),done=new Promise((r,j)=>child.once('exit',code=>code===0?r():j(Error('child failed'))));return{child,ready,done};});
 await Promise.all(children.map(c=>c.ready));const values=Promise.all(children.map(c=>new Promise(r=>c.child.once('message',r))));children.forEach(c=>c.child.send('start'));const results=await values;await Promise.all(children.map(c=>c.done));assert.equal(results.filter(r=>r==='ok').length,1);assert.ok(['authority_already_exists','authority_unavailable','authority_changed'].includes(results.find(r=>r!=='ok')));assert.equal(inspect(dir,options).schema,4);
});
test('database replacement after exclusive reservation refuses before schema writes',posix,t=>{
 const dir=fixture(t),target=file(dir),retained=target+'.retained',open=fs.openSync;let replaced=false;
 fs.openSync=function(name,...args){const fd=open.call(fs,name,...args);if(name===target&&typeof args[0]==='number'&&(args[0]&fs.constants.O_EXCL)){replaced=true;fs.renameSync(target,retained);fs.writeFileSync(target,'',{flag:'wx',mode:0o600});}return fd;};
 try{assert.throws(()=>initialize(dir,options),{code:'authority_changed'});}finally{fs.openSync=open;}
 assert.equal(replaced,true);for(const name of [target,retained])assert.equal(fs.statSync(name).size,0);assert.equal(fs.existsSync(path.join(dir,'pairing-authority.json')),false);
});
test('fresh read rollback faults do not return successful diagnostic status',posix,t=>{
 for(const when of ['before','after']){
  const dir=fixture(t);initialize(dir,options);const before=bytes(dir),exec=DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec=function(sql,...args){if(sql==='ROLLBACK'&&when==='before')throw Error('synthetic rollback');const result=exec.call(this,sql,...args);if(sql==='ROLLBACK'&&when==='after')throw Error('synthetic rolled-back return');return result;};
  try{assert.throws(()=>inspect(dir,options),{code:'authority_unavailable'});}finally{DatabaseSync.prototype.exec=exec;}
  assert.deepEqual(bytes(dir),before);assert.equal(inspect(dir,options).schema,4);
 }
});
