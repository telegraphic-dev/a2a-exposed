import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {installContinuationProvenanceTables} from '../lib/continuation-provenance-tables.mjs';
import {assertContinuationProvenanceInventory as inspect} from '../lib/continuation-provenance-inventory.mjs';

function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
 installContinuationProvenanceTables(db);return db;
}
const schema=db=>db.prepare('SELECT * FROM main.sqlite_schema ORDER BY type,name').all();
test('exact fresh inventory survives reopen of transaction without changing main schema or data',t=>{
 const db=fixture(t),before=schema(db),changes=db.prepare('SELECT total_changes() n').get().n;
 assert.deepEqual(inspect(db),{version:1,format:'fresh-continuation-provenance'});
 assert.equal(Object.isFrozen(inspect(db)),true);
 db.exec('COMMIT; BEGIN IMMEDIATE');assert.deepEqual(inspect(db),{version:1,format:'fresh-continuation-provenance'});
 assert.deepEqual(schema(db),before);assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);
 assert.equal(db.prepare('PRAGMA user_version').get().user_version,0);assert.equal(db.isTransaction,true);
});
test('caller transaction, foreign keys and untrusted-schema mode are mandatory',t=>{
 const db=fixture(t);db.exec('COMMIT');assert.throws(()=>inspect(db),{code:'continuation_inventory_transaction_required'});
 db.exec('PRAGMA foreign_keys=OFF; BEGIN');assert.throws(()=>inspect(db),{code:'continuation_inventory_foreign_keys_required'});
 db.exec('ROLLBACK; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=ON; BEGIN');assert.throws(()=>inspect(db),{code:'continuation_inventory_untrusted_schema_required'});
});
for(const version of [2,3,4])test('existing authority version '+version+' refuses without reset',t=>{
 const db=fixture(t);db.exec(`PRAGMA user_version=${version}`);const before=schema(db);
 assert.throws(()=>inspect(db),{code:'continuation_inventory_version_mismatch'});
 assert.equal(db.prepare('PRAGMA user_version').get().user_version,version);assert.deepEqual(schema(db),before);
});
for(const sql of [
 'CREATE TABLE unrelated(id TEXT)',
 'CREATE TABLE authority(id INTEGER PRIMARY KEY)',
 'CREATE VIEW unrelated AS SELECT id FROM continuation_signer_enrollments',
 'CREATE INDEX unrelated ON continuation_enrollment_plans(operation)',
 "CREATE TRIGGER unrelated AFTER INSERT ON continuation_signer_enrollments BEGIN SELECT 1; END",
 'DROP TRIGGER continuation_signer_enrollments_retained',
 "DROP TRIGGER continuation_signer_enrollments_retained; CREATE TRIGGER continuation_signer_enrollments_retained BEFORE DELETE ON continuation_signer_enrollments BEGIN SELECT 1; END",
 'ALTER TABLE continuation_enrollment_plans ADD COLUMN extra TEXT',
 'ALTER TABLE continuation_signer_enrollments RENAME TO old_signers',
])test('extra or changed schema refuses: '+sql,t=>{
 const db=fixture(t);db.exec(sql);const before=schema(db);
 assert.throws(()=>inspect(db),{code:'continuation_inventory_schema_mismatch'});assert.deepEqual(schema(db),before);assert.equal(db.isTransaction,true);
});
for(const sql of [
 'CREATE TEMP TABLE continuation_signer_enrollments(id TEXT)',
 'CREATE TEMP VIEW continuation_enrollment_plans AS SELECT 1',
 'CREATE TEMP TRIGGER shadow AFTER INSERT ON main.continuation_signer_enrollments BEGIN SELECT 1; END',
 "ATTACH ':memory:' AS shadow",
])test('temporary shadows and attached schemas refuse: '+sql,t=>{
 const db=fixture(t);db.exec(sql);assert.throws(()=>inspect(db),{code:'continuation_inventory_namespace_mismatch'});
});
test('empty or incomplete stores refuse without installing or adopting anything',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; BEGIN');
 assert.throws(()=>inspect(db),{code:'continuation_inventory_schema_mismatch'});assert.deepEqual(schema(db),[]);
 db.exec('CREATE TABLE continuation_intents(id TEXT)');const before=schema(db);
 assert.throws(()=>inspect(db),{code:'continuation_inventory_schema_mismatch'});assert.deepEqual(schema(db),before);
});
test('schema check explicitly does not authenticate row data',t=>{
 const db=fixture(t);db.exec('PRAGMA ignore_check_constraints=ON');
 db.prepare('INSERT INTO continuation_signer_enrollments VALUES(?,?,?,?,?,?)').run('synthetic','synthetic','synthetic','synthetic','synthetic','synthetic');
 assert.deepEqual(inspect(db),{version:1,format:'fresh-continuation-provenance'});
 assert.equal(db.prepare('SELECT COUNT(*) n FROM continuation_signer_enrollments').get().n,1);
});
test('physical read-only connection leaves candidate file bytes unchanged',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'provenance-inventory-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const file=path.join(directory,'candidate.sqlite'),writer=new DatabaseSync(file);
 try{writer.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');installContinuationProvenanceTables(writer);writer.exec('COMMIT');}finally{writer.close();}
 const before=fs.readFileSync(file),db=new DatabaseSync(file,{readOnly:true});
 try{
  db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; BEGIN');inspect(db);db.exec('COMMIT');
 }finally{db.close();}
 assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(fs.readdirSync(directory),['candidate.sqlite']);
});
