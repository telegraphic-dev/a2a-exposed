import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,createHmac,generateKeyPairSync} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {planContinuationSignerChange} from '../lib/continuation-enrollment-plan.mjs';
import {initializeFreshContinuationProvenanceAuthority as initialize,inspectFreshContinuationProvenanceAuthority as inspect,retainInitialContinuationSignerPlan as retain,readInitialContinuationSignerPlan as read,readRetainedInitialContinuationSignerPlan as original,initializePairingAuthority,initializeContinuationAuthority} from '../lib/pairing-authority.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const options={configIdentity:id(1)},posix={skip:process.platform==='win32'};
function candidate(){const der=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'});return{public_key_spki:der.toString('base64url'),fingerprint:createHash('sha256').update(der).digest('base64url')};}
const input=()=>({...options,id:id(2),candidate:candidate(),now:1000,expiresMs:2000});
function fixture(t,init=initialize){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'a2a-enrollment-physical-')));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.writeFileSync(path.join(root,'config.env'),'TOKEN=synthetic-token\n',{mode:0o600});init(root,options);return root;}
const file=root=>path.join(root,'pairing-authority.sqlite');
function raw(root,fn){const db=new DatabaseSync(file(root));try{return fn(db);}finally{db.close();}}
const bytes=root=>fs.readFileSync(file(root));
function onEOF(file,fn,action){const ino=fs.statSync(file).ino,readSync=fs.readSync;let hit=false;fs.readSync=function(fd,...args){const n=readSync.call(fs,fd,...args);if(n===0&&!hit&&fs.fstatSync(fd).ino===ino){hit=true;fn();}return n;};try{return action();}finally{fs.readSync=readSync;assert.equal(hit,true);}}
const readInput=p=>({configIdentity:p.configIdentity,id:p.id,now:p.now});

const originalInput=p=>({configIdentity:p.configIdentity,id:p.id});
function unguard(db){const triggers=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='continuation_enrollment_plans'").all();for(const {name}of triggers)db.exec(`DROP TRIGGER ${name}`);return()=>{for(const {sql}of triggers)db.exec(sql);};}

test('anchored original-ID read preserves exact expired plan and freezes every nested record',posix,t=>{
 const root=fixture(t),p=input(),plan=retain(root,p),before=bytes(root);
 assert.throws(()=>read(root,{...readInput(p),now:p.expiresMs}));
 const result=original(root,originalInput(p));assert.deepEqual(result,plan);
 assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.authority)&&Object.isFrozen(result.candidate));
 assert.throws(()=>{result.candidate.fingerprint='changed';},TypeError);
 assert.throws(()=>{result.authority.revision=1;},TypeError);
 assert.throws(()=>{result.expires_ms=9999;},TypeError);
 assert.deepEqual(bytes(root),before);assert.equal(result.expires_ms,p.expiresMs);
 raw(root,db=>{const r=db.prepare('SELECT * FROM authority').get();assert.equal(r.revision,0);assert.equal(r.current_signer_id,null);assert.equal(r.suspended,1);});
 assert.throws(()=>inspect(root,options),{code:'authority_fresh_required'});
});
test('exact read has no clock dependency and never selects a newer sibling',posix,t=>{
 const root=fixture(t),p=input(),first=retain(root,p),second=retain(root,{...p,id:id(3),now:2000,expiresMs:3000,candidate:candidate()});
 assert.deepEqual(original(root,originalInput(p)),first);
 assert.deepEqual(original(root,{...originalInput(p),id:id(3)}),second);
 const before=bytes(root);for(const value of [undefined,null,{},'bad',id(2)+'\0',id(99)])assert.throws(()=>original(root,{configIdentity:p.configIdentity,id:value}));assert.deepEqual(bytes(root),before);
});
test('unknown commit outcomes reconcile by original ID after process restart and expiry',posix,t=>{
 for(const when of ['before','after']){
  const root=fixture(t),p=input(),exec=DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec=function(sql,...args){if(sql==='COMMIT'&&when==='before')throw Error('synthetic before');const result=exec.call(this,sql,...args);if(sql==='COMMIT'&&when==='after')throw Error('synthetic after');return result;};
  try{assert.throws(()=>retain(root,p));}finally{DatabaseSync.prototype.exec=exec;}
  const before=bytes(root),module=new URL('../lib/pairing-authority.mjs',import.meta.url).href;
  const script=`import{readRetainedInitialContinuationSignerPlan as original,readInitialContinuationSignerPlan as fresh}from ${JSON.stringify(module)};const options=${JSON.stringify(originalInput(p))};try{const plan=original(process.argv[1],options);let expired=false;try{fresh(process.argv[1],{...options,now:plan.expires_ms})}catch{expired=true}console.log(JSON.stringify({id:plan.id,expires:plan.expires_ms,expired}));}catch(e){console.log(JSON.stringify({code:e.code}));}`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script,root],{encoding:'utf8',timeout:10000,env:{DO_NOT_TRACK:'1'}});assert.equal(child.status,0,child.stderr);
  const result=JSON.parse(child.stdout);if(when==='after')assert.deepEqual(result,{id:p.id,expires:p.expiresMs,expired:true});else assert.equal(result.code,'authority_unavailable');
  assert.deepEqual(bytes(root),before);
 }
});
test('source drift, wrong configuration and legacy schemas refuse original reads unchanged',posix,t=>{
 for(const init of [initializePairingAuthority,initializeContinuationAuthority]){const root=fixture(t,init),before=bytes(root);assert.throws(()=>original(root,originalInput(input())),{code:'authority_schema'});assert.deepEqual(bytes(root),before);}
 const root=fixture(t),p=input();retain(root,p);let before=bytes(root);
 assert.throws(()=>original(root,{...originalInput(p),configIdentity:id(99)}));assert.deepEqual(bytes(root),before);
 fs.appendFileSync(path.join(root,'config.env'),'# drift\n');before=bytes(root);assert.throws(()=>original(root,originalInput(p)),{code:'authority_external_change'});assert.deepEqual(bytes(root),before);
});
test('authenticated but foreign original plan binding cannot authenticate this authority',posix,t=>{
 for(const patch of [{epoch:id(99)},{revision:1},{canonical_root:'/synthetic/foreign'},{config_identity:id(99)}]){
  const root=fixture(t),p=input(),plan=retain(root,p);
  raw(root,db=>{
   const {version,plan_digest,...input}=plan,other=planContinuationSignerChange({...input,authority:{...plan.authority,...patch}}),record=JSON.stringify(other),key=Buffer.from(db.prepare('SELECT recovery_key FROM authority').get().recovery_key,'base64url');
   const mac=createHmac('sha256',key).update('a2a-exposed continuation enrollment storage v1\n'+record).digest('base64url');const restore=unguard(db);
   db.prepare('UPDATE continuation_enrollment_plans SET config_identity=?,canonical_root=?,epoch=?,baseline_revision=?,record=?,storage_mac=?').run(other.authority.config_identity,other.authority.canonical_root,other.authority.epoch,other.authority.revision,record,mac);restore();
  });
  const before=bytes(root);assert.throws(()=>original(root,originalInput(p)));assert.deepEqual(bytes(root),before);
 }
});
test('selected record corruption refuses without leaking roots, keys or protected sources',posix,t=>{
 for(const column of ['storage_mac','record','epoch']){
  const root=fixture(t),p=input();retain(root,p);raw(root,db=>{const restore=unguard(db);db.prepare(`UPDATE continuation_enrollment_plans SET ${column}=?`).run({storage_mac:Buffer.alloc(32).toString('base64url'),record:'{}',epoch:id(99)}[column]);restore();});
  const before=bytes(root);assert.throws(()=>original(root,originalInput(p)),error=>error.code==='authority_unavailable'&&![root,p.candidate.public_key_spki,'synthetic-token'].some(value=>JSON.stringify(error).includes(value)));assert.deepEqual(bytes(root),before);
 }
});
test('exact read does not claim to authenticate an unrelated sibling plan',posix,t=>{
 const root=fixture(t),p=input(),first=retain(root,p);retain(root,{...p,id:id(3)});
 raw(root,db=>{const restore=unguard(db);db.prepare('UPDATE continuation_enrollment_plans SET storage_mac=? WHERE id=?').run(Buffer.alloc(32).toString('base64url'),id(3));restore();});
 const before=bytes(root);assert.deepEqual(original(root,originalInput(p)),first);assert.throws(()=>original(root,{...originalInput(p),id:id(3)}));assert.deepEqual(bytes(root),before);
});
test('advanced authority or nonempty signer state refuses even authentic original records',posix,t=>{
 for(const change of ['revision','signer']){
  const root=fixture(t),p=input();retain(root,p);
  raw(root,db=>{if(change==='revision')db.exec('UPDATE authority SET revision=1');else{const c=candidate();db.prepare('INSERT INTO continuation_signer_enrollments VALUES(?,?,?,?,?,?)').run(id(4),options.configIdentity,root,id(5),c.public_key_spki,c.fingerprint);}});
  const before=bytes(root);assert.throws(()=>original(root,originalInput(p)),{code:'authority_fresh_required'});assert.deepEqual(bytes(root),before);
 }
});
test('namespace replacement during source check refuses a retained original read',posix,t=>{
 const root=fixture(t),p=input();retain(root,p);const marker=path.join(root,'pairing-authority.json'),before=bytes(root);
 onEOF(path.join(root,'config.env'),()=>{fs.renameSync(marker,marker+'.retained');fs.copyFileSync(marker+'.retained',marker);},()=>assert.throws(()=>original(root,originalInput(p)),{code:'authority_changed'}));assert.deepEqual(bytes(root),before);
});
test('source change after selected lookup refuses before returning private plan bytes',posix,t=>{
 const root=fixture(t),p=input();retain(root,p);const before=bytes(root),prepare=DatabaseSync.prototype.prepare;let hit=false;
 DatabaseSync.prototype.prepare=function(sql,...args){const statement=prepare.call(this,sql,...args);if(sql.startsWith('SELECT *,CAST(record AS BLOB)')){const get=statement.get.bind(statement);statement.get=(...values)=>{const result=get(...values);hit=true;fs.appendFileSync(path.join(root,'config.env'),'# changed\n');return result;};}return statement;};
 try{assert.throws(()=>original(root,originalInput(p)),{code:'authority_external_change'});}finally{DatabaseSync.prototype.prepare=prepare;}assert.equal(hit,true);assert.deepEqual(bytes(root),before);
});
test('rollback faults and post-rollback namespace replacement never return a plan',posix,t=>{
 for(const phase of ['before','after','namespace']){
  const root=fixture(t),p=input();retain(root,p);const before=bytes(root),exec=DatabaseSync.prototype.exec,marker=path.join(root,'pairing-authority.json');let hit=false;
  DatabaseSync.prototype.exec=function(sql,...args){if(sql==='ROLLBACK'&&!hit){hit=true;if(phase==='before')throw Error('synthetic rollback');const result=exec.call(this,sql,...args);if(phase==='after')throw Error('synthetic return');fs.renameSync(marker,marker+'.retained');fs.copyFileSync(marker+'.retained',marker);return result;}return exec.call(this,sql,...args);};
  try{assert.throws(()=>original(root,originalInput(p)),{code:phase==='namespace'?'authority_changed':'authority_unavailable'});}finally{DatabaseSync.prototype.exec=exec;}assert.equal(hit,true);assert.deepEqual(bytes(root),before);
 }
});
