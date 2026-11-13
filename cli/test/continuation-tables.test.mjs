import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createContinuationRecords} from '../lib/continuation-records.mjs';
import {installContinuationTables,prepareContinuationIntent,commitContinuationMembers,readContinuationIntent,continuationTableNames} from '../lib/continuation-tables.mjs';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const digest=n=>Buffer.alloc(32,n).toString('base64url');
const copy=x=>JSON.parse(JSON.stringify(x));
function fixture(t,file=':memory:'){
 const db=new DatabaseSync(file);t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');installContinuationTables(db);db.exec('COMMIT');
 const binding={root:path.resolve('/synthetic/private'),config_identity:id(1),epoch:id(2),set_id:id(3)};
 const records=createContinuationRecords(Buffer.alloc(32,1),Buffer.alloc(32,2),binding);
 const members=[4,5].map(n=>records.bindMember({grant_id:id(n),pairing_identity:digest(n),alias:`peer_${n}`,endpoint:`https://example.com/peer-${n}`,credential_variable:`PEER_${n}_TOKEN`,credential_source:'file',trust_record_digest:digest(10+n),trust_record_version:1,local_id:id(6),local_bundle_digest:digest(20),peer_bundle_digest:digest(30+n),policy:'required',verification:'independent',pairing_provenance:'local-adoption',pairing_decision_id:id(10+n)},`synthetic-token-${n}`));
 const plan=records.bindPlan({baseline_revision:0,source_mac:records.sourceMac({configEnv:'',peers:'{}'}),plan_nonce:digest(40),members,excluded_aliases:['omitted']});
 const attestation=records.bindAttestation(plan,{id:id(20),decision_id:id(21),created_ms:1000,expires_ms:601000,comparisons:members.map((m,i)=>({grant_id:m.grant_id,approved_proposal_digest:digest(50+i),compared_safety_code:Array(12).fill('10000').join(' '),current_trust_digest:m.trust_record_digest,current_trust_version:m.trust_record_version}))});
 const intent=records.bindIntent(id(22),plan,attestation);db.exec('BEGIN IMMEDIATE');return{db,records,intent,binding};
}
const prepare=f=>prepareContinuationIntent(f.db,f.records,f.intent,1000);
const commit=f=>commitContinuationMembers(f.db,f.records,f.intent);
const read=f=>readContinuationIntent(f.db,f.records,f.intent.id);
const count=(f,table)=>f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const insert=(db,table,row,verb='INSERT')=>{const keys=Object.keys(row);return db.prepare(`${verb} INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));};
function dropGuards(db,table){for(const {name} of db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").all(table))db.exec(`DROP TRIGGER ${name}`);}

test('private table primitives persist complete authenticated I/C history without activation',t=>{
 const f=fixture(t);assert.deepEqual(continuationTableNames,['continuation_intents','grant_sets','grant_members','continuation_attestations']);
 assert.equal(prepare(f).state,'prepared');assert.equal(count(f,'grant_sets'),0);assert.equal(commit(f).state,'set-committed');assert.equal(read(f).setState,'committed');assert.deepEqual(read(f).intent,f.intent);
 f.db.exec('COMMIT; BEGIN IMMEDIATE');assert.equal(read(f).state,'set-committed');assert.equal(count(f,'grant_members'),2);
 assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='authority'").get().n,0);
 assert.ok(!JSON.stringify(f.db.prepare('SELECT record FROM continuation_intents').all()).includes('synthetic-token'));
});
test('every operation requires a caller transaction and foreign-key enforcement',t=>{
 const f=fixture(t);f.db.exec('ROLLBACK');for(const action of [()=>prepare(f),()=>commit(f),()=>read(f),()=>installContinuationTables(f.db)])assert.throws(action,{code:'continuation_transaction_required'});
 f.db.exec('PRAGMA foreign_keys=OFF; BEGIN');assert.throws(()=>prepare(f),{code:'continuation_foreign_keys_required'});assert.equal(count(f,'continuation_intents'),0);
});
test('fresh-only installation refuses schema 1/2/3 and partial/colliding databases without changes',t=>{
 for(const version of [1,2,3]){const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(`PRAGMA foreign_keys=ON; PRAGMA user_version=${version}; BEGIN`);assert.throws(()=>installContinuationTables(db),{code:'continuation_fresh_schema_required'});assert.equal(db.prepare('SELECT COUNT(*) n FROM sqlite_schema').get().n,0);assert.equal(db.prepare('PRAGMA user_version').get().user_version,version);}
 const f=fixture(t);assert.throws(()=>installContinuationTables(f.db),{code:'continuation_fresh_schema_required'});assert.equal(prepare(f).state,'prepared');
});
test('attestation age and authentication fail before storage or consumption',t=>{
 const f=fixture(t);for(const now of [999,601000,NaN,-1])assert.throws(()=>prepareContinuationIntent(f.db,f.records,f.intent,now),e=>e.code.startsWith('continuation_'));
 const altered=copy(f.intent);altered.record.plan.members.pop();assert.throws(()=>prepareContinuationIntent(f.db,f.records,altered,1000));for(const table of continuationTableNames)assert.equal(count(f,table),0);
});
test('one pending intent, single-use attestation and exact-state CAS refuse retries',t=>{
 const f=fixture(t);prepare(f);assert.throws(()=>prepare(f));assert.equal(count(f,'continuation_attestations'),1);assert.equal(f.db.prepare('SELECT consumed_intent FROM continuation_attestations').get().consumed_intent,f.intent.id);
 const i=f.records.authorityRows(f.intent).intent;assert.throws(()=>insert(f.db,'continuation_intents',{...i,id:id(90),set_id:id(91),state:'prepared'}));assert.throws(()=>insert(f.db,'continuation_intents',{...i,id:id(90),set_id:id(91),state:'prepared'},'INSERT OR REPLACE'));assert.equal(count(f,'continuation_intents'),1);
 commit(f);assert.throws(()=>commit(f),{code:'continuation_compare_failed'});assert.equal(count(f,'grant_members'),2);
 const replacement=copy(f.intent);replacement.intent_mac=digest(90);assert.throws(()=>commitContinuationMembers(f.db,f.records,replacement));assert.equal(read(f).state,'set-committed');
});
test('partial member insertion rolls back only its savepoint and retains the prepared intent',t=>{
 const f=fixture(t);prepare(f);f.db.exec("CREATE TRIGGER synthetic_fault BEFORE INSERT ON grant_members WHEN NEW.alias='peer_5' BEGIN SELECT RAISE(ABORT,'synthetic second member fault'); END");assert.throws(()=>commit(f));assert.equal(count(f,'grant_sets'),0);assert.equal(count(f,'grant_members'),0);assert.equal(read(f).state,'prepared');assert.equal(f.db.isTransaction,true);f.db.exec('DROP TRIGGER synthetic_fault');commit(f);assert.equal(read(f).state,'set-committed');
});
test('immutable rows and consumed attestations cannot be rewritten, deleted or replaced',t=>{
 const f=fixture(t);prepare(f);commit(f);
 for(const table of continuationTableNames){const row=f.db.prepare(`SELECT * FROM ${table} LIMIT 1`).get();assert.throws(()=>f.db.exec(`DELETE FROM ${table}`));assert.throws(()=>insert(f.db,table,row,'INSERT OR REPLACE'));}
 for(const [table,column,value] of [['continuation_intents','record','{}'],['continuation_intents','intent_mac',digest(99)],['grant_sets','membership_mac',digest(99)],['grant_members','alias','other'],['continuation_attestations','expires_ms',500000],['continuation_attestations','record','{}'],['continuation_attestations','consumed_intent',null],['continuation_attestations','consumed_intent',id(80)]])assert.throws(()=>f.db.prepare(`UPDATE ${table} SET ${column}=?`).run(value));
 assert.equal(read(f).state,'set-committed');
});
test('SQL constraints independently reject noncanonical identities, MACs, revisions and states',t=>{
 const f=fixture(t),r=f.records.authorityRows(f.intent).intent;
 for(const patch of [{id:'invalid'},{id:id(22).toUpperCase().replace('00000000','AAAAAAAA')},{id:id(22)+'\0'},{epoch:'a'.repeat(36)},{baseline_revision:-1},{baseline_revision:0.5},{target_revision:2},{target_revision:9007199254740992},{intent_mac:'B'.repeat(43)},{intent_mac:'A'.repeat(42)+'-'},{intent_mac:'A'.repeat(42)+'\0'},{state:'eligible'},{state:'aborted'},{record:''}])assert.throws(()=>insert(f.db,'continuation_intents',{...r,state:'prepared',...patch}));
 assert.equal(count(f,'continuation_intents'),0);
});
test('uniqueness covers all member identities, aliases and explicit variables',t=>{
 const f=fixture(t);prepare(f);commit(f);const r=f.db.prepare('SELECT * FROM grant_members LIMIT 1').get();
 for(const field of ['grant_id','alias','pairing_identity','credential_variable']){const candidate={...r,grant_id:id(70),alias:'new_alias',pairing_identity:digest(70),credential_variable:'NEW_TOKEN'};candidate[field]=r[field];assert.throws(()=>insert(f.db,'grant_members',candidate));}
 assert.equal(count(f,'grant_members'),2);
});
test('state transitions retain terminal history, forbid resurrection and reject inconsistent readers',t=>{
 const f=fixture(t);prepare(f);commit(f);assert.throws(()=>f.db.exec("UPDATE continuation_intents SET state='prepared'"));
 f.db.exec("UPDATE grant_sets SET state='eligible'");assert.throws(()=>read(f),{code:'continuation_row_mismatch'});f.db.exec("UPDATE continuation_intents SET state='eligible'");assert.equal(read(f).state,'eligible'); // Raw privileged SQL is not an admission API.
 f.db.exec("UPDATE grant_sets SET state='void'");assert.throws(()=>read(f),{code:'continuation_row_mismatch'});assert.throws(()=>f.db.exec("UPDATE grant_sets SET state='eligible'"));assert.throws(()=>f.db.exec("UPDATE continuation_intents SET state='prepared'"));assert.throws(()=>f.db.exec("UPDATE continuation_intents SET state='aborted'"));
});
test('aborted history is retained, cannot be resurrected and cannot supply a new aggregate',t=>{
 const f=fixture(t);prepare(f);commit(f);f.db.exec("UPDATE grant_sets SET state='void'; UPDATE continuation_intents SET state='aborted'");assert.equal(read(f).state,'aborted');assert.throws(()=>commit(f),{code:'continuation_compare_failed'});assert.throws(()=>f.db.exec("UPDATE continuation_intents SET state='prepared'"));assert.throws(()=>prepare(f));assert.equal(count(f,'continuation_intents'),1);
});
for(const [table,column,value] of [['continuation_intents','epoch',id(98)],['continuation_intents','plan_mac',digest(98)],['continuation_intents','target_revision',2],['grant_sets','epoch',id(98)],['grant_sets','membership_mac',digest(98)],['grant_members','alias','swapped'],['grant_members','member_mac',digest(98)],['continuation_attestations','expires_ms',500000],['continuation_attestations','attestation_mac',digest(98)],['continuation_attestations','consumed_intent',null]])test(`authenticated read detects bypassed ${table}.${column} corruption`,t=>{
 const f=fixture(t);prepare(f);commit(f);dropGuards(f.db,table);if(column==='target_revision')f.db.exec('PRAGMA ignore_check_constraints=ON');const key=table==='grant_members'?'grant_id':'id';f.db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${key}=(SELECT ${key} FROM ${table} LIMIT 1)`).run(value);assert.throws(()=>read(f),e=>e.code?.startsWith('continuation_'));
});
test('complete cardinality refuses missing/extra members and cross-record JSON substitutions',t=>{
 const f=fixture(t);prepare(f);commit(f);dropGuards(f.db,'grant_members');const first=f.db.prepare('SELECT * FROM grant_members LIMIT 1').get();f.db.prepare('DELETE FROM grant_members WHERE grant_id=?').run(first.grant_id);assert.throws(()=>read(f),{code:'continuation_row_mismatch'});insert(f.db,'grant_members',first);
 insert(f.db,'grant_members',{...first,grant_id:id(90),alias:'extra',pairing_identity:digest(90),credential_variable:'EXTRA_TOKEN'});assert.throws(()=>read(f),{code:'continuation_row_mismatch'});f.db.prepare('DELETE FROM grant_members WHERE grant_id=?').run(id(90));
 f.db.prepare('UPDATE grant_members SET record=? WHERE grant_id=?').run(JSON.stringify({...JSON.parse(first.record),alias:'swapped'}),first.grant_id);assert.throws(()=>read(f),{code:'continuation_row_mismatch'});
});
test('duplicate JSON keys, noncanonical JSON and unknown fields fail row/JSON agreement',t=>{
 for(const transform of [text=>text.replace('{','{"plan_mac":"duplicate",'),text=>' '+text,text=>JSON.stringify({...JSON.parse(text),extra:true})]){const f=fixture(t);prepare(f);dropGuards(f.db,'continuation_intents');const original=f.db.prepare('SELECT record FROM continuation_intents').get().record;f.db.prepare('UPDATE continuation_intents SET record=?').run(transform(original));assert.throws(()=>read(f),e=>e.code?.startsWith('continuation_'));}
});
test('a real second process cannot write under the parent reserved transaction and observes retained commits',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-continuation-tables-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'state.sqlite'),f=fixture(t,file);prepare(f);commit(f);
 const script=`import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync(process.argv[1]);d.exec('PRAGMA busy_timeout=10');let locked=false;try{d.exec('BEGIN IMMEDIATE')}catch(e){locked=/locked|busy/.test(e.message)};console.log(JSON.stringify({locked,count:d.prepare('SELECT COUNT(*) n FROM continuation_intents').get().n}));d.close();`;
 const run=()=>{const p=spawnSync(process.execPath,['--input-type=module','-e',script,file],{encoding:'utf8',timeout:10000,env:{DO_NOT_TRACK:'1'}});assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);};assert.deepEqual(run(),{locked:true,count:0});f.db.exec('COMMIT');assert.deepEqual(run(),{locked:false,count:1});f.db.exec('BEGIN IMMEDIATE');assert.equal(read(f).state,'set-committed');
});

for(const phase of ['prepared','set-committed'])test(`independent process exit retains only the committed ${phase} checkpoint`,t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-continuation-crash-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'state.sqlite'),f=fixture(t,file);f.db.exec('ROLLBACK');
 const tables=new URL('../lib/continuation-tables.mjs',import.meta.url).href,codec=new URL('../lib/continuation-records.mjs',import.meta.url).href;
 const script=`import fs from 'node:fs';import{DatabaseSync}from'node:sqlite';import{createContinuationRecords}from ${JSON.stringify(codec)};import{prepareContinuationIntent,commitContinuationMembers}from ${JSON.stringify(tables)};const p=JSON.parse(fs.readFileSync(0,'utf8')),db=new DatabaseSync(p.file),records=createContinuationRecords(Buffer.alloc(32,1),Buffer.alloc(32,2),p.binding);db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');prepareContinuationIntent(db,records,p.intent,1000);db.exec('COMMIT');if(p.phase==='set-committed'){db.exec('BEGIN IMMEDIATE');commitContinuationMembers(db,records,p.intent);db.exec('COMMIT');}db.exec('BEGIN IMMEDIATE');process.exit(17);`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{input:JSON.stringify({file,intent:f.intent,binding:f.binding,phase}),encoding:'utf8',timeout:10000,env:{DO_NOT_TRACK:'1'}});assert.equal(result.status,17,result.stderr);f.db.exec('BEGIN IMMEDIATE');assert.equal(read(f).state,phase);assert.equal(count(f,'grant_members'),phase==='prepared'?0:2);assert.equal(count(f,'continuation_attestations'),1);
});

for(const table of continuationTableNames)test(`retained ${table} exposes no hidden replacement identity`,t=>{
 const f=fixture(t);prepare(f);commit(f);
 const before=f.db.prepare(`SELECT * FROM ${table}`).all();
 for(const alias of ['rowid','_rowid_','oid']){
  assert.throws(()=>f.db.prepare(`SELECT ${alias} FROM ${table}`).all(),/no such column/);
  const row=before[0],keys=Object.keys(row);
  assert.throws(()=>f.db.prepare(`INSERT OR REPLACE INTO ${table}(${alias},${keys.join(',')}) VALUES(1,${keys.map(()=>'?').join(',')})`).run(...Object.values(row)),/no column named/);
  assert.throws(()=>f.db.exec(`UPDATE ${table} SET ${alias}=99`),/no such column/);
 }
 assert.deepEqual(f.db.prepare(`SELECT * FROM ${table}`).all(),before);
 assert.equal(read(f).state,'set-committed');
});

for(const malformed of ['ff','c0','e282'])test(`member JSON rejects malformed UTF-8 ${malformed} before decoded-row comparison`,t=>{
 const f=fixture(t);prepare(f);commit(f);dropGuards(f.db,'grant_members');
 const original=f.db.prepare('SELECT grant_id,record FROM grant_members LIMIT 1').get();
 const bytes=Buffer.from(original.record),offset=bytes.indexOf(Buffer.from('peer_4'));
 assert.ok(offset>=0);const damaged=Buffer.concat([bytes.subarray(0,offset),Buffer.from(malformed,'hex'),bytes.subarray(offset+1)]);
 f.db.prepare('UPDATE grant_members SET record=CAST(? AS TEXT) WHERE grant_id=?').run(damaged,original.grant_id);
 assert.throws(()=>read(f),{code:'continuation_store_invalid'});assert.equal(f.db.isTransaction,true);
});
