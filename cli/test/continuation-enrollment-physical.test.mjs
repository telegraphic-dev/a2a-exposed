import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {spawnSync,spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {initializeFreshContinuationProvenanceAuthority as initialize,inspectFreshContinuationProvenanceAuthority as inspect,retainInitialContinuationSignerPlan as retain,readInitialContinuationSignerPlan as read,initializePairingAuthority,initializeContinuationAuthority} from '../lib/pairing-authority.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const options={configIdentity:id(1)},posix={skip:process.platform==='win32'};
function candidate(){const der=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'});return{public_key_spki:der.toString('base64url'),fingerprint:createHash('sha256').update(der).digest('base64url')};}
const input=()=>({...options,id:id(2),candidate:candidate(),now:1000,expiresMs:2000});
function fixture(t,init=initialize){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'a2a-enrollment-physical-')));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.writeFileSync(path.join(root,'config.env'),'TOKEN=synthetic-token\n',{mode:0o600});init(root,options);return root;}
const file=root=>path.join(root,'pairing-authority.sqlite');
function raw(root,fn){const db=new DatabaseSync(file(root));try{return fn(db);}finally{db.close();}}
const bytes=root=>fs.readFileSync(file(root));
function onEOF(file,fn,action){const ino=fs.statSync(file).ino,readSync=fs.readSync;let hit=false;fs.readSync=function(fd,...args){const n=readSync.call(fs,fd,...args);if(n===0&&!hit&&fs.fstatSync(fd).ino===ino){hit=true;fn();}return n;};try{return action();}finally{fs.readSync=readSync;assert.equal(hit,true);}}
const readInput=p=>({configIdentity:p.configIdentity,id:p.id,now:p.now});

test('anchored initial plan persists without selecting a signer, changing authority or approving anything',posix,t=>{
 const root=fixture(t),p=input(),before=raw(root,db=>db.prepare('SELECT * FROM authority').get()),plan=retain(root,p);
 assert.equal(plan.operation,'initial');assert.equal(plan.current_signer,null);assert.equal(plan.authority.canonical_root,root);assert.equal(plan.authority.epoch,before.suspension_epoch);assert.deepEqual(plan.candidate,p.candidate);assert.equal(plan.created_ms,1000);assert.equal(plan.expires_ms,2000);
 raw(root,db=>{assert.deepEqual(db.prepare('SELECT * FROM authority').get(),before);for(const table of ['continuation_signer_enrollments','continuation_decision_receipts','continuation_intents','grant_sets','grant_members','continuation_attestations'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);});
 const persisted=bytes(root);assert.deepEqual(read(root,readInput(p)),plan);assert.deepEqual(bytes(root),persisted);assert.throws(()=>inspect(root,options),{code:'authority_fresh_required'});
 assert.ok(!JSON.stringify(plan).includes(before.recovery_key));assert.ok(!JSON.stringify(plan).includes(before.source_hash));assert.ok(!JSON.stringify(plan).includes('synthetic-token'));
 const module=new URL('../lib/pairing-authority.mjs',import.meta.url).href,child=spawnSync(process.execPath,['--input-type=module','-e',`import{readInitialContinuationSignerPlan as read}from ${JSON.stringify(module)};console.log(JSON.stringify(read(process.argv[1],${JSON.stringify(readInput(p))})));`,root],{encoding:'utf8',timeout:10000,env:{DO_NOT_TRACK:'1'}});assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),plan);
});
test('duplicate ID refuses without replacement; a distinct plan keeps the same suspended baseline',posix,t=>{
 const root=fixture(t),p=input(),first=retain(root,p),before=bytes(root);assert.throws(()=>retain(root,{...p,candidate:candidate()}));assert.deepEqual(bytes(root),before);assert.deepEqual(read(root,readInput(p)),first);
 const second=retain(root,{...p,id:id(3),now:2000,expiresMs:3000});assert.deepEqual(first.authority,second.authority);assert.equal(raw(root,db=>db.prepare('SELECT COUNT(*) n FROM continuation_enrollment_plans').get().n),2);
});
test('invalid candidate, identity, clocks and missing plans fail without writes',posix,t=>{
 const root=fixture(t),p=input(),before=bytes(root);
 for(const patch of [{id:'bad'},{candidate:{...p.candidate,fingerprint:Buffer.alloc(32).toString('base64url')}},{now:-1},{now:NaN},{expiresMs:1000},{expiresMs:601001},{configIdentity:id(9)}]){assert.throws(()=>retain(root,{...p,...patch}));assert.deepEqual(bytes(root),before);}
 assert.throws(()=>read(root,readInput(p)));assert.deepEqual(bytes(root),before);
 retain(root,p);const saved=bytes(root);for(const now of [999,2000,NaN])assert.throws(()=>read(root,{...readInput(p),now}));assert.deepEqual(bytes(root),saved);assert.equal(read(root,{...readInput(p),now:1999}).id,p.id);
});
test('legacy authority formats are preserved and refused',posix,t=>{
 for(const init of [initializePairingAuthority,initializeContinuationAuthority]){const root=fixture(t,init),before=bytes(root);assert.throws(()=>retain(root,input()),{code:'authority_schema'});assert.throws(()=>read(root,readInput(input())),{code:'authority_schema'});assert.deepEqual(bytes(root),before);}
});
test('source drift refuses retention and reads without repairing authority',posix,t=>{
 const root=fixture(t),p=input();retain(root,p);fs.appendFileSync(path.join(root,'config.env'),'# drift\n');const before=bytes(root);for(const action of [()=>retain(root,{...p,id:id(3)}),()=>read(root,readInput(p))])assert.throws(action,{code:'authority_external_change'});assert.deepEqual(bytes(root),before);
});
test('retained MAC corruption refuses read; errors contain no private plan or source',posix,t=>{
 const root=fixture(t),p=input();retain(root,p);raw(root,db=>{const triggers=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='continuation_enrollment_plans'").all();for(const r of triggers)db.exec(`DROP TRIGGER ${r.name}`);db.prepare('UPDATE continuation_enrollment_plans SET storage_mac=?').run(Buffer.alloc(32).toString('base64url'));for(const r of triggers)db.exec(r.sql);});
 const before=bytes(root);assert.throws(()=>read(root,readInput(p)),error=>error.code==='authority_unavailable'&&!JSON.stringify(error).includes(root)&&!error.message.includes('synthetic-token'));assert.deepEqual(bytes(root),before);
});
test('a structurally valid synthetic signer cannot supply current signer authority',posix,t=>{
 const root=fixture(t);raw(root,db=>db.prepare('INSERT INTO continuation_signer_enrollments VALUES(?,?,?,?,?,?)').run(id(4),options.configIdentity,root,id(5),Buffer.alloc(44).toString('base64url'),Buffer.alloc(32).toString('base64url')));const before=bytes(root);assert.throws(()=>retain(root,input()),{code:'authority_fresh_required'});assert.deepEqual(bytes(root),before);
});
test('namespace replacement on source I/O refuses before plan commit',posix,t=>{
 const root=fixture(t),p=input(),marker=path.join(root,'pairing-authority.json');onEOF(path.join(root,'config.env'),()=>{fs.renameSync(marker,marker+'.retained');fs.copyFileSync(marker+'.retained',marker);},()=>assert.throws(()=>retain(root,p),{code:'authority_changed'}));assert.equal(raw(root,db=>db.prepare('SELECT COUNT(*) n FROM continuation_enrollment_plans').get().n),0);
});
test('source change during final guard rolls back retained plan',posix,t=>{
 const root=fixture(t),p=input(),prepare=DatabaseSync.prototype.prepare;let hit=false;
 DatabaseSync.prototype.prepare=function(sql,...args){const statement=prepare.call(this,sql,...args);if(sql.startsWith('INSERT INTO continuation_enrollment_plans(')){const run=statement.run.bind(statement);statement.run=(...values)=>{const result=run(...values);hit=true;fs.appendFileSync(path.join(root,'config.env'),'# changed\n');return result;};}return statement;};
 try{assert.throws(()=>retain(root,p),{code:'authority_external_change'});}finally{DatabaseSync.prototype.prepare=prepare;}assert.equal(hit,true);assert.equal(raw(root,db=>db.prepare('SELECT COUNT(*) n FROM continuation_enrollment_plans').get().n),0);
});
test('pre/post commit faults preserve original operation and never return success',posix,t=>{
 for(const when of ['before','after']){const root=fixture(t),p=input(),exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql,...args){if(sql==='COMMIT'&&when==='before')throw Error('synthetic commit');const result=exec.call(this,sql,...args);if(sql==='COMMIT'&&when==='after')throw Error('synthetic committed return');return result;};try{assert.throws(()=>retain(root,p),{code:'authority_unavailable'});}finally{DatabaseSync.prototype.exec=exec;}const count=raw(root,db=>db.prepare('SELECT COUNT(*) n FROM continuation_enrollment_plans').get().n);assert.equal(count,when==='after'?1:0);if(when==='after'){assert.equal(read(root,readInput(p)).id,p.id);assert.throws(()=>retain(root,p));}else assert.equal(retain(root,p).id,p.id);}
});
test('postcommit namespace failure retains original plan for read-only diagnosis',posix,t=>{
 const root=fixture(t),p=input(),exec=DatabaseSync.prototype.exec,marker=path.join(root,'pairing-authority.json');let hit=false;DatabaseSync.prototype.exec=function(sql,...args){const result=exec.call(this,sql,...args);if(sql==='COMMIT'){hit=true;fs.renameSync(marker,marker+'.retained');fs.copyFileSync(marker+'.retained',marker);}return result;};try{assert.throws(()=>retain(root,p),{code:'authority_changed'});}finally{DatabaseSync.prototype.exec=exec;}assert.equal(hit,true);assert.equal(read(root,readInput(p)).id,p.id);assert.throws(()=>retain(root,p));
});
test('independent writers serialize and retain a plan ID only once', {...posix,timeout:15000},async t=>{
 const root=fixture(t),p=input(),module=new URL('../lib/pairing-authority.mjs',import.meta.url).href,script=`import{retainInitialContinuationSignerPlan as retain}from ${JSON.stringify(module)};process.send('ready');process.once('message',()=>{try{retain(process.argv[1],${JSON.stringify(p)});process.send('ok');}catch(e){process.send(e.code);}process.disconnect();});`;
 const children=[0,1].map(()=>{const child=spawn(process.execPath,['--input-type=module','-e',script,root],{stdio:['ignore','ignore','ignore','ipc']});t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});return{child,ready:new Promise((r,j)=>{child.once('message',r);child.once('error',j);}),done:new Promise((r,j)=>child.once('exit',code=>code===0?r():j(Error('child failed'))))};});await Promise.all(children.map(c=>c.ready));const results=Promise.all(children.map(c=>new Promise(r=>c.child.once('message',r))));children.forEach(c=>c.child.send('start'));const values=await results;await Promise.all(children.map(c=>c.done));assert.equal(values.filter(v=>v==='ok').length,1);assert.ok(['authority_busy','authority_unavailable'].includes(values.find(v=>v!=='ok')));assert.equal(read(root,readInput(p)).id,p.id);assert.equal(raw(root,db=>db.prepare('SELECT COUNT(*) n FROM continuation_enrollment_plans').get().n),1);
});
test('copied retained plan cannot authenticate under another physical configuration',posix,t=>{
 const root=fixture(t),other=fixture(t),p=input();retain(root,p);const saved=raw(root,db=>db.prepare('SELECT * FROM continuation_enrollment_plans').get());raw(other,db=>{const keys=Object.keys(saved);db.prepare(`INSERT INTO continuation_enrollment_plans(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(saved));});const before=bytes(other);assert.throws(()=>read(other,readInput(p)),{code:'authority_unavailable'});assert.deepEqual(bytes(other),before);assert.equal(read(root,readInput(p)).id,p.id);
});
test('read rollback failure returns no plan and leaves stored bytes unchanged',posix,t=>{
 for(const when of ['before','after']){const root=fixture(t),p=input();retain(root,p);const before=bytes(root),exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql,...args){if(sql==='ROLLBACK'&&when==='before')throw Error('synthetic rollback');const result=exec.call(this,sql,...args);if(sql==='ROLLBACK'&&when==='after')throw Error('synthetic rolled-back return');return result;};try{assert.throws(()=>read(root,readInput(p)),{code:'authority_unavailable'});}finally{DatabaseSync.prototype.exec=exec;}assert.deepEqual(bytes(root),before);assert.equal(read(root,readInput(p)).id,p.id);}
});
