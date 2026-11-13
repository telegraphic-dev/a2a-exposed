// Isolated schema-3 continuation table primitives. The default authority remains
// schema 2; the separate fresh schema-3 foundation never admits a grant. No command
// or human-approval adapter uses these tables.
// Hidden row identifiers are absent so REPLACE cannot evict retained history.
// Privileged host code must own the connection/transaction, source checks and
// authority->SDK ordering. These functions do not establish human provenance.
export class ContinuationStoreError extends Error {
 constructor(code='continuation_store_invalid'){super(code);this.code=code;}
}
const fail=code=>{throw new ContinuationStoreError(code);};
const uuid=column=>`length(CAST(${column} AS BLOB))=36 AND length(${column})=36 AND ${column} NOT GLOB '*[^0-9a-f-]*' AND substr(${column},9,1)='-' AND substr(${column},14,1)='-' AND substr(${column},19,1)='-' AND substr(${column},24,1)='-' AND length(replace(${column},'-',''))=32 AND substr(${column},15,1)='4' AND substr(${column},20,1) IN ('8','9','a','b')`;
const digest=column=>`length(CAST(${column} AS BLOB))=43 AND length(${column})=43 AND ${column} NOT GLOB '*[^A-Za-z0-9_-]*' AND substr(${column},43,1) IN ('A','E','I','M','Q','U','Y','c','g','k','o','s','w','0','4','8')`;
const integer=column=>`${column} BETWEEN 0 AND 9007199254740991`;
const json=column=>`length(CAST(${column} AS BLOB)) BETWEEN 2 AND 1048576`;
const tables=['continuation_intents','grant_sets','grant_members','continuation_attestations'];
function transaction(db){if(db.isTransaction!==true)fail('continuation_transaction_required');if(db.prepare('PRAGMA foreign_keys').get().foreign_keys!==1)fail('continuation_foreign_keys_required');}
function immutable(table,columns){return `CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} WHEN ${columns.map(c=>`NEW.${c} IS NOT OLD.${c}`).join(' OR ')} BEGIN SELECT RAISE(ABORT,'continuation immutable'); END;
 CREATE TRIGGER ${table}_retained BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'continuation retained'); END;`;}

// For the future fresh schema-3 initializer only, inside its own transaction.
// Does not set user_version, migrate schema 2, create an authority identity or
// change a physical store. No IF NOT EXISTS: partial/colliding schemas refuse.
export function installContinuationTables(db){
 transaction(db);
 if(db.prepare('PRAGMA user_version').get().user_version!==0||db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get().n!==0)fail('continuation_fresh_schema_required');
 return savepoint(db,()=>db.exec(`CREATE TABLE continuation_intents(
 id TEXT PRIMARY KEY CHECK(${uuid('id')}), epoch TEXT NOT NULL CHECK(${uuid('epoch')}),
 baseline_revision INTEGER NOT NULL CHECK(${integer('baseline_revision')}),
 target_revision INTEGER NOT NULL CHECK(${integer('target_revision')} AND target_revision=baseline_revision+1),
 set_id TEXT NOT NULL UNIQUE CHECK(${uuid('set_id')}), plan_mac TEXT NOT NULL CHECK(${digest('plan_mac')}),
 intent_mac TEXT NOT NULL CHECK(${digest('intent_mac')}), state TEXT NOT NULL CHECK(state IN ('prepared','set-committed','eligible','aborted')),
 record TEXT NOT NULL CHECK(${json('record')})
 ) STRICT, WITHOUT ROWID;
 CREATE UNIQUE INDEX continuation_one_pending ON continuation_intents((1)) WHERE state IN ('prepared','set-committed');
 CREATE TABLE grant_sets(
 id TEXT PRIMARY KEY CHECK(${uuid('id')}), intent_id TEXT NOT NULL UNIQUE REFERENCES continuation_intents(id),
 epoch TEXT NOT NULL CHECK(${uuid('epoch')}), target_revision INTEGER NOT NULL CHECK(${integer('target_revision')} AND target_revision>0),
 membership_mac TEXT NOT NULL CHECK(${digest('membership_mac')}), state TEXT NOT NULL CHECK(state IN ('committed','eligible','void'))
 ) STRICT, WITHOUT ROWID;
 CREATE TABLE grant_members(
 set_id TEXT NOT NULL REFERENCES grant_sets(id), grant_id TEXT NOT NULL CHECK(${uuid('grant_id')}),
 pairing_identity TEXT NOT NULL CHECK(${digest('pairing_identity')}),
 alias TEXT NOT NULL CHECK(length(CAST(alias AS BLOB))=length(alias) AND length(alias) BETWEEN 1 AND 80 AND alias NOT GLOB '*[^A-Za-z0-9_-]*'),
 credential_variable TEXT NOT NULL CHECK(length(CAST(credential_variable AS BLOB))=length(credential_variable) AND length(credential_variable) BETWEEN 1 AND 128 AND substr(credential_variable,1,1) GLOB '[A-Za-z_]' AND credential_variable NOT GLOB '*[^A-Za-z0-9_]*'),
 record TEXT NOT NULL CHECK(${json('record')}), member_mac TEXT NOT NULL CHECK(${digest('member_mac')}),
 PRIMARY KEY(set_id,grant_id), UNIQUE(set_id,alias), UNIQUE(set_id,pairing_identity), UNIQUE(set_id,credential_variable)
 ) STRICT, WITHOUT ROWID;
 CREATE TABLE continuation_attestations(
 id TEXT PRIMARY KEY CHECK(${uuid('id')}), plan_mac TEXT NOT NULL UNIQUE CHECK(${digest('plan_mac')}),
 epoch TEXT NOT NULL CHECK(${uuid('epoch')}), created_ms INTEGER NOT NULL CHECK(${integer('created_ms')}),
 expires_ms INTEGER NOT NULL CHECK(${integer('expires_ms')} AND expires_ms>created_ms AND expires_ms-created_ms<=600000),
 consumed_intent TEXT UNIQUE REFERENCES continuation_intents(id), attestation_mac TEXT NOT NULL CHECK(${digest('attestation_mac')}),
 record TEXT NOT NULL CHECK(${json('record')})
 ) STRICT, WITHOUT ROWID;
 ${immutable('continuation_intents',['id','epoch','baseline_revision','target_revision','set_id','plan_mac','intent_mac','record'])}
 ${immutable('grant_sets',['id','intent_id','epoch','target_revision','membership_mac'])}
 ${immutable('grant_members',['set_id','grant_id','pairing_identity','alias','credential_variable','record','member_mac'])}
 ${immutable('continuation_attestations',['id','plan_mac','epoch','created_ms','expires_ms','attestation_mac','record'])}
 CREATE TRIGGER continuation_intents_noreplace BEFORE INSERT ON continuation_intents WHEN EXISTS(SELECT 1 FROM continuation_intents WHERE id=NEW.id OR set_id=NEW.set_id OR (NEW.state IN ('prepared','set-committed') AND state IN ('prepared','set-committed'))) BEGIN SELECT RAISE(ABORT,'continuation retained'); END;
 CREATE TRIGGER grant_sets_noreplace BEFORE INSERT ON grant_sets WHEN EXISTS(SELECT 1 FROM grant_sets WHERE id=NEW.id OR intent_id=NEW.intent_id) BEGIN SELECT RAISE(ABORT,'continuation retained'); END;
 CREATE TRIGGER grant_members_noreplace BEFORE INSERT ON grant_members WHEN EXISTS(SELECT 1 FROM grant_members WHERE set_id=NEW.set_id AND (grant_id=NEW.grant_id OR alias=NEW.alias OR pairing_identity=NEW.pairing_identity OR credential_variable=NEW.credential_variable)) BEGIN SELECT RAISE(ABORT,'continuation retained'); END;
 CREATE TRIGGER continuation_attestations_noreplace BEFORE INSERT ON continuation_attestations WHEN EXISTS(SELECT 1 FROM continuation_attestations WHERE id=NEW.id OR plan_mac=NEW.plan_mac OR (NEW.consumed_intent IS NOT NULL AND consumed_intent=NEW.consumed_intent)) BEGIN SELECT RAISE(ABORT,'continuation retained'); END;
 CREATE TRIGGER continuation_intents_initial BEFORE INSERT ON continuation_intents WHEN NEW.state!='prepared' BEGIN SELECT RAISE(ABORT,'continuation initial state'); END;
 CREATE TRIGGER continuation_intents_state BEFORE UPDATE OF state ON continuation_intents WHEN NOT ((OLD.state='prepared' AND NEW.state IN ('set-committed','aborted')) OR (OLD.state='set-committed' AND NEW.state IN ('eligible','aborted'))) BEGIN SELECT RAISE(ABORT,'continuation state'); END;
 CREATE TRIGGER grant_sets_initial BEFORE INSERT ON grant_sets WHEN NEW.state!='committed' BEGIN SELECT RAISE(ABORT,'continuation initial state'); END;
 CREATE TRIGGER grant_sets_state BEFORE UPDATE OF state ON grant_sets WHEN NOT ((OLD.state='committed' AND NEW.state IN ('eligible','void')) OR (OLD.state='eligible' AND NEW.state='void')) BEGIN SELECT RAISE(ABORT,'continuation state'); END;
 CREATE TRIGGER continuation_attestations_initial BEFORE INSERT ON continuation_attestations WHEN NEW.consumed_intent IS NOT NULL BEGIN SELECT RAISE(ABORT,'continuation consumed'); END;
 CREATE TRIGGER continuation_attestations_consume BEFORE UPDATE OF consumed_intent ON continuation_attestations WHEN OLD.consumed_intent IS NOT NULL OR NEW.consumed_intent IS NULL OR NOT EXISTS(SELECT 1 FROM continuation_intents WHERE id=NEW.consumed_intent AND plan_mac=OLD.plan_mac AND epoch=OLD.epoch AND state='prepared') BEGIN SELECT RAISE(ABORT,'continuation consumed'); END;
 `));
}

function insert(db,table,row,extra={}){const value={...row,...extra},keys=Object.keys(value);db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(value));}
function equalRows(actual,expected,additional=[]){
 if(!actual||Object.keys(actual).sort().join(',')!==[...Object.keys(expected),...additional].sort().join(',')||Object.keys(expected).some(k=>actual[k]!==expected[k]))fail('continuation_row_mismatch');
}
function storedText(row){
 if(!row)return row;
 const {record_bytes,...stored}=row;
 // Authenticate the bytes SQLite stores, not Node's replacement-decoded view.
 // ignoreBOM preserves a literal BOM for the existing exact JSON checks.
 try{if(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(record_bytes)!==stored.record)fail();}
 catch{fail();}
 return stored;
}
function parse(text){if(typeof text!=='string'||Buffer.byteLength(text)>1048576)fail();try{return JSON.parse(text);}catch{fail();}}
function savepoint(db,fn){transaction(db);db.exec('SAVEPOINT continuation_write');try{const result=fn();db.exec('RELEASE continuation_write');return result;}catch(error){try{db.exec('ROLLBACK TO continuation_write; RELEASE continuation_write');}catch{fail('continuation_rollback_unknown');}throw error;}}

// Internal authenticated storage read. Output includes private MACs: do not emit
// it to tool/model output. A valid bundle does not establish current readiness.
export function readContinuationIntent(db,records,id){
 transaction(db);
 const i=storedText(db.prepare('SELECT *,CAST(record AS BLOB) AS record_bytes FROM continuation_intents WHERE id=?').get(id));if(!i)fail('continuation_intent_missing');
 const record=parse(i.record),attestations=db.prepare('SELECT *,CAST(record AS BLOB) AS record_bytes FROM continuation_attestations WHERE consumed_intent=?').all(id).map(storedText);if(attestations.length!==1)fail('continuation_row_mismatch');
 const a=attestations[0],intent={id:i.id,record,intent_mac:i.intent_mac,attestation:{attestation:parse(a.record),attestation_mac:a.attestation_mac}},expected=records.authorityRows(intent);
 equalRows(i,expected.intent,['state']);equalRows(a,expected.attestation,['consumed_intent']);
 if(a.consumed_intent!==i.id||!['prepared','set-committed','eligible','aborted'].includes(i.state))fail('continuation_row_mismatch');
 const sets=db.prepare('SELECT * FROM grant_sets WHERE intent_id=? OR id=?').all(id,expected.set.id);
 if(sets.length>1)fail('continuation_row_mismatch');
 const set=sets[0]||null,members=db.prepare('SELECT *,CAST(record AS BLOB) AS record_bytes FROM grant_members WHERE set_id=? ORDER BY grant_id COLLATE BINARY').all(expected.set.id).map(storedText);
 if(set){equalRows(set,expected.set,['state']);if(!['committed','eligible','void'].includes(set.state)||members.length!==expected.members.length)fail('continuation_row_mismatch');for(let n=0;n<members.length;n++)equalRows(members[n],expected.members[n]);}
 else if(members.length)fail('continuation_row_mismatch');
 if(i.state==='prepared'&&set||i.state==='set-committed'&&set?.state!=='committed'||i.state==='eligible'&&set?.state!=='eligible'||i.state==='aborted'&&set&&set.state!=='void')fail('continuation_row_mismatch');
 return{intent,state:i.state,setState:set?.state||null};
}

// Storage-only I/C primitives, not the host I/S/C/R/E coordinator. The caller
// must commit its matching authority-row CAS in the SAME outer transaction.
// No API here clears suspension, makes a set eligible, or finalizes/abandons.
export function prepareContinuationIntent(db,records,intent,now){
 return savepoint(db,()=>{
  intent=records.assertFresh(intent,now);const r=records.authorityRows(intent);
  insert(db,'continuation_attestations',r.attestation,{consumed_intent:null});
  insert(db,'continuation_intents',r.intent,{state:'prepared'});
  const result=db.prepare('UPDATE continuation_attestations SET consumed_intent=? WHERE id=? AND consumed_intent IS NULL AND plan_mac=? AND epoch=?').run(r.intent.id,r.attestation.id,r.intent.plan_mac,r.intent.epoch);
  if(result.changes!==1)fail('continuation_compare_failed');
  return readContinuationIntent(db,records,r.intent.id);
 });
}
export function commitContinuationMembers(db,records,expectedIntent){
 return savepoint(db,()=>{
  // Snapshot/authenticate before any SQL and compare the complete immutable ID.
  const r=records.authorityRows(expectedIntent),current=readContinuationIntent(db,records,r.intent.id);
  if(current.state!=='prepared'||current.intent.intent_mac!==r.intent.intent_mac)fail('continuation_compare_failed');
  insert(db,'grant_sets',r.set,{state:'committed'});for(const m of r.members)insert(db,'grant_members',m);
  const result=db.prepare("UPDATE continuation_intents SET state='set-committed' WHERE id=? AND state='prepared' AND intent_mac=? AND epoch=? AND target_revision=? AND set_id=?").run(r.intent.id,r.intent.intent_mac,r.intent.epoch,r.intent.target_revision,r.intent.set_id);
  if(result.changes!==1)fail('continuation_compare_failed');
  return readContinuationIntent(db,records,r.intent.id);
 });
}

// Exposed solely for schema inventory in tests/future fresh initialization.
export const continuationTableNames=Object.freeze(tables);
