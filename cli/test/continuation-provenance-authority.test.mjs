import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {installContinuationProvenanceAuthority as install,assertContinuationProvenanceAuthorityInventory as inspect} from '../lib/continuation-provenance-authority.mjs';
import {initializeContinuationAuthority,inspectContinuationAuthority} from '../lib/pairing-authority.mjs';

// Structural fixtures only: dummy keys/signatures/JSON are NOT authentic human
// decisions, and must never be accepted by a future anchored authority reader.
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const digest=n=>Buffer.alloc(32,n).toString('base64url');
const schema=db=>db.prepare('SELECT * FROM main.sqlite_schema ORDER BY type,name').all();
const expected={version:1,schema:4,format:'continuation-provenance-authority'};
function insert(db,table,row,verb='INSERT'){
 const keys=Object.keys(row);db.prepare(`${verb} INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));
}
function fresh(t,file=':memory:'){
 const db=new DatabaseSync(file);t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');return db;
}
function fixture(t){
 const db=fresh(t);install(db);
 const authority={id:1,config_id:id(1),canonical_root:'/synthetic/private',revision:0,source_hash:digest(1),pending:null,suspended:1,recovery_key:digest(2),suspension_epoch:id(2),active_set:null,current_signer_id:null};
 insert(db,'authority',authority);return{db,authority};
}
function signer(f,patch={}){
 const enrollment={id:id(3),config_identity:f.authority.config_id,canonical_root:f.authority.canonical_root,epoch:id(4),public_key_spki:Buffer.alloc(44).toString('base64url'),fingerprint:digest(3),...patch};
 insert(f.db,'continuation_signer_enrollments',enrollment);return enrollment;
}
function select(f,e){f.db.prepare('UPDATE authority SET revision=revision+1,suspension_epoch=?,current_signer_id=?').run(e.epoch,e.id);}
function prepared(f,e){
 select(f,e);
 const intent={id:id(5),epoch:e.epoch,baseline_revision:1,target_revision:2,set_id:id(6),plan_mac:digest(4),intent_mac:digest(5),state:'prepared',record:'{}'};
 insert(f.db,'continuation_attestations',{id:id(7),plan_mac:intent.plan_mac,epoch:e.epoch,created_ms:1000,expires_ms:2000,consumed_intent:null,attestation_mac:digest(6),record:'{}'});
 insert(f.db,'continuation_intents',intent);f.db.prepare('UPDATE continuation_attestations SET consumed_intent=?').run(intent.id);
 const receipt={decision_id:id(8),enrollment_id:e.id,signer_fingerprint:e.fingerprint,intent_id:intent.id,config_identity:e.config_identity,canonical_root:e.canonical_root,epoch:e.epoch,baseline_revision:1,target_revision:2,plan_mac:intent.plan_mac,set_id:intent.set_id,created_ms:1000,expires_ms:2000,attestation:'{}',signature:Buffer.alloc(64).toString('base64url')};
 return{intent,receipt};
}
test('fresh schema 4 combines authority and provenance, with no authority or signer row created',t=>{
 const db=fresh(t);install(db);assert.deepEqual(inspect(db),expected);assert.equal(Object.isFrozen(inspect(db)),true);
 for(const table of ['authority','continuation_signer_enrollments','continuation_enrollment_plans','continuation_decision_receipts','continuation_intents'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
 assert.equal(db.isTransaction,true);const before=schema(db);db.exec('COMMIT; BEGIN');assert.deepEqual(inspect(db),expected);assert.deepEqual(schema(db),before);
});
for(const version of [1,2,3,4])test('installer preserves existing version '+version,t=>{
 const db=fresh(t);db.exec(`PRAGMA user_version=${version}`);const before=schema(db);
 assert.throws(()=>install(db),{code:'continuation_authority_fresh_required'});assert.deepEqual(schema(db),before);assert.equal(db.prepare('PRAGMA user_version').get().user_version,version);
});
test('nonempty/partial version-zero stores refuse without adoption or reset',t=>{
 const db=fresh(t);db.exec('CREATE TABLE authority(id TEXT)');const before=schema(db);
 assert.throws(()=>install(db),{code:'continuation_authority_fresh_required'});assert.deepEqual(schema(db),before);
});
test('missing transaction and unsafe connection pragmas refuse before changes',t=>{
 const db=fresh(t);db.exec('ROLLBACK');assert.throws(()=>install(db),{code:'continuation_authority_transaction_required'});
 for(const [name,value]of [['foreign_keys',0],['trusted_schema',1],['ignore_check_constraints',1],['writable_schema',1]]){
  db.exec(`PRAGMA ${name}=${value}; BEGIN`);
  // Newer Node SQLite defensive mode can refuse writable_schema=ON. Test the
  // effective connection state: an ignored unsafe request leaves a safe DB.
  const effective=db.prepare(`PRAGMA ${name}`).get()[name];
  if(effective===value){assert.throws(()=>install(db),{code:'continuation_authority_connection_invalid'});assert.equal(schema(db).length,0);}
  else{assert.equal(name,'writable_schema');assert.equal(effective,0);install(db);assert.deepEqual(inspect(db),expected);}
  db.exec(`ROLLBACK; PRAGMA ${name}=${1-value}`);
 }
 db.exec('BEGIN');install(db);
});
test('DDL failure including final version stamp rolls back all nested installers, preserving caller transaction',t=>{
 for(const phase of ['authority','stamp','release']){
  const db=fresh(t);let stamped=false;
  const wrapper={get isTransaction(){return db.isTransaction;},prepare:q=>db.prepare(q),exec(sql){
   if(sql.includes('CREATE TABLE authority')&&phase==='authority')throw Error('synthetic DDL failure');
   const result=db.exec(sql);if(sql.includes('PRAGMA main.user_version=4')){stamped=true;if(phase==='stamp')throw Error('synthetic stamp failure');}
   if(stamped&&phase==='release'&&sql==='RELEASE continuation_authority_install')throw Error('synthetic release uncertainty');return result;
  }};
  if(phase==='release'){
   assert.throws(()=>install(wrapper),{code:'continuation_authority_rollback_unknown'});
   // RELEASE succeeded before the injected error: outer rollback remains the
   // caller's responsibility; the API must report uncertainty, never success.
   db.exec('ROLLBACK; BEGIN');
  }else assert.throws(()=>install(wrapper),/synthetic/);
  assert.equal(db.isTransaction,true);assert.deepEqual(schema(db),[]);assert.equal(db.prepare('PRAGMA user_version').get().user_version,0);install(db);
 }
});
for(const sql of ['CREATE TEMP TABLE authority(id INTEGER)',"ATTACH ':memory:' AS other",'CREATE TEMP VIEW shadow AS SELECT 1'])test('installer and reader reject foreign namespace: '+sql,t=>{
 const db=fresh(t);db.exec(sql);assert.throws(()=>install(db),{code:'continuation_authority_namespace_invalid'});
});
for(const sql of ['DROP TRIGGER authority_signer_epoch','DROP INDEX continuation_signer_authority_binding','ALTER TABLE authority ADD COLUMN extra TEXT','CREATE INDEX extra ON authority(revision)','CREATE TABLE extra(id TEXT)',"DROP TRIGGER authority_pending; CREATE TRIGGER authority_pending BEFORE UPDATE ON authority BEGIN SELECT 1; END"])
 test('inventory refuses changed schema without repair: '+sql,t=>{
  const {db}=fixture(t);db.exec(sql);const before=schema(db);assert.throws(()=>inspect(db),{code:'continuation_authority_schema_invalid'});assert.deepEqual(schema(db),before);
 });
test('reader refuses altered version, connection state, TEMP shadow or attached database',t=>{
 for(const sql of ['PRAGMA user_version=3','PRAGMA ignore_check_constraints=ON','PRAGMA trusted_schema=ON','PRAGMA writable_schema=ON','CREATE TEMP TABLE authority(id INTEGER)',"ATTACH ':memory:' AS other"]){
  const {db}=fixture(t);db.exec(sql);
  if(sql==='PRAGMA writable_schema=ON'&&db.prepare('PRAGMA writable_schema').get().writable_schema===0)assert.deepEqual(inspect(db),expected);
  else assert.throws(()=>inspect(db),e=>e.code?.startsWith('continuation_authority_'));
 }
 const {db}=fixture(t);db.exec('COMMIT; PRAGMA foreign_keys=OFF; BEGIN');assert.throws(()=>inspect(db),{code:'continuation_authority_connection_invalid'});
});
test('initial authority cannot start enrolled, active, pending or with an advanced revision',t=>{
 for(const patch of [{revision:1},{current_signer_id:id(3)},{pending:id(5)},{active_set:id(6)},{suspended:0}]){
  const db=fresh(t);install(db);const f=fixture(t);assert.throws(()=>insert(db,'authority',{...f.authority,...patch}));assert.equal(db.prepare('SELECT COUNT(*) n FROM authority').get().n,0);
 }
});
test('current signer binds retained config, root and epoch and rotation increments revision exactly once',t=>{
 for(const patch of [{config_identity:id(90)},{canonical_root:'/synthetic/other'}]){
  const f=fixture(t),e=signer(f,patch);assert.throws(()=>select(f,e),/FOREIGN KEY/);assert.deepEqual({...f.db.prepare('SELECT * FROM authority').get()},f.authority);
 }
 const f=fixture(t),e=signer(f);select(f,e);const row=f.db.prepare('SELECT * FROM authority').get();assert.equal(row.current_signer_id,e.id);assert.equal(row.suspension_epoch,e.epoch);assert.equal(row.revision,1);
 for(const sql of ["UPDATE authority SET current_signer_id=NULL","UPDATE authority SET suspension_epoch='"+id(91)+"'","UPDATE authority SET current_signer_id=NULL,suspension_epoch='"+id(91)+"',revision=revision+2"]){assert.throws(()=>f.db.exec(sql));assert.deepEqual(f.db.prepare('SELECT * FROM authority').get(),row);}
 // Removing a structural selection still rotates epoch/revision and suspends.
 f.db.prepare('UPDATE authority SET current_signer_id=NULL,suspension_epoch=?,revision=revision+1').run(id(91));assert.equal(f.db.prepare('SELECT revision FROM authority').get().revision,2);
});
test('selecting a retained key under another epoch or without exact rotation refuses',t=>{
 const f=fixture(t),e=signer(f);
 for(const [epoch,revision]of [[id(90),1],[e.epoch,0],[e.epoch,2],[f.authority.suspension_epoch,1]]){
  assert.throws(()=>f.db.prepare('UPDATE authority SET current_signer_id=?,suspension_epoch=?,revision=?').run(e.id,epoch,revision));
  assert.deepEqual({...f.db.prepare('SELECT * FROM authority').get()},f.authority);
 }
 select(f,e);
});
test('authority identity and retention cannot be changed through update, delete or replacement identities',t=>{
 const f=fixture(t),before=f.db.prepare('SELECT * FROM authority').get();
 for(const patch of [{config_id:id(90)},{canonical_root:'/synthetic/other'},{recovery_key:digest(90)},{id:2},{revision:-1}]){
  const k=Object.keys(patch)[0];assert.throws(()=>f.db.prepare(`UPDATE authority SET ${k}=?`).run(patch[k]));
 }
 assert.throws(()=>f.db.exec('DELETE FROM authority'));assert.throws(()=>insert(f.db,'authority',f.authority));
 assert.deepEqual(f.db.prepare('SELECT * FROM authority').get(),before);
});
test('hidden rowid and INSERT OR REPLACE cannot evict the retained authority',t=>{
 const f=fixture(t),before=f.db.prepare('SELECT * FROM authority').get();assert.equal(f.db.prepare('PRAGMA recursive_triggers').get().recursive_triggers,0);
 assert.throws(()=>insert(f.db,'authority',f.authority,'INSERT OR REPLACE'));
 for(const alias of ['rowid','_rowid_','oid'])assert.throws(()=>f.db.exec(`INSERT OR REPLACE INTO authority(${alias},id) VALUES(1,1)`));
 assert.deepEqual(f.db.prepare('SELECT * FROM authority').get(),before);
});
test('pending pointer requires retained receipt for exactly the current enrollment',t=>{
 const f=fixture(t),e=signer(f),{intent,receipt}=prepared(f,e);
 const update=()=>f.db.prepare('UPDATE authority SET pending=?,revision=?').run(intent.id,intent.target_revision);
 assert.throws(update,/authority pending provenance/);insert(f.db,'continuation_decision_receipts',receipt);update();
 assert.equal(f.db.prepare('SELECT pending FROM authority').get().pending,intent.id);
 const next=signer(f,{id:id(90),epoch:id(91)});assert.throws(()=>select(f,next),/authority (signer rotation|pending provenance)/);
});
test('active pointer requires eligible intent/set and current signer receipt; SQL success is not authentication',t=>{
 const f=fixture(t),e=signer(f),{intent,receipt}=prepared(f,e);
 insert(f.db,'grant_sets',{id:intent.set_id,intent_id:intent.id,epoch:e.epoch,target_revision:2,membership_mac:digest(9),state:'committed'});
 const update=()=>f.db.prepare('UPDATE authority SET revision=2,active_set=?,suspended=0').run(intent.set_id);
 assert.throws(update,/authority active provenance/);
 f.db.exec("UPDATE continuation_intents SET state='set-committed'; UPDATE continuation_intents SET state='eligible'; UPDATE grant_sets SET state='eligible'");assert.throws(update,/authority active provenance/);
 // Receipt insert itself requires prepared state, so restore a fresh fixture.
 const g=fixture(t),s=signer(g),r=prepared(g,s);insert(g.db,'continuation_decision_receipts',r.receipt);
 insert(g.db,'grant_sets',{id:r.intent.set_id,intent_id:r.intent.id,epoch:s.epoch,target_revision:2,membership_mac:digest(9),state:'committed'});
 g.db.exec("UPDATE continuation_intents SET state='set-committed'; UPDATE continuation_intents SET state='eligible'; UPDATE grant_sets SET state='eligible'");
 g.db.prepare('UPDATE authority SET revision=2,active_set=?,suspended=0').run(r.intent.set_id);assert.deepEqual(inspect(g.db),expected);
 // Dummy signature and JSON show this inventory assertion proves shape only.
});
test('eligible set cannot substitute another intent set identity, epoch or revision',t=>{
 for(const patch of [{id:id(90)},{epoch:id(90)},{target_revision:3}]){
  const f=fixture(t),e=signer(f),{intent,receipt}=prepared(f,e);insert(f.db,'continuation_decision_receipts',receipt);
  const set={id:intent.set_id,intent_id:intent.id,epoch:e.epoch,target_revision:2,membership_mac:digest(9),state:'committed',...patch};insert(f.db,'grant_sets',set);
  f.db.exec("UPDATE continuation_intents SET state='set-committed'; UPDATE continuation_intents SET state='eligible'; UPDATE grant_sets SET state='eligible'");
  assert.throws(()=>f.db.prepare('UPDATE authority SET revision=?,suspension_epoch=?,active_set=?,suspended=0').run(set.target_revision,set.epoch,set.id),/authority/);
  assert.equal(f.db.prepare('SELECT active_set FROM authority').get().active_set,null);
 }
});
test('schema and version are atomic across outer rollback and independently inspected after commit',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'provenance-authority-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const file=path.join(directory,'candidate.sqlite'),db=fresh(t,file);install(db);db.exec('ROLLBACK; BEGIN');assert.deepEqual(schema(db),[]);assert.equal(db.prepare('PRAGMA user_version').get().user_version,0);install(db);db.exec('COMMIT');
 const bytes=fs.readFileSync(file),script=`import{DatabaseSync}from'node:sqlite';import{assertContinuationProvenanceAuthorityInventory as inspect}from${JSON.stringify(new URL('../lib/continuation-provenance-authority.mjs',import.meta.url).href)};const d=new DatabaseSync(process.argv[1],{readOnly:true});d.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; BEGIN');console.log(JSON.stringify(inspect(d)));d.close();`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script,file],{encoding:'utf8',timeout:10000,env:{DO_NOT_TRACK:'1'}});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),expected);assert.deepEqual(fs.readFileSync(file),bytes);
});
test('existing physical schema-3 initialization and inspection remain unchanged and reject schema 4',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'old-continuation-'));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 initializeContinuationAuthority(root,{configIdentity:id(1)});assert.equal(inspectContinuationAuthority(root,{configIdentity:id(1)}).schema,3);
 const file=path.join(root,'pairing-authority.sqlite'),db=new DatabaseSync(file);db.exec('PRAGMA user_version=4');db.close();const before=fs.readFileSync(file);
 assert.throws(()=>inspectContinuationAuthority(root,{configIdentity:id(1)}),{code:'authority_schema'});assert.deepEqual(fs.readFileSync(file),before);
});
