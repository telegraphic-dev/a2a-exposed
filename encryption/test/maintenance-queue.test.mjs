import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {setImmediate as tick} from 'node:timers/promises';
import {LocalState} from '../local-state.mjs';
import {DatabaseSync} from 'node:sqlite';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-sdk-queue-')),state=new LocalState(dir,{create:true});t.after(()=>{state.close();fs.rmSync(dir,{recursive:true,force:true});});return{dir,state};}
const host=()=>{let active=false,approved=true;return{options:{assertAuthority:()=>active&&approved,withAuthorityLease:async run=>{active=true;try{return await run();}finally{active=false;}}},revoke(){approved=false;}};};
const row=(s,key)=>s.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;
const put=(s,key,value)=>s.db.prepare('INSERT INTO meta VALUES(?,?)').run(key,value);
function childWriter(dir){
 const script=`import{LocalState}from ${JSON.stringify(new URL('../local-state.mjs',import.meta.url).href)};const s=new LocalState(process.argv[1],{write:true});let result;try{s.db.exec('PRAGMA busy_timeout=30;BEGIN IMMEDIATE');s.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run('synthetic-child','written');s.db.exec('COMMIT');result={written:true};}catch(e){try{s.db.exec('ROLLBACK');}catch{}result={written:false,busy:[5,6].includes(e.errcode)};}finally{s.close();}process.stdout.write(JSON.stringify(result));`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script,dir],{encoding:'utf8',timeout:5000,env:{DO_NOT_TRACK:'1',A2A_NO_UPDATE_CHECK:'1',TZ:process.env.TZ||'UTC'}});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}

test('maintenance keeps the shared SDK queue across distinct durable commits',async t=>{
 const {state,dir}=fixture(t),other=new LocalState(dir,{write:true});t.after(()=>other.close());const entered=deferred(),release=deferred(),authority=host();let writerRan=false,escaped;
 const pending=state._withMaintenanceQueue(authority.options,async q=>{escaped=q;q.begin();put(state,'synthetic-first','durable');q.commit();entered.resolve();await release.promise;q.begin();put(state,'synthetic-second','durable');q.commit();return 'complete';});
 await entered.promise;assert.equal(row(other,'synthetic-first'),'durable');assert.equal(row(other,'synthetic-second'),undefined);const queued=other.locked(async()=>{writerRan=true;put(other,'synthetic-normal','queued');});await tick();await tick();assert.equal(writerRan,false);assert.throws(()=>state.close(),{code:'maintenance_queue_active'});
 release.resolve();assert.equal(await pending,'complete');await queued;assert.equal(writerRan,true);assert.equal(row(state,'synthetic-second'),'durable');assert.equal(row(state,'synthetic-normal'),'queued');for(const name of ['begin','commit','rollback','transactionState'])assert.throws(()=>escaped[name](),{code:'maintenance_queue_expired'});
});
test('unfinished transaction rolls back while an earlier committed stage survives a callback failure',async t=>{
 const {state}=fixture(t);await assert.rejects(state._withMaintenanceQueue(host().options,async q=>{q.begin();put(state,'synthetic-first','committed');q.commit();q.begin();put(state,'synthetic-second','rollback');throw Error('synthetic private error must not escape');}),e=>e.code==='state_unavailable'&&!e.message.includes('synthetic private'));
 assert.equal(row(state,'synthetic-first'),'committed');assert.equal(row(state,'synthetic-second'),undefined);await state.locked(async()=>put(state,'synthetic-released','yes'));assert.equal(row(state,'synthetic-released'),'yes');
});
test('returning with an open transaction refuses and rolls back only that transaction',async t=>{
 const {state}=fixture(t);await assert.rejects(state._withMaintenanceQueue(host().options,q=>{q.begin();put(state,'synthetic-open','not-committed');}),{code:'maintenance_transaction_open'});assert.equal(row(state,'synthetic-open'),undefined);
 await state._withMaintenanceQueue(host().options,q=>{assert.equal(q.transactionState(),'idle');assert.throws(()=>q.commit(),{code:'maintenance_transaction_state'});q.begin();assert.equal(q.transactionState(),'open');assert.throws(()=>q.begin(),{code:'maintenance_transaction_state'});q.rollback();assert.throws(()=>q.rollback(),{code:'maintenance_transaction_state'});});
});
test('queue reentry refuses before another authority acquisition rather than deadlocking',async t=>{
 const {state}=fixture(t);let acquisitions=0;await state._withMaintenanceQueue(host().options,async()=>{
  await assert.rejects(state.locked(async()=>assert.fail('must not run')),{code:'state_queue_reentry'});
  await assert.rejects(state._withMaintenanceQueue({assertAuthority:()=>true,withAuthorityLease:async run=>{acquisitions++;return run();}},()=>assert.fail('must not run')),{code:'state_queue_reentry'});
 });
 await state.locked(async()=>{await assert.rejects(state._withMaintenanceQueue({assertAuthority:()=>true,withAuthorityLease:async run=>{acquisitions++;return run();}},()=>assert.fail('must not run')),{code:'state_queue_reentry'});});assert.equal(acquisitions,0);
});
test('ordinary cross-root queue nesting is allowed but a cycle back to an owned root refuses',async t=>{
 const a=fixture(t).state,b=fixture(t).state;await a.locked(async()=>b.locked(async()=>{await assert.rejects(a.locked(async()=>{}),{code:'state_queue_reentry'});}));
});
test('authority is required at each transaction boundary and after a committed stage',async t=>{
 const {state}=fixture(t),authority=host();await assert.rejects(state._withMaintenanceQueue(authority.options,q=>{q.begin();put(state,'synthetic-first','committed');q.commit();authority.revoke();q.begin();}),{code:'maintenance_authorization_changed'});assert.equal(row(state,'synthetic-first'),'committed');
 let calls=0;for(const assertAuthority of [()=>false,()=>1,async()=>true,async()=>{throw Error('synthetic private guard');}])await assert.rejects(state._withMaintenanceQueue({withAuthorityLease:async run=>run(),assertAuthority},()=>calls++),{code:'maintenance_authorization_changed'});assert.equal(calls,0);
});
test('real pre/post COMMIT faults retain the correct stage without a rollback promise',async t=>{
 for(const when of ['before','after']){
  const {state}=fixture(t),exec=state.db.exec;state.db.exec=function(sql,...args){if(sql==='COMMIT'&&when==='before')throw Error('synthetic precommit');const result=exec.call(this,sql,...args);if(sql==='COMMIT'&&when==='after')throw Error('synthetic postcommit');return result;};
  try{await assert.rejects(state._withMaintenanceQueue(host().options,q=>{q.begin();put(state,'synthetic-stage','value');q.commit();}),{code:'state_unavailable'});}finally{state.db.exec=exec;}
  assert.equal(row(state,'synthetic-stage'),when==='after'?'value':undefined);await state.locked(async()=>put(state,'synthetic-next','works'));
 }
});
test('missing, double and fire-and-forget host invocation cannot run an unguarded callback',async t=>{
 const {state}=fixture(t);let calls=0,late;
 await assert.rejects(state._withMaintenanceQueue({assertAuthority:()=>true,withAuthorityLease:async run=>{late=run;}},()=>calls++),{code:'maintenance_queue_invalid'});assert.throws(()=>late(),{code:'maintenance_queue_invalid'});
 await assert.rejects(state._withMaintenanceQueue({assertAuthority:()=>true,withAuthorityLease:async run=>{run();return run();}},()=>calls++),{code:'maintenance_queue_invalid'});
 let active=false;await assert.rejects(state._withMaintenanceQueue({assertAuthority:()=>active,withAuthorityLease:run=>{active=true;run();active=false;}},()=>calls++),e=>['maintenance_queue_invalid','maintenance_authorization_changed'].includes(e.code));assert.equal(calls,0);
});
test('readonly, missing and restored stores cannot start maintenance writes',async t=>{
 const {state,dir}=fixture(t),readonly=new LocalState(dir);t.after(()=>readonly.close());let calls=0;
 await assert.rejects(readonly._withMaintenanceQueue(host().options,()=>calls++),{code:'state_readonly'});
 state.db.prepare("INSERT INTO meta VALUES('restore_paused','1')").run();await assert.rejects(state._withMaintenanceQueue(host().options,()=>calls++),{code:'restore_archive_only'});
 const missing=new LocalState(path.join(dir,'missing'));t.after(()=>missing.close());await assert.rejects(missing._withMaintenanceQueue(host().options,()=>calls++),{code:'keys_unconfigured'});assert.equal(calls,0);
});
test('physical SQLite transaction excludes a child writer; an idle queue alone does not',async t=>{
 const {state,dir}=fixture(t);await state._withMaintenanceQueue(host().options,q=>{q.begin();assert.deepEqual(childWriter(dir),{written:false,busy:true});q.commit();assert.deepEqual(childWriter(dir),{written:true});q.begin();assert.equal(row(state,'synthetic-child'),'written');assert.deepEqual(childWriter(dir),{written:false,busy:true});q.rollback();});
 assert.deepEqual(childWriter(dir),{written:true});
});

test('authority changes at real BEGIN/COMMIT edges refuse and retain only actually committed data',async t=>{
 for(const edge of ['BEGIN IMMEDIATE','COMMIT']){
  const {state}=fixture(t),authority=host(),exec=state.db.exec;let inserted=false;
  state.db.exec=function(sql,...args){const result=exec.call(this,sql,...args);if(sql===edge)authority.revoke();return result;};
  try{await assert.rejects(state._withMaintenanceQueue(authority.options,q=>{q.begin();inserted=true;put(state,'synthetic-edge','value');q.commit();}),{code:'maintenance_authorization_changed'});}finally{state.db.exec=exec;}
  assert.equal(inserted,edge==='COMMIT');assert.equal(row(state,'synthetic-edge'),edge==='COMMIT'?'value':undefined);
 }
});
test('ordinary writers queued before an archive hold recheck it before running',async t=>{
 const {state}=fixture(t),entered=deferred(),release=deferred();let ran=false;
 const maintenance=state._withMaintenanceQueue(host().options,async()=>{entered.resolve();await release.promise;});const heldResult=assert.rejects(maintenance,{code:'restore_archive_only'});await entered.promise;
 const normal=state.locked(async()=>{ran=true;put(state,'synthetic-forbidden','no');});const normalResult=assert.rejects(normal,{code:'restore_archive_only'});await tick();
 // Synthetic durable external policy change, not a permitted maintenance action.
 state.db.prepare("INSERT INTO meta VALUES('restore_paused','1')").run();release.resolve();await Promise.all([heldResult,normalResult]);assert.equal(ran,false);assert.equal(row(state,'synthetic-forbidden'),undefined);assert.equal(row(state,'restore_paused'),'1');
});


test('C/E phase exit may validate a committed authority transition without permitting a new SDK write',async t=>{
 for(const phase of ['C','E']){
  const {state,dir}=fixture(t),file=path.join(dir,'synthetic-authority.sqlite');fs.writeFileSync(file,'',{flag:'wx',mode:0o600});const authority=new DatabaseSync(file);t.after(()=>authority.close());authority.exec("CREATE TABLE phase(value TEXT);INSERT INTO phase VALUES('held')");let held=false,scope=false;const stages=[];
  const options={withAuthorityLease:async run=>{authority.exec('BEGIN IMMEDIATE');held=true;scope=true;try{return await run();}finally{scope=false;held=false;try{authority.exec('ROLLBACK');}catch{}}},assertAuthority:stage=>{stages.push(stage);return scope&&(held||stage==='exit'&&authority.prepare('SELECT value FROM phase').get().value===phase);}};
  assert.equal(await state._withMaintenanceQueue(options,q=>{
   q.begin();put(state,'synthetic-ready','durable');q.commit();if(phase==='E'){q.begin();assert.deepEqual(childWriter(dir),{written:false,busy:true});}
   authority.prepare('UPDATE phase SET value=?').run(phase);authority.exec('COMMIT');held=false;
   if(phase==='E')q.rollback();assert.throws(()=>q.begin(),{code:'maintenance_authorization_changed'});return phase;
  }),phase);assert.equal(row(state,'synthetic-ready'),'durable');assert.ok(stages.includes('entry'));assert.ok(stages.includes('transaction'));assert.equal(stages.at(-1),'exit');
 }
});
