import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,createHmac,generateKeyPairSync} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {planContinuationSignerChange} from '../lib/continuation-enrollment-plan.mjs';
import {createContinuationEnrollmentStorage} from '../lib/continuation-enrollment-storage.mjs';
import {installContinuationProvenanceTables as install} from '../lib/continuation-provenance-tables.mjs';

// Synthetic state only; no actual enrollment, custody or human ceremony.
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const key=()=>Buffer.alloc(32,1);
const clone=value=>JSON.parse(JSON.stringify(value));
function publicKey(){const der=generateKeyPairSync('ed25519').publicKey.export({format:'der',type:'spki'});return{public_key_spki:der.toString('base64url'),fingerprint:createHash('sha256').update(der).digest('base64url')};}
function fixture(t,operation='initial',file=':memory:',root='/synthetic/private'){
 const db=new DatabaseSync(file);t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');install(db);db.exec('COMMIT; BEGIN IMMEDIATE');
 const authority={config_identity:id(1),canonical_root:root,epoch:id(2),revision:0,suspended:true,active_set_id:null,pending_intent_id:null};
 const signer=operation==='initial'?null:{version:1,id:id(3),config_identity:id(1),canonical_root:authority.canonical_root,epoch:id(2),...publicKey()};
 if(signer){const {version,...row}=signer,keys=Object.keys(row);db.prepare(`INSERT INTO continuation_signer_enrollments(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));}
 const plan=planContinuationSignerChange({id:id(4),operation,authority,current_signer:signer,candidate:operation==='remove'?null:publicKey(),created_ms:1000,expires_ms:2000});
 return{db,authority,signer,plan,store:createContinuationEnrollmentStorage(key())};
}
const retain=f=>f.store.retain(f.db,f.plan,f.authority,f.signer,1000);
const read=(f,now=1000)=>f.store.read(f.db,f.plan.id,f.authority,f.signer,now);
const count=f=>f.db.prepare('SELECT COUNT(*) n FROM continuation_enrollment_plans').get().n;
const refuses=fn=>assert.throws(fn,e=>e?.code?.startsWith('continuation_'));
function unguard(db){for(const {name}of db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='continuation_enrollment_plans'").all())db.exec(`DROP TRIGGER ${name}`);}

for(const operation of ['initial','replace','remove'])test('retains exact '+operation+' plan without changing signer or authority',t=>{
 const f=fixture(t,operation),before=f.db.prepare('SELECT * FROM continuation_signer_enrollments').all();
 assert.deepEqual(retain(f),f.plan);f.db.exec('COMMIT; BEGIN IMMEDIATE');assert.deepEqual(read(f),f.plan);
 assert.deepEqual(f.db.prepare('SELECT * FROM continuation_signer_enrollments').all(),before);
 assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,0);
 for(const table of ['authority','grant_sets','continuation_intents','continuation_decision_receipts']){
  if(table==='authority')assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='authority'").get().n,0);
  else assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
 }
 assert.equal(f.db.isTransaction,true);
});
test('private key snapshot authenticates retention after caller buffer mutation and across instances',t=>{
 const f=fixture(t),bytes=key();f.store=createContinuationEnrollmentStorage(bytes);bytes.fill(2);retain(f);
 f.store=createContinuationEnrollmentStorage(key());assert.deepEqual(read(f),f.plan);
 f.store=createContinuationEnrollmentStorage(bytes);assert.throws(()=>read(f),{code:'continuation_enrollment_storage_mac_mismatch'});
 for(const value of [null,'secret',Buffer.alloc(31),Buffer.alloc(33),{length:32},new Uint8Array(31)])refuses(()=>createContinuationEnrollmentStorage(value));
});
test('missing transaction, foreign keys, identity or plan refuse promptly',t=>{
 const f=fixture(t);for(const value of ['bad',id(99)])refuses(()=>f.store.read(f.db,value,f.authority,f.signer,1000));
 f.db.exec('ROLLBACK');for(const action of [()=>retain(f),()=>read(f)])assert.throws(action,{code:'continuation_enrollment_transaction_required'});
 f.db.exec('PRAGMA foreign_keys=OFF; BEGIN');for(const action of [()=>retain(f),()=>read(f)])assert.throws(action,{code:'continuation_enrollment_foreign_keys_required'});
});
test('stale state, altered candidates and invalid clocks refuse reads and retention',t=>{
 const f=fixture(t);retain(f);
 for(const patch of [{revision:1},{epoch:id(99)},{config_identity:id(99)},{canonical_root:'/synthetic/other'},{pending_intent_id:id(99)},{suspended:false,active_set_id:id(99)}]){
  const authority={...f.authority,...patch};refuses(()=>f.store.read(f.db,f.plan.id,authority,f.signer,1000));refuses(()=>f.store.retain(f.db,f.plan,authority,f.signer,1000));
 }
 for(const now of [999,2000,NaN,-1,1000.5]){refuses(()=>read(f,now));refuses(()=>f.store.retain(f.db,f.plan,f.authority,f.signer,now));}
 assert.deepEqual(read(f,1999),f.plan);const changed={...f.plan,candidate:publicKey()};refuses(()=>f.store.retain(f.db,changed,f.authority,f.signer,1000));assert.equal(count(f),1);
});
test('noninitial plans require exact retained current signer bytes and identity',t=>{
 const f=fixture(t,'replace');retain(f);
 refuses(()=>f.store.read(f.db,f.plan.id,f.authority,{...f.signer,id:id(99)},1000));
 for(const {name}of f.db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='continuation_signer_enrollments'").all())f.db.exec(`DROP TRIGGER ${name}`);
 f.db.prepare('UPDATE continuation_signer_enrollments SET public_key_spki=?').run(publicKey().public_key_spki);
 assert.throws(()=>read(f),{code:'continuation_enrollment_row_mismatch'});const next={...f.plan,id:id(99)};refuses(()=>f.store.retain(f.db,next,f.authority,f.signer,1000));assert.equal(count(f),1);
});
test('retained identity cannot be updated, deleted or replaced',t=>{
 const f=fixture(t);retain(f);const row=f.db.prepare('SELECT * FROM continuation_enrollment_plans').get(),keys=Object.keys(row);
 assert.throws(()=>retain(f));assert.throws(()=>f.db.exec('UPDATE continuation_enrollment_plans SET expires_ms=expires_ms+1'));assert.throws(()=>f.db.exec('DELETE FROM continuation_enrollment_plans'));
 assert.throws(()=>f.db.prepare(`INSERT OR REPLACE INTO continuation_enrollment_plans(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row)));
 assert.equal(count(f),1);assert.deepEqual(read(f),f.plan);
});
for(const column of ['record','storage_mac','epoch','baseline_revision','operation','expires_ms'])test('authenticated read refuses bypassed '+column+' tampering',t=>{
 const f=fixture(t);retain(f);unguard(f.db);
 const value={record:JSON.stringify({...f.plan,candidate:publicKey()}),storage_mac:Buffer.alloc(32,9).toString('base64url'),epoch:id(99),baseline_revision:1,operation:'remove',expires_ms:2001}[column];
 f.db.exec('PRAGMA ignore_check_constraints=ON');f.db.prepare(`UPDATE continuation_enrollment_plans SET ${column}=?`).run(value);refuses(()=>read(f));
});
test('even correctly MACed noncanonical JSON or duplicate fields refuse exact row validation',t=>{
 const f=fixture(t);retain(f);unguard(f.db);const original=JSON.stringify(f.plan);
 for(const record of [' '+original,original.replace('"version":1','"version":1,"version":1')]){
  const mac=createHmac('sha256',key()).update('a2a-exposed continuation enrollment storage v1\n'+record).digest('base64url');
  f.db.prepare('UPDATE continuation_enrollment_plans SET record=?,storage_mac=?').run(record,mac);assert.throws(()=>read(f),{code:'continuation_enrollment_row_mismatch'});
 }
});
test('strict descriptors reject getters and hidden fields without invoking them',t=>{
 const f=fixture(t);let gets=0;const plan={...f.plan};Object.defineProperty(plan,'candidate',{enumerable:true,get(){gets++;return f.plan.candidate;}});
 refuses(()=>f.store.retain(f.db,plan,f.authority,f.signer,1000));assert.equal(gets,0);
 const hidden=clone(f.plan);Object.defineProperty(hidden,'unknown',{value:true});refuses(()=>f.store.retain(f.db,hidden,f.authority,f.signer,1000));assert.equal(count(f),0);
});
test('insert/read failures roll back only the retention savepoint and preserve caller work',t=>{
 for(const phase of ['insert','read']){
  const f=fixture(t);f.db.exec("CREATE TABLE caller_work(value TEXT); INSERT INTO caller_work VALUES('keep')");let wrote=false;
  const db={get isTransaction(){return f.db.isTransaction;},exec:q=>f.db.exec(q),prepare(q){
   if(q.startsWith('INSERT INTO continuation_enrollment_plans')){if(phase==='insert')throw Error('synthetic insert fault');wrote=true;}
   if(wrote&&q.startsWith('SELECT *,CAST(record AS BLOB)'))throw Error('synthetic read fault');return f.db.prepare(q);
  }};
  assert.throws(()=>f.store.retain(db,f.plan,f.authority,f.signer,1000),/synthetic .* fault/);assert.equal(count(f),0);assert.equal(f.db.isTransaction,true);assert.equal(f.db.prepare('SELECT value FROM caller_work').get().value,'keep');retain(f);
 }
});
test('independent process cannot see uncommitted plan; authenticated read survives restart only after commit',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-enrollment-plan-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'state.sqlite'),f=fixture(t,'initial',file);f.db.exec('COMMIT; BEGIN IMMEDIATE');retain(f);
 const script=`import{DatabaseSync}from'node:sqlite';import{createContinuationEnrollmentStorage}from${JSON.stringify(new URL('../lib/continuation-enrollment-storage.mjs',import.meta.url).href)};const d=new DatabaseSync(process.argv[1]);d.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10');let locked=false;try{d.exec('BEGIN IMMEDIATE')}catch(e){locked=/locked|busy/.test(e.message)};if(!d.isTransaction)d.exec('BEGIN');const n=d.prepare('SELECT COUNT(*) n FROM continuation_enrollment_plans').get().n;const plan=n?createContinuationEnrollmentStorage(Buffer.alloc(32,1)).read(d,process.argv[2],JSON.parse(process.argv[3]),null,1000):null;console.log(JSON.stringify({locked,n,plan}));d.close();`;
 const run=()=>{const r=spawnSync(process.execPath,['--input-type=module','-e',script,file,f.plan.id,JSON.stringify(f.authority)],{encoding:'utf8',timeout:10000,env:{DO_NOT_TRACK:'1'}});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
 assert.deepEqual(run(),{locked:true,n:0,plan:null});f.db.exec('COMMIT');assert.deepEqual(run(),{locked:false,n:1,plan:f.plan});
 f.db.exec('BEGIN IMMEDIATE');assert.deepEqual(read(f),f.plan);
});
test('SQL rejects invalid operation, absent replacement signer and unsafe scalars independently',t=>{
 const f=fixture(t);retain(f);const row=f.db.prepare('SELECT * FROM continuation_enrollment_plans').get();
 for(const patch of [{id:'invalid'},{id:id(99)+'\0'},{operation:'unknown'},{operation:'replace'},{current_signer_id:id(99)},{baseline_revision:-1},{baseline_revision:9007199254740991},{created_ms:0.5},{expires_ms:1000},{expires_ms:601001},{storage_mac:'A'.repeat(42)+'B'},{canonical_root:'/synthetic\0suffix'},{record:''}]){
  const changed={...row,id:id(99),...patch},keys=Object.keys(changed);assert.throws(()=>f.db.prepare(`INSERT INTO continuation_enrollment_plans(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(changed)));
 }
 assert.equal(count(f),1);
});
test('outer rollback removes retained planning bytes without replacing the original identity',t=>{
 const f=fixture(t);retain(f);f.db.exec('ROLLBACK; BEGIN IMMEDIATE');assert.equal(count(f),0);assert.throws(()=>read(f),{code:'continuation_enrollment_plan_missing'});
 retain(f);assert.deepEqual(read(f),f.plan);
});
for(const column of ['record','canonical_root'])test('invalid UTF-8 in retained '+column+' cannot masquerade as a valid replacement character',t=>{
 const f=fixture(t);f.authority.canonical_root='/synthetic/\uFFFD';
 f.plan=planContinuationSignerChange({id:id(4),operation:'initial',authority:f.authority,current_signer:null,candidate:publicKey(),created_ms:1000,expires_ms:2000});retain(f);unguard(f.db);
 const original=Buffer.from(f.db.prepare(`SELECT ${column} value FROM continuation_enrollment_plans`).get().value);
 const at=original.indexOf(Buffer.from('\uFFFD'));assert.ok(at>=0);
 const invalid=Buffer.concat([original.subarray(0,at),Buffer.from([255]),original.subarray(at+3)]);
 f.db.prepare(`UPDATE continuation_enrollment_plans SET ${column}=CAST(? AS TEXT)`).run(invalid);
 refuses(()=>read(f));
});
test('invalid UTF-8 in retained current enrollment refuses even when decoded text matches',t=>{
 const f=fixture(t,'replace',':memory:','/synthetic/\uFFFD');retain(f);
 for(const {name}of f.db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='continuation_signer_enrollments'").all())f.db.exec(`DROP TRIGGER ${name}`);
 const bytes=Buffer.from(f.signer.canonical_root),at=bytes.indexOf(Buffer.from('\uFFFD'));
 f.db.prepare('UPDATE continuation_signer_enrollments SET canonical_root=CAST(? AS TEXT)').run(Buffer.concat([bytes.subarray(0,at),Buffer.from([255]),bytes.subarray(at+3)]));
 refuses(()=>read(f));
});
test('a fresh plan identity cannot replace retained history through an explicit rowid collision',t=>{
 const f=fixture(t);retain(f);assert.equal(f.db.prepare('PRAGMA recursive_triggers').get().recursive_triggers,0);
 const stored=f.db.prepare('SELECT * FROM continuation_enrollment_plans').get(),keys=Object.keys(stored),values={...stored,id:id(99)};
 assert.throws(()=>f.db.prepare(`INSERT OR REPLACE INTO continuation_enrollment_plans(rowid,${keys.join(',')}) VALUES(1,${keys.map(()=>'?').join(',')})`).run(...Object.values(values)));
 assert.equal(count(f),1);assert.deepEqual(read(f),f.plan);
});
