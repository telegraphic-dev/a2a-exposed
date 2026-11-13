import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createContinuationRecords} from '../lib/continuation-records.mjs';
import {verifyContinuationDecisionReceipt} from '../lib/continuation-receipt.mjs';
import {installContinuationProvenanceTables as install} from '../lib/continuation-provenance-tables.mjs';
import {prepareContinuationIntent,commitContinuationMembers} from '../lib/continuation-tables.mjs';
import {prepareContinuationProvenance,readContinuationProvenance} from '../lib/continuation-provenance-storage.mjs';

// Synthetic test-only signer and human assertions; no real ceremony or custody.
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const digest=n=>Buffer.alloc(32,n).toString('base64url');
const clone=x=>JSON.parse(JSON.stringify(x));
function fixture(t,file=':memory:',root='/synthetic/private'){
 const db=new DatabaseSync(file);t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');install(db);db.exec('COMMIT; BEGIN IMMEDIATE');
 const records=createContinuationRecords(Buffer.alloc(32,1),Buffer.alloc(32,2),{root,config_identity:id(1),epoch:id(2),set_id:id(3)});
 const member=records.bindMember({grant_id:id(4),pairing_identity:digest(4),alias:'synthetic',endpoint:'https://example.com/',credential_variable:'PEER_SYNTHETIC_TOKEN',credential_source:'file',trust_record_digest:digest(5),trust_record_version:1,local_id:id(6),local_bundle_digest:digest(6),peer_bundle_digest:digest(7),policy:'required',verification:'independent',pairing_provenance:'local-adoption',pairing_decision_id:id(7)},'synthetic-token');
 const plan=records.bindPlan({baseline_revision:0,source_mac:records.sourceMac({configEnv:null,peers:null}),plan_nonce:digest(8),members:[member],excluded_aliases:['excluded']});
 const attestation=records.bindAttestation(plan,{id:id(9),decision_id:id(10),created_ms:1000,expires_ms:2000,comparisons:[{grant_id:member.grant_id,approved_proposal_digest:digest(9),compared_safety_code:Array(12).fill('12345').join(' '),current_trust_digest:member.trust_record_digest,current_trust_version:1}]});
 const intent=records.bindIntent(id(11),plan,attestation),{publicKey,privateKey}=generateKeyPairSync('ed25519');
 const der=publicKey.export({type:'spki',format:'der'}),fingerprint=createHash('sha256').update(der).digest('base64url');
 const enrollment={version:1,id:id(12),config_identity:id(1),canonical_root:root,epoch:id(2),public_key_spki:der.toString('base64url'),fingerprint};
 const text=records.authorityRows(intent).attestation.record;
 const receipt={version:1,decision_id:id(10),enrollment_id:id(12),signer_fingerprint:fingerprint,attestation:text,signature:sign(null,Buffer.from('a2a-exposed continuation human decision v1\n'+text),privateKey).toString('base64url'),intent_id:id(11),config_identity:id(1),canonical_root:root,epoch:id(2),baseline_revision:0,target_revision:1,plan_mac:plan.plan_mac,set_id:id(3),created_ms:1000,expires_ms:2000};
 const verify=(e=enrollment,r=receipt,i=intent,now=1000)=>verifyContinuationDecisionReceipt(records,i,e,r,now);
 const {version,...row}=enrollment;const keys=Object.keys(row);db.prepare(`INSERT INTO continuation_signer_enrollments(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));db.exec('COMMIT; BEGIN IMMEDIATE');return{db,records,intent,enrollment,receipt,privateKey,verify};
}
const refuses=fn=>assert.throws(fn,e=>e?.code?.startsWith('continuation_'));


const prepare=f=>prepareContinuationProvenance(f.db,f.records,f.intent,f.enrollment,f.receipt,1000);
const read=(f,now=1000)=>readContinuationProvenance(f.db,f.records,f.intent.id,f.enrollment,now);
const count=(f,table)=>f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
function dropGuards(db,table){for(const {name} of db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").all(table))db.exec(`DROP TRIGGER ${name}`);}

test('signed receipt and consuming intent persist together without authority adoption or eligibility',t=>{
 const f=fixture(t),result=prepare(f);assert.equal(result.state,'prepared');assert.equal(result.setState,null);assert.deepEqual(result.receipt,f.receipt);
 assert.equal(f.db.isTransaction,true);f.db.exec('COMMIT; BEGIN IMMEDIATE');assert.deepEqual(read(f),result);
 commitContinuationMembers(f.db,f.records,f.intent);assert.equal(read(f).state,'set-committed');
 assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,0);assert.equal(count(f,'grant_members'),1);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='authority'").get().n,0);
 assert.ok(!JSON.stringify(result).includes('synthetic-token'));assert.ok(!JSON.stringify(result).includes('12345 12345'));
});
test('missing transaction and disabled foreign keys refuse reads and writes',t=>{
 const f=fixture(t);f.db.exec('ROLLBACK');for(const action of [()=>prepare(f),()=>read(f)])assert.throws(action,{code:'continuation_provenance_transaction_required'});
 f.db.exec('PRAGMA foreign_keys=OFF; BEGIN');for(const action of [()=>prepare(f),()=>read(f)])assert.throws(action,{code:'continuation_provenance_foreign_keys_required'});
});
test('bad signatures, stale approval and wrong enrollment refuse before any intent or receipt write',t=>{
 const f=fixture(t);for(const patch of [{signature:Buffer.alloc(64).toString('base64url')},{intent_id:id(99)},{extra:true}])refuses(()=>prepareContinuationProvenance(f.db,f.records,f.intent,f.enrollment,{...f.receipt,...patch},1000));
 for(const now of [999,2000,NaN])refuses(()=>prepareContinuationProvenance(f.db,f.records,f.intent,f.enrollment,f.receipt,now));
 for(const patch of [{id:id(99)},{epoch:id(99)},{canonical_root:'/synthetic/other'}])refuses(()=>prepareContinuationProvenance(f.db,f.records,f.intent,{...f.enrollment,...patch},f.receipt,1000));
 for(const table of ['continuation_intents','continuation_attestations','continuation_decision_receipts'])assert.equal(count(f,table),0);
});
test('failure inserting receipt rolls back intent and consumed attestation but preserves caller transaction',t=>{
 const f=fixture(t);f.db.exec("CREATE TABLE caller_work(value TEXT); INSERT INTO caller_work VALUES('keep'); CREATE TRIGGER synthetic_fault BEFORE INSERT ON continuation_decision_receipts BEGIN SELECT RAISE(ABORT,'synthetic receipt fault'); END");
 assert.throws(()=>prepare(f),/synthetic receipt fault/);assert.equal(f.db.isTransaction,true);assert.equal(count(f,'caller_work'),1);
 for(const table of ['continuation_intents','continuation_attestations','continuation_decision_receipts'])assert.equal(count(f,table),0);
 f.db.exec('DROP TRIGGER synthetic_fault');prepare(f);assert.deepEqual(read(f).receipt,f.receipt);
});
test('post-write authenticated read failure rolls back the complete savepoint',t=>{
 const f=fixture(t);let writes=false;
 const wrapped={get isTransaction(){return f.db.isTransaction;},exec:q=>f.db.exec(q),prepare(q){if(q.startsWith('INSERT INTO continuation_decision_receipts'))writes=true;if(writes&&q.startsWith('SELECT ')&&q.includes(' FROM continuation_decision_receipts'))throw Error('synthetic read fault');return f.db.prepare(q);}};
 assert.throws(()=>prepareContinuationProvenance(wrapped,f.records,f.intent,f.enrollment,f.receipt,1000),/synthetic read fault/);
 for(const table of ['continuation_intents','continuation_attestations','continuation_decision_receipts'])assert.equal(count(f,table),0);
 assert.equal(f.db.isTransaction,true);
});
test('synthetic intent without receipt refuses; repeat preparation cannot replace consumed provenance',t=>{
 const f=fixture(t);prepareContinuationIntent(f.db,f.records,f.intent,1000);assert.throws(()=>read(f),{code:'continuation_provenance_receipt_missing'});assert.throws(()=>prepare(f));assert.equal(count(f,'continuation_decision_receipts'),0);
 const g=fixture(t);prepare(g);assert.throws(()=>prepare(g));assert.equal(count(g,'continuation_decision_receipts'),1);assert.deepEqual(read(g).receipt,g.receipt);
});
for(const patch of [{signature:Buffer.alloc(64).toString('base64url')},{decision_id:id(99)},{attestation:'{}'},{created_ms:1001},{expires_ms:2001},{signer_fingerprint:digest(99)},{set_id:id(99)}])test('authenticated read rejects bypassed receipt corruption '+Object.keys(patch)[0],t=>{
 const f=fixture(t);prepare(f);dropGuards(f.db,'continuation_decision_receipts');f.db.exec('PRAGMA ignore_check_constraints=ON');
 // FK columns cannot be modified with foreign_keys on, even by this fixture.
 if('signer_fingerprint' in patch){f.db.exec('COMMIT; PRAGMA foreign_keys=OFF; BEGIN');}
 const [key,value]=Object.entries(patch)[0];f.db.prepare(`UPDATE continuation_decision_receipts SET ${key}=?`).run(value);
 if('signer_fingerprint' in patch)f.db.exec('COMMIT; PRAGMA foreign_keys=ON; BEGIN');
 refuses(()=>read(f));
});
test('stored enrollment bytes must match current anchored enrollment even with same fingerprint column',t=>{
 const f=fixture(t);prepare(f);dropGuards(f.db,'continuation_signer_enrollments');f.db.prepare('UPDATE continuation_signer_enrollments SET public_key_spki=?').run(generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}).toString('base64url'));
 assert.throws(()=>read(f),{code:'continuation_provenance_row_mismatch'});
});
test('missing enrolled row refuses and never silently enrolls supplied public key',t=>{
 const f=fixture(t);dropGuards(f.db,'continuation_signer_enrollments');f.db.exec('DELETE FROM continuation_signer_enrollments');
 assert.throws(()=>prepare(f),{code:'continuation_provenance_row_mismatch'});assert.equal(count(f,'continuation_intents'),0);assert.equal(count(f,'continuation_signer_enrollments'),0);
});
test('checkpoint read enforces original deadline and refuses clock regression after reopening',t=>{
 const f=fixture(t);prepare(f);f.db.exec('COMMIT; BEGIN IMMEDIATE');assert.deepEqual(read(f,1999).receipt,f.receipt);for(const now of [999,2000,NaN])refuses(()=>read(f,now));
});
test('real independent process sees neither receipt nor intent before outer commit and both afterward',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-provenance-storage-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'state.sqlite'),f=fixture(t,file);prepare(f);
 const script=`import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync(process.argv[1]);d.exec('PRAGMA busy_timeout=10');let locked=false;try{d.exec('BEGIN IMMEDIATE')}catch(e){locked=/locked|busy/.test(e.message)};console.log(JSON.stringify({locked,intents:d.prepare('SELECT COUNT(*) n FROM continuation_intents').get().n,receipts:d.prepare('SELECT COUNT(*) n FROM continuation_decision_receipts').get().n}));d.close();`;
 const run=()=>{const p=spawnSync(process.execPath,['--input-type=module','-e',script,file],{encoding:'utf8',timeout:10000,env:{DO_NOT_TRACK:'1'}});assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);};
 assert.deepEqual(run(),{locked:true,intents:0,receipts:0});f.db.exec('COMMIT');assert.deepEqual(run(),{locked:false,intents:1,receipts:1});f.db.exec('BEGIN IMMEDIATE');assert.deepEqual(read(f).receipt,f.receipt);
});
test('enrollment proxy cannot substitute property reads after descriptor validation',t=>{
 const f=fixture(t),absent={...f.enrollment,id:id(99)},receipt={...f.receipt,enrollment_id:id(99)};
 // The signature does not cover the wrapper enrollment ID; current enrollment
 // selection and the exact stored row must supply that binding independently.
 let gets=0;const proxy=new Proxy(absent,{get(target,key){gets++;return f.enrollment[key];}});
 assert.throws(()=>prepareContinuationProvenance(f.db,f.records,f.intent,proxy,receipt,1000),{code:'continuation_provenance_row_mismatch'});
 assert.equal(gets,0);assert.equal(count(f,'continuation_intents'),0);prepare(f);
 assert.throws(()=>readContinuationProvenance(f.db,f.records,f.intent.id,proxy,1000));assert.equal(gets,0);
});

// A valid U+FFFD in authenticated input is distinct from a corrupt byte that
// Node's SQLite text conversion would silently replace with that character.
for(const [table,column] of [
 ['continuation_intents','record'],
 ['continuation_attestations','record'],
 ['continuation_decision_receipts','attestation'],
 ['continuation_decision_receipts','canonical_root'],
 ['continuation_signer_enrollments','canonical_root'],
])for(const malformed of ['ff','c0','e282'])test(`retained ${table}.${column} refuses lossy UTF-8 ${malformed}`,t=>{
 const f=fixture(t,':memory:','/synthetic/\ufffd');prepare(f);
 const original=f.db.prepare(`SELECT ${column} text,CAST(${column} AS BLOB) bytes FROM ${table}`).get();
 const marker=Buffer.from('\ufffd'),offset=Buffer.from(original.bytes).indexOf(marker);assert.ok(offset>=0);
 const damaged=Buffer.concat([original.bytes.subarray(0,offset),Buffer.from(malformed,'hex'),original.bytes.subarray(offset+marker.length)]);
 assert.equal(damaged.toString('utf8'),original.text);
 dropGuards(f.db,table);f.db.exec('COMMIT; PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
 f.db.prepare(`UPDATE ${table} SET ${column}=CAST(? AS TEXT)`).run(damaged);
 f.db.exec('COMMIT; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
 assert.equal(f.db.prepare(`SELECT ${column} text FROM ${table}`).get().text,original.text);
 const before=f.db.prepare('SELECT total_changes() n').get().n;
 assert.throws(()=>read(f),e=>['continuation_store_invalid','continuation_provenance_text_invalid'].includes(e?.code));
 assert.equal(f.db.isTransaction,true);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 assert.deepEqual(Buffer.from(f.db.prepare(`SELECT CAST(${column} AS BLOB) bytes FROM ${table}`).get().bytes),damaged);
});
test('valid non-ASCII and literal replacement characters remain authenticated after reopen',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-provenance-unicode-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'state.sqlite'),f=fixture(t,file,'/synthetic/\ufeffpříliš/日本/\ufffd');prepare(f);commitContinuationMembers(f.db,f.records,f.intent);f.db.exec('COMMIT');
 const before=fs.readFileSync(file),other=new DatabaseSync(file,{readOnly:true});
 try{
  other.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; BEGIN');
  const result=readContinuationProvenance(other,f.records,f.intent.id,f.enrollment,1000);
  assert.deepEqual(result.receipt,f.receipt);assert.equal(result.state,'set-committed');other.exec('COMMIT');
 }finally{other.close();}
 assert.deepEqual(fs.readFileSync(file),before);
});
test('lossy enrollment text refuses preparation before any receipt or intent mutation',t=>{
 const f=fixture(t,':memory:','/synthetic/\ufffd');
 dropGuards(f.db,'continuation_signer_enrollments');
 f.db.prepare("UPDATE continuation_signer_enrollments SET canonical_root=CAST(? AS TEXT)").run(Buffer.concat([Buffer.from('/synthetic/'),Buffer.from([255])]));
 assert.throws(()=>prepare(f),{code:'continuation_provenance_text_invalid'});
 for(const table of ['continuation_intents','continuation_attestations','continuation_decision_receipts'])assert.equal(count(f,table),0);
 assert.equal(f.db.isTransaction,true);
});
