import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {installContinuationProvenanceTables as install} from '../lib/continuation-provenance-tables.mjs';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const digest=n=>Buffer.alloc(32,n).toString('base64url');
function insert(db,table,row,verb='INSERT'){
 const keys=Object.keys(row);db.prepare(`${verb} INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));
}
function fixture(t,file=':memory:'){
 const db=new DatabaseSync(file);t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');install(db);
 const der=generateKeyPairSync('ed25519').publicKey.export({format:'der',type:'spki'});
 const enrollment={id:id(1),config_identity:id(2),canonical_root:'/synthetic/private',epoch:id(3),public_key_spki:der.toString('base64url'),fingerprint:createHash('sha256').update(der).digest('base64url')};
 const intent={id:id(4),epoch:id(3),baseline_revision:0,target_revision:1,set_id:id(5),plan_mac:digest(1),intent_mac:digest(2),state:'prepared',record:'{}'};
 const attestation={id:id(6),plan_mac:digest(1),epoch:id(3),created_ms:1000,expires_ms:2000,consumed_intent:null,attestation_mac:digest(3),record:'{}'};
 insert(db,'continuation_signer_enrollments',enrollment);insert(db,'continuation_attestations',attestation);insert(db,'continuation_intents',intent);
 db.prepare('UPDATE continuation_attestations SET consumed_intent=? WHERE id=?').run(intent.id,attestation.id);
 // Synthetic SQL-only fixture: '{}' and zero signature do NOT pass the receipt
 // codec. This suite verifies database constraints, never human provenance.
 const receipt={decision_id:id(7),enrollment_id:enrollment.id,signer_fingerprint:enrollment.fingerprint,intent_id:intent.id,config_identity:enrollment.config_identity,canonical_root:enrollment.canonical_root,epoch:intent.epoch,baseline_revision:0,target_revision:1,plan_mac:intent.plan_mac,set_id:intent.set_id,created_ms:1000,expires_ms:2000,attestation:'{}',signature:Buffer.alloc(64).toString('base64url')};
 return{db,enrollment,intent,receipt};
}
const count=(db,table)=>db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const write=f=>insert(f.db,'continuation_decision_receipts',f.receipt);

test('fresh-only installer adds retained provenance tables without authority or version adoption',t=>{
 const f=fixture(t);write(f);assert.equal(count(f.db,'continuation_decision_receipts'),1);
 assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='authority'").get().n,0);
 assert.equal(f.db.isTransaction,true);
});
test('old versions, existing/partial stores, missing transaction and foreign keys refuse without changes',t=>{
 for(const version of [0,1,2,3,4]){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(`PRAGMA foreign_keys=ON; PRAGMA user_version=${version}`);
  assert.throws(()=>install(db),{code:'continuation_provenance_transaction_required'});
  if(version===0)db.exec('CREATE TABLE existing(value TEXT)');
  db.exec('BEGIN');const before=db.prepare('SELECT sql FROM sqlite_schema').all();
  assert.throws(()=>install(db));assert.deepEqual(db.prepare('SELECT sql FROM sqlite_schema').all(),before);assert.equal(db.isTransaction,true);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,version);
 }
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('PRAGMA foreign_keys=OFF; BEGIN');assert.throws(()=>install(db),{code:'continuation_provenance_foreign_keys_required'});assert.equal(count(db,'sqlite_schema'),0);
});
test('installer failure after continuation tables rolls back its entire savepoint',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON; BEGIN');
 const wrapped={get isTransaction(){return db.isTransaction;},prepare:q=>db.prepare(q),exec(sql){if(sql.includes('CREATE TABLE continuation_signer_enrollments'))throw Error('synthetic install fault');return db.exec(sql);}};
 assert.throws(()=>install(wrapped),/synthetic install fault/);assert.equal(count(db,'sqlite_schema'),0);assert.equal(db.isTransaction,true);
 install(db);assert.equal(count(db,'continuation_signer_enrollments'),0);
});
test('enrollments and receipts cannot be overwritten, replaced or deleted',t=>{
 const f=fixture(t);write(f);
 for(const [table,row] of [['continuation_signer_enrollments',f.enrollment],['continuation_decision_receipts',f.receipt]]){
  assert.throws(()=>f.db.exec(`DELETE FROM ${table}`));assert.throws(()=>f.db.exec(`UPDATE ${table} SET epoch=epoch`));
  for(const verb of ['INSERT','INSERT OR REPLACE'])assert.throws(()=>insert(f.db,table,row,verb));assert.equal(count(f.db,table),1);
 }
});
test('composite foreign key binds exact enrollment identity, config, root, epoch and fingerprint',t=>{
 for(const patch of [{enrollment_id:id(90)},{config_identity:id(90)},{canonical_root:'/synthetic/other'},{epoch:id(90)},{signer_fingerprint:digest(90)}]){
  const f=fixture(t);assert.throws(()=>insert(f.db,'continuation_decision_receipts',{...f.receipt,...patch}));assert.equal(count(f.db,'continuation_decision_receipts'),0);
 }
});
test('receipt must bind exact prepared intent, attestation bytes and original validity',t=>{
 for(const patch of [{intent_id:id(90)},{baseline_revision:1,target_revision:2},{plan_mac:digest(90)},{set_id:id(90)},{created_ms:1001},{expires_ms:2001},{attestation:' {}'}]){
  const f=fixture(t);assert.throws(()=>insert(f.db,'continuation_decision_receipts',{...f.receipt,...patch}));assert.equal(count(f.db,'continuation_decision_receipts'),0);
 }
 const f=fixture(t);f.db.exec("UPDATE continuation_intents SET state='aborted'");assert.throws(()=>write(f));
});
test('single consumer and decision identifiers remain reserved for the retained history',t=>{
 const f=fixture(t);write(f);
 for(const patch of [{decision_id:id(90)},{decision_id:id(90),intent_id:id(91),set_id:id(92)},{intent_id:id(91),set_id:id(92)}]){
  for(const verb of ['INSERT','INSERT OR REPLACE'])assert.throws(()=>insert(f.db,'continuation_decision_receipts',{...f.receipt,...patch},verb));
 }
 assert.equal(count(f.db,'continuation_decision_receipts'),1);
});
test('SQL independently rejects malformed, alternate and unsafe scalar encodings',t=>{
 const f=fixture(t);
 for(const patch of [{id:'invalid'},{epoch:id(90)+'\0'},{public_key_spki:f.enrollment.public_key_spki+'='},{public_key_spki:'A'.repeat(58)+'B'},{fingerprint:'A'.repeat(42)+'B'},{canonical_root:''},{canonical_root:'/private\0suffix'}])assert.throws(()=>insert(f.db,'continuation_signer_enrollments',{...f.enrollment,id:id(91),epoch:id(92),...patch}));
 for(const patch of [{decision_id:'invalid'},{decision_id:id(90)+'\0'},{signature:'A'.repeat(85)+'B'},{signature:f.receipt.signature+'='},{baseline_revision:-1},{baseline_revision:0.5},{target_revision:9007199254740992},{expires_ms:1000},{expires_ms:601001},{attestation:''}])assert.throws(()=>insert(f.db,'continuation_decision_receipts',{...f.receipt,...patch}));
 assert.equal(count(f.db,'continuation_decision_receipts'),0);
});
test('equal-key reenrollment retains old identity and requires a distinct epoch',t=>{
 const f=fixture(t);assert.throws(()=>insert(f.db,'continuation_signer_enrollments',{...f.enrollment,id:id(90)}));
 insert(f.db,'continuation_signer_enrollments',{...f.enrollment,id:id(90),epoch:id(91)});assert.equal(count(f.db,'continuation_signer_enrollments'),2);
});
test('receipt and intent rollback together and survive independent process restart only after commit',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-provenance-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'state.sqlite'),f=fixture(t,file);f.db.exec('COMMIT; BEGIN IMMEDIATE');write(f);f.db.exec('ROLLBACK');assert.equal(count(f.db,'continuation_decision_receipts'),0);
 const script=`import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync(process.argv[1]);d.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10');let locked=false;try{d.exec('BEGIN IMMEDIATE')}catch(e){locked=/locked|busy/.test(e.message)}console.log(JSON.stringify({locked,n:d.prepare('SELECT COUNT(*) n FROM continuation_decision_receipts').get().n}));d.close();`;
 const read=()=>{const r=spawnSync(process.execPath,['--input-type=module','-e',script,file],{encoding:'utf8',timeout:10000,env:{DO_NOT_TRACK:'1'}});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
 f.db.exec('BEGIN IMMEDIATE');write(f);assert.deepEqual(read(),{locked:true,n:0});f.db.exec('COMMIT');assert.deepEqual(read(),{locked:false,n:1});
});

for(const table of ['continuation_signer_enrollments','continuation_decision_receipts'])test(`retained ${table} exposes no hidden replacement identity`,t=>{
 const f=fixture(t);write(f);const before=f.db.prepare(`SELECT * FROM ${table}`).all();
 for(const alias of ['rowid','_rowid_','oid']){
  assert.throws(()=>f.db.prepare(`SELECT ${alias} FROM ${table}`).all(),/no such column/);
  const row=before[0],keys=Object.keys(row);
  assert.throws(()=>f.db.prepare(`INSERT OR REPLACE INTO ${table}(${alias},${keys.join(',')}) VALUES(1,${keys.map(()=>'?').join(',')})`).run(...Object.values(row)),/no column named/);
  assert.throws(()=>f.db.exec(`UPDATE ${table} SET ${alias}=99`),/no such column/);
 }
 assert.deepEqual(f.db.prepare(`SELECT * FROM ${table}`).all(),before);
});
