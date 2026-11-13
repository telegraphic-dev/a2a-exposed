import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {initializeContinuationAuthority,inspectContinuationAuthority,withContinuationAuthorityMaintenance,initializePairingAuthority,inspectPairingAuthority,withPairingAuthorityLease,mutatePairingAuthority} from '../lib/pairing-authority.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const digest=n=>Buffer.alloc(32,n).toString('base64url');
const options={configIdentity:id(1)};
function fixture(t,{schema=3}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-authority-three-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'config.env'),'PEER_TOKEN=synthetic-token\n',{mode:0o600});fs.writeFileSync(path.join(dir,'peers.json'),JSON.stringify({peer:{url:'https://example.com/',token_env:'PEER_TOKEN'}}),{mode:0o600});
 if(schema===3)initializeContinuationAuthority(dir,options);else initializePairingAuthority(dir,options);return dir;
}
function intent(view,{source='file',environment={}}={}){
 const snapshot=view.snapshot(),records=view.records(id(3)),texts=view.readSources(s=>s.sourceTexts());
 const member=records.bindMember({grant_id:id(4),pairing_identity:digest(1),alias:'peer',endpoint:'https://example.com/',credential_variable:'PEER_TOKEN',credential_source:source,trust_record_digest:digest(2),trust_record_version:1,local_id:id(5),local_bundle_digest:digest(3),peer_bundle_digest:digest(4),policy:'required',verification:'independent',pairing_provenance:'local-adoption',pairing_decision_id:id(6)},source==='file'?'synthetic-token':environment.PEER_TOKEN);
 const plan=records.bindPlan({baseline_revision:snapshot.revision,source_mac:records.sourceMac(texts),plan_nonce:digest(5),members:[member],excluded_aliases:[]});
 const attestation=records.bindAttestation(plan,{id:id(7),decision_id:id(8),created_ms:1000,expires_ms:601000,comparisons:[{grant_id:member.grant_id,approved_proposal_digest:digest(6),compared_safety_code:Array(12).fill('10000').join(' '),current_trust_digest:member.trust_record_digest,current_trust_version:1}]});return records.bindIntent(id(9),plan,attestation);
}
const maintain=(dir,fn)=>withContinuationAuthorityMaintenance(dir,options,fn);
function raw(dir,fn){const db=new DatabaseSync(path.join(dir,'pairing-authority.sqlite'));try{return fn(db);}finally{db.close();}}
function child(dir,body){const module=new URL('../lib/pairing-authority.mjs',import.meta.url).href;const script=`import * as a from ${JSON.stringify(module)};const dir=process.argv[1],options={configIdentity:'${id(1)}'};${body}`;const r=spawnSync(process.execPath,['--input-type=module','-e',script,dir],{encoding:'utf8',timeout:10000,env:{DO_NOT_TRACK:'1',TZ:process.env.TZ||'UTC'}});return r;}

test('fresh physical schema 3 starts suspended with a real random epoch and no active set',t=>{
 const dir=fixture(t),r=inspectContinuationAuthority(dir,options);assert.equal(r.schema,3);assert.equal(r.revision,0);assert.match(r.epoch,/^[a-f0-9-]{36}$/);assert.equal(r.suspended,true);assert.equal(r.activeSet,null);assert.equal(r.intentId,null);assert.equal(r.sourceMismatch,false);assert.ok(!JSON.stringify(r).includes('source_hash'));assert.ok(!JSON.stringify(r).includes('recovery_key'));
 raw(dir,db=>{assert.equal(db.prepare('PRAGMA user_version').get().user_version,3);assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n,5);});
 assert.throws(()=>initializeContinuationAuthority(dir,options),{code:'authority_already_exists'});assert.throws(()=>inspectPairingAuthority(dir),{code:'authority_schema'});
});
test('schema-2 stores are preserved and all schema-3 entry points refuse them',async t=>{
 const dir=fixture(t,{schema:2}),file=path.join(dir,'pairing-authority.sqlite'),before=fs.readFileSync(file);
 assert.throws(()=>initializeContinuationAuthority(dir,options),{code:'authority_already_exists'});assert.throws(()=>inspectContinuationAuthority(dir,options),{code:'authority_schema'});await assert.rejects(maintain(dir,()=>assert.fail()),{code:'authority_schema'});assert.deepEqual(fs.readFileSync(file),before);assert.equal(inspectPairingAuthority(dir).revision,0);
});
test('legacy grant leases and file mutation cannot operate on schema 3',async t=>{
 const dir=fixture(t);await assert.rejects(withPairingAuthorityLease(dir,options,()=>assert.fail()),{code:'authority_schema'});assert.throws(()=>mutatePairingAuthority(dir,{...options,expectedRevision:0},()=>assert.fail()),{code:'authority_schema'});assert.equal(inspectContinuationAuthority(dir,options).revision,0);
});
test('maintenance owns one connection across separate explicit transactions and expires every view',async t=>{
 const dir=fixture(t);let saved,records,source;
 await maintain(dir,view=>{saved=view;assert.equal(view.transactionState(),'idle');assert.throws(()=>view.snapshot(),{code:'authority_transaction_required'});view.begin();records=view.records(id(3));view.readSources(s=>{source=s;assert.equal(s.inspectInventory().length,1);});assert.throws(()=>source.inspectInventory(),{code:'authority_snapshot_expired'});view.commit();view.begin();assert.equal(view.snapshot().revision,0);view.rollback();});
 for(const fn of [()=>saved.begin(),()=>saved.commit(),()=>saved.rollback(),()=>saved.snapshot(),()=>saved.transactionState(),()=>records.sourceMac({configEnv:'',peers:'{}'})])assert.throws(fn,{code:'authority_maintenance_expired'});
});
test('I commit atomically consumes attestation, binds real epoch/revision/pending and retains suspension',async t=>{
 const dir=fixture(t);await maintain(dir,view=>{view.begin();const i=intent(view);assert.equal(view.prepareIntent(i,{environment:{},now:1000}).revision,1);assert.equal(view.snapshot().intentId,i.id);view.commit();});
 const r=inspectContinuationAuthority(dir,options);assert.equal(r.revision,1);assert.equal(r.intentId,id(9));assert.equal(r.suspended,true);assert.equal(r.activeSet,null);
 await maintain(dir,view=>{view.begin();assert.equal(view.snapshot().intentId,id(9));view.rollback();});raw(dir,db=>{assert.equal(db.prepare('SELECT consumed_intent FROM continuation_attestations').get().consumed_intent,id(9));assert.equal(db.prepare('SELECT COUNT(*) n FROM grant_sets').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM grant_members').get().n,0);});
});
test('unfinished I transaction rolls back all state; a durable I survives later callback failure',async t=>{
 for(const committed of [false,true]){const dir=fixture(t);await assert.rejects(maintain(dir,view=>{view.begin();view.prepareIntent(intent(view),{environment:{},now:1000});if(committed)view.commit();throw Error('synthetic private detail');}),e=>e.code==='authority_unavailable'&&!e.message.includes('synthetic private'));assert.equal(inspectContinuationAuthority(dir,options).revision,committed?1:0);raw(dir,db=>assert.equal(db.prepare('SELECT COUNT(*) n FROM continuation_attestations').get().n,committed?1:0));}
});
test('returning an open transaction refuses and rollback preserves the prior checkpoint',async t=>{
 const dir=fixture(t);await assert.rejects(maintain(dir,view=>{view.begin();view.prepareIntent(intent(view),{environment:{},now:1000});}),{code:'authority_transaction_open'});assert.equal(inspectContinuationAuthority(dir,options).revision,0);
});
test('reentry from maintenance, ordinary lease and initializers refuses before another connection',async t=>{
 const dir=fixture(t);await maintain(dir,async view=>{view.begin();await assert.rejects(maintain(dir,()=>assert.fail()),{code:'authority_busy'});await assert.rejects(withPairingAuthorityLease(dir,options,()=>assert.fail()),{code:'authority_busy'});assert.throws(()=>initializeContinuationAuthority(dir,options),{code:'authority_already_exists'});view.rollback();});
 const legacy=fixture(t,{schema:2});await withPairingAuthorityLease(legacy,options,async()=>{await assert.rejects(maintain(legacy,()=>assert.fail()),{code:'authority_busy'});});
});
test('source drift, changed effective credentials and expired attestation refuse before consumption',async t=>{
 for(const mode of ['environment','expired','source']){const dir=fixture(t);await maintain(dir,view=>{view.begin();const i=intent(view);if(mode==='source')fs.appendFileSync(path.join(dir,'config.env'),'# drift\n');assert.throws(()=>view.prepareIntent(i,{environment:mode==='environment'?{PEER_TOKEN:'different'}:{},now:mode==='expired'?601000:1000}));if(mode==='source')fs.writeFileSync(path.join(dir,'config.env'),'PEER_TOKEN=synthetic-token\n');view.rollback();});assert.equal(inspectContinuationAuthority(dir,options).revision,0);raw(dir,db=>assert.equal(db.prepare('SELECT COUNT(*) n FROM continuation_attestations').get().n,0));}
});
test('environment-bound I preparation binds actual source and process nonce',async t=>{
 const dir=fixture(t),environment={PEER_TOKEN:'synthetic-environment-token'};await maintain(dir,view=>{view.begin();const i=intent(view,{source:'environment',environment});assert.equal(view.prepareIntent(i,{environment,now:1000}).intentId,i.id);view.commit();});assert.equal(inspectContinuationAuthority(dir,options).suspended,true);
});
test('a real child process is excluded by BEGIN IMMEDIATE but an idle connection owns no SQL lock',async t=>{
 const dir=fixture(t);const run=()=>{const r=child(dir,"try{await a.withContinuationAuthorityMaintenance(dir,options,v=>{v.begin();v.rollback();});console.log('ok')}catch(e){console.log(e.code)}");assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 await maintain(dir,view=>{assert.equal(run(),'ok');view.begin();assert.equal(run(),'authority_busy');view.commit();assert.equal(run(),'ok');});
});
test('separate process exit after I retains the physical checkpoint and rolls back its next transaction',async t=>{
 const dir=fixture(t);let serialized;await maintain(dir,view=>{view.begin();serialized=intent(view);view.rollback();});
 const module=new URL('../lib/pairing-authority.mjs',import.meta.url).href,script=`import fs from 'node:fs';import{withContinuationAuthorityMaintenance}from ${JSON.stringify(module)};const p=JSON.parse(fs.readFileSync(0,'utf8'));await withContinuationAuthorityMaintenance(p.dir,p.options,v=>{v.begin();v.prepareIntent(p.intent,{environment:{},now:1000});v.commit();v.begin();process.exit(17);});`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',script],{input:JSON.stringify({dir,options,intent:serialized}),encoding:'utf8',timeout:10000,env:{DO_NOT_TRACK:'1'}});assert.equal(r.status,17,r.stderr);assert.equal(inspectContinuationAuthority(dir,options).intentId,id(9));
});
test('identical-content marker replacement invalidates the maintenance view',async t=>{
 const dir=fixture(t);await assert.rejects(maintain(dir,view=>{view.begin();fs.renameSync(path.join(dir,'pairing-authority.json'),path.join(dir,'original-marker'));fs.writeFileSync(path.join(dir,'pairing-authority.json'),JSON.stringify({v:1,configIdentity:id(1)}),{mode:0o600});view.snapshot();}),{code:'authority_changed'});
});
test('malformed source refuses fresh initialization before creating authority files',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-three-invalid-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'config.env'),'TOKEN=$(forbidden)\n',{mode:0o600});assert.throws(()=>initializeContinuationAuthority(dir,options),{code:'authority_source_invalid'});assert.equal(fs.existsSync(path.join(dir,'pairing-authority.sqlite')),false);
});
test('SQL constraints refuse replacement, unsuspended-empty state, invalid epoch and fake pending binding',t=>{
 const dir=fixture(t);raw(dir,db=>{db.exec('PRAGMA foreign_keys=ON');for(const sql of ["DELETE FROM authority","INSERT OR REPLACE INTO authority SELECT * FROM authority","UPDATE authority SET suspended=0","UPDATE authority SET suspension_epoch='invalid'",`UPDATE authority SET pending='${id(99)}'`,"UPDATE authority SET revision=-1","UPDATE authority SET recovery_key='invalid'"])assert.throws(()=>db.exec(sql));});assert.equal(inspectContinuationAuthority(dir,options).revision,0);
});
test('authenticated maintenance read detects bypassed immutable intent corruption',async t=>{
 const dir=fixture(t);await maintain(dir,v=>{v.begin();v.prepareIntent(intent(v),{environment:{},now:1000});v.commit();});raw(dir,db=>{db.exec('DROP TRIGGER continuation_intents_immutable');db.prepare('UPDATE continuation_intents SET intent_mac=?').run(digest(99));});await assert.rejects(maintain(dir,v=>{v.begin();}),{code:'authority_unavailable'});
});

test('real pre/post I COMMIT faults expose uncertainty and retain only the durable checkpoint',async t=>{
 for(const when of ['before','after']){const dir=fixture(t),exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql,...args){if(sql==='COMMIT'&&when==='before')throw Error('synthetic precommit');const result=exec.call(this,sql,...args);if(sql==='COMMIT'&&when==='after')throw Error('synthetic postcommit');return result;};
  try{await assert.rejects(maintain(dir,v=>{v.begin();v.prepareIntent(intent(v),{environment:{},now:1000});v.commit();}),e=>e.code==='authority_unavailable'&&e.intentId===id(9)&&e.setId===id(3)&&e.checkpoint==='unknown');}finally{DatabaseSync.prototype.exec=exec;}
  assert.equal(inspectContinuationAuthority(dir,options).revision,when==='after'?1:0);await maintain(dir,v=>{v.begin();v.rollback();});
 }
});
test('strict parsed bytes must match the authority fingerprint even if source paths return to baseline',async t=>{
 const dir=fixture(t),file=path.join(dir,'config.env'),original=fs.readFileSync(file),read=fs.readSync;await maintain(dir,v=>{
  v.begin();const ino=fs.statSync(file).ino;let changed=false,reads=0;
  // The first read belongs to guard; substitute only the exact snapshot read.
  fs.readSync=function(fd,buffer,offset,length,position){const n=read.call(fs,fd,buffer,offset,length,position);if(n>0&&fs.fstatSync(fd).ino===ino&&++reads===2){changed=true;buffer.fill(32,offset,offset+n);Buffer.from('PEER_TOKEN=synthetic-other\n').copy(buffer,offset,0,n);}return n;};
  try{assert.throws(()=>v.readSources(s=>s.sourceTexts()),{code:'authority_external_change'});}finally{fs.readSync=read;}assert.equal(changed,true);assert.deepEqual(fs.readFileSync(file),original);v.rollback();
 });
});
test('revision and epoch changes invalidate a previously authenticated plan before consumption',async t=>{
 for(const column of ['revision','suspension_epoch']){const dir=fixture(t);let i;await maintain(dir,v=>{v.begin();i=intent(v);v.rollback();});raw(dir,db=>db.prepare(`UPDATE authority SET ${column}=?`).run(column==='revision'?1:id(90)));await maintain(dir,v=>{v.begin();assert.throws(()=>v.prepareIntent(i,{environment:{},now:1000}));v.rollback();});raw(dir,db=>assert.equal(db.prepare('SELECT COUNT(*) n FROM continuation_attestations').get().n,0));}
});
test('foreign process cannot prepare an environment-bound persisted plan',async t=>{
 const dir=fixture(t),environment={PEER_TOKEN:'synthetic-environment-token'};let i;await maintain(dir,v=>{v.begin();i=intent(v,{source:'environment',environment});v.rollback();});const module=new URL('../lib/pairing-authority.mjs',import.meta.url).href,script=`import fs from 'node:fs';import{withContinuationAuthorityMaintenance}from ${JSON.stringify(module)};const p=JSON.parse(fs.readFileSync(0,'utf8'));try{await withContinuationAuthorityMaintenance(p.dir,p.options,v=>{v.begin();v.prepareIntent(p.i,{environment:p.environment,now:1000});v.commit();});console.log('unexpected')}catch(e){console.log(e.code)}`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',script],{input:JSON.stringify({dir,options,i,environment}),encoding:'utf8',timeout:10000,env:{DO_NOT_TRACK:'1'}});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),'authority_continuation_changed');assert.equal(inspectContinuationAuthority(dir,options).revision,0);
});
test('continuation inspection authenticates pending intent data without printing private MACs',async t=>{
 const dir=fixture(t);await maintain(dir,v=>{v.begin();v.prepareIntent(intent(v),{environment:{},now:1000});v.commit();});raw(dir,db=>{db.exec('DROP TRIGGER continuation_intents_immutable');db.prepare('UPDATE continuation_intents SET intent_mac=?').run(digest(99));});assert.throws(()=>inspectContinuationAuthority(dir,options),{code:'authority_unavailable'});
});

test('I COMMIT rechecks environment after awaits and refuses expired approval or clock regression',async t=>{
 for(const mode of ['environment','expired','regression']){const dir=fixture(t),environment={PEER_TOKEN:'synthetic-environment-token'},clock=Date.now;await assert.rejects(maintain(dir,async v=>{
  v.begin();v.prepareIntent(intent(v,{source:'environment',environment}),{environment,now:1000});await Promise.resolve();if(mode==='environment')environment.PEER_TOKEN='changed';else{const wall=Date.now();Date.now=()=>wall+(mode==='expired'?600001:-10000);}try{v.commit();}finally{Date.now=clock;}
 }),e=>['authority_continuation_changed','authority_unavailable','authority_clock_regression'].includes(e.code));Date.now=clock;assert.equal(inspectContinuationAuthority(dir,options).revision,0);}
});
