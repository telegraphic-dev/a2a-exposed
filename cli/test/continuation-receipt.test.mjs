import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {createContinuationRecords} from '../lib/continuation-records.mjs';
import {verifyContinuationDecisionReceipt} from '../lib/continuation-receipt.mjs';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const digest=n=>Buffer.alloc(32,n).toString('base64url');
const clone=x=>JSON.parse(JSON.stringify(x));
function fixture(){
 const records=createContinuationRecords(Buffer.alloc(32,1),Buffer.alloc(32,2),{root:'/synthetic/private',config_identity:id(1),epoch:id(2),set_id:id(3)});
 const member=records.bindMember({grant_id:id(4),pairing_identity:digest(4),alias:'synthetic',endpoint:'https://example.com/',credential_variable:'PEER_SYNTHETIC_TOKEN',credential_source:'file',trust_record_digest:digest(5),trust_record_version:1,local_id:id(6),local_bundle_digest:digest(6),peer_bundle_digest:digest(7),policy:'required',verification:'independent',pairing_provenance:'local-adoption',pairing_decision_id:id(7)},'synthetic-token');
 const plan=records.bindPlan({baseline_revision:0,source_mac:records.sourceMac({configEnv:null,peers:null}),plan_nonce:digest(8),members:[member],excluded_aliases:['excluded']});
 const attestation=records.bindAttestation(plan,{id:id(9),decision_id:id(10),created_ms:1000,expires_ms:2000,comparisons:[{grant_id:member.grant_id,approved_proposal_digest:digest(9),compared_safety_code:Array(12).fill('12345').join(' '),current_trust_digest:member.trust_record_digest,current_trust_version:1}]});
 const intent=records.bindIntent(id(11),plan,attestation),{publicKey,privateKey}=generateKeyPairSync('ed25519');
 const der=publicKey.export({type:'spki',format:'der'}),fingerprint=createHash('sha256').update(der).digest('base64url');
 const enrollment={version:1,id:id(12),config_identity:id(1),canonical_root:'/synthetic/private',epoch:id(2),public_key_spki:der.toString('base64url'),fingerprint};
 const text=records.authorityRows(intent).attestation.record;
 const receipt={version:1,decision_id:id(10),enrollment_id:id(12),signer_fingerprint:fingerprint,attestation:text,signature:sign(null,Buffer.from('a2a-exposed continuation human decision v1\n'+text),privateKey).toString('base64url'),intent_id:id(11),config_identity:id(1),canonical_root:'/synthetic/private',epoch:id(2),baseline_revision:0,target_revision:1,plan_mac:plan.plan_mac,set_id:id(3),created_ms:1000,expires_ms:2000};
 const verify=(e=enrollment,r=receipt,i=intent,now=1000)=>verifyContinuationDecisionReceipt(records,i,e,r,now);
 return{records,intent,enrollment,receipt,privateKey,verify};
}
const refuses=fn=>assert.throws(fn,e=>e?.code?.startsWith('continuation_'));

test('signed receipt round-trips as strict detached storage data without mutating inputs',()=>{
 const f=fixture(),result=f.verify(clone(f.enrollment),clone(f.receipt),clone(f.intent));assert.deepEqual(result,f.receipt);assert.notEqual(result,f.receipt);
 result.epoch=id(90);assert.equal(f.receipt.epoch,id(2));
 assert.ok(!JSON.stringify(f.receipt).includes('synthetic-token'));assert.ok(!JSON.stringify(f.receipt).includes('12345 12345'));
});
test('each duplicated receipt field is checked against the authenticated intent and enrollment',()=>{
 const f=fixture();for(const field of Object.keys(f.receipt).filter(k=>k!=='signature')){
  const changed={...f.receipt,[field]:typeof f.receipt[field]==='number'?f.receipt[field]+1:f.receipt[field]+'x'};refuses(()=>f.verify(f.enrollment,changed));
 }
});
test('wrong key, changed signature, wrong domain and malformed encodings refuse',()=>{
 const f=fixture(),other=fixture();refuses(()=>f.verify({...f.enrollment,public_key_spki:other.enrollment.public_key_spki,fingerprint:other.enrollment.fingerprint},{...f.receipt,signer_fingerprint:other.enrollment.fingerprint}));
 for(const signature of [null,'',f.receipt.signature+'=',Buffer.alloc(64,0).toString('base64url'),sign(null,Buffer.from(f.receipt.attestation),f.privateKey).toString('base64url')])refuses(()=>f.verify(f.enrollment,{...f.receipt,signature}));
 // Noncanonical trailing bits decode to identical bytes and must still fail.
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',s=f.receipt.signature,noncanonical=s.slice(0,-1)+alphabet[alphabet.indexOf(s.at(-1))+1];
 assert.deepEqual(Buffer.from(s,'base64url'),Buffer.from(noncanonical,'base64url'));refuses(()=>f.verify(f.enrollment,{...f.receipt,signature:noncanonical}));
});
test('canonical key identity rejects PEM, private keys, wrong key type, padding and forged fingerprints',()=>{
 const f=fixture(),rsa=generateKeyPairSync('rsa',{modulusLength:1024}).publicKey.export({type:'spki',format:'der'});
 for(const public_key_spki of [null,'',f.enrollment.public_key_spki+'=',f.privateKey.export({type:'pkcs8',format:'der'}).toString('base64url'),rsa.toString('base64url'),Buffer.alloc(44,0).toString('base64url')])refuses(()=>f.verify({...f.enrollment,public_key_spki}));
 refuses(()=>f.verify({...f.enrollment,fingerprint:digest(99)}));
});
test('same key with a different enrollment, configuration, root or epoch cannot reuse a receipt',()=>{
 const f=fixture();for(const patch of [{id:id(90)},{config_identity:id(90)},{epoch:id(90)},{canonical_root:'/synthetic/other'}])refuses(()=>f.verify({...f.enrollment,...patch}));
});
test('a signed attestation cannot be attached to a different consuming intent or changed plan',()=>{
 const f=fixture(),other=f.records.bindIntent(id(90),{plan:f.intent.record.plan,membership_mac:f.intent.record.membership_mac,plan_mac:f.intent.record.plan_mac},f.intent.attestation);
 refuses(()=>f.verify(f.enrollment,f.receipt,other));
 const modified=clone(f.intent);modified.record.plan.excluded_aliases=[];refuses(()=>f.verify(f.enrollment,f.receipt,modified));
 const text=JSON.stringify(JSON.parse(f.receipt.attestation),null,2),signature=sign(null,Buffer.from('a2a-exposed continuation human decision v1\n'+text),f.privateKey).toString('base64url');
 refuses(()=>f.verify(f.enrollment,{...f.receipt,attestation:text,signature}));
});
test('fresh verification rejects expiry and clock regression without extending the signed window',()=>{
 const f=fixture();assert.deepEqual(f.verify(f.enrollment,f.receipt,f.intent,1999),f.receipt);
 for(const now of [999,2000,NaN,Infinity,-1,1000.5,null,undefined])refuses(()=>verifyContinuationDecisionReceipt(f.records,f.intent,f.enrollment,f.receipt,now));
});
test('unknown, missing, hidden, symbolic and accessor fields fail without executing getters',()=>{
 const f=fixture();let calls=0;
 for(const [original,position]of [[f.enrollment,'enrollment'],[f.receipt,'receipt']]){
  const values=[{...original,extra:1},{...original,[Symbol('extra')]:1},Object.create(original)];
  const missing={...original};delete missing.version;values.push(missing);
  values.push(Object.defineProperty({...original},'version',{get(){calls++;return 1;},enumerable:true}));
  values.push(Object.defineProperty({...original},'version',{value:1,enumerable:false}));
  for(const value of values)refuses(()=>position==='enrollment'?f.verify(value):f.verify(f.enrollment,value));
 }
 assert.equal(calls,0);
});
