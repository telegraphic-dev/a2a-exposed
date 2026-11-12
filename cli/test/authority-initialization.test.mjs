import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {initializePairingAuthority,inspectPairingAuthority,readContinuationSourceSnapshot,withPairingAuthorityLease,mutatePairingAuthority} from '../lib/pairing-authority.mjs';
const posix={skip:process.platform==='win32'};
function fixture(t){
 const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'a2a-authority-init-'))),dir=path.join(parent,'config');fs.mkdirSync(dir,{mode:0o700});t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 const sources=root=>{fs.writeFileSync(path.join(root,'config.env'),'A=synthetic-original\n',{mode:0o600});fs.writeFileSync(path.join(root,'peers.json'),'{}\n',{mode:0o600});};sources(dir);
 return{dir,parent,sources,configIdentity:randomUUID()};
}
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function roots(t,{initialized=false}={}){
 const f=fixture(t),next=path.join(f.parent,'next'),retained=path.join(f.parent,'retained'),nextIdentity=randomUUID();fs.mkdirSync(next,{mode:0o700});f.sources(next);if(initialized){initializePairingAuthority(f.dir,f);initializePairingAuthority(next,{configIdentity:nextIdentity});}
 let swapped=false;return{...f,next,retained,nextIdentity,swap(){assert.equal(swapped,false);swapped=true;fs.renameSync(f.dir,retained);fs.renameSync(next,f.dir);},check(){assert.equal(swapped,true);assert.ok(fs.existsSync(path.join(retained,'config.env')));assert.ok(fs.existsSync(path.join(f.dir,'config.env')));}};
}
function onEOF(file,action,run){const ino=fs.statSync(file).ino,read=fs.readSync;let changed=false;fs.readSync=function(fd,...args){const n=read.call(fs,fd,...args);if(!changed&&n===0&&fs.fstatSync(fd).ino===ino){changed=true;action();}return n;};try{return run();}finally{fs.readSync=read;assert.equal(changed,true);}}

test('two independent initializers create exactly one private store without overwriting it',{...posix,timeout:10000},async t=>{
 const f=fixture(t),ids=[randomUUID(),randomUUID()];const children=ids.map(configIdentity=>{
  const child=fork(fileURLToPath(new URL('./fixtures/authority-process.mjs',import.meta.url)),[f.dir,configIdentity,'init'],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  const ready=new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);}),done=new Promise((resolve,reject)=>{child.once('exit',code=>code===0?resolve():reject(Error('synthetic initializer failed')));});return{child,ready,done};
 });await Promise.all(children.map(c=>c.ready));const results=Promise.all(children.map(c=>new Promise(resolve=>c.child.once('message',resolve))));children.forEach(c=>c.child.send('start'));const values=await results;await Promise.all(children.map(c=>c.done));assert.equal(values.filter(v=>v.ok).length,1);assert.ok(['authority_already_exists','authority_unavailable','authority_changed'].includes(values.find(v=>!v.ok).code));
 const winner=values.find(v=>v.ok);assert.equal(inspectPairingAuthority(f.dir).configIdentity,winner.configIdentity);for(const name of ['pairing-authority.sqlite','pairing-authority.json'])assert.equal(fs.statSync(path.join(f.dir,name)).mode&0o777,0o600);
 const before=hash(path.join(f.dir,'pairing-authority.sqlite'));assert.throws(()=>initializePairingAuthority(f.dir,f),{code:'authority_already_exists'});assert.equal(hash(path.join(f.dir,'pairing-authority.sqlite')),before);
});
test('initial source-read root replacement refuses before reserving any authority files',posix,t=>{
 const f=roots(t);onEOF(path.join(f.dir,'peers.json'),()=>f.swap(),()=>assert.throws(()=>initializePairingAuthority(f.dir,f),{code:'authority_changed'}));f.check();for(const root of [f.dir,f.retained])for(const name of ['pairing-authority.sqlite','pairing-authority.json'])assert.equal(fs.existsSync(path.join(root,name)),false);
});
test('initial database pre/post COMMIT faults preserve incomplete files and never regenerate on retry',posix,t=>{
 for(const when of ['before','after']){
  const f=fixture(t),exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql,...args){if(sql==='COMMIT'&&when==='before')throw Error('synthetic commit fault');const result=exec.call(this,sql,...args);if(sql==='COMMIT'&&when==='after')throw Error('synthetic committed return fault');return result;};
  try{assert.throws(()=>initializePairingAuthority(f.dir,f),{code:'authority_unavailable'});}finally{DatabaseSync.prototype.exec=exec;}
  assert.deepEqual(inspectPairingAuthority(f.dir),{configured:false,incomplete:true});const file=path.join(f.dir,'pairing-authority.sqlite'),before=hash(file);assert.throws(()=>initializePairingAuthority(f.dir,f),{code:'authority_already_exists'});assert.equal(hash(file),before);assert.equal(fs.existsSync(path.join(f.dir,'pairing-authority.json')),false);
 }
});
test('partial marker publication is retained as invalid rather than reset or reported complete',posix,t=>{
 const f=fixture(t),write=fs.writeFileSync;fs.writeFileSync=function(file,value,...args){if(typeof file==='number'&&typeof value==='string'&&value.startsWith('{"v":1')){write.call(fs,file,'{');throw Error('synthetic publication fault');}return write.call(fs,file,value,...args);};
 try{assert.throws(()=>initializePairingAuthority(f.dir,f),{code:'authority_unavailable'});}finally{fs.writeFileSync=write;}
 assert.equal(fs.readFileSync(path.join(f.dir,'pairing-authority.json'),'utf8'),'{');assert.throws(()=>inspectPairingAuthority(f.dir),{code:'authority_marker_invalid'});const before=hash(path.join(f.dir,'pairing-authority.sqlite'));assert.throws(()=>initializePairingAuthority(f.dir,f),{code:'authority_already_exists'});assert.equal(hash(path.join(f.dir,'pairing-authority.sqlite')),before);
});
test('replacement during marker reservation refuses success and preserves both partial namespaces',posix,t=>{
 const f=roots(t),marker=path.join(f.dir,'pairing-authority.json'),open=fs.openSync;
 fs.openSync=function(file,...args){if(file===marker&&typeof args[0]==='number'&&(args[0]&fs.constants.O_EXCL))f.swap();return open.call(fs,file,...args);};
 try{assert.throws(()=>initializePairingAuthority(f.dir,f),{code:'authority_changed'});}finally{fs.openSync=open;}
 f.check();assert.deepEqual(inspectPairingAuthority(f.retained),{configured:false,incomplete:true});assert.deepEqual(inspectPairingAuthority(f.dir),{configured:false,incomplete:true});assert.equal(fs.existsSync(path.join(f.retained,'pairing-authority.sqlite')),true);assert.equal(fs.existsSync(path.join(f.dir,'pairing-authority.json')),true);
});
test('substituting the exclusively reserved database instance refuses before schema writes',posix,t=>{
 const f=fixture(t),db=path.join(f.dir,'pairing-authority.sqlite'),retained=db+'.retained',open=fs.openSync;let replaced=false;
 fs.openSync=function(file,...args){const fd=open.call(fs,file,...args);if(file===db&&typeof args[0]==='number'&&(args[0]&fs.constants.O_EXCL)){replaced=true;fs.renameSync(db,retained);fs.writeFileSync(db,'',{flag:'wx',mode:0o600});}return fd;};
 try{assert.throws(()=>initializePairingAuthority(f.dir,f),{code:'authority_changed'});}finally{fs.openSync=open;}
 assert.equal(replaced,true);assert.equal(fs.statSync(db).size,0);assert.equal(fs.statSync(retained).size,0);assert.deepEqual(inspectPairingAuthority(f.dir),{configured:false,incomplete:true});
});
test('diagnostics refuse replacement during marker parsing and final source I/O',posix,t=>{
 for(const name of ['pairing-authority.json','peers.json']){
  const f=roots(t,{initialized:true});onEOF(path.join(f.dir,name),()=>f.swap(),()=>assert.throws(()=>inspectPairingAuthority(f.dir),{code:'authority_changed'}));f.check();assert.equal(inspectPairingAuthority(f.retained).configIdentity,f.configIdentity);assert.equal(inspectPairingAuthority(f.dir).configIdentity,f.nextIdentity);
 }
});
test('diagnostics in an outer lease cannot rebase onto an identical-byte marker replacement',posix,async t=>{
 const f=fixture(t);initializePairingAuthority(f.dir,f);const marker=path.join(f.dir,'pairing-authority.json'),retained=marker+'.retained';
 await assert.rejects(withPairingAuthorityLease(f.dir,f,async()=>{fs.renameSync(marker,retained);fs.copyFileSync(retained,marker);assert.throws(()=>inspectPairingAuthority(f.dir),{code:'authority_changed'});}),{code:'authority_changed'});assert.equal(hash(marker),hash(retained));
});
test('requested parent alias retargeted during the last anchor marker read cannot escape final checks',posix,t=>{
 const f=fixture(t),other=path.join(f.parent,'other'),alias=path.join(f.parent,'alias');fs.mkdirSync(other,{mode:0o700});f.sources(other);initializePairingAuthority(f.dir,f);initializePairingAuthority(other,{configIdentity:randomUUID()});
 // Root symlinks themselves are forbidden; use a parent alias containing an ordinary child.
 const a=path.join(f.parent,'a'),b=path.join(f.parent,'b');fs.mkdirSync(a,{mode:0o700});fs.mkdirSync(b,{mode:0o700});fs.renameSync(f.dir,path.join(a,'config'));fs.renameSync(other,path.join(b,'config'));fs.symlinkSync(a,alias);
 const target=path.join(alias,'config'),markerInode=fs.statSync(path.join(a,'config','pairing-authority.json')).ino,read=fs.readSync;let armed=false,markerReads=0,changed=false;
 fs.readSync=function(fd,...args){const n=read.call(fs,fd,...args);if(armed&&n===0&&fs.fstatSync(fd).ino===markerInode&&++markerReads===2){changed=true;fs.unlinkSync(alias);fs.symlinkSync(b,alias);}return n;};
 try{assert.throws(()=>readContinuationSourceSnapshot(target,f,view=>{armed=true;return view.inspectInventory();}),{code:'authority_changed'});}finally{fs.readSync=read;}
 assert.equal(changed,true);assert.notEqual(inspectPairingAuthority(target).configIdentity,f.configIdentity);assert.equal(inspectPairingAuthority(path.join(a,'config')).configIdentity,f.configIdentity);
});


test('a mutation after marker publication cannot leave a stale successful revision-zero setup result',posix,t=>{
 const f=fixture(t),marker=path.join(f.dir,'pairing-authority.json'),sync=fs.fsyncSync;let mutated=false;
 fs.fsyncSync=function(fd){const result=sync.call(fs,fd);if(!mutated&&fs.existsSync(marker)&&fs.fstatSync(fd).ino===fs.statSync(marker).ino){mutated=true;mutatePairingAuthority(f.dir,{...f,expectedRevision:0},()=>{});}return result;};
 try{assert.throws(()=>initializePairingAuthority(f.dir,f),{code:'authority_changed'});}finally{fs.fsyncSync=sync;}
 assert.equal(mutated,true);const state=inspectPairingAuthority(f.dir);assert.equal(state.configured,true);assert.equal(state.revision,1);assert.equal(state.writePending,false);const before=hash(path.join(f.dir,'pairing-authority.sqlite'));assert.throws(()=>initializePairingAuthority(f.dir,f),{code:'authority_already_exists'});assert.equal(hash(path.join(f.dir,'pairing-authority.sqlite')),before);
});
