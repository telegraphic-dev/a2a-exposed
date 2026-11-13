import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash,generateKeyPairSync,sign} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {LocalState} from '../local-state.mjs';
import {generateIdentity,canonicalJSON} from '../index.mjs';
import {initializeContinuationAuthority,inspectContinuationAuthority,withContinuationAuthorityMaintenance} from '../../cli/lib/pairing-authority.mjs';
const hash=(label,x)=>createHash('sha256').update(label+'\n'+canonicalJSON(x)).digest('base64url');
async function fixture(t,{source='file',prepare=true,comparison={},foreignConfig=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-phase-two-'));fs.chmodSync(dir,0o700);const sdk=new LocalState(dir,{create:true});t.after(()=>{sdk.close();fs.rmSync(dir,{recursive:true,force:true});});
 fs.writeFileSync(path.join(dir,'config.env'),'PEER_TOKEN=synthetic-token\n',{mode:0o600});fs.writeFileSync(path.join(dir,'peers.json'),JSON.stringify({peer:{url:'https://peer.example.com/rpc',token_env:'PEER_TOKEN'}}),{mode:0o600});
 const options={configIdentity:foreignConfig?randomUUID():sdk.configId()},local=await sdk.initialize({store:'file',cardUrl:'https://local.example.com/card'}),remote=await generateIdentity('https://peer.example.com/card');
 const p=await sdk.propose({peer:'peer',localId:local.id,bundle:remote.bundle,pairingIdentity:Buffer.alloc(32,3).toString('base64url'),peerEndpoint:'https://peer.example.com/rpc',expectedCurrent:'none',policy:'required',verification:'independent'}),approved=await sdk.approve({peer:'peer',digest:p.digest,expectedCurrent:'none',ownerApproved:true,independentVerified:true,verifiedProposalDigest:p.digest});
 initializeContinuationAuthority(dir,options);const environment=source==='file'?{}:{PEER_TOKEN:'synthetic-environment'};let intent;
 const maintain=fn=>withContinuationAuthorityMaintenance(dir,options,fn);
 await maintain(v=>{v.begin();const r=v.records(randomUUID()),trust=approved.record,m=r.bindMember({grant_id:randomUUID(),pairing_identity:trust.pairingIdentity,alias:'peer',endpoint:trust.peerEndpoint,credential_variable:'PEER_TOKEN',credential_source:source,trust_record_digest:approved.digest,trust_record_version:trust.version,local_id:local.id,local_bundle_digest:trust.localBundleDigest,peer_bundle_digest:hash('a2a-exposed sealed bundle v1',remote.bundle),policy:'required',verification:'independent',pairing_provenance:'local-adoption',pairing_decision_id:randomUUID()},source==='file'?'synthetic-token':environment.PEER_TOKEN);
 const plan=r.bindPlan({baseline_revision:0,source_mac:r.sourceMac(v.readSources(s=>s.sourceTexts())),plan_nonce:Buffer.alloc(32,4).toString('base64url'),members:[m],excluded_aliases:[]}),now=Date.now();
 // Synthetic attestation: these tests do not supply human provenance.
 const attestation=r.bindAttestation(plan,{id:randomUUID(),decision_id:randomUUID(),created_ms:now,expires_ms:now+600000,comparisons:[{grant_id:m.grant_id,approved_proposal_digest:p.digest,compared_safety_code:sdk.safetyCode(local.id,'peer').code,current_trust_digest:approved.digest,current_trust_version:trust.version,...comparison}]});intent=r.bindIntent(randomUUID(),plan,attestation);if(prepare)v.prepareIntent(intent,{environment});v.commit();});
 return{dir,sdk,options,intent,environment,maintain,inspect:()=>inspectContinuationAuthority(dir,options)};
}
async function stage(f){return f.maintain(v=>{v.begin();return v.stageIntent(f.intent,f.sdk,{environment:f.environment});});}
function authority(f,fn){const d=new DatabaseSync(path.join(f.dir,'pairing-authority.sqlite'));try{return fn(d);}finally{d.close();}}
const phase=f=>({intent:authority(f,d=>d.prepare('SELECT state FROM continuation_intents').get().state),sdk:f.sdk.db.prepare('SELECT state FROM host_grant_sets').get()?.state||null,sets:authority(f,d=>d.prepare('SELECT COUNT(*) n FROM grant_sets').get().n)});

test('real authority and SDK phase I to S to C retains pending intent and suspension',async t=>{
 const f=await fixture(t),r=await stage(f);assert.equal(r.checkpoint,'C');assert.equal(r.suspended,true);assert.equal(r.activeSet,null);assert.equal(r.intentId,f.intent.id);assert.deepEqual(phase(f),{intent:'set-committed',sdk:'staged',sets:1});assert.equal(f.inspect().revision,1);
 await assert.rejects(stage(f));assert.deepEqual(phase(f),{intent:'set-committed',sdk:'staged',sets:1});
});
test('current SDK readiness holds refuse before S and retain durable I',async t=>{
 for(const mode of ['proposal','retired','lost','revoked']){const f=await fixture(t);if(mode==='proposal')f.sdk.db.prepare("UPDATE proposals SET state='pending'").run();if(mode==='retired')f.sdk.db.prepare("UPDATE identities SET live_state='retired'").run();if(mode==='lost')for(const file of fs.readdirSync(f.sdk.root).filter(x=>x.endsWith('.key')))fs.unlinkSync(path.join(f.sdk.root,file));if(mode==='revoked'){const row=f.sdk.db.prepare('SELECT record FROM trust').get(),r={...JSON.parse(row.record),state:'revoked'};f.sdk.db.prepare('UPDATE trust SET record=?').run(JSON.stringify(r));}await assert.rejects(stage(f),e=>e.intentId===f.intent.id&&e.checkpoint==='unknown');assert.deepEqual(phase(f),{intent:'prepared',sdk:null,sets:0});assert.equal(f.inspect().suspended,true);}
});
test('pre/post SDK COMMIT failures preserve I or S without automatic retry',async t=>{
 for(const when of ['before','after']){const f=await fixture(t),exec=f.sdk.db.exec;f.sdk.db.exec=function(sql,...args){if(sql==='COMMIT'&&when==='before')throw Error('synthetic SDK commit');const r=exec.call(this,sql,...args);if(sql==='COMMIT'&&when==='after')throw Error('synthetic SDK commit');return r;};try{await assert.rejects(stage(f),e=>e.intentId===f.intent.id&&e.checkpoint==='unknown');}finally{f.sdk.db.exec=exec;}assert.deepEqual(phase(f),{intent:'prepared',sdk:when==='after'?'staged':null,sets:0});if(when==='after')await assert.rejects(stage(f));}
});
test('pre/post authority C COMMIT failures retain S or C with no eligibility',async t=>{
 for(const when of ['before','after']){const f=await fixture(t),exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql,...args){if(this!==f.sdk.db&&sql==='COMMIT'&&when==='before')throw Error('synthetic authority commit');const r=exec.call(this,sql,...args);if(this!==f.sdk.db&&sql==='COMMIT'&&when==='after')throw Error('synthetic authority commit');return r;};try{await assert.rejects(stage(f),e=>e.intentId===f.intent.id&&e.checkpoint==='unknown');}finally{DatabaseSync.prototype.exec=exec;}assert.deepEqual(phase(f),{intent:when==='after'?'set-committed':'prepared',sdk:'staged',sets:when==='after'?1:0});assert.equal(f.inspect().activeSet,null);assert.equal(f.inspect().suspended,true);}
});
test('environment change after SDK awaits prevents C while preserving any committed S',async t=>{
 for(const edge of ['readiness','S']){const f=await fixture(t,{source:'environment'});if(edge==='readiness'){const get=f.sdk.privateGet;f.sdk.privateGet=async function(...args){const r=await get.apply(this,args);f.environment.PEER_TOKEN='changed';return r;};}else{const exec=f.sdk.db.exec;f.sdk.db.exec=function(sql,...args){const r=exec.call(this,sql,...args);if(sql==='COMMIT')f.environment.PEER_TOKEN='changed';return r;};}await assert.rejects(stage(f));assert.deepEqual(phase(f),{intent:'prepared',sdk:edge==='S'?'staged':null,sets:0});}
});
test('same-config SDK queue reentry refuses without deadlock or new writes',async t=>{
 const f=await fixture(t);await f.sdk.locked(async()=>{await assert.rejects(stage(f));});assert.deepEqual(phase(f),{intent:'prepared',sdk:null,sets:0});
});


test('physical authority precedes SDK lock and stays reserved across the S to C gap',async t=>{
 const f=await fixture(t),locks=()=>{
  const script="import{DatabaseSync}from'node:sqlite';let r=[];for(const file of process.argv.slice(1)){const d=new DatabaseSync(file);d.exec('PRAGMA busy_timeout=30');try{d.exec('BEGIN IMMEDIATE;ROLLBACK');r.push(true);}catch(e){if(![5,6].includes(e.errcode))throw e;r.push(false);}finally{d.close();}}console.log(JSON.stringify(r));";
  const p=spawnSync(process.execPath,['--input-type=module','-e',script,path.join(f.dir,'pairing-authority.sqlite'),path.join(f.sdk.root,'state.sqlite')],{encoding:'utf8',timeout:5000,env:{DO_NOT_TRACK:'1'}});assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);
 };
 const get=f.sdk.privateGet,exec=f.sdk.db.exec;let checkedS=false;
 f.sdk.privateGet=async function(...args){assert.deepEqual(locks(),[false,false]);return get.apply(this,args);};
 f.sdk.db.exec=function(sql,...args){const r=exec.call(this,sql,...args);if(sql==='COMMIT'){checkedS=true;assert.deepEqual(locks(),[false,true]);}return r;};
 await stage(f);assert.equal(checkedS,true);assert.deepEqual(locks(),[true,true]);assert.equal(f.inspect().suspended,true);
});

test('an SDK adapter that omits its callback cannot report a completed checkpoint',async t=>{
 const f=await fixture(t);await assert.rejects(f.maintain(v=>{v.begin();return v.stageIntent(f.intent,{_withMaintenanceQueue:async()=>{}},{environment:f.environment});}));assert.deepEqual(phase(f),{intent:'prepared',sdk:null,sets:0});
});

async function ready(f,sdk=f.sdk){return f.maintain(v=>{v.begin();return v.readyIntent(f.intent,sdk,{environment:f.environment});});}
test('C to R rechecks ready in a fresh reserved transaction and retains authority suspension',async t=>{
 const f=await fixture(t);await stage(f);const r=await ready(f);assert.equal(r.checkpoint,'R');assert.equal(r.suspended,true);assert.equal(r.activeSet,null);assert.equal(r.intentId,f.intent.id);assert.deepEqual(phase(f),{intent:'set-committed',sdk:'ready',sets:1});
 await assert.rejects(ready(f));assert.deepEqual(phase(f),{intent:'set-committed',sdk:'ready',sets:1});
});
test('R requires durable C and exact SDK staged binding',async t=>{
 for(const mode of ['I','missing','different']){const f=await fixture(t);if(mode!=='I')await stage(f);if(mode==='missing'){f.sdk.db.exec('DROP TRIGGER host_grant_retained');f.sdk.db.prepare('DELETE FROM host_grant_sets').run();}if(mode==='different'){f.sdk.db.exec('DROP TRIGGER host_grant_immutable');f.sdk.db.prepare('UPDATE host_grant_sets SET membership_mac=?').run(Buffer.alloc(32,5).toString('base64url'));}await assert.rejects(ready(f));assert.equal(f.inspect().suspended,true);assert.notEqual(phase(f).sdk,'ready');}
});
test('pre/post R COMMIT failure retains C with staged or ready SDK and unknown checkpoint',async t=>{
 for(const when of ['before','after']){const f=await fixture(t);await stage(f);const exec=f.sdk.db.exec;f.sdk.db.exec=function(sql,...args){if(sql==='COMMIT'&&when==='before')throw Error('synthetic R commit');const r=exec.call(this,sql,...args);if(sql==='COMMIT'&&when==='after')throw Error('synthetic R commit');return r;};try{await assert.rejects(ready(f),e=>e.intentId===f.intent.id&&e.setId===f.intent.record.plan.set_id&&e.checkpoint==='unknown');}finally{f.sdk.db.exec=exec;}assert.deepEqual(phase(f),{intent:'set-committed',sdk:when==='after'?'ready':'staged',sets:1});assert.equal(f.inspect().suspended,true);}
});
test('SDK mutation in R commit gap is observed in the new reserved snapshot',async t=>{
 for(const mode of ['proposal','trust','binding','void']){const f=await fixture(t);await stage(f);const exec=f.sdk.db.exec;let gap=false,mutated=false;f.sdk.db.exec=function(sql,...args){const r=exec.call(this,sql,...args);if(sql==='COMMIT'){gap=true;const script="import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync(process.argv[1]);d.exec(process.argv[2]);d.close();";const change=mode==='proposal'?"UPDATE proposals SET state='pending'":mode==='trust'?"UPDATE trust SET version=version+1":mode==='void'?"UPDATE host_grant_sets SET state='void'":"DROP TRIGGER host_grant_immutable; UPDATE host_grant_sets SET target_revision=target_revision+1";const child=spawnSync(process.execPath,['--input-type=module','-e',script,path.join(f.sdk.root,'state.sqlite'),change],{encoding:'utf8',timeout:5000,env:{DO_NOT_TRACK:'1'}});assert.equal(child.status,0,child.stderr);mutated=true;}return r;};try{await assert.rejects(ready(f));}finally{f.sdk.db.exec=exec;}assert.equal(gap,true);assert.equal(mutated,true);assert.equal(phase(f).intent,'set-committed');assert.equal(f.inspect().activeSet,null);assert.equal(f.inspect().suspended,true);}
});
test('authority and SDK reserved locks cover both readiness passes at R',async t=>{
 const f=await fixture(t);await stage(f);const get=f.sdk.privateGet;let passes=0;
 f.sdk.privateGet=async function(...args){passes++;const script="import{DatabaseSync}from'node:sqlite';let r=[];for(const file of process.argv.slice(1)){const d=new DatabaseSync(file);d.exec('PRAGMA busy_timeout=30');try{d.exec('BEGIN IMMEDIATE;ROLLBACK');r.push(true);}catch(e){if(![5,6].includes(e.errcode))throw e;r.push(false);}finally{d.close();}}console.log(JSON.stringify(r));";const child=spawnSync(process.execPath,['--input-type=module','-e',script,path.join(f.dir,'pairing-authority.sqlite'),path.join(f.sdk.root,'state.sqlite')],{encoding:'utf8',timeout:5000,env:{DO_NOT_TRACK:'1'}});assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),[false,false]);return get.apply(this,args);};
 await ready(f);assert.equal(passes,2);assert.equal(f.inspect().suspended,true);
});
test('environment drift before or after R refuses without eligibility',async t=>{
 for(const edge of ['readiness','R']){const f=await fixture(t,{source:'environment'});await stage(f);if(edge==='readiness'){const get=f.sdk.privateGet;f.sdk.privateGet=async function(...args){const r=await get.apply(this,args);f.environment.PEER_TOKEN='changed';return r;};}else{const exec=f.sdk.db.exec;f.sdk.db.exec=function(sql,...args){const r=exec.call(this,sql,...args);if(sql==='COMMIT')f.environment.PEER_TOKEN='changed';return r;};}await assert.rejects(ready(f));assert.equal(phase(f).sdk,edge==='R'?'ready':'staged');assert.equal(f.inspect().suspended,true);}
});
test('R adapter omission and queue reentry refuse without false completion',async t=>{
 const f=await fixture(t);await stage(f);await assert.rejects(ready(f,{_withMaintenanceQueue:async()=>{}}));await f.sdk.locked(async()=>{await assert.rejects(ready(f));});assert.deepEqual(phase(f),{intent:'set-committed',sdk:'staged',sets:1});
});

test('final read-only rollback failures cannot report R success or eligibility',async t=>{
 for(const side of ['authority','sdk'])for(const when of ['before','after']){const f=await fixture(t);await stage(f);const exec=DatabaseSync.prototype.exec;let injected=false;DatabaseSync.prototype.exec=function(sql,...args){const match=sql==='ROLLBACK'&&(side==='sdk'?this===f.sdk.db:this!==f.sdk.db)&&!injected;if(match){injected=true;if(when==='before')throw Error('synthetic rollback');}const r=exec.call(this,sql,...args);if(match&&when==='after')throw Error('synthetic rollback');return r;};try{await assert.rejects(ready(f),e=>e.intentId===f.intent.id&&e.checkpoint==='unknown');}finally{DatabaseSync.prototype.exec=exec;}assert.equal(injected,true);assert.equal(f.sdk.db.isTransaction,false);assert.deepEqual(phase(f),{intent:'set-committed',sdk:'ready',sets:1});assert.equal(f.inspect().suspended,true);}
});

test('authority close failures after durable R retain original IDs and unknown outcome',async t=>{
 for(const when of ['before','after']){const f=await fixture(t);await stage(f);const close=DatabaseSync.prototype.close;let injected=false,failedDB;DatabaseSync.prototype.close=function(...args){if(this!==f.sdk.db&&!injected){injected=true;failedDB=this;if(when==='before')throw Error('synthetic close');const r=close.apply(this,args);throw Error('synthetic close after');}return close.apply(this,args);};try{await assert.rejects(ready(f),e=>e.intentId===f.intent.id&&e.setId===f.intent.record.plan.set_id&&e.checkpoint==='unknown');}finally{DatabaseSync.prototype.close=close;try{failedDB?.close();}catch{}}assert.equal(injected,true);assert.deepEqual(phase(f),{intent:'set-committed',sdk:'ready',sets:1});assert.equal(f.inspect().suspended,true);}
});

const humanKeys=generateKeyPairSync('ed25519');
function human(f,keys=humanKeys){
 const file=path.join(f.dir,'continuation-human-key.pem');fs.writeFileSync(file,keys.publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
 const signature=sign(null,Buffer.from('a2a-exposed continuation human decision v1\n'+canonicalJSON(f.intent.attestation.attestation)),keys.privateKey).toString('base64url');
 return{file,signature};
}
async function verified(f,signature,sdk=f.sdk){return f.maintain(v=>{v.begin();return v.prepareVerifiedIntent(f.intent,sdk,{signature,environment:f.environment});});}
const emptyPhase=f=>({intent:authority(f,d=>d.prepare('SELECT COUNT(*) n FROM continuation_intents').get().n),attestation:authority(f,d=>d.prepare('SELECT COUNT(*) n FROM continuation_attestations').get().n),sdk:f.sdk.db.prepare('SELECT COUNT(*) n FROM host_grant_sets').get().n,revision:f.inspect().revision});
const empty={intent:0,attestation:0,sdk:0,revision:0};
test('signed exact local decision plus approved-proposal lineage and live readiness commits only suspended I',async t=>{
 const f=await fixture(t,{prepare:false}),{signature}=human(f),result=await verified(f,signature);
 assert.equal(result.checkpoint,'I');assert.equal(result.suspended,true);assert.equal(result.activeSet,null);assert.deepEqual(phase(f),{intent:'prepared',sdk:null,sets:0});
 assert.equal(authority(f,d=>d.prepare('SELECT consumed_intent FROM continuation_attestations').get().consumed_intent),f.intent.id);
 await assert.rejects(verified(f,signature));assert.equal(f.inspect().revision,1);
});
test('missing human evidence, arbitrary booleans and signatures from another key cannot consume an attestation',async t=>{
 for(const mode of ['missing','boolean','invalid','wrong-key','missing-key','permissions','symlink','wrong-type']){
  const f=await fixture(t,{prepare:false});let{file,signature}=human(f);
  if(mode==='missing')signature=undefined;if(mode==='boolean')signature=true;if(mode==='invalid')signature=Buffer.alloc(64,1).toString('base64url');
  if(mode==='wrong-key')signature=sign(null,Buffer.from('a2a-exposed continuation human decision v1\n'+canonicalJSON(f.intent.attestation.attestation)),generateKeyPairSync('ed25519').privateKey).toString('base64url');
  if(mode==='missing-key')fs.unlinkSync(file);if(mode==='permissions')fs.chmodSync(file,0o644);
  if(mode==='symlink'){fs.renameSync(file,file+'.held');fs.symlinkSync(file+'.held',file);}
  if(mode==='wrong-type')fs.writeFileSync(file,generateKeyPairSync('x25519').publicKey.export({type:'spki',format:'pem'}));
  await assert.rejects(verified(f,signature));assert.deepEqual(emptyPhase(f),empty);
 }
});
test('even a signed decision must match locally computed code and an approved proposal for the current record',async t=>{
 for(const mode of ['wrong-code','wrong-proposal','pending','rejected','missing','proposal-tamper','version','revoke']){
  const f=await fixture(t,{prepare:false,comparison:mode==='wrong-code'?{compared_safety_code:Array(12).fill('00000').join(' ')}:mode==='wrong-proposal'?{approved_proposal_digest:Buffer.alloc(32,9).toString('base64url')}:{}}),{signature}=human(f);
  if(mode==='pending'||mode==='rejected')f.sdk.db.prepare('UPDATE proposals SET state=?').run(mode);
  if(mode==='missing')f.sdk.db.prepare('DELETE FROM proposals').run();
  if(mode==='proposal-tamper'){const p=JSON.parse(f.sdk.db.prepare('SELECT proposal FROM proposals').get().proposal);p.peerEndpoint='https://peer.example.com/other';f.sdk.db.prepare('UPDATE proposals SET proposal=?').run(JSON.stringify(p));}
  if(mode==='version')f.sdk.db.prepare('UPDATE proposals SET expected_version=expected_version+1').run();
  if(mode==='revoke'){const r=JSON.parse(f.sdk.db.prepare('SELECT record FROM trust').get().record);r.state='revoked';f.sdk.db.prepare('UPDATE trust SET record=?').run(JSON.stringify(r));}
  await assert.rejects(verified(f,signature));assert.deepEqual(emptyPhase(f),empty);
 }
});
test('pre-I readiness holds refuse without storing intent, attestation or SDK stage',async t=>{
 for(const mode of ['lost','native','retired','archive','key-operation']){
  const f=await fixture(t,{prepare:false}),{signature}=human(f);
  if(mode==='lost')for(const file of fs.readdirSync(f.sdk.root).filter(x=>x.endsWith('.key')))fs.unlinkSync(path.join(f.sdk.root,file));
  if(mode==='native')f.sdk.db.prepare("UPDATE identities SET store='keychain'").run();
  if(mode==='retired')f.sdk.db.prepare("UPDATE identities SET live_state='retired'").run();
  if(mode==='archive')f.sdk.db.prepare("INSERT INTO meta VALUES('restore_paused','1')").run();
  if(mode==='key-operation')f.sdk.db.prepare('INSERT INTO key_operations VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),'rotate','{}','synthetic','uncertain',1,1,null,0);
  await assert.rejects(verified(f,signature));assert.deepEqual(emptyPhase(f),empty);
 }
});
test('human trust root, sources and environment are rechecked after every SDK await',async t=>{
 for(const mode of ['key-bytes','key-instance','sources','environment','expiry']){
  const f=await fixture(t,{prepare:false,source:mode==='environment'?'environment':'file'}),{file,signature}=human(f),get=f.sdk.privateGet,clock=Date.now;
  f.sdk.privateGet=async function(...args){const r=await get.apply(this,args);if(mode==='key-bytes')fs.writeFileSync(file,generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}));if(mode==='key-instance'){const bytes=fs.readFileSync(file);fs.renameSync(file,file+'.held');fs.writeFileSync(file,bytes,{mode:0o600});}if(mode==='sources')fs.appendFileSync(path.join(f.dir,'config.env'),'#changed\n');if(mode==='environment')f.environment.PEER_TOKEN='changed';if(mode==='expiry'){const now=clock();Date.now=()=>now+600001;}return r;};
  try{await assert.rejects(verified(f,signature));}finally{Date.now=clock;}
  assert.deepEqual(emptyPhase(f),empty);
 }
});
test('authority and SDK reserved locks cover private-key awaits and pre-I authority COMMIT',async t=>{
 const f=await fixture(t,{prepare:false}),{signature}=human(f),get=f.sdk.privateGet,exec=DatabaseSync.prototype.exec;let checkedAwait=false,checkedCommit=false;
 const locks=()=>{const child=spawnSync(process.execPath,['--input-type=module','-e',"import{DatabaseSync}from'node:sqlite';let r=[];for(const file of process.argv.slice(1)){const d=new DatabaseSync(file);d.exec('PRAGMA busy_timeout=30');try{d.exec('BEGIN IMMEDIATE;ROLLBACK');r.push(true);}catch(e){if(![5,6].includes(e.errcode))throw e;r.push(false);}finally{d.close();}}console.log(JSON.stringify(r));",path.join(f.dir,'pairing-authority.sqlite'),path.join(f.sdk.root,'state.sqlite')],{encoding:'utf8',timeout:5000,env:{DO_NOT_TRACK:'1'}});assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout);};
 f.sdk.privateGet=async function(...args){checkedAwait=true;assert.deepEqual(locks(),[false,false]);return get.apply(this,args);};
 DatabaseSync.prototype.exec=function(sql,...args){if(this!==f.sdk.db&&sql==='COMMIT'){checkedCommit=true;assert.deepEqual(locks(),[false,false]);}return exec.call(this,sql,...args);};
 try{await verified(f,signature);}finally{DatabaseSync.prototype.exec=exec;}
 assert.equal(checkedAwait,true);assert.equal(checkedCommit,true);assert.deepEqual(locks(),[true,true]);assert.equal(f.inspect().suspended,true);
});
test('pre/post I COMMIT and SDK release failures preserve IDs and never report success',async t=>{
 for(const mode of ['before','after','sdk-release']){
  const f=await fixture(t,{prepare:false}),{signature}=human(f),exec=DatabaseSync.prototype.exec;let injected=false;
  DatabaseSync.prototype.exec=function(sql,...args){const hit=!injected&&(mode==='sdk-release'?this===f.sdk.db&&sql==='ROLLBACK':this!==f.sdk.db&&sql==='COMMIT');if(hit){injected=true;if(mode==='before'||mode==='sdk-release')throw Error('synthetic pre-I fault');}const r=exec.call(this,sql,...args);if(hit&&mode==='after')throw Error('synthetic post-I fault');return r;};
  try{await assert.rejects(verified(f,signature),e=>e.intentId===f.intent.id&&e.setId===f.intent.record.plan.set_id&&e.checkpoint==='unknown');}finally{DatabaseSync.prototype.exec=exec;}
  assert.equal(injected,true);if(mode==='before')assert.deepEqual(emptyPhase(f),empty);else assert.deepEqual(phase(f),{intent:'prepared',sdk:null,sets:0});assert.equal(f.inspect().suspended,true);assert.equal(f.sdk.db.isTransaction,false);
 }
});
test('omitted SDK callback and queue reentry cannot create I',async t=>{
 const f=await fixture(t,{prepare:false}),{signature}=human(f);await assert.rejects(verified(f,signature,{_withMaintenanceQueue:async()=>{}}));await f.sdk.locked(async()=>{await assert.rejects(verified(f,signature));});assert.deepEqual(emptyPhase(f),empty);
});

test('a valid signature cannot cross configurations or newly bound plans and comparison decisions',async t=>{
 const first=await fixture(t,{prepare:false}),signed=human(first),second=await fixture(t,{prepare:false});human(second);await assert.rejects(verified(second,signed.signature),{code:'authority_human_signature_invalid'});assert.deepEqual(emptyPhase(second),empty);
 await first.maintain(v=>{v.begin();const r=v.records(first.intent.record.plan.set_id),a=first.intent.attestation.attestation,plan={plan:first.intent.record.plan,membership_mac:first.intent.record.membership_mac,plan_mac:first.intent.record.plan_mac};const changed=r.bindAttestation(plan,{id:a.id,decision_id:randomUUID(),created_ms:a.created_ms,expires_ms:a.expires_ms,comparisons:a.comparisons.map(c=>({grant_id:c.grant_id,approved_proposal_digest:c.approved_proposal_digest,compared_safety_code:first.sdk.safetyCode(first.intent.record.plan.members[0].local_id,'peer').code,current_trust_digest:c.current_trust_digest,current_trust_version:c.current_trust_version}))});first.intent=r.bindIntent(first.intent.id,plan,changed);v.rollback();});
 await assert.rejects(verified(first,signed.signature),{code:'authority_human_signature_invalid'});assert.deepEqual(emptyPhase(first),empty);
});

test('pre-I cannot consume a human decision with an SDK from another configuration',async t=>{
 const f=await fixture(t,{prepare:false,foreignConfig:true}),{signature}=human(f);await assert.rejects(verified(f,signature));assert.deepEqual(emptyPhase(f),empty);
});
