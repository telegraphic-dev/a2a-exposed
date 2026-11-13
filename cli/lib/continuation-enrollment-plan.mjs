// Internal read-only planning only. A public digest is not human authorization.
// No command, enrollment writer, signer custody or grant transition uses this.
import path from 'node:path';
import {createHash,createPublicKey} from 'node:crypto';

export class ContinuationEnrollmentPlanError extends Error {
 constructor(code='continuation_enrollment_plan_invalid'){super(code);this.code=code;}
}
const fail=(code)=>{throw new ContinuationEnrollmentPlanError(code);};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const AUTHORITY=['config_identity','canonical_root','epoch','revision','suspended','active_set_id','pending_intent_id'];
const SIGNER=['version','id','config_identity','canonical_root','epoch','public_key_spki','fingerprint'];
const INPUT=['id','operation','authority','current_signer','candidate','created_ms','expires_ms'];
function record(value,fields){
 if(!value||Object.getPrototypeOf(value)!==Object.prototype)fail();
 const keys=Reflect.ownKeys(value);if(keys.length!==fields.length||keys.some(k=>typeof k!=='string'||!fields.includes(k)))fail();
 const result={};for(const k of fields){const d=Object.getOwnPropertyDescriptor(value,k);if(!d||!d.enumerable||!Object.hasOwn(d,'value'))fail();result[k]=d.value;}return result;
}
function uuid(value){if(typeof value!=='string'||!UUID.test(value))fail();return value;}
function integer(value){if(!Number.isSafeInteger(value)||value<0)fail();}
function root(value){
 if(typeof value!=='string'||Buffer.byteLength(value)>4096||!path.isAbsolute(value)||path.resolve(value)!==value||value.includes('\0')||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))fail();
}
function encoded(value,size){
 if(typeof value!=='string'||value.length!==Math.ceil(size*4/3)||!/^[A-Za-z0-9_-]+$/.test(value))fail();
 const bytes=Buffer.from(value,'base64url');if(bytes.length!==size||bytes.toString('base64url')!==value)fail();return bytes;
}
function publicKey(value){
 const c=record(value,['public_key_spki','fingerprint']),der=encoded(c.public_key_spki,44);let key;
 try{key=createPublicKey({key:der,type:'spki',format:'der'});}catch{fail();}
 if(key.asymmetricKeyType!=='ed25519'||!key.export({type:'spki',format:'der'}).equals(der))fail();
 encoded(c.fingerprint,32);if(createHash('sha256').update(der).digest('base64url')!==c.fingerprint)fail();return c;
}
function authority(value){
 const a=record(value,AUTHORITY);uuid(a.config_identity);uuid(a.epoch);root(a.canonical_root);integer(a.revision);
 if(a.revision===Number.MAX_SAFE_INTEGER||typeof a.suspended!=='boolean')fail();
 for(const field of ['active_set_id','pending_intent_id'])if(a[field]!==null)uuid(a[field]);
 // Planning cannot reconcile or supersede an unfinished continuation.
 if(a.pending_intent_id!==null)fail('continuation_enrollment_pending_intent');
 if(a.suspended&&a.active_set_id!==null||!a.suspended&&a.active_set_id===null)fail();return a;
}
function signer(value,a){
 if(value===null)return null;const s=record(value,SIGNER);
 if(s.version!==1)fail();uuid(s.id);uuid(s.config_identity);uuid(s.epoch);root(s.canonical_root);
 publicKey({public_key_spki:s.public_key_spki,fingerprint:s.fingerprint});
 for(const k of ['config_identity','canonical_root','epoch'])if(s[k]!==a[k])fail('continuation_enrollment_binding_mismatch');return s;
}
// Snapshot a planning binding only. Its caller must authenticate the physical
// authority/current signer; validation cannot establish their source or currency.
export function snapshotContinuationSignerBinding(currentAuthority,currentSigner){
 const a=authority(currentAuthority),s=signer(currentSigner,a);
 return Object.freeze({authority:Object.freeze(a),current_signer:s===null?null:Object.freeze(s)});
}
const text=value=>JSON.stringify(value);
const digest=value=>createHash('sha256').update('a2a-exposed continuation signer change plan v1\n'+text(value)).digest('base64url');

// Input must be supplied by the future anchored authority reader and privileged
// adapter. This function cannot establish source trust or fingerprint comparison.
export function planContinuationSignerChange(input){
 const v=record(input,INPUT);uuid(v.id);const a=authority(v.authority),s=signer(v.current_signer,a);
 if(!['initial','replace','remove'].includes(v.operation)||v.operation==='initial'&&s!==null||v.operation!=='initial'&&s===null)fail('continuation_enrollment_operation_mismatch');
 const c=v.operation==='remove'?(v.candidate===null?null:fail()):publicKey(v.candidate);
 integer(v.created_ms);integer(v.expires_ms);if(v.expires_ms<=v.created_ms||v.expires_ms-v.created_ms>600000)fail();
 // All objects are reconstructed in a fixed order; equivalent input key ordering
 // gives identical bytes. No arbitrary JSON objects are hashed.
 const plan={version:1,id:v.id,operation:v.operation,authority:a,current_signer:s,candidate:c,created_ms:v.created_ms,expires_ms:v.expires_ms};
 return{...plan,plan_digest:digest(plan)};
}

// Recheck before a future human-authorized transaction, never as its approval.
// The writer must still consume the plan once and rotate epoch/revision atomically.
export function assertContinuationSignerChange(value,currentAuthority,currentSigner,now){
 const p=record(value,['version',...INPUT,'plan_digest']);if(p.version!==1)fail();encoded(p.plan_digest,32);
 const {version,plan_digest,...input}=p,expected=planContinuationSignerChange(input);
 if(expected.plan_digest!==plan_digest)fail('continuation_enrollment_plan_mismatch');
 integer(now);if(now<p.created_ms||now>=p.expires_ms)fail('continuation_enrollment_plan_expired');
 const {authority:a,current_signer:s}=snapshotContinuationSignerBinding(currentAuthority,currentSigner);
 if(text(a)!==text(expected.authority)||text(s)!==text(expected.current_signer))fail('continuation_enrollment_plan_stale');
 return expected;
}
