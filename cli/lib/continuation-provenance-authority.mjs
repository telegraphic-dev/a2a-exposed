// Disabled schema-4 foundation, separate from the physical schema-3 authority.
// Only the fresh-only physical initializer imports this; no command or admission.
// SQL bindings establish shape, never human approval or row authentication.
import {createRequire} from 'node:module';
import {installContinuationProvenanceTables} from './continuation-provenance-tables.mjs';

const require=createRequire(import.meta.url);
export class ContinuationProvenanceAuthorityError extends Error {
 constructor(code){super(code);this.code=code;}
}
const fail=code=>{throw new ContinuationProvenanceAuthorityError(code);};
const uuid=c=>`length(CAST(${c} AS BLOB))=36 AND length(${c})=36 AND ${c} NOT GLOB '*[^0-9a-f-]*' AND substr(${c},9,1)='-' AND substr(${c},14,1)='-' AND substr(${c},19,1)='-' AND substr(${c},24,1)='-' AND length(replace(${c},'-',''))=32 AND substr(${c},15,1)='4' AND substr(${c},20,1) IN ('8','9','a','b')`;
const digest=c=>`length(CAST(${c} AS BLOB))=43 AND length(${c})=43 AND ${c} NOT GLOB '*[^A-Za-z0-9_-]*' AND substr(${c},43,1) IN ('A','E','I','M','Q','U','Y','c','g','k','o','s','w','0','4','8')`;
const inventory=db=>JSON.stringify(db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all());
function connection(db){
 if(db.isTransaction!==true)fail('continuation_authority_transaction_required');
 for(const [pragma,value]of [['foreign_keys',1],['trusted_schema',0],['ignore_check_constraints',0],['writable_schema',0]])if(db.prepare(`PRAGMA ${pragma}`).get()[pragma]!==value)fail('continuation_authority_connection_invalid');
 if(db.prepare('SELECT COUNT(*) n FROM temp.sqlite_schema').get().n!==0||db.prepare('PRAGMA database_list').all().some(r=>!['main','temp'].includes(r.name)))fail('continuation_authority_namespace_invalid');
}

// Caller owns the transaction. Install only into an empty, version-zero database;
// all DDL and the version stamp roll back together on failure. No authority row,
// physical file, key, migration, adoption or reset is created here.
export function installContinuationProvenanceAuthority(db){
 connection(db);
 if(db.prepare('PRAGMA main.user_version').get().user_version!==0||db.prepare('SELECT COUNT(*) n FROM main.sqlite_schema').get().n!==0)fail('continuation_authority_fresh_required');
 db.exec('SAVEPOINT continuation_authority_install');
 try{
  installContinuationProvenanceTables(db);
  db.exec(`CREATE UNIQUE INDEX continuation_signer_authority_binding ON continuation_signer_enrollments(id,config_identity,canonical_root,epoch);
   CREATE TABLE authority(
    id INTEGER PRIMARY KEY CHECK(id=1),
    config_id TEXT NOT NULL CHECK(${uuid('config_id')}),
    canonical_root TEXT NOT NULL CHECK(length(CAST(canonical_root AS BLOB)) BETWEEN 1 AND 4096 AND instr(canonical_root,char(0))=0),
    revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),
    source_hash TEXT NOT NULL CHECK(${digest('source_hash')}),
    pending TEXT REFERENCES continuation_intents(id),
    suspended INTEGER NOT NULL CHECK(suspended IN (0,1)),
    recovery_key TEXT NOT NULL CHECK(${digest('recovery_key')}),
    suspension_epoch TEXT NOT NULL CHECK(${uuid('suspension_epoch')}),
    active_set TEXT REFERENCES grant_sets(id),
    current_signer_id TEXT,
    FOREIGN KEY(current_signer_id,config_id,canonical_root,suspension_epoch)
     REFERENCES continuation_signer_enrollments(id,config_identity,canonical_root,epoch),
    CHECK((pending IS NULL OR suspended=1) AND (suspended=0 OR active_set IS NULL)),
    CHECK(suspended=1 OR active_set IS NOT NULL),
    CHECK(current_signer_id IS NOT NULL OR (pending IS NULL AND active_set IS NULL AND suspended=1))
   ) STRICT, WITHOUT ROWID;
   CREATE TRIGGER authority_initial BEFORE INSERT ON authority
    WHEN NEW.revision!=0 OR NEW.pending IS NOT NULL OR NEW.suspended!=1 OR NEW.active_set IS NOT NULL OR NEW.current_signer_id IS NOT NULL OR EXISTS(SELECT 1 FROM authority)
    BEGIN SELECT RAISE(ABORT,'authority initial state'); END;
   CREATE TRIGGER authority_retained BEFORE DELETE ON authority BEGIN SELECT RAISE(ABORT,'authority retained'); END;
   CREATE TRIGGER authority_identity BEFORE UPDATE ON authority
    WHEN NEW.id IS NOT OLD.id OR NEW.config_id IS NOT OLD.config_id OR NEW.canonical_root IS NOT OLD.canonical_root OR NEW.recovery_key IS NOT OLD.recovery_key OR NEW.revision<OLD.revision
    BEGIN SELECT RAISE(ABORT,'authority immutable'); END;
   CREATE TRIGGER authority_signer_epoch BEFORE UPDATE ON authority
    WHEN (NEW.current_signer_id IS NOT OLD.current_signer_id OR NEW.suspension_epoch IS NOT OLD.suspension_epoch)
     AND (NEW.suspension_epoch IS OLD.suspension_epoch OR OLD.revision=9007199254740991 OR NEW.revision!=OLD.revision+1 OR OLD.pending IS NOT NULL OR NEW.pending IS NOT NULL OR NEW.active_set IS NOT NULL OR NEW.suspended!=1)
    BEGIN SELECT RAISE(ABORT,'authority signer rotation'); END;
   CREATE TRIGGER authority_pending BEFORE UPDATE ON authority
    WHEN NEW.pending IS NOT NULL AND NOT EXISTS(
     SELECT 1 FROM continuation_intents i JOIN continuation_decision_receipts r ON r.intent_id=i.id
      WHERE i.id=NEW.pending AND i.epoch=NEW.suspension_epoch AND i.target_revision=NEW.revision AND i.state IN ('prepared','set-committed')
       AND r.enrollment_id=NEW.current_signer_id AND r.config_identity=NEW.config_id AND r.canonical_root=NEW.canonical_root AND r.epoch=NEW.suspension_epoch)
    BEGIN SELECT RAISE(ABORT,'authority pending provenance'); END;
   CREATE TRIGGER authority_active BEFORE UPDATE ON authority
    WHEN NEW.active_set IS NOT NULL AND NOT EXISTS(
     SELECT 1 FROM grant_sets s JOIN continuation_intents i ON i.id=s.intent_id JOIN continuation_decision_receipts r ON r.intent_id=i.id
      WHERE s.id=NEW.active_set AND s.epoch=NEW.suspension_epoch AND s.target_revision=NEW.revision AND s.state='eligible' AND i.state='eligible'
       AND i.set_id=s.id AND i.epoch=s.epoch AND i.target_revision=s.target_revision
       AND r.enrollment_id=NEW.current_signer_id AND r.config_identity=NEW.config_id AND r.canonical_root=NEW.canonical_root AND r.epoch=NEW.suspension_epoch
       AND NEW.pending IS NULL AND NEW.suspended=0)
    BEGIN SELECT RAISE(ABORT,'authority active provenance'); END;
   PRAGMA main.user_version=4;`);
  db.exec('RELEASE continuation_authority_install');
 }catch(error){
  try{db.exec('ROLLBACK TO continuation_authority_install; RELEASE continuation_authority_install');}
  catch{fail('continuation_authority_rollback_unknown');}
  throw error;
 }
}
let expected;
export function assertContinuationProvenanceAuthorityInventory(db){
 connection(db);
 if(db.prepare('PRAGMA main.user_version').get().user_version!==4)fail('continuation_authority_version_invalid');
 if(expected===undefined){
  const {DatabaseSync}=require('node:sqlite'),reference=new DatabaseSync(':memory:');
  try{
   reference.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE');
   installContinuationProvenanceAuthority(reference);expected=inventory(reference);
  }catch(error){expected=undefined;throw error;}finally{reference.close();}
 }
 if(inventory(db)!==expected)fail('continuation_authority_schema_invalid');
 return Object.freeze({version:1,schema:4,format:'continuation-provenance-authority'});
}
