import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {LocalState} from '../local-state.mjs';
import {generateIdentity,canonicalJSON} from '../index.mjs';
import {initializeContinuationAuthority,inspectContinuationAuthority,withContinuationAuthorityMaintenance} from '../../cli/lib/pairing-authority.mjs';
const hash=(label,x)=>createHash('sha256').update(label+'\n'+canonicalJSON(x)).digest('base64url');
async function fixture(t,{source='file'}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-phase-two-'));fs.chmodSync(dir,0o700);const sdk=new LocalState(dir,{create:true});t.after(()=>{sdk.close();fs.rmSync(dir,{recursive:true,force:true});});
 fs.writeFileSync(path.join(dir,'config.env'),'PEER_TOKEN=synthetic-token\n',{mode:0o600});fs.writeFileSync(path.join(dir,'peers.json'),JSON.stringify({peer:{url:'https://peer.example.com/rpc',token_env:'PEER_TOKEN'}}),{mode:0o600});
 const options={configIdentity:sdk.configId()},local=await sdk.initialize({store:'file',cardUrl:'https://local.example.com/card'}),remote=await generateIdentity('https://peer.example.com/card');
 const p=await sdk.propose({peer:'peer',localId:local.id,bundle:remote.bundle,pairingIdentity:Buffer.alloc(32,3).toString('base64url'),peerEndpoint:'https://peer.example.com/rpc',expectedCurrent:'none',policy:'required',verification:'independent'}),approved=await sdk.approve({peer:'peer',digest:p.digest,expectedCurrent:'none',ownerApproved:true,independentVerified:true,verifiedProposalDigest:p.digest});
 initializeContinuationAuthority(dir,options);const environment=source==='file'?{}:{PEER_TOKEN:'synthetic-environment'};let intent;
 const maintain=fn=>withContinuationAuthorityMaintenance(dir,options,fn);
 await maintain(v=>{v.begin();const r=v.records(randomUUID()),trust=approved.record,m=r.bindMember({grant_id:randomUUID(),pairing_identity:trust.pairingIdentity,alias:'peer',endpoint:trust.peerEndpoint,credential_variable:'PEER_TOKEN',credential_source:source,trust_record_digest:approved.digest,trust_record_version:trust.version,local_id:local.id,local_bundle_digest:trust.localBundleDigest,peer_bundle_digest:hash('a2a-exposed sealed bundle v1',remote.bundle),policy:'required',verification:'independent',pairing_provenance:'local-adoption',pairing_decision_id:randomUUID()},source==='file'?'synthetic-token':environment.PEER_TOKEN);
 const plan=r.bindPlan({baseline_revision:0,source_mac:r.sourceMac(v.readSources(s=>s.sourceTexts())),plan_nonce:Buffer.alloc(32,4).toString('base64url'),members:[m],excluded_aliases:[]}),now=Date.now();
 // Synthetic attestation: these tests do not supply human provenance.
 const attestation=r.bindAttestation(plan,{id:randomUUID(),decision_id:randomUUID(),created_ms:now,expires_ms:now+600000,comparisons:[{grant_id:m.grant_id,approved_proposal_digest:p.digest,compared_safety_code:sdk.safetyCode(local.id,'peer').code,current_trust_digest:approved.digest,current_trust_version:trust.version}]});intent=r.bindIntent(randomUUID(),plan,attestation);v.prepareIntent(intent,{environment});v.commit();});
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
