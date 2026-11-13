// Disabled private storage primitives. The future anchored authority reader must
// supply the CURRENT enrollment; selecting a retained key is not authorization.
// No command, authority initializer, enrollment writer or grant path uses this.
import {prepareContinuationIntent,readContinuationIntent} from './continuation-tables.mjs';
import {verifyContinuationDecisionReceipt} from './continuation-receipt.mjs';

export class ContinuationProvenanceStorageError extends Error {
 constructor(code){super(code);this.code=code;}
}
const fail=code=>{throw new ContinuationProvenanceStorageError(code);};
function transaction(db){
 if(db.isTransaction!==true)fail('continuation_provenance_transaction_required');
 if(db.prepare('PRAGMA foreign_keys').get().foreign_keys!==1)fail('continuation_provenance_foreign_keys_required');
}
function equal(actual,expected){
 if(!actual||Object.keys(actual).sort().join(',')!==Object.keys(expected).sort().join(',')||Object.keys(expected).some(k=>actual[k]!==expected[k]))fail('continuation_provenance_row_mismatch');
}
function exactText(bytes,value){
 try{if(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)!==value)fail('continuation_provenance_text_invalid');}
 catch{fail('continuation_provenance_text_invalid');}
}
function snapshotEnrollment(value){
 if(!value||Object.getPrototypeOf(value)!==Object.prototype)fail('continuation_provenance_row_mismatch');
 // Preserve descriptors for the strict codec to reject getters/hidden/unknown
 // fields, but never read properties through a caller-controlled proxy again.
 return Object.defineProperties({},Object.getOwnPropertyDescriptors(value));
}
function enrollmentRow(db,enrollment){
 // The receipt codec strictly validates and snapshots enrollment before this
 // function is called. Compare every stored column, including canonical key DER.
 const {version,...expected}=enrollment;
 const row=db.prepare('SELECT *,CAST(canonical_root AS BLOB) AS root_bytes FROM continuation_signer_enrollments WHERE id=?').get(expected.id);
 if(!row)fail('continuation_provenance_row_mismatch');
 const {root_bytes,...stored}=row;exactText(root_bytes,stored.canonical_root);equal(stored,expected);
}
function storedReceipt(receipt){const {version,...row}=receipt;return row;}

// Internal fresh-checkpoint read only, not live admission after ceremony expiry.
// Reverify actual stored signature and all SQL/JSON bindings. Sensitive return
// values stay private; no signature/MAC is a public diagnostic or ceremony proof.
export function readContinuationProvenance(db,records,id,currentEnrollment,now){
 transaction(db);
 currentEnrollment=snapshotEnrollment(currentEnrollment);
 const current=readContinuationIntent(db,records,id);
 const rows=db.prepare('SELECT *,CAST(attestation AS BLOB) AS attestation_bytes,CAST(canonical_root AS BLOB) AS root_bytes FROM continuation_decision_receipts WHERE intent_id=?').all(current.intent.id).map(row=>{
  const {attestation_bytes,root_bytes,...stored}=row;
  exactText(attestation_bytes,stored.attestation);exactText(root_bytes,stored.canonical_root);return stored;
 });
 if(rows.length!==1)fail('continuation_provenance_receipt_missing');
 const receipt=verifyContinuationDecisionReceipt(records,current.intent,currentEnrollment,{version:1,...rows[0]},now);
 enrollmentRow(db,currentEnrollment);
 equal(rows[0],storedReceipt(receipt));
 return{...current,receipt};
}

// Atomic storage-only I+receipt preparation. The caller must CAS its authority
// row in the SAME outer transaction and recheck sources/namespace/SDK readiness.
// This does not enroll a signer, choose current enrollment, commit authority,
// establish a human event, clear suspension or admit any grant.
export function prepareContinuationProvenance(db,records,intent,currentEnrollment,receipt,now){
 transaction(db);
 currentEnrollment=snapshotEnrollment(currentEnrollment);
 // Authenticate and snapshot all untrusted input before any storage mutation.
 const authenticated=records.assertFresh(intent,now);
 const verified=verifyContinuationDecisionReceipt(records,authenticated,currentEnrollment,receipt,now);
 enrollmentRow(db,currentEnrollment);
 db.exec('SAVEPOINT continuation_provenance_prepare');
 try{
  prepareContinuationIntent(db,records,authenticated,now);
  const row=storedReceipt(verified),keys=Object.keys(row);
  db.prepare(`INSERT INTO continuation_decision_receipts(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));
  const result=readContinuationProvenance(db,records,authenticated.id,currentEnrollment,now);
  db.exec('RELEASE continuation_provenance_prepare');
  return result;
 }catch(error){
  try{db.exec('ROLLBACK TO continuation_provenance_prepare; RELEASE continuation_provenance_prepare');}
  catch{fail('continuation_provenance_rollback_unknown');}
  throw error;
 }
}
