// Disabled private plan retention, never signer enrollment or human approval.
// The anchored caller owns the key, current state and outer transaction.
import {createHmac,timingSafeEqual} from 'node:crypto';
import {assertContinuationSignerChange} from './continuation-enrollment-plan.mjs';

export class ContinuationEnrollmentStorageError extends Error {
 constructor(code='continuation_enrollment_storage_invalid'){super(code);this.code=code;}
}
const fail=code=>{throw new ContinuationEnrollmentStorageError(code);};
function transaction(db){
 if(db.isTransaction!==true)fail('continuation_enrollment_transaction_required');
 if(db.prepare('PRAGMA foreign_keys').get().foreign_keys!==1)fail('continuation_enrollment_foreign_keys_required');
}
function equal(actual,expected){
 if(!actual||Object.keys(actual).sort().join(',')!==Object.keys(expected).sort().join(',')||Object.keys(expected).some(k=>actual[k]!==expected[k]))fail('continuation_enrollment_row_mismatch');
}
function exactText(bytes,value){
 try{if(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)!==value)fail();}
 catch{fail();}
}
function enrolled(db,plan){
 if(plan.current_signer===null)return;
 const {version,...row}=plan.current_signer;
 const result=db.prepare('SELECT *,CAST(canonical_root AS BLOB) AS root_bytes FROM continuation_signer_enrollments WHERE id=?').get(row.id);
 if(!result)fail('continuation_enrollment_row_mismatch');
 const {root_bytes,...stored}=result;exactText(root_bytes,stored.canonical_root);equal(stored,row);
}
function keySnapshot(value){
 if(!ArrayBuffer.isView(value)||![Buffer.prototype,Uint8Array.prototype].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).length!==32)fail();
 const bytes=[];for(let n=0;n<32;n++){const d=Object.getOwnPropertyDescriptor(value,String(n));if(!d||!Object.hasOwn(d,'value')||!Number.isInteger(d.value)||d.value<0||d.value>255)fail();bytes.push(d.value);}return Buffer.from(bytes);
}

// A private HMAC authenticates retained planning bytes. The public plan digest
// alone cannot do that. Neither value proves the human approved this plan.
// No command or physical authority initializer calls this module.
export function createContinuationEnrollmentStorage(recoveryKey){
 const key=keySnapshot(recoveryKey);
 const mac=record=>createHmac('sha256',key).update('a2a-exposed continuation enrollment storage v1\n'+record).digest('base64url');
 function row(plan){
  const record=JSON.stringify(plan);if(Buffer.byteLength(record)>1048576)fail();
  return{id:plan.id,config_identity:plan.authority.config_identity,canonical_root:plan.authority.canonical_root,epoch:plan.authority.epoch,baseline_revision:plan.authority.revision,current_signer_id:plan.current_signer?.id??null,operation:plan.operation,created_ms:plan.created_ms,expires_ms:plan.expires_ms,record,storage_mac:mac(record)};
 }
 function read(db,id,currentAuthority,currentSigner,now){
  transaction(db);
  if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))fail();
  const result=db.prepare('SELECT *,CAST(record AS BLOB) AS record_bytes,CAST(canonical_root AS BLOB) AS root_bytes FROM continuation_enrollment_plans WHERE id=?').get(id);
  if(!result)fail('continuation_enrollment_plan_missing');
  const {record_bytes,root_bytes,...stored}=result;
  exactText(record_bytes,stored.record);exactText(root_bytes,stored.canonical_root);
  if(typeof stored.record!=='string'||Buffer.byteLength(stored.record)>1048576||typeof stored.storage_mac!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(stored.storage_mac)||Buffer.from(stored.storage_mac,'base64url').toString('base64url')!==stored.storage_mac)fail();
  if(!timingSafeEqual(Buffer.from(stored.storage_mac,'base64url'),Buffer.from(mac(stored.record),'base64url')))fail('continuation_enrollment_storage_mac_mismatch');
  let parsed;try{parsed=JSON.parse(stored.record);}catch{fail();}
  const plan=assertContinuationSignerChange(parsed,currentAuthority,currentSigner,now);
  equal(stored,row(plan));enrolled(db,plan);return plan;
 }
 function retain(db,value,currentAuthority,currentSigner,now){
  transaction(db);
  const plan=assertContinuationSignerChange(value,currentAuthority,currentSigner,now),stored=row(plan);
  enrolled(db,plan);
  db.exec('SAVEPOINT continuation_enrollment_retain');
  try{
   const keys=Object.keys(stored);
   db.prepare(`INSERT INTO continuation_enrollment_plans(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(stored));
   const result=read(db,plan.id,plan.authority,plan.current_signer,now);
   db.exec('RELEASE continuation_enrollment_retain');return result;
  }catch(error){
   try{db.exec('ROLLBACK TO continuation_enrollment_retain; RELEASE continuation_enrollment_retain');}
   catch{fail('continuation_enrollment_rollback_unknown');}
   throw error;
  }
 }
 // Diagnosis authenticates every retained plan at its own creation instant,
 // including expired plans. It never returns an applicable plan or bypasses
 // the fresh-time check in read/retain. One bad row refuses the whole result.
 function diagnose(db,currentAuthority,currentSigner,now){
  transaction(db);
  if(!Number.isSafeInteger(now)||now<0)fail();
  return Object.freeze(db.prepare('SELECT id,created_ms FROM continuation_enrollment_plans ORDER BY id COLLATE BINARY').all().map(row=>{
   const plan=read(db,row.id,currentAuthority,currentSigner,row.created_ms);
   return Object.freeze({id:plan.id,operation:plan.operation,candidateFingerprint:plan.candidate?.fingerprint??null,planDigest:plan.plan_digest,createdMs:plan.created_ms,expiresMs:plan.expires_ms,status:now<plan.created_ms?'not-yet-valid':now>=plan.expires_ms?'expired':'fresh'});
  }));
 }
 // No consume/apply operation: a future human-authorized authority CAS must
 // reserve this retained identity once and rotate epoch/revision atomically.
 return Object.freeze({read,retain,diagnose});
}
