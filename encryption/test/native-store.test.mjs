import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { nativeCredentialOperation } from "../native-store.mjs";
const input={op:"set",namespace:"11111111-1111-4111-8111-111111111111",account:"22222222-2222-4222-8222-222222222222/"+"A".repeat(43),value:"synthetic-private-canary"};
function fake(mode) {
 const child=new EventEmitter();child.pid=123456789;child.stdin=new PassThrough();child.stdout=new PassThrough();child.signals=[];child.unref=()=>{};
 child.kill=signal=>{child.signals.push(signal);if(mode!=="unreaped"&&(signal==='SIGKILL'||mode!=='ignore-term'))queueMicrotask(()=>{child.emit('exit',null,signal);child.emit('close',null,signal);});return true;};
 const spawn=()=>{setTimeout(()=>{
  if(mode==='success'){child.stdout.end('{"ok":true}');child.emit('exit',0);child.emit('close',0);}
  if(mode==='malformed'){child.stdout.end('synthetic-private-canary');child.emit('exit',0);child.emit('close',0);}
  if(mode==='oversized')child.stdout.write('x'.repeat(20000));
  if(mode==='pipe')child.stdin.emit('error',Error('synthetic-private-canary'));
  if(mode==='nonzero'){child.stdout.end('{"ok":false}');child.emit('exit',1);child.emit('close',1);}
 },1);return child;};return {child,spawn};
}
test("native consent rejects truthy nonbooleans without creating a process",async()=>{
 let calls=0;for(const allowOsConsent of [false,'false',0,1,null,{},[]])await assert.rejects(nativeCredentialOperation(input,{allowOsConsent,spawnImpl:()=>{calls++;throw Error();}}),{code:'key_store_consent'});assert.equal(calls,0);
});
test("native success waits for exit/close and persists PID before private input",async()=>{
 const f=fake('success');let pid;
 await nativeCredentialOperation(input,{allowOsConsent:true,spawnImpl:f.spawn,onSpawn:value=>{pid=value;assert.equal(f.child.stdin.readableLength,0);},timeoutMs:30,graceMs:5});assert.equal(pid,f.child.pid);assert.deepEqual(f.child.signals,[]);
});
test("timeout escalates ignored termination and waits for confirmed close",async()=>{
 const f=fake('ignore-term');await assert.rejects(nativeCredentialOperation(input,{allowOsConsent:true,spawnImpl:f.spawn,timeoutMs:5,graceMs:5}),{code:'native_outcome_unknown'});assert.deepEqual(f.child.signals,['SIGTERM','SIGKILL']);
});
test("unreaped children are reported as unknown with public PID, never successful",async()=>{
 const f=fake('unreaped');await assert.rejects(nativeCredentialOperation(input,{allowOsConsent:true,spawnImpl:f.spawn,timeoutMs:5,graceMs:5}),error=>error.code==='native_process_unreaped'&&error.pid===f.child.pid);assert.deepEqual(f.child.signals,['SIGTERM','SIGKILL']);
});
test("malformed/large output, nonzero exit and pipe errors never expose private material",async()=>{
 for(const mode of ['malformed','oversized','pipe','nonzero']){
  const f=fake(mode);await assert.rejects(nativeCredentialOperation(input,{allowOsConsent:true,spawnImpl:f.spawn,timeoutMs:30,graceMs:5}),error=>['native_outcome_unknown','native_process_unreaped'].includes(error.code)&&!String(error).includes(input.value));
 }
});
test("Windows timeout uses bounded force termination rather than POSIX signal assumptions",async()=>{
 const f=fake('ignore-term');await assert.rejects(nativeCredentialOperation(input,{allowOsConsent:true,spawnImpl:f.spawn,platform:'win32',timeoutMs:5,graceMs:5}),{code:'native_outcome_unknown'});assert.deepEqual(f.child.signals,['SIGKILL']);
});
