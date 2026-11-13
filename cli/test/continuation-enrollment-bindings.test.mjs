import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {planContinuationSignerChange,snapshotContinuationSignerBinding} from '../lib/continuation-enrollment-plan.mjs';
import {createContinuationEnrollmentStorage} from '../lib/continuation-enrollment-storage.mjs';
import {installContinuationProvenanceTables} from '../lib/continuation-provenance-tables.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function candidate(){const der=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'});return{public_key_spki:der.toString('base64url'),fingerprint:createHash('sha256').update(der).digest('base64url')};}
function fixture(t,file=':memory:'){
 const db=new DatabaseSync(file);t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE');installContinuationProvenanceTables(db);db.exec('COMMIT; BEGIN IMMEDIATE');
 const authority={config_identity:id(1),canonical_root:'/synthetic/private',epoch:id(2),revision:0,suspended:true,active_set_id:null,pending_intent_id:null},store=createContinuationEnrollmentStorage(Buffer.alloc(32,1));
 function retain(n,a=authority,s=null,operation='initial',created=1000){const plan=planContinuationSignerChange({id:id(n),operation,authority:a,current_signer:s,candidate:operation==='remove'?null:candidate(),created_ms:created,expires_ms:created+1000});store.retain(db,plan,a,s,created);return plan;}
 return{db,authority,store,retain};
}
const diagnose=(f,a=f.authority,s=null,now=1500)=>f.store.diagnoseBindings(f.db,a,s,now);
function signer(f,a,n=9){const s={version:1,id:id(n),config_identity:a.config_identity,canonical_root:a.canonical_root,epoch:a.epoch,...candidate()}, {version,...row}=s,keys=Object.keys(row);f.db.prepare(`INSERT INTO continuation_signer_enrollments(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));return s;}

test('mixed original bindings retain all identities and classify separately from time',t=>{
 const f=fixture(t),first=f.retain(4),a={...f.authority,epoch:id(8),revision:1},s=signer(f,a);
 f.retain(7,a,s,'replace');f.retain(6,a,s,'remove');
 const result=diagnose(f,a,s,2000);
 assert.deepEqual(result.map(p=>[p.id,p.operation,p.epoch,p.currentSignerId,p.bindingMatches,p.status]),[[id(4),'initial',id(2),null,false,'expired'],[id(6),'remove',id(8),id(9),true,'expired'],[id(7),'replace',id(8),id(9),true,'expired']]);
 assert.deepEqual(diagnose(f).map(p=>p.bindingMatches),[true,false,false]);
 assert.deepEqual(f.store.diagnoseRetained(f.db,2000),result.map(({bindingMatches,...p})=>p));
 assert.ok(Object.isFrozen(result)&&result.every(Object.isFrozen));
 const output=JSON.stringify(result);for(const secret of [a.canonical_root,s.public_key_spki,first.candidate.public_key_spki,'storage_mac','applicable','approved'])assert.ok(!output.includes(secret));
 assert.throws(()=>f.store.read(f.db,id(4),a,s,1500),{code:'continuation_enrollment_plan_stale'});
 assert.throws(()=>f.store.read(f.db,id(6),a,s,2000),{code:'continuation_enrollment_plan_expired'});
});
test('every authority field and full signer bytes participate in equality',t=>{
 const f=fixture(t);f.retain(4);
 for(const patch of [{config_identity:id(20)},{canonical_root:'/synthetic/other'},{epoch:id(20)},{revision:1},{suspended:false,active_set_id:id(20)}])assert.equal(diagnose(f,{...f.authority,...patch})[0].bindingMatches,false);
 const a={...f.authority,revision:1},s=signer(f,a);f.retain(5,a,s,'replace');
 for(const patch of [{id:id(20)},candidate()])assert.equal(diagnose(f,a,{...s,...patch})[1].bindingMatches,false);
 assert.equal(diagnose(f,a,null)[1].bindingMatches,false);
});
test('fresh, expired and future time metadata never establish applicability',t=>{
 const f=fixture(t);f.retain(4);
 for(const [now,status] of [[999,'not-yet-valid'],[1000,'fresh'],[1999,'fresh'],[2000,'expired'],[Number.MAX_SAFE_INTEGER,'expired']])assert.deepEqual([diagnose(f,f.authority,null,now)[0].bindingMatches,diagnose(f,f.authority,null,now)[0].status],[true,status]);
 for(const now of [undefined,null,-1,NaN,Infinity,1.5,'1000'])assert.throws(()=>f.store.diagnoseBindings(f.db,f.authority,null,now));
});
test('invalid binding refuses even an empty inventory without executing accessors',t=>{
 const f=fixture(t);
 for(const a of [null,{...f.authority,revision:-1},{...f.authority,pending_intent_id:id(20)},{...f.authority,extra:true},{...f.authority,canonical_root:'/bad/../root'}])assert.throws(()=>diagnose(f,a));
 let calls=0;const a={...f.authority};Object.defineProperty(a,'revision',{enumerable:true,get(){calls++;return 0;}});assert.throws(()=>diagnose(f,a));assert.equal(calls,0);
 assert.throws(()=>diagnose(f,f.authority,{}));assert.deepEqual(diagnose(f),[]);
 f.db.exec('ROLLBACK');assert.throws(()=>diagnose(f),{code:'continuation_enrollment_transaction_required'});
 f.db.exec('PRAGMA foreign_keys=OFF; BEGIN');assert.throws(()=>diagnose(f),{code:'continuation_enrollment_foreign_keys_required'});
});
test('binding snapshot is detached, immutable and canonical across field ordering',t=>{
 const f=fixture(t),s=signer(f,f.authority),a={...f.authority};
 const snapshot=snapshotContinuationSignerBinding(a,s);assert.ok(Object.isFrozen(snapshot)&&Object.isFrozen(snapshot.authority)&&Object.isFrozen(snapshot.current_signer));
 const original=JSON.stringify(snapshot);a.revision=9;s.fingerprint='changed';assert.equal(JSON.stringify(snapshot),original);
 const reordered=Object.fromEntries(Object.entries(f.authority).reverse());f.retain(4);assert.equal(diagnose(f,reordered)[0].bindingMatches,true);
});
test('caller mutation during SQL reads cannot change the comparison snapshot',t=>{
 const f=fixture(t);f.retain(4);const a={...f.authority},prepare=DatabaseSync.prototype.prepare;let hit=false;
 DatabaseSync.prototype.prepare=function(sql,...args){if(sql==='SELECT id FROM continuation_enrollment_plans ORDER BY id COLLATE BINARY'){a.revision=99;hit=true;}return prepare.call(this,sql,...args);};
 try{assert.equal(diagnose(f,a)[0].bindingMatches,true);}finally{DatabaseSync.prototype.prepare=prepare;}assert.equal(hit,true);assert.equal(diagnose(f,a)[0].bindingMatches,false);
});
test('one corrupt original row refuses the entire mixed result, including nonmatching rows',t=>{
 for(const change of ['mac','epoch','signer']){
  const f=fixture(t);f.retain(4);const a={...f.authority,epoch:id(8),revision:1},s=signer(f,a);f.retain(5,a,s,'replace');
  for(const {name}of f.db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name IN ('continuation_enrollment_plans','continuation_signer_enrollments')").all())f.db.exec(`DROP TRIGGER ${name}`);
  if(change==='mac')f.db.prepare('UPDATE continuation_enrollment_plans SET storage_mac=? WHERE id=?').run(Buffer.alloc(32,2).toString('base64url'),id(5));
  if(change==='epoch')f.db.prepare('UPDATE continuation_enrollment_plans SET epoch=? WHERE id=?').run(id(20),id(5));
  if(change==='signer'){const c=candidate();f.db.prepare('UPDATE continuation_signer_enrollments SET public_key_spki=?,fingerprint=?').run(c.public_key_spki,c.fingerprint);}
  const before=f.db.prepare('SELECT * FROM continuation_enrollment_plans').all();assert.throws(()=>diagnose(f));assert.deepEqual(f.db.prepare('SELECT * FROM continuation_enrollment_plans').all(),before);
 }
});
test('read-only restart classification preserves all physical store bytes',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-binding-diagnosis-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'state.sqlite'),f=fixture(t,file);f.retain(4);f.db.exec('COMMIT; BEGIN');
 const expected=diagnose(f),before=fs.readFileSync(file),module=new URL('../lib/continuation-enrollment-storage.mjs',import.meta.url).href;
 const script=`import{DatabaseSync}from'node:sqlite';import{createContinuationEnrollmentStorage}from${JSON.stringify(module)};const d=new DatabaseSync(process.argv[1],{readOnly:true});d.exec('PRAGMA foreign_keys=ON; BEGIN');console.log(JSON.stringify(createContinuationEnrollmentStorage(Buffer.alloc(32,1)).diagnoseBindings(d,JSON.parse(process.argv[2]),null,1500)));d.exec('ROLLBACK');d.close();`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script,file,JSON.stringify(f.authority)],{encoding:'utf8',timeout:10000,env:{DO_NOT_TRACK:'1'}});assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),expected);assert.deepEqual(fs.readFileSync(file),before);
});
