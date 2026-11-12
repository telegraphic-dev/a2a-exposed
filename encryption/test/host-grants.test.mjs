import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {LocalState,restoreBackup} from '../local-state.mjs';
import {openBackup,sealBackup} from '../backup.mjs';
const host={assertAuthority:()=>true,withAuthorityLease:async run=>run()}; // Synthetic, not physical authority.
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-host-grants-')),state=new LocalState(dir,{create:true});t.after(()=>{state.close();fs.rmSync(dir,{recursive:true,force:true});});const binding={config_id:state.configId(),intent_id:randomUUID(),set_id:randomUUID(),epoch:randomUUID(),target_revision:1,membership_mac:Buffer.alloc(32,1).toString('base64url')};return{state,dir,binding};}
const snapshot=x=>JSON.parse(JSON.stringify(x));
const fields=['config_id','intent_id','set_id','epoch','target_revision','membership_mac'];
async function transaction(state,action){return state._withMaintenanceQueue(host,q=>{q.begin();const result=action(q);q.commit();return result;});}
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('exact staged/ready/void records persist but do not create keys, trust or grant eligibility',async t=>{
 const {state,dir,binding}=fixture(t);assert.equal(state.db.prepare('PRAGMA user_version').get().user_version,6);
 assert.equal(await transaction(state,q=>q.inspectGrant(binding.intent_id)),null);
 const first=await transaction(state,q=>q.stageGrant(binding));assert.deepEqual(first,{...binding,state:'staged'});assert.deepEqual(await transaction(state,q=>q.stageGrant(binding)),first);
 assert.equal((await transaction(state,q=>q.transitionGrant(binding,'staged','ready'))).state,'ready');assert.equal((await transaction(state,q=>q.transitionGrant(binding,'ready','void'))).state,'void');
 const other=new LocalState(dir);t.after(()=>other.close());assert.equal(other.db.prepare('SELECT state FROM host_grant_sets').get().state,'void');assert.deepEqual(state.status().identities,[]);assert.equal(state.db.prepare('SELECT COUNT(*) n FROM trust').get().n,0);assert.ok(!Object.hasOwn(state.status(),'grants_eligible'));
});
test('immutable binding and generation uniqueness refuse composition, stale state and resurrection',async t=>{
 const {state,binding}=fixture(t);await transaction(state,q=>q.stageGrant(binding));
 for(const patch of [{membership_mac:Buffer.alloc(32,2).toString('base64url')},{set_id:randomUUID()},{target_revision:2}])await assert.rejects(transaction(state,q=>q.stageGrant({...binding,...patch})),{code:'host_grant_conflict'});
 for(const patch of [{intent_id:randomUUID()},{intent_id:randomUUID(),set_id:randomUUID()}])await assert.rejects(transaction(state,q=>q.stageGrant({...binding,...patch})),{code:'host_grant_conflict'});
 await assert.rejects(transaction(state,q=>q.transitionGrant(binding,'ready','void')),{code:'host_grant_stale'});await transaction(state,q=>q.transitionGrant(binding,'staged','void'));
 await assert.rejects(transaction(state,q=>q.stageGrant(binding)),{code:'host_grant_conflict'});await assert.rejects(transaction(state,q=>q.transitionGrant(binding,'staged','ready')),{code:'host_grant_stale'});
 for(const [from,to]of [['void','ready'],['ready','staged'],['void','staged'],['ready','ready']])await assert.rejects(transaction(state,q=>q.transitionGrant(binding,from,to)),{code:'host_grant_transition'});
 assert.equal((await transaction(state,q=>q.inspectGrant(binding.intent_id))).state,'void');
});
test('SQL constraints/triggers independently enforce canonical bindings, initial state and retained monotonic transitions',t=>{
 const {state,binding}=fixture(t),insert=state.db.prepare('INSERT INTO host_grant_sets VALUES(?,?,?,?,?,?,?)');
 for(const patch of [{config_id:randomUUID()},{config_id:binding.config_id.toUpperCase()},{intent_id:'invalid'}, {set_id:binding.set_id+'\0'},{epoch:'a'.repeat(36)},{target_revision:-1},{target_revision:1.5},{target_revision:9007199254740992},{membership_mac:'B'.repeat(43)},{membership_mac:'A'.repeat(42)+'-'},{membership_mac:'A'.repeat(42)+'\0'}]){const r={...binding,...patch};assert.throws(()=>insert.run(...fields.map(k=>r[k]),'staged'));}
 for(const stateName of ['ready','void','unknown'])assert.throws(()=>insert.run(...fields.map(k=>binding[k]),stateName));
 insert.run(...fields.map(k=>binding[k]),'staged');const duplicateGeneration={...binding,intent_id:randomUUID(),set_id:randomUUID()};assert.throws(()=>insert.run(...fields.map(k=>duplicateGeneration[k]),'staged'));assert.throws(()=>state.db.prepare('UPDATE host_grant_sets SET membership_mac=?').run(Buffer.alloc(32,2).toString('base64url')));assert.throws(()=>state.db.exec('DELETE FROM host_grant_sets'));
 state.db.exec("UPDATE host_grant_sets SET state='ready'");assert.throws(()=>state.db.exec("UPDATE host_grant_sets SET state='staged'"));state.db.exec("UPDATE host_grant_sets SET state='void'");assert.throws(()=>state.db.exec("UPDATE host_grant_sets SET state='ready'"));assert.throws(()=>state.db.prepare('INSERT OR REPLACE INTO host_grant_sets VALUES(?,?,?,?,?,?,?)').run(...fields.map(k=>binding[k]),'staged'));assert.equal(state.db.prepare('SELECT state FROM host_grant_sets').get().state,'void');
});
test('record snapshots precede host callbacks, getters do not run and operations require live transactions',async t=>{
 const {state,binding}=fixture(t);let calls=0,escaped;const malicious={...binding};Object.defineProperty(malicious,'membership_mac',{enumerable:true,get(){calls++;return binding.membership_mac;}});
 await assert.rejects(transaction(state,q=>q.stageGrant(malicious)),{code:'host_grant_invalid'});assert.equal(calls,0);
 const input={...binding},original=snapshot(binding);let mutate=false;
 await state._withMaintenanceQueue({withAuthorityLease:async run=>run(),assertAuthority:()=>{if(mutate)input.membership_mac='invalid-after-snapshot';return true;}},q=>{escaped=q;assert.throws(()=>q.stageGrant(binding),{code:'maintenance_transaction_state'});q.begin();mutate=true;const result=q.stageGrant(input);assert.equal(result.membership_mac,original.membership_mac);q.commit();});
 assert.throws(()=>escaped.inspectGrant(binding.intent_id),{code:'maintenance_queue_expired'});assert.equal((await transaction(state,q=>q.inspectGrant(binding.intent_id))).membership_mac,original.membership_mac);
 for(const patch of [{config_id:randomUUID()},{target_revision:'1'},{membership_mac:'not-a-mac'},{extra:true}])await assert.rejects(transaction(state,q=>q.stageGrant({...binding,intent_id:randomUUID(),...patch})),e=>['host_grant_invalid','host_grant_config'].includes(e.code));
});
test('real pre/post COMMIT faults preserve only actual staging effects',async t=>{
 for(const when of ['before','after']){
  const {state,binding}=fixture(t),exec=state.db.exec;state.db.exec=function(sql,...args){if(sql==='COMMIT'&&when==='before')throw Error('synthetic precommit');const result=exec.call(this,sql,...args);if(sql==='COMMIT'&&when==='after')throw Error('synthetic postcommit');return result;};
  try{await assert.rejects(transaction(state,q=>q.stageGrant(binding)),{code:'state_unavailable'});}finally{state.db.exec=exec;}
  assert.equal(state.db.prepare('SELECT COUNT(*) n FROM host_grant_sets').get().n,when==='after'?1:0);
 }
});
test('schema-five draft files are refused byte-for-byte without recreating schema-six objects',t=>{
 const {state,dir}=fixture(t);state.db.exec('DROP TRIGGER host_grant_noreplace;DROP TRIGGER host_grant_initial;DROP TRIGGER host_grant_config;DROP TRIGGER host_grant_immutable;DROP TRIGGER host_grant_retained;DROP TRIGGER host_grant_transition;DROP TABLE host_grant_sets;PRAGMA user_version=5');state.close();const file=path.join(dir,'encryption/state.sqlite'),before=digest(file);assert.throws(()=>new LocalState(dir,{create:true}),{code:'state_version_unsupported'});assert.equal(digest(file),before);const db=new DatabaseSync(file,{readOnly:true});try{assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='host_grant_sets'").get().n,0);}finally{db.close();}
});
test('nonempty staged history refuses backup before private credential reads or output creation',async t=>{
 const {state,dir,binding}=fixture(t),own=await state.initialize({store:'file',cardUrl:'https://example.com/card'});await transaction(state,q=>q.stageGrant(binding));
 // If backup tried reading a private credential it would now fail with key_file, not the host-row refusal.
 fs.unlinkSync(path.join(state.root,own.id+'.key'));const output=path.join(dir,'no-backup.json');for(const phase of ['staged','ready','void']){if(phase==='ready')await transaction(state,q=>q.transitionGrant(binding,'staged','ready'));if(phase==='void')await transaction(state,q=>q.transitionGrant(binding,'ready','void'));await assert.rejects(state.createBackup({destination:output,passphrase:Buffer.from('synthetic passphrase')}),{code:'backup_host_grants_unsupported'});assert.equal(fs.existsSync(output),false);}assert.equal(state.db.prepare('SELECT COUNT(*) n FROM host_grant_sets').get().n,1);
});
test('empty-host snapshots still restore archive-only; imported host approvals refuse before target creation',async t=>{
 const {state,dir,binding}=fixture(t);await state.initialize({store:'file',cardUrl:'https://example.com/card'});const passphrase=Buffer.from('synthetic passphrase'),source=path.join(dir,'snapshot.json');await state.createBackup({destination:source,passphrase});
 const payload=openBackup(fs.readFileSync(source,'utf8'),passphrase);assert.equal(payload.schema,6);assert.deepEqual(payload.rows.host_grant_sets,[]);
 const archive=path.join(dir,'archive');const result=await restoreBackup({source,destination:archive,passphrase,store:'file',acknowledgeReplayRollback:true});assert.equal(result.archive_only,true);
 payload.rows.host_grant_sets=[{...binding,state:'staged'}];const altered=path.join(dir,'with-host.json');fs.writeFileSync(altered,sealBackup(payload,passphrase),{mode:0o600});const blocked=path.join(dir,'blocked');await assert.rejects(restoreBackup({source:altered,destination:blocked,passphrase,store:'file',acknowledgeReplayRollback:true}),{code:'backup_host_grants_unsupported'});assert.equal(fs.existsSync(blocked),false);
});
