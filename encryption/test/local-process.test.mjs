import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {LocalState} from '../local-state.mjs';
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-custody-process-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;
}
function child(t,dir,mode) {
 const proc=fork(fileURLToPath(new URL('./fixtures/local-process.mjs',import.meta.url)),[dir,mode],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
 t.after(()=>{if(proc.exitCode===null && proc.signalCode===null)proc.kill('SIGKILL');});
 const messages=[];let resolveReady;
 const ready=new Promise(resolve=>resolveReady=resolve);
 proc.on('message',message=>{messages.push(message);if(message.ready)resolveReady();});
 const exited=new Promise((resolve,reject)=>{proc.once('error',reject);proc.once('exit',(code,signal)=>resolve({code,signal,messages}));});
 return {proc,ready,exited};
}
test('two independent processes cannot initialize duplicate keys or untracked credentials',{timeout:15000},async t=>{
 const dir=fixture(t);const initial=new LocalState(dir,{create:true});initial.close();
 const a=child(t,dir,'file'),b=child(t,dir,'file');await Promise.all([a.ready,b.ready]);a.proc.send('start');b.proc.send('start');
 const results=await Promise.all([a.exited,b.exited]);assert.ok(results.every(x=>x.code===0));
 const replies=results.flatMap(x=>x.messages).filter(x=>!x.ready);
 assert.equal(replies.filter(x=>x.ok).length,1);assert.ok(['keys_exist','initialization_pending'].includes(replies.find(x=>!x.ok).code));
 const state=new LocalState(dir);t.after(()=>state.close());const status=state.status();
 assert.equal(status.identities.length,1);assert.equal(status.operations.length,1);assert.equal(status.operations[0].state,'committed');
 assert.equal(fs.readdirSync(path.join(dir,'encryption')).filter(x=>x.endsWith('.key')).length,1);
});
test('process crash after mock native write recovers original credential from durable intent',{timeout:15000},async t=>{
 const dir=fixture(t),a=child(t,dir,'crash');await a.ready;a.proc.send('start');assert.equal((await a.exited).code,77);
 const state=new LocalState(dir,{write:true,keyring:async input=>{assert.equal(input.op,'get');return fs.readFileSync(path.join(dir,'mock-native.key'),'utf8');}});t.after(()=>state.close());
 const status=state.status();assert.equal(status.identities.length,0);assert.equal(status.operations.length,1);assert.equal(status.operations[0].state,'writing');
 await assert.rejects(state.initialize({store:'file',cardUrl:'https://local.example.com/card'}),{code:'initialization_pending'});
 const op=status.operations[0];
 const adopted=await state.reconcileInitialization({operationId:op.id,expectedDigest:op.digest,action:'adopt',ownerApproved:true,allowOsConsent:true});
 assert.equal(adopted.id,op.operation.identityId);assert.equal(state.status().identities.length,1);assert.equal(state.status().operations[0].state,'committed');
});
test('schema tampering fails closed without replacing or migrating the database',async t=>{
 const dir=fixture(t),state=new LocalState(dir,{create:true});state.db.exec('CREATE TABLE unexpected(value TEXT)');state.close();
 const before=fs.readFileSync(path.join(dir,'encryption/state.sqlite'));
 assert.throws(()=>new LocalState(dir),{code:'state_corrupt'});
 assert.deepEqual(fs.readFileSync(path.join(dir,'encryption/state.sqlite')),before);
});
