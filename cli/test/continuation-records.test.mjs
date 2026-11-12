import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createHmac} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createContinuationRecords} from '../lib/continuation-records.mjs';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const d=n=>Buffer.alloc(32,n).toString('base64url');
const key=Buffer.alloc(32,1),nonce=Buffer.alloc(32,2);
const binding={root:path.resolve('/synthetic/private'),config_identity:id(1),epoch:id(2),set_id:id(3)};
const copy=x=>JSON.parse(JSON.stringify(x));
function setup(){
 const c=createContinuationRecords(key,nonce,binding);
 const members=[4,5].map((n,i)=>c.bindMember({grant_id:id(n),pairing_identity:d(n),alias:`peer_${n}`,endpoint:`https://example.com/peer-${n}`,credential_variable:`PEER_${n}_TOKEN`,credential_source:i?'file':'environment',trust_record_digest:d(10+n),trust_record_version:1,local_id:id(6),local_bundle_digest:d(20),peer_bundle_digest:d(30+n),policy:'required',verification:'independent',pairing_provenance:'local-adoption',pairing_decision_id:id(10+n)},`synthetic-token-${n}`));
 const source_mac=c.sourceMac({configEnv:'PEER_5_TOKEN=synthetic-token-5\n',peers:'{}\n'});
 const plan=c.bindPlan({baseline_revision:0,source_mac,plan_nonce:d(40),members,excluded_aliases:['omitted']});
 const evidence={id:id(20),decision_id:id(21),created_ms:1000,expires_ms:601000,comparisons:members.map((m,i)=>({grant_id:m.grant_id,approved_proposal_digest:d(50+i),compared_safety_code:Array(12).fill(String(10000+i)).join(' '),current_trust_digest:m.trust_record_digest,current_trust_version:m.trust_record_version}))};
 const attestation=c.bindAttestation(plan,evidence),intent=c.bindIntent(id(22),plan,attestation);
 return{c,members,source_mac,plan,evidence,attestation,intent};
}
function fields(f,observations,{action='abandon',checkpoint='I',state=null}={}){
 const r=f.intent.record;
 return{action,root:binding.root,config_identity:binding.config_identity,epoch:binding.epoch,authority_revision:1,intent_id:f.intent.id,set_id:binding.set_id,authority_checkpoint:checkpoint,intent_mac:f.intent.intent_mac,authority_set_state:['C','R'].includes(checkpoint)?'committed':null,sdk_row:state===null?null:{config_id:binding.config_identity,intent_id:f.intent.id,set_id:binding.set_id,epoch:binding.epoch,target_revision:1,membership_mac:r.membership_mac,state},observations,attestation_mac:r.attestation_mac,approval_nonce:d(60)};
}
const observed=(f,environment={},fileValues={},c=f.c)=>c.observeAbandonment(f.intent,{source_mac:f.source_mac,environment,fileValues});
const refuse=fn=>assert.throws(fn,e=>e?.code?.startsWith('continuation_'));

test('complete multi-peer comparison and intent authenticate with domain-separated canonical bytes',()=>{
 const f=setup();assert.deepEqual(f.c.authenticateIntent(f.intent),f.intent);
 const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
 const expected=createHmac('sha256',key).update('sealed continuation intent v1\n'+canonical([f.intent.id,f.intent.record])).digest('base64url');assert.equal(f.intent.intent_mac,expected);
 assert.ok(!JSON.stringify(f.intent).includes('synthetic-token'));assert.ok(!JSON.stringify(f.intent).includes('10000 10000'));
 const aliases=f.intent.record.plan.members.map(m=>m.alias);f.plan.plan.members[0].alias='mutated';assert.deepEqual(f.intent.record.plan.members.map(m=>m.alias),aliases);
});
test('aggregate membership, exclusions and variable uniqueness cannot be composed or silently normalized',()=>{
 const f=setup(),input={baseline_revision:0,source_mac:f.source_mac,plan_nonce:d(40),members:f.members,excluded_aliases:['omitted']};
 for(const transform of [x=>x.members.reverse(),x=>x.members.push(copy(x.members[0])),x=>x.members[1].credential_variable=x.members[0].credential_variable,x=>x.members[1].pairing_identity=x.members[0].pairing_identity,x=>x.members[1].alias=x.members[0].alias,x=>x.excluded_aliases.push('omitted'),x=>x.excluded_aliases=[x.members[0].alias],x=>x.members[0].policy='allow-server-readable',x=>x.members[0].policy='opportunistic']){const x=copy(input);transform(x);refuse(()=>f.c.bindPlan(x));}
 const altered=copy(f.intent);altered.record.plan.members.pop();refuse(()=>f.c.authenticateIntent(altered));
});
test('comparison bijection rejects omitted, extra, duplicate, swapped and stale trust evidence',()=>{
 const f=setup();
 for(const transform of [x=>x.comparisons.pop(),x=>x.comparisons.push(copy(x.comparisons[0])),x=>x.comparisons.reverse(),x=>x.comparisons[1]=copy(x.comparisons[0]),x=>x.comparisons[0].current_trust_digest=d(88),x=>x.comparisons[0].current_trust_version=2]){const x=copy(f.evidence);transform(x);refuse(()=>f.c.bindAttestation(f.plan,x));}
 for(const field of ['expires_ms','created_ms','decision_id']){const x=copy(f.intent);x.attestation.attestation[field]=field==='decision_id'?id(99):2000;refuse(()=>f.c.authenticateIntent(x));}
 const second=f.c.bindPlan({baseline_revision:0,source_mac:f.source_mac,plan_nonce:d(99),members:f.members,excluded_aliases:['omitted']});refuse(()=>f.c.bindIntent(id(22),second,f.attestation));
});
test('cross-plan, root, epoch, key and membership substitutions fail integrity verification',()=>{
 const f=setup();for(const patch of [{root:path.resolve('/synthetic/other')},{epoch:id(90)},{set_id:id(91)},{config_identity:id(92)}]){const other=createContinuationRecords(key,nonce,{...binding,...patch});refuse(()=>other.authenticateIntent(f.intent));}
 refuse(()=>createContinuationRecords(Buffer.alloc(32,9),nonce,binding).authenticateIntent(f.intent));
 const x=copy(f.intent);x.record.attestation_id=id(99);refuse(()=>f.c.authenticateIntent(x));
});
test('expiry is enforced for fresh use but expired authenticated intent remains available to abandonment',()=>{
 const f=setup();assert.deepEqual(f.c.assertFresh(f.intent,1000),f.intent);assert.deepEqual(f.c.assertFresh(f.intent,600999),f.intent);for(const now of [999,601000,NaN,-1,0.5])refuse(()=>f.c.assertFresh(f.intent,now));
 assert.deepEqual(f.c.authenticateIntent(f.intent),f.intent);const approval=f.c.bindReconciliation(f.intent,fields(f,observed(f)));assert.equal(approval.payload.action,'abandon');
});
test('absent/empty/nonempty observations and both literal sources have distinct commitments',()=>{
 const f=setup(),missing=observed(f),empty=observed(f,{PEER_4_TOKEN:''},{PEER_4_TOKEN:''}),present=observed(f,{PEER_4_TOKEN:'synthetic'},{PEER_4_TOKEN:'synthetic'});
 assert.deepEqual(missing.members[0].environment,{state:'absent',value_mac:null});assert.equal(empty.members[0].environment.state,'empty');assert.equal(present.members[0].environment.state,'nonempty');assert.notEqual(empty.members[0].environment.value_mac,present.members[0].environment.value_mac);assert.notEqual(present.members[0].environment.value_mac,present.members[0].file.value_mac);
 assert.notEqual(f.c.sourceMac({configEnv:null,peers:null}),f.c.sourceMac({configEnv:'',peers:''}));
});
test('new process can abandon an environment-only interruption without old token/nonce but cannot use old approval',()=>{
 const f=setup(),other=createContinuationRecords(key,Buffer.alloc(32,9),binding),original=observed(f),fresh=observed(f,{}, {},other);
 assert.equal(original.members[0].process_status,'same');assert.equal(fresh.members[0].process_status,'unavailable');assert.equal(fresh.members[1].process_status,'not-applicable');
 const prior=f.c.bindReconciliation(f.intent,fields(f,original));refuse(()=>other.authenticateReconciliation(f.intent,prior));
 const next=other.bindReconciliation(f.intent,fields(f,fresh));assert.deepEqual(other.authenticateReconciliation(f.intent,next),next);refuse(()=>f.c.authenticateReconciliation(f.intent,next));
 for(const checkpoint of ['C','R']){const approval=other.bindReconciliation(f.intent,fields(f,fresh,{checkpoint,state:checkpoint==='C'?'staged':'ready'}));assert.equal(approval.payload.observations.members[0].environment.state,'absent');}
});
test('file-backed-only abandonment is also bound to the diagnosing process',()=>{
 const f=setup();f.members[0]=f.c.bindMember({...Object.fromEntries(Object.entries(f.members[0]).filter(([k])=>!['credential_mac','process_mac'].includes(k))),credential_source:'file'},'synthetic');
 f.plan=f.c.bindPlan({baseline_revision:0,source_mac:f.source_mac,plan_nonce:d(40),members:f.members,excluded_aliases:['omitted']});f.attestation=f.c.bindAttestation(f.plan,f.evidence);f.intent=f.c.bindIntent(id(22),f.plan,f.attestation);
 const approval=f.c.bindReconciliation(f.intent,fields(f,observed(f)));refuse(()=>createContinuationRecords(key,Buffer.alloc(32,9),binding).authenticateReconciliation(f.intent,approval));
});
test('void+missing credentials permits only finish-abandon and never grants finalization',()=>{
 const f=setup(),o=observed(f);for(const checkpoint of ['I','C']){const approval=f.c.bindReconciliation(f.intent,fields(f,o,{action:'finish-abandon',checkpoint,state:'void'}));assert.equal(approval.payload.action,'finish-abandon');}
 for(const [action,checkpoint,state] of [['abandon','C','void'],['finalize-exact-set','C','void'],['finalize-exact-set','R','ready'],['finish-abandon','R','ready']])refuse(()=>f.c.bindReconciliation(f.intent,fields(f,o,{action,checkpoint,state})));
});
test('tag and cross-field substitutions cannot convert no-grant evidence into finalization',()=>{
 const f=setup();for(const transform of [x=>x.members.pop(),x=>x.members.reverse(),x=>x.members[0].original_member_mac=d(80),x=>x.members[0].environment={state:'absent',value_mac:d(90)},x=>x.members[0].environment.state='nonempty',x=>x.kind='finalize']){const x=observed(f,{PEER_4_TOKEN:''});transform(x);refuse(()=>f.c.bindReconciliation(f.intent,fields(f,x)));}
 const x=observed(f,{PEER_4_TOKEN:'same'},{PEER_4_TOKEN:''});x.members[0].environment={state:'empty',value_mac:x.members[0].file.value_mac};refuse(()=>f.c.bindReconciliation(f.intent,fields(f,x)));
});
test('observed change requires relisting; identical observations do not claim undetectable ABA prevention',()=>{
 const f=setup();const approve=o=>f.c.bindReconciliation(f.intent,fields(f,o)),old=approve(observed(f)),fresh=approve(observed(f,{PEER_4_TOKEN:'reintroduced'}));refuse(()=>f.c.assertUnchanged(f.intent,old,fresh));assert.equal(f.c.assertUnchanged(f.intent,old,approve(observed(f))),true);
 const changed=observed(f);changed.source_mac=f.c.sourceMac({configEnv:null,peers:'{}'});refuse(()=>f.c.assertUnchanged(f.intent,old,approve(changed)));
 const wrong=copy(old);wrong.payload.action='finish-abandon';refuse(()=>f.c.authenticateReconciliation(f.intent,wrong));
});
test('getters, symbols, sparse arrays and caller mutations cannot produce lossy approved records',()=>{
 const f=setup();let calls=0;for(const obj of [Object.defineProperty({},'source_mac',{enumerable:true,get(){calls++;return f.source_mac;}}),{[Symbol('hidden')]:1},Object.assign(Array(1),{extra:1})])refuse(()=>f.c.observeAbandonment(f.intent,obj));
 const environment={};Object.defineProperty(environment,'PEER_4_TOKEN',{enumerable:true,get(){calls++;return 'synthetic';}});refuse(()=>observed(f,environment));assert.equal(calls,0);
 const input=fields(f,observed(f)),approval=f.c.bindReconciliation(f.intent,input);input.observations.members[0].process_status='unavailable';assert.equal(f.c.authenticateReconciliation(f.intent,approval).payload.observations.members[0].process_status,'same');
});
test('unknown and invalid shapes refuse instead of accepting partial records',()=>{
 const f=setup();for(const patch of [{sdk_row:{}},{observations:null},{authority_revision:2},{authority_checkpoint:'E'},{authority_set_state:'eligible'},{approval_nonce:'bad'},{extra:true}])refuse(()=>f.c.bindReconciliation(f.intent,{...fields(f,observed(f)),...patch}));
 for(const token of ['',null,123])refuse(()=>f.c.bindMember({},token));
});


test('a real restarted process refuses cached abandonment approval without recovering the old nonce',()=>{
 const f=setup(),approval=f.c.bindReconciliation(f.intent,fields(f,observed(f)));
 const script=`import fs from 'node:fs';import {createContinuationRecords} from ${JSON.stringify(new URL('../lib/continuation-records.mjs',import.meta.url).href)};const p=JSON.parse(fs.readFileSync(0,'utf8'));const c=createContinuationRecords(Buffer.alloc(32,1),Buffer.alloc(32,9),p.binding);let refused=false;try{c.authenticateReconciliation(p.intent,p.approval);}catch(e){refused=typeof e.code==='string'&&e.code.startsWith('continuation_');}const o=c.observeAbandonment(p.intent,{source_mac:p.source_mac,environment:{},fileValues:{}});const fresh=c.bindReconciliation(p.intent,{...p.approval.payload,observations:o});process.stdout.write(JSON.stringify({refused,process:o.members[0].process_status,fresh:!!c.authenticateReconciliation(p.intent,fresh)}));`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{input:JSON.stringify({binding,intent:f.intent,approval,source_mac:f.source_mac}),encoding:'utf8',env:{DO_NOT_TRACK:'1',A2A_NO_UPDATE_CHECK:'1',TZ:process.env.TZ||'UTC'},timeout:10000});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{refused:true,process:'unavailable',fresh:true});
});


test('complete finalize records are structurally separate, with whole-set environment process binding',()=>{
 const f=setup(),canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
 const B=[binding.root,binding.config_identity,binding.epoch,binding.set_id],Q=f.members.map(m=>[m.grant_id,createHmac('sha256',key).update('sealed continuation member v1\n'+canonical([B,m])).digest('base64url')]);
 const o={kind:'finalize',source_mac:f.source_mac,current_member_macs:Q},x=fields(f,o,{action:'finalize-exact-set',checkpoint:'R',state:'ready'}),approval=f.c.bindReconciliation(f.intent,x);assert.deepEqual(f.c.authenticateReconciliation(f.intent,approval),approval);
 refuse(()=>createContinuationRecords(key,Buffer.alloc(32,9),binding).authenticateReconciliation(f.intent,approval));
 for(const transform of [x=>x.observations.current_member_macs.pop(),x=>x.observations.current_member_macs.reverse(),x=>x.observations.source_mac=d(99),x=>x.sdk_row.membership_mac=d(98),x=>x.action='abandon']){const next=copy(x);transform(next);refuse(()=>f.c.bindReconciliation(f.intent,next));}
});


test('object aliases refuse with typed errors before JavaScript string coercion (C7)',()=>{
 const f=setup(),base=Object.fromEntries(Object.entries(f.members[0]).filter(([k])=>!['credential_mac','process_mac'].includes(k)));
 for(const alias of [{toString:'not-callable'},null,0,false,[],{valueOf:42}])assert.throws(()=>f.c.bindMember({...base,alias},'synthetic'),e=>e.name==='Error'&&e.code==='continuation_record_invalid');
});
test('binary keys and nonces refuse own getters and extra fields without invoking them (C8)',()=>{
 let calls=0;
 for(const create of [()=>Buffer.alloc(32,1),()=>new Uint8Array(32).fill(1)]){
  for(const position of ['key','nonce'])for(const extra of ['length','custom',Symbol('extra')]){
   const value=create();Object.defineProperty(value,extra,{get(){calls++;return 32;}});
   assert.throws(()=>createContinuationRecords(position==='key'?value:key,position==='nonce'?value:nonce,binding),{code:'continuation_record_invalid'});
  }
  for(const length of [0,31,33])refuse(()=>createContinuationRecords(new Uint8Array(length),nonce,binding));
  const typed=create(),c=createContinuationRecords(typed,nonce,binding);typed.fill(9);assert.equal(c.sourceMac({configEnv:null,peers:null}),createContinuationRecords(key,nonce,binding).sourceMac({configEnv:null,peers:null}));
 }
 const fake=Object.create(Buffer.prototype);Object.defineProperty(fake,'length',{get(){calls++;return 32;}});refuse(()=>createContinuationRecords(fake,nonce,binding));
 assert.equal(calls,0);
});


test('file-only finalization authenticates only in its diagnosing process, including unchanged checks',()=>{
 const f=setup();f.members=f.members.map(m=>f.c.bindMember({...Object.fromEntries(Object.entries(m).filter(([k])=>!['credential_mac','process_mac'].includes(k))),credential_source:'file'},'synthetic-file'));
 f.plan=f.c.bindPlan({baseline_revision:0,source_mac:f.source_mac,plan_nonce:d(40),members:f.members,excluded_aliases:['omitted']});f.attestation=f.c.bindAttestation(f.plan,f.evidence);f.intent=f.c.bindIntent(id(22),f.plan,f.attestation);
 const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
 const B=[binding.root,binding.config_identity,binding.epoch,binding.set_id],Q=f.members.map(m=>[m.grant_id,createHmac('sha256',key).update('sealed continuation member v1\n'+canonical([B,m])).digest('base64url')]);
 const input=fields(f,{kind:'finalize',source_mac:f.source_mac,current_member_macs:Q},{action:'finalize-exact-set',checkpoint:'R',state:'ready'}),old=f.c.bindReconciliation(f.intent,input);
 assert.deepEqual(f.c.authenticateReconciliation(f.intent,old),old);assert.equal(f.c.assertUnchanged(f.intent,old,old),true);
 const restarted=createContinuationRecords(key,Buffer.alloc(32,9),binding);refuse(()=>restarted.authenticateReconciliation(f.intent,old));refuse(()=>restarted.assertUnchanged(f.intent,old,old));
 const fresh=restarted.bindReconciliation(f.intent,input);assert.deepEqual(restarted.authenticateReconciliation(f.intent,fresh),fresh);assert.equal(restarted.assertUnchanged(f.intent,fresh,fresh),true);assert.notEqual(old.process_mac,fresh.process_mac);assert.notEqual(old.mac,fresh.mac);
 refuse(()=>restarted.authenticateReconciliation(f.intent,{...old,process_mac:fresh.process_mac}));refuse(()=>restarted.authenticateReconciliation(f.intent,{...fresh,payload:{...fresh.payload,approval_nonce:d(99)}}));
 const missing=copy(fresh);delete missing.process_mac;refuse(()=>restarted.authenticateReconciliation(f.intent,missing));
});
