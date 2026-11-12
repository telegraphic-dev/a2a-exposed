import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {LocalState} from '../local-state.mjs';

// Simulate PowerShell's nonterminating-error exit behavior at the process
// boundary. This verifies fail-closed wiring, not real Windows ACL semantics.
function withAclFailure(kind,action){
 const platform=Object.getOwnPropertyDescriptor(process,'platform'),exec=childProcess.execFileSync,calls=[];
 Object.defineProperty(process,'platform',{...platform,value:'win32'});
 childProcess.execFileSync=(command,args,options)=>{
  assert.equal(command,'powershell.exe');assert.deepEqual(args.slice(0,3),['-NoProfile','-NonInteractive','-Command']);assert.equal(options.timeout,5000);
  const script=args[3];calls.push(script);assert.equal(typeof options.input,'string');
  const modifies=script.includes('Set-Acl');
  if((['read','postwrite'].includes(kind)&&!modifies)||(kind==='write'&&modifies)){
   // Without terminating errors and an explicit failure exit, PowerShell can
   // report an ACL failure but exit zero, which must not authorize custody.
   if(script.includes("$ErrorActionPreference='Stop'")&&script.includes('catch{exit 1}'))throw Object.assign(Error('synthetic ACL failure'),{status:1});
  }
  return Buffer.alloc(0);
 };
 syncBuiltinESMExports();
 try{action(calls);}finally{childProcess.execFileSync=exec;syncBuiltinESMExports();Object.defineProperty(process,'platform',platform);}
}
test('Windows ACL inspection errors refuse an existing store without changing it',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-acl-read-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const original=new LocalState(dir,{create:true});original.close();const db=path.join(dir,'encryption/state.sqlite'),before=fs.readFileSync(db);
 withAclFailure('read',calls=>{assert.throws(()=>new LocalState(dir),{code:'key_store_permissions'});assert.equal(calls.length,1);});assert.deepEqual(fs.readFileSync(db),before);
});
test('Windows ACL modification errors refuse creation before a state database is installed',t=>{
 for(const kind of ['write','postwrite']){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-acl-write-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  withAclFailure(kind,calls=>{assert.throws(()=>new LocalState(dir,{create:true}),{code:'key_store_permissions'});assert.ok(calls[0].includes('Set-Acl'));if(kind==='postwrite')assert.equal(calls.length,2);});
  assert.equal(fs.existsSync(path.join(dir,'encryption/state.sqlite')),false);
 }
});
