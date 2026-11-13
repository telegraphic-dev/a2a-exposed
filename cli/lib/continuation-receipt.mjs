// Internal verification-only codec. No enrollment, signing, persistence or admission.
// Callers must obtain enrollment from an anchored authority transaction, never
// from the receipt or model input. Schema-3 cannot provide that trusted record.
import {createHash,createPublicKey,verify} from 'node:crypto';

export class ContinuationReceiptError extends Error {
 constructor(code='continuation_receipt_invalid'){super(code);this.code=code;}
}
const fail=(code)=>{throw new ContinuationReceiptError(code);};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ENROLLMENT=['version','id','config_identity','canonical_root','epoch','public_key_spki','fingerprint'];
const RECEIPT=['version','decision_id','enrollment_id','signer_fingerprint','attestation','signature','intent_id','config_identity','canonical_root','epoch','baseline_revision','target_revision','plan_mac','set_id','created_ms','expires_ms'];
function record(value,fields){
 if(!value||Object.getPrototypeOf(value)!==Object.prototype)fail();
 const keys=Reflect.ownKeys(value);if(keys.length!==fields.length||keys.some(k=>typeof k!=='string'||!fields.includes(k)))fail();
 const result={};for(const k of fields){const d=Object.getOwnPropertyDescriptor(value,k);if(!d||!d.enumerable||!Object.hasOwn(d,'value'))fail();result[k]=d.value;}return result;
}
function uuid(value){if(typeof value!=='string'||!UUID.test(value))fail();}
function encoded(value,size){
 if(typeof value!=='string'||value.length!==Math.ceil(size*4/3)||!/^[A-Za-z0-9_-]+$/.test(value))fail();
 const bytes=Buffer.from(value,'base64url');if(bytes.length!==size||bytes.toString('base64url')!==value)fail();return bytes;
}
function signer(input){
 const e=record(input,ENROLLMENT);if(e.version!==1)fail();uuid(e.id);uuid(e.config_identity);uuid(e.epoch);
 // Ed25519 SPKI is exactly 44 DER bytes. Re-export rejects alternate DER forms.
 const der=encoded(e.public_key_spki,44);let key;try{key=createPublicKey({key:der,type:'spki',format:'der'});}catch{fail();}
 if(key.asymmetricKeyType!=='ed25519'||!key.export({type:'spki',format:'der'}).equals(der))fail();
 encoded(e.fingerprint,32);if(createHash('sha256').update(der).digest('base64url')!==e.fingerprint)fail();
 return{enrollment:e,key};
}

// Returns sensitive storage data, not a public diagnostic or proof of an actual
// human ceremony. Its one-intent consumption and enrollment currency still
// require a future authority transaction; this function cannot resume grants.
export function verifyContinuationDecisionReceipt(records,intent,enrolled,receipt,now){
 const {enrollment:e,key}=signer(enrolled),r=record(receipt,RECEIPT);
 const authenticated=records.assertFresh(intent,now),rows=records.authorityRows(authenticated);
 const p=authenticated.record.plan,a=authenticated.attestation.attestation;
 for(const [field,expected]of Object.entries({version:1,decision_id:a.decision_id,enrollment_id:e.id,signer_fingerprint:e.fingerprint,attestation:rows.attestation.record,intent_id:authenticated.id,config_identity:p.config_identity,canonical_root:p.canonical_root,epoch:p.epoch,baseline_revision:p.baseline_revision,target_revision:p.target_revision,plan_mac:authenticated.record.plan_mac,set_id:p.set_id,created_ms:a.created_ms,expires_ms:a.expires_ms}))if(r[field]!==expected)fail('continuation_receipt_mismatch');
 for(const field of ['config_identity','canonical_root','epoch'])if(e[field]!==r[field])fail('continuation_receipt_enrollment_mismatch');
 const signature=encoded(r.signature,64);
 if(!verify(null,Buffer.from('a2a-exposed continuation human decision v1\n'+r.attestation),key,signature))fail('continuation_receipt_signature_invalid');
 return r;
}
