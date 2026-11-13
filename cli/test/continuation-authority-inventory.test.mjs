import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {initializeContinuationAuthority,inspectContinuationAuthority,withContinuationAuthorityMaintenance} from '../lib/pairing-authority.mjs';
const options={configIdentity:'00000000-0000-4000-8000-000000000001'};
function fixture(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'authority-inventory-')));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 initializeContinuationAuthority(dir,options);return dir;
}
const file=dir=>path.join(dir,'pairing-authority.sqlite');
function change(dir,sql){const db=new DatabaseSync(file(dir));try{db.exec(sql);}finally{db.close();}}
const inspect=dir=>inspectContinuationAuthority(dir,options);
const maintain=(dir,fn)=>withContinuationAuthorityMaintenance(dir,options,fn);
for(const sql of [
 'DROP TRIGGER authority_retained',
 'DROP TRIGGER continuation_intents_noreplace',
 "DROP TRIGGER authority_pending; CREATE TRIGGER authority_pending BEFORE UPDATE ON authority BEGIN SELECT 1; END",
 'CREATE TABLE extra(id TEXT)',
 'CREATE VIEW extra AS SELECT config_id FROM authority',
 'CREATE INDEX extra ON authority(source_hash)',
 'CREATE TRIGGER extra AFTER UPDATE ON authority BEGIN SELECT 1; END',
 'ALTER TABLE continuation_intents ADD COLUMN extra TEXT',
 'DROP INDEX continuation_one_pending',
 'PRAGMA user_version=4',
])test('physical authority refuses changed inventory without rewriting: '+sql,async t=>{
 const dir=fixture(t);change(dir,sql);const before=fs.readFileSync(file(dir));
 assert.throws(()=>inspect(dir),{code:'authority_schema'});
 await assert.rejects(maintain(dir,v=>{v.begin();assert.fail('changed schema admitted');}),{code:'authority_schema'});
 assert.deepEqual(fs.readFileSync(file(dir)),before);
 assert.equal(fs.readFileSync(path.join(dir,'pairing-authority.json'),'utf8'),JSON.stringify({v:1,configIdentity:options.configIdentity})+'\n');
});
test('equivalent trigger text is refused until its exact original inventory is restored',t=>{
 const dir=fixture(t);let original;const db=new DatabaseSync(file(dir));
 try{original=db.prepare("SELECT sql FROM sqlite_schema WHERE name='authority_retained'").get().sql;db.exec('DROP TRIGGER authority_retained');db.exec(original.replace('BEGIN SELECT', 'BEGIN /* equivalent SQL */ SELECT'));}finally{db.close();}
 assert.throws(()=>inspect(dir),{code:'authority_schema'});
 change(dir,'DROP TRIGGER authority_retained; '+original);
 assert.equal(inspect(dir).revision,0);
});
test('inspection and idle maintenance preserve valid physical files and keep grants suspended',async t=>{
 const dir=fixture(t),before=fs.readFileSync(file(dir)),snapshot=inspect(dir);
 await maintain(dir,async v=>{v.begin();assert.deepEqual(v.snapshot(),Object.fromEntries(Object.entries(snapshot).filter(([k])=>k!=='sourceMismatch')));v.commit();await Promise.resolve();v.begin();v.rollback();});
 assert.deepEqual(inspect(dir),snapshot);assert.equal(snapshot.suspended,true);assert.equal(snapshot.activeSet,null);
 assert.deepEqual(fs.readFileSync(file(dir)),before);
});
test('maintenance rechecks inventory after an await before beginning its next transaction',async t=>{
 const dir=fixture(t);let before;
 await assert.rejects(maintain(dir,async v=>{v.begin();v.commit();await Promise.resolve();change(dir,'DROP TRIGGER authority_retained');before=fs.readFileSync(file(dir));v.begin();}),{code:'authority_schema'});
 assert.deepEqual(fs.readFileSync(file(dir)),before);
});
for(const sql of [
 'CREATE TEMP TABLE authority(id INTEGER)',
 'CREATE TEMP VIEW continuation_intents AS SELECT 1',
 'CREATE TEMP TRIGGER shadow AFTER UPDATE ON main.authority BEGIN SELECT 1; END',
 "ATTACH ':memory:' AS shadow",
 'PRAGMA trusted_schema=ON',
 'PRAGMA foreign_keys=OFF',
])test('a connection namespace or pragma change refuses before authority reads: '+sql,async t=>{
 const dir=fixture(t),before=fs.readFileSync(file(dir)),exec=DatabaseSync.prototype.exec;let injected=false;
 DatabaseSync.prototype.exec=function(value,...args){const result=exec.call(this,value,...args);if(value==='PRAGMA synchronous=FULL'&&!injected){injected=true;exec.call(this,sql);}return result;};
 try{await assert.rejects(maintain(dir,v=>{v.begin();assert.fail('changed namespace admitted');}),{code:'authority_schema'});}finally{DatabaseSync.prototype.exec=exec;}
 assert.equal(injected,true);assert.deepEqual(fs.readFileSync(file(dir)),before);assert.equal(inspect(dir).suspended,true);
});

for(const pragma of ['ignore_check_constraints','writable_schema'])for(const stage of ['before-begin','after-await'])test('physical maintenance rechecks effective '+pragma+' '+stage,async t=>{
 const dir=fixture(t),before=fs.readFileSync(file(dir)),exec=DatabaseSync.prototype.exec;
 let connection,effective,finalPragma;const close=DatabaseSync.prototype.close;
 DatabaseSync.prototype.close=function(...args){if(this===connection)finalPragma=this.prepare(`PRAGMA ${pragma}`).get()[pragma];return close.apply(this,args);};
 DatabaseSync.prototype.exec=function(value,...args){
  const result=exec.call(this,value,...args);
  if(value==='PRAGMA synchronous=FULL'){
   connection=this;
   if(stage==='before-begin'){exec.call(this,`PRAGMA ${pragma}=ON`);effective=this.prepare(`PRAGMA ${pragma}`).get()[pragma];}
  }
  return result;
 };
 try{
  const action=maintain(dir,async v=>{
   if(stage==='after-await'){
    v.begin();v.commit();await Promise.resolve();
    exec.call(connection,`PRAGMA ${pragma}=ON`);effective=connection.prepare(`PRAGMA ${pragma}`).get()[pragma];
   }
   v.begin();assert.equal(effective,0,'unsafe connection admitted');v.rollback();
  });
  // Some supported Node versions refuse writable_schema=ON in defensive mode.
  // Assert the effective state, never infer safety from pragma request success.
  try{await action;assert.equal(effective,0);}
  catch(error){assert.equal(effective,1);assert.equal(error.code,'authority_schema');}
  assert.equal(finalPragma,effective);
 }finally{DatabaseSync.prototype.exec=exec;DatabaseSync.prototype.close=close;}
 assert.deepEqual(fs.readFileSync(file(dir)),before);assert.equal(inspect(dir).suspended,true);
});
