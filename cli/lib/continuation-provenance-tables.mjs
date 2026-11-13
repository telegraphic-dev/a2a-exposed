// Disabled fresh-store table foundation for a future authority schema.
// No command, authority initializer, signer adapter or admission path imports it.
// SQL retention/bindings do not authenticate a key or establish human approval.
import {installContinuationTables} from './continuation-tables.mjs';

export class ContinuationProvenanceStoreError extends Error {
 constructor(code){super(code);this.code=code;}
}
const fail=code=>{throw new ContinuationProvenanceStoreError(code);};
const uuid=c=>`length(CAST(${c} AS BLOB))=36 AND length(${c})=36 AND ${c} NOT GLOB '*[^0-9a-f-]*' AND substr(${c},9,1)='-' AND substr(${c},14,1)='-' AND substr(${c},19,1)='-' AND substr(${c},24,1)='-' AND length(replace(${c},'-',''))=32 AND substr(${c},15,1)='4' AND substr(${c},20,1) IN ('8','9','a','b')`;
const encoded=(c,n,last)=>`length(CAST(${c} AS BLOB))=${n} AND length(${c})=${n} AND ${c} NOT GLOB '*[^A-Za-z0-9_-]*' AND substr(${c},${n},1) IN (${last.split('').map(x=>`'${x}'`).join(',')})`;
const digest=c=>encoded(c,43,'AEIMQUYcgkosw048');
const integer=c=>`${c} BETWEEN 0 AND 9007199254740991`;
const retained=t=>`CREATE TRIGGER ${t}_immutable BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT,'provenance immutable'); END;
 CREATE TRIGGER ${t}_retained BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'provenance retained'); END;`;

// Install all continuation and provenance tables ONLY into an empty database in
// a caller-held transaction. No authority row, version stamp or migration.
// A future anchored initializer must supply schema inventory authentication and
// atomically bind the current enrollment/epoch; these rows alone cannot do so.
export function installContinuationProvenanceTables(db){
 if(db.isTransaction!==true)fail('continuation_provenance_transaction_required');
 if(db.prepare('PRAGMA foreign_keys').get().foreign_keys!==1)fail('continuation_provenance_foreign_keys_required');
 db.exec('SAVEPOINT continuation_provenance_install');
 try{
  installContinuationTables(db);
  db.exec(`CREATE TABLE continuation_signer_enrollments(
   id TEXT PRIMARY KEY CHECK(${uuid('id')}),
   config_identity TEXT NOT NULL CHECK(${uuid('config_identity')}),
   canonical_root TEXT NOT NULL CHECK(length(CAST(canonical_root AS BLOB)) BETWEEN 1 AND 4096 AND instr(canonical_root,char(0))=0),
   epoch TEXT NOT NULL UNIQUE CHECK(${uuid('epoch')}),
   public_key_spki TEXT NOT NULL CHECK(${encoded('public_key_spki',59,'AEIMQUYcgkosw048')}),
   fingerprint TEXT NOT NULL CHECK(${digest('fingerprint')}),
   UNIQUE(id,config_identity,canonical_root,epoch,fingerprint)
  ) STRICT;
  CREATE TABLE continuation_decision_receipts(
   decision_id TEXT PRIMARY KEY CHECK(${uuid('decision_id')}),
   enrollment_id TEXT NOT NULL CHECK(${uuid('enrollment_id')}),
   signer_fingerprint TEXT NOT NULL CHECK(${digest('signer_fingerprint')}),
   intent_id TEXT NOT NULL UNIQUE REFERENCES continuation_intents(id),
   config_identity TEXT NOT NULL CHECK(${uuid('config_identity')}),
   canonical_root TEXT NOT NULL,
   epoch TEXT NOT NULL CHECK(${uuid('epoch')}),
   baseline_revision INTEGER NOT NULL CHECK(${integer('baseline_revision')}),
   target_revision INTEGER NOT NULL CHECK(${integer('target_revision')} AND target_revision=baseline_revision+1),
   plan_mac TEXT NOT NULL CHECK(${digest('plan_mac')}),
   set_id TEXT NOT NULL UNIQUE CHECK(${uuid('set_id')}),
   created_ms INTEGER NOT NULL CHECK(${integer('created_ms')}),
   expires_ms INTEGER NOT NULL CHECK(${integer('expires_ms')} AND expires_ms>created_ms AND expires_ms-created_ms<=600000),
   attestation TEXT NOT NULL CHECK(length(CAST(attestation AS BLOB)) BETWEEN 2 AND 1048576),
   signature TEXT NOT NULL CHECK(${encoded('signature',86,'AQgw')}),
   FOREIGN KEY(enrollment_id,config_identity,canonical_root,epoch,signer_fingerprint)
    REFERENCES continuation_signer_enrollments(id,config_identity,canonical_root,epoch,fingerprint)
  ) STRICT;
  ${retained('continuation_signer_enrollments')}
  ${retained('continuation_decision_receipts')}
  CREATE TRIGGER continuation_signer_enrollments_noreplace BEFORE INSERT ON continuation_signer_enrollments
   WHEN EXISTS(SELECT 1 FROM continuation_signer_enrollments WHERE id=NEW.id OR epoch=NEW.epoch)
   BEGIN SELECT RAISE(ABORT,'provenance retained'); END;
  CREATE TRIGGER continuation_decision_receipts_noreplace BEFORE INSERT ON continuation_decision_receipts
   WHEN EXISTS(SELECT 1 FROM continuation_decision_receipts WHERE decision_id=NEW.decision_id OR intent_id=NEW.intent_id OR set_id=NEW.set_id)
   BEGIN SELECT RAISE(ABORT,'provenance retained'); END;
  CREATE TRIGGER continuation_decision_receipts_bind BEFORE INSERT ON continuation_decision_receipts
   WHEN NOT EXISTS(SELECT 1 FROM continuation_intents i JOIN continuation_attestations a ON a.consumed_intent=i.id
    WHERE i.id=NEW.intent_id AND i.state='prepared' AND i.epoch=NEW.epoch
     AND i.baseline_revision=NEW.baseline_revision AND i.target_revision=NEW.target_revision
     AND i.plan_mac=NEW.plan_mac AND i.set_id=NEW.set_id AND a.epoch=NEW.epoch
     AND a.plan_mac=NEW.plan_mac AND a.created_ms=NEW.created_ms AND a.expires_ms=NEW.expires_ms
     AND a.record=NEW.attestation)
   BEGIN SELECT RAISE(ABORT,'provenance binding'); END;
  `);
  db.exec('RELEASE continuation_provenance_install');
 }catch(error){
  try{db.exec('ROLLBACK TO continuation_provenance_install; RELEASE continuation_provenance_install');}
  catch{fail('continuation_provenance_rollback_unknown');}
  throw error;
 }
}
