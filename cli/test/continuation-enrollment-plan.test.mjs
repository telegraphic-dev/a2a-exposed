import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {planContinuationSignerChange,assertContinuationSignerChange} from '../lib/continuation-enrollment-plan.mjs';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const clone=x=>JSON.parse(JSON.stringify(x));
function candidate(){const der=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'});return{public_key_spki:der.toString('base64url'),fingerprint:createHash('sha256').update(der).digest('base64url')};}
function fixture(operation='initial'){
 const authority={config_identity:id(1),canonical_root:'/synthetic/private',epoch:id(2),revision:2,suspended:true,active_set_id:null,pending_intent_id:null};
 const key=candidate(),current_signer=operation==='initial'?null:{version:1,id:id(3),config_identity:id(1),canonical_root:'/synthetic/private',epoch:id(2),...key};
 const input={id:id(4),operation,authority,current_signer,candidate:operation==='remove'?null:key,created_ms:1000,expires_ms:2000};
 const plan=()=>planContinuationSignerChange(input),check=(p=plan(),a=authority,s=current_signer,now=1000)=>assertContinuationSignerChange(p,a,s,now);
 return{input,plan,check};
}
const refuses=fn=>assert.throws(fn,e=>e?.code?.startsWith('continuation_enrollment_'));

test('initial, equal-key replacement and removal plans round-trip without changing inputs',()=>{
 for(const operation of ['initial','replace','remove']){
  const f=fixture(operation),before=clone(f.input),p=f.plan();assert.deepEqual(f.check(p),p);assert.deepEqual(f.input,before);
  p.authority.epoch=id(99);assert.deepEqual(f.input,before);
 }
});
test('operation is explicit and cannot silently replace, remove or discover a signer',()=>{
 for(const operation of ['initial','replace','remove']){
  const f=fixture(operation);
  for(const invalid of ['',null,'rotate','auto','INITIAL'])refuses(()=>planContinuationSignerChange({...f.input,operation:invalid}));
 }
 const f=fixture('replace');refuses(()=>planContinuationSignerChange({...f.input,operation:'initial'}));
 for(const operation of ['replace','remove'])refuses(()=>planContinuationSignerChange({...fixture().input,operation}));
 refuses(()=>planContinuationSignerChange({...fixture('remove').input,candidate:candidate()}));
 refuses(()=>planContinuationSignerChange({...fixture().input,candidate:null}));
});
test('all authority, signer, key and operation fields contribute to plan identity',()=>{
 const f=fixture('replace'),original=f.plan();
 for(const patch of [{id:id(99)},{operation:'remove',candidate:null},{candidate:candidate()},{created_ms:1001},{expires_ms:2001},{current_signer:{...f.input.current_signer,id:id(99)}},{authority:{...f.input.authority,revision:3}}])assert.notEqual(planContinuationSignerChange({...f.input,...patch}).plan_digest,original.plan_digest);
});
test('latest exact authority snapshot and enrollment are required for recheck',()=>{
 const f=fixture('replace'),p=f.plan();
 for(const patch of [{config_identity:id(99)},{canonical_root:'/synthetic/other'},{epoch:id(99)},{revision:3},{suspended:false,active_set_id:id(99)}]){
  const a={...f.input.authority,...patch},s={...f.input.current_signer};for(const k of ['config_identity','canonical_root','epoch'])s[k]=a[k];refuses(()=>f.check(p,a,s));
 }
 refuses(()=>f.check(p,f.input.authority,null));refuses(()=>f.check(p,f.input.authority,{...f.input.current_signer,id:id(99)}));
});
test('pending intents and inconsistent active membership refuse rather than reconcile',()=>{
 const f=fixture();for(const patch of [{pending_intent_id:id(99)},{active_set_id:id(99)},{suspended:false}])refuses(()=>planContinuationSignerChange({...f.input,authority:{...f.input.authority,...patch}}));
 const active={...f.input.authority,suspended:false,active_set_id:id(99)};
 assert.equal(planContinuationSignerChange({...f.input,authority:active}).authority.active_set_id,id(99));
});
test('canonical public key and fingerprint required; private, alternate and malformed keys refuse',()=>{
 const f=fixture(),c=f.input.candidate;
 for(const public_key_spki of ['',null,c.public_key_spki+'=',Buffer.alloc(44).toString('base64url'),generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'der'}).toString('base64url')])refuses(()=>planContinuationSignerChange({...f.input,candidate:{...c,public_key_spki}}));
 refuses(()=>planContinuationSignerChange({...f.input,candidate:{...c,fingerprint:Buffer.alloc(32).toString('base64url')}}));
 for(const k of ['config_identity','epoch','canonical_root'])refuses(()=>planContinuationSignerChange({...fixture('replace').input,current_signer:{...fixture('replace').input.current_signer,[k]:k==='canonical_root'?'/other':id(99)}}));
});
test('expiry, clock regression, unsafe revisions, malformed UUIDs and noncanonical roots refuse',()=>{
 const f=fixture();assert.equal(f.check(f.plan(),f.input.authority,null,1999).expires_ms,2000);
 for(const now of [999,2000,NaN,Infinity,-1,1000.5,null,undefined])refuses(()=>assertContinuationSignerChange(f.plan(),f.input.authority,null,now));
 for(const patch of [{created_ms:-1},{created_ms:2000},{expires_ms:601001},{expires_ms:Number.MAX_SAFE_INTEGER+1}])refuses(()=>planContinuationSignerChange({...f.input,...patch}));
 for(const patch of [{revision:-1},{revision:Number.MAX_SAFE_INTEGER},{revision:1.5},{config_identity:'invalid'},{canonical_root:'relative'},{canonical_root:'/synthetic/../private'},{canonical_root:'/synthetic/\0'},{canonical_root:'/synthetic/\ud800'}])refuses(()=>planContinuationSignerChange({...f.input,authority:{...f.input.authority,...patch}}));
});
test('tampered plan payload and digest refuse; digest is only public consistency data',()=>{
 const f=fixture('replace'),p=f.plan();for(const patch of [{id:id(99)},{operation:'remove'},{expires_ms:3000},{plan_digest:p.plan_digest+'='},{plan_digest:Buffer.alloc(32).toString('base64url')}])refuses(()=>f.check({...p,...patch}));
 // Anyone can compute a new plan. This API intentionally cannot prove approval,
 // durable single consumption or genuine source trust, and does not apply it.
 const next=planContinuationSignerChange({...f.input,id:id(99)});assert.equal(f.check(next).id,id(99));
});
test('fixed field ordering gives identical digest and callers receive detached snapshots',()=>{
 const f=fixture('replace'),reverse=o=>Object.fromEntries(Object.entries(o).reverse());
 const reordered=reverse({...f.input,authority:reverse(f.input.authority),current_signer:reverse(f.input.current_signer),candidate:reverse(f.input.candidate)});
 assert.deepEqual(planContinuationSignerChange(reordered),f.plan());
 const p=f.plan(),checked=f.check(p);checked.candidate.fingerprint='changed';assert.notEqual(p.candidate.fingerprint,'changed');
});
test('unknown, hidden, symbol, inherited and accessor fields refuse without getter execution',()=>{
 let calls=0;const f=fixture('replace');
 for(const field of [null,'authority','current_signer','candidate']){
  const original=field===null?f.input:f.input[field];
  const values=[{...original,extra:true},{...original,[Symbol('extra')]:true},Object.create(original)];
  const first=Object.keys(original)[0],missing={...original};delete missing[first];values.push(missing);
  values.push(Object.defineProperty({...original},first,{get(){calls++;return original[first];},enumerable:true}));
  values.push(Object.defineProperty({...original},first,{value:original[first],enumerable:false}));
  for(const value of values)refuses(()=>planContinuationSignerChange(field===null?value:{...f.input,[field]:value}));
 }
 const p=f.plan();refuses(()=>f.check(Object.defineProperty({...p},'plan_digest',{get(){calls++;return p.plan_digest;},enumerable:true})));
 assert.equal(calls,0);
});
