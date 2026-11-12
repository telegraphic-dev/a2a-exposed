import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {initializePairingAuthority,inspectPairingAuthority,mutatePairingAuthority,planPairingAuthorityRecovery,quarantinePairingAuthority,withPairingAuthorityLease,readPairingAuthorityRevision} from '../lib/pairing-authority.mjs';
const posix={skip:process.platform==='win32'};
function roots(t,{pending=false,clone=false}={}){
 const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'a2a-writer-anchor-'))),dir=path.join(parent,'config'),next=path.join(parent,'next'),retained=path.join(parent,'retained'),configIdentity=randomUUID(),replacementIdentity=clone?configIdentity:randomUUID();t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 const init=(root,id)=>{fs.mkdirSync(root,{mode:0o700});fs.writeFileSync(path.join(root,'config.env'),'A=synthetic-original\n',{mode:0o600});fs.writeFileSync(path.join(root,'peers.json'),'{}\n',{mode:0o600});initializePairingAuthority(root,{configIdentity:id});};init(dir,configIdentity);
 if(pending)assert.throws(()=>mutatePairingAuthority(dir,{configIdentity,expectedRevision:0},()=>{throw Error('synthetic interruption');}));
 if(clone){fs.mkdirSync(next,{mode:0o700});for(const name of ['config.env','peers.json','pairing-authority.sqlite','pairing-authority.json']){fs.copyFileSync(path.join(dir,name),path.join(next,name));fs.chmodSync(path.join(next,name),0o600);}}else init(next,replacementIdentity);
 let swapped=false;return{dir,next,retained,configIdentity,replacementIdentity,swap(){assert.equal(swapped,false);swapped=true;fs.renameSync(dir,retained);fs.renameSync(next,dir);},check(){assert.equal(swapped,true);assert.equal(inspectPairingAuthority(dir).configIdentity,replacementIdentity);assert.equal(inspectPairingAuthority(retained).configIdentity,configIdentity);}};
}
function sourceSwap(p,action){
 const ino=fs.statSync(path.join(p.dir,'config.env')).ino,read=fs.readSync;let swapped=false;
 fs.readSync=function(fd,...args){const n=read.call(fs,fd,...args);if(!swapped&&n===0&&fs.fstatSync(fd).ino===ino){swapped=true;p.swap();}return n;};
 try{return action();}finally{fs.readSync=read;assert.equal(swapped,true);}
}
const options=(p,plan)=>({configIdentity:p.configIdentity,expectedRevision:plan.revision,expectedIntent:plan.pendingIntent,...plan.choices[0],ownerApproved:true});

test('mutation refuses replacement before the barrier and retains original pending/committed effects across both commit edges',posix,t=>{
 for(const stage of ['before-barrier','after-barrier','after-final']){
  const p=roots(t);let calls=0,commits=0;const exec=DatabaseSync.prototype.exec;
  const act=()=>mutatePairingAuthority(p.dir,{configIdentity:p.configIdentity,expectedRevision:0},()=>{calls++;fs.writeFileSync(path.join(p.dir,'config.env'),'A=synthetic-changed\n',{mode:0o600});});
  try{
   if(stage==='before-barrier')sourceSwap(p,()=>assert.throws(act,{code:'authority_changed'}));
   else{DatabaseSync.prototype.exec=function(sql,...args){const result=exec.call(this,sql,...args);if(sql==='COMMIT'&&++commits===(stage==='after-barrier'?1:2))p.swap();return result;};assert.throws(act,{code:'authority_changed'});}
  }finally{DatabaseSync.prototype.exec=exec;}
  p.check();const original=inspectPairingAuthority(p.retained),replacement=inspectPairingAuthority(p.dir);assert.equal(replacement.revision,0);assert.equal(replacement.writePending,false);
  assert.equal(calls,stage==='after-final'?1:0);assert.equal(original.revision,stage==='before-barrier'?0:1);assert.equal(original.writePending,stage==='after-barrier');assert.equal(original.sourceMismatch,false);
  assert.equal(fs.readFileSync(path.join(p.retained,'config.env'),'utf8'),stage==='after-final'?'A=synthetic-changed\n':'A=synthetic-original\n');assert.equal(fs.readFileSync(path.join(p.dir,'config.env'),'utf8'),'A=synthetic-original\n');
 }
});
test('recovery planning does not return an approval against a renamed configuration',posix,t=>{
 const p=roots(t,{pending:true});sourceSwap(p,()=>assert.throws(()=>planPairingAuthorityRecovery(p.dir,{configIdentity:p.configIdentity}),{code:'authority_changed'}));p.check();assert.equal(inspectPairingAuthority(p.retained).writePending,true);assert.equal(inspectPairingAuthority(p.dir).revision,0);
});
test('quarantine detects replacement before commit and reports post-COMMIT failure without undoing suspension',posix,t=>{
 for(const stage of ['before-commit','after-commit']){
  const p=roots(t,{pending:true}),plan=planPairingAuthorityRecovery(p.dir,{configIdentity:p.configIdentity}),exec=DatabaseSync.prototype.exec;let commits=0;
  const act=()=>quarantinePairingAuthority(p.dir,options(p,plan));
  try{if(stage==='before-commit')sourceSwap(p,()=>assert.throws(act,{code:'authority_changed'}));else{DatabaseSync.prototype.exec=function(sql,...args){const result=exec.call(this,sql,...args);if(sql==='COMMIT'&&++commits===1)p.swap();return result;};assert.throws(act,{code:'authority_changed'});}}finally{DatabaseSync.prototype.exec=exec;}
  p.check();const original=inspectPairingAuthority(p.retained),replacement=inspectPairingAuthority(p.dir);assert.equal(original.revision,stage==='after-commit'?2:1);assert.equal(original.suspended,stage==='after-commit');assert.equal(original.writePending,stage!=='after-commit');assert.equal(replacement.revision,0);assert.equal(replacement.suspended,false);
 }
});
test('same-path full-store copy invalidates the old recovery approval despite copied UUID and private MAC key',posix,t=>{
 const p=roots(t,{pending:true,clone:true}),plan=planPairingAuthorityRecovery(p.dir,{configIdentity:p.configIdentity});p.swap();
 assert.throws(()=>quarantinePairingAuthority(p.dir,options(p,plan)),{code:'authority_recovery_stale'});
 const fresh=planPairingAuthorityRecovery(p.dir,{configIdentity:p.configIdentity});assert.notEqual(fresh.choices[0].approvalToken,plan.choices[0].approvalToken);assert.equal(quarantinePairingAuthority(p.dir,options(p,fresh)).suspended,true);p.check();
 assert.equal(inspectPairingAuthority(p.retained).writePending,true);assert.equal(inspectPairingAuthority(p.retained).revision,1);assert.equal(inspectPairingAuthority(p.dir).revision,2);
});
test('writes/plans cannot rebase onto a copied root while an outer lease owns the original instance',posix,async t=>{
 const p=roots(t,{clone:true});let calls=0;
 await assert.rejects(withPairingAuthorityLease(p.dir,{configIdentity:p.configIdentity},async()=>{p.swap();assert.throws(()=>mutatePairingAuthority(p.dir,{configIdentity:p.configIdentity,expectedRevision:0},()=>calls++),{code:'authority_changed'});assert.throws(()=>planPairingAuthorityRecovery(p.dir,{configIdentity:p.configIdentity}),{code:'authority_changed'});}),{code:'authority_changed'});
 p.check();assert.equal(calls,0);assert.equal(inspectPairingAuthority(p.dir).revision,0);assert.equal(inspectPairingAuthority(p.retained).revision,0);
});


test('nested lease and revision read cannot adopt a copied root while the original outer lease is active',posix,async t=>{
 const p=roots(t,{clone:true});let calls=0;
 await assert.rejects(withPairingAuthorityLease(p.dir,{configIdentity:p.configIdentity},async()=>{p.swap();assert.throws(()=>readPairingAuthorityRevision(p.dir,{configIdentity:p.configIdentity}),{code:'authority_changed'});await assert.rejects(withPairingAuthorityLease(p.dir,{configIdentity:p.configIdentity},async()=>{calls++;}),{code:'authority_changed'});}),{code:'authority_changed'});
 p.check();assert.equal(calls,0);
});
