import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {initializeFreshContinuationProvenanceAuthority as initialize,retainInitialContinuationSignerPlan as retain,readInitialContinuationSignerPlan as read,diagnoseInitialContinuationSignerPlans as diagnose} from '../lib/pairing-authority.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,configIdentity=id(1),posix={skip:process.platform==='win32'};
function fixture(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'a2a-enrollment-diagnosis-')));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.writeFileSync(path.join(root,'config.env'),'TOKEN=synthetic-diagnosis-token\n',{mode:0o600});initialize(root,{configIdentity});return root;}
const file=root=>path.join(root,'pairing-authority.sqlite');
function raw(root,fn){const db=new DatabaseSync(file(root));try{return fn(db);}finally{db.close();}}
function plan(root,n,now=1000){const der=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'});return retain(root,{configIdentity,id:id(n),candidate:{public_key_spki:der.toString('base64url'),fingerprint:createHash('sha256').update(der).digest('base64url')},now,expiresMs:now+1000});}
const inspect=(root,now)=>diagnose(root,{configIdentity,now});
function corrupt(root,sql,...values){raw(root,db=>{const triggers=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='continuation_enrollment_plans'").all();for(const r of triggers)db.exec(`DROP TRIGGER ${r.name}`);db.prepare(sql).run(...values);for(const r of triggers)db.exec(r.sql);});}

test('empty and nonempty diagnosis returns authenticated metadata in stable ID order without writes',posix,t=>{
 const root=fixture(t),initial=fs.readFileSync(file(root));assert.deepEqual(inspect(root,0).plans,[]);assert.deepEqual(fs.readFileSync(file(root)),initial);
 const b=plan(root,3,2000),a=plan(root,2),before=fs.readFileSync(file(root)),result=inspect(root,2000);
 assert.deepEqual(result.plans,[a,b].map((p,n)=>({id:p.id,operation:'initial',candidateFingerprint:p.candidate.fingerprint,planDigest:p.plan_digest,createdMs:p.created_ms,expiresMs:p.expires_ms,status:n===0?'expired':'fresh'})));
 assert.equal(result.suspended,true);assert.equal(result.currentSigner,null);assert.equal(result.revision,0);assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.plans)&&result.plans.every(Object.isFrozen));assert.deepEqual(fs.readFileSync(file(root)),before);
 const serialized=JSON.stringify(result),authority=raw(root,db=>db.prepare('SELECT * FROM authority').get());for(const privateText of [root,authority.recovery_key,authority.source_hash,a.candidate.public_key_spki,'synthetic-diagnosis-token'])assert.ok(!serialized.includes(privateText));
});
test('diagnosis preserves expired identities without making fresh reads applicable',posix,t=>{
 const root=fixture(t),p=plan(root,2),before=fs.readFileSync(file(root));
 for(const [now,status] of [[999,'not-yet-valid'],[1000,'fresh'],[1999,'fresh'],[2000,'expired'],[Number.MAX_SAFE_INTEGER,'expired']])assert.equal(inspect(root,now).plans[0].status,status);
 for(const now of [999,2000,Number.MAX_SAFE_INTEGER])assert.throws(()=>read(root,{configIdentity,id:p.id,now}));
 for(const now of [undefined,-1,NaN,Infinity,1.5,'1000'])assert.throws(()=>inspect(root,now));assert.deepEqual(fs.readFileSync(file(root)),before);
 const module=new URL('../lib/pairing-authority.mjs',import.meta.url).href,child=spawnSync(process.execPath,['--input-type=module','-e',`import{diagnoseInitialContinuationSignerPlans as diagnose}from ${JSON.stringify(module)};console.log(JSON.stringify(diagnose(process.argv[1],{configIdentity:${JSON.stringify(configIdentity)},now:999999})));`,root],{encoding:'utf8',timeout:10000,env:{DO_NOT_TRACK:'1'}});assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),inspect(root,999999));
});
test('one bad retained row refuses the entire inventory, even if another row is valid',posix,t=>{
 for(const change of ['mac','record','binding','root-bytes','created']){const root=fixture(t);plan(root,2);plan(root,3);
  if(change==='mac')corrupt(root,'UPDATE continuation_enrollment_plans SET storage_mac=? WHERE id=?',Buffer.alloc(32).toString('base64url'),id(3));
  if(change==='record')corrupt(root,'UPDATE continuation_enrollment_plans SET record=? WHERE id=?','{}',id(3));
  if(change==='binding')corrupt(root,'UPDATE continuation_enrollment_plans SET config_identity=? WHERE id=?',id(9),id(3));
  if(change==='root-bytes')corrupt(root,"UPDATE continuation_enrollment_plans SET canonical_root=CAST(x'ff' AS TEXT) WHERE id=?",id(3));
  if(change==='created')corrupt(root,'UPDATE continuation_enrollment_plans SET created_ms=? WHERE id=?',1001,id(3));
  const before=fs.readFileSync(file(root));assert.throws(()=>inspect(root,999999),error=>error.code==='authority_unavailable'&&!JSON.stringify(error).includes(root)&&!error.message.includes('synthetic-diagnosis-token'));assert.deepEqual(fs.readFileSync(file(root)),before);
 }
});
test('foreign retained rows cannot be diagnosed under another physical authority',posix,t=>{
 const root=fixture(t),other=fixture(t);plan(root,2);const saved=raw(root,db=>db.prepare('SELECT * FROM continuation_enrollment_plans').get());raw(other,db=>{const keys=Object.keys(saved);db.prepare(`INSERT INTO continuation_enrollment_plans(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(saved));});assert.throws(()=>inspect(other,999999));assert.equal(inspect(root,999999).plans.length,1);
});
test('source drift, altered schema and advanced authority refuse without repair',posix,t=>{
 for(const change of ['source','schema','revision']){const root=fixture(t);plan(root,2);if(change==='source')fs.appendFileSync(path.join(root,'config.env'),'# drift\n');else raw(root,db=>db.exec(change==='schema'?'CREATE TABLE extra(id)':'UPDATE authority SET revision=1'));const before=fs.readFileSync(file(root));assert.throws(()=>inspect(root,2000));assert.deepEqual(fs.readFileSync(file(root)),before);}
});
test('namespace substitution during source validation and rollback faults return no diagnosis',posix,t=>{
 const root=fixture(t);plan(root,2);const originalRead=fs.readSync,ino=fs.statSync(path.join(root,'config.env')).ino;let hit=false;
 fs.readSync=function(fd,...args){const n=originalRead.call(fs,fd,...args);if(n===0&&!hit&&fs.fstatSync(fd).ino===ino){hit=true;const marker=path.join(root,'pairing-authority.json');fs.renameSync(marker,marker+'.retained');fs.copyFileSync(marker+'.retained',marker);}return n;};try{assert.throws(()=>inspect(root,2000),{code:'authority_changed'});}finally{fs.readSync=originalRead;}assert.equal(hit,true);
 const before=fs.readFileSync(file(root)),exec=DatabaseSync.prototype.exec;for(const when of ['before','after']){DatabaseSync.prototype.exec=function(sql,...args){if(sql==='ROLLBACK'&&when==='before')throw Error('synthetic rollback');const value=exec.call(this,sql,...args);if(sql==='ROLLBACK'&&when==='after')throw Error('synthetic rolled back');return value;};try{assert.throws(()=>inspect(root,2000),{code:'authority_unavailable'});}finally{DatabaseSync.prototype.exec=exec;}assert.deepEqual(fs.readFileSync(file(root)),before);}
});
test('independent writer cannot publish a new plan through the diagnosis snapshot', {...posix,timeout:15000},t=>{
 const root=fixture(t),first=plan(root,2),module=new URL('../lib/pairing-authority.mjs',import.meta.url).href;
 const originalRead=fs.readSync,ino=fs.statSync(path.join(root,'config.env')).ino;let hit=false;
 fs.readSync=function(fd,...args){const n=originalRead.call(fs,fd,...args);if(n===0&&!hit&&fs.fstatSync(fd).ino===ino){hit=true;const child=spawnSync(process.execPath,['--input-type=module','-e',`import{retainInitialContinuationSignerPlan as retain}from ${JSON.stringify(module)};try{retain(process.argv[1],${JSON.stringify({configIdentity,id:id(3),candidate:first.candidate,now:1000,expiresMs:2000})});process.exitCode=1;}catch(e){if(!['authority_busy','authority_unavailable'].includes(e.code))process.exitCode=2;}`,root],{encoding:'utf8',timeout:10000,env:{DO_NOT_TRACK:'1'}});assert.equal(child.status,0,child.stderr);}return n;};
 try{assert.deepEqual(inspect(root,2000).plans.map(p=>p.id),[first.id]);}finally{fs.readSync=originalRead;}assert.equal(hit,true);assert.deepEqual(inspect(root,2000).plans.map(p=>p.id),[first.id]);assert.equal(plan(root,3).id,id(3));assert.equal(inspect(root,2000).plans.length,2);
});
