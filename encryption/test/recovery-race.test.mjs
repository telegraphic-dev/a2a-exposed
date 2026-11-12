import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {LocalState} from '../local-state.mjs';
const choices=(state,id,action)=>{const op=state.status().operations.find(x=>x.id===id);return {operationId:id,expectedDigest:op.digest,action,approvalDigest:op.recovery_choices.find(x=>x.action===action).approval_digest,ownerApproved:true,allowOsConsent:true};};
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-recovery-race-'));let secret,read;
 const state=new LocalState(dir,{create:true,keyring:async input=>{
  if(input.op==='set'){secret=input.value;throw Error('synthetic uncertain write');}
  assert.equal(input.op,'get');return read?read():secret;
 }});
 t.after(()=>{state.close();secret=undefined;fs.rmSync(dir,{recursive:true,force:true});});
 return {state,setRead:value=>read=value,getSecret:()=>secret};
}
async function pending(state){await assert.rejects(state.initialize({store:'keychain',allowOsConsent:true,cardUrl:'https://local.example.com/card'}),{code:'initialization_uncertain'});return state.status().operations[0].id;}
const localInit=state=>state.initialize({store:'file',cardUrl:'https://local.example.com/card'});
test('delayed absence cannot downgrade a committed adoption',async t=>{
 const {state,setRead}=fixture(t),id=await pending(state);let release,started;
 const began=new Promise(r=>started=r);setRead(()=>{started();return new Promise(r=>release=r);});
 const delayed=state.reconcileInitialization(choices(state,id,'abandon-if-absent'));
 const rejected=assert.rejects(delayed,{code:'approval_stale'});await began;setRead(null);
 await state.reconcileInitialization(choices(state,id,'adopt'));release(null);await rejected;
 const op=state.status().operations.find(x=>x.id===id);assert.equal(op.state,'committed');assert.equal(state.status().identities.length,1);
 await assert.rejects(localInit(state),{code:'keys_exist'});
});
test('delayed adoption rolls back after absence approval and new initialization',async t=>{
 const {state,setRead,getSecret}=fixture(t),id=await pending(state);let release;
 const secret=getSecret();
 let started;const began=new Promise(r=>started=r);setRead(()=>{started();return new Promise(r=>release=r);});
 const delayed=state.reconcileInitialization(choices(state,id,'adopt')),rejected=assert.rejects(delayed,{code:'approval_stale'});await began;
 setRead(()=>null);await state.reconcileInitialization(choices(state,id,'abandon-if-absent'));
 const current=await localInit(state);release(secret);await rejected;setRead(()=>secret);
 assert.equal(state.status().identities.length,1);assert.equal(state.status().identities[0].id,current.id);
 const result=await state.reconcileInitialization(choices(state,id,'adopt'));assert.equal(result.retained_orphan,true);
 assert.equal(state.status().identities[0].id,current.id);
});
test('action and revision approvals cannot be reused, including an unchanged state name',async t=>{
 const {state,setRead}=fixture(t),id=await pending(state);setRead(()=>null);
 const first=choices(state,id,'abandon-if-absent'),adopt=choices(state,id,'adopt');
 await assert.rejects(state.reconcileInitialization({...first,approvalDigest:adopt.approvalDigest}),{code:'approval_stale'});
 await state.reconcileInitialization(first);const second=choices(state,id,'abandon-if-absent');
 await state.reconcileInitialization(second);
 const before=state.status().operations.find(x=>x.id===id);assert.equal(before.state,'observed-absent');
 await assert.rejects(state.reconcileInitialization(second),{code:'approval_stale'});
 assert.deepEqual(state.status().operations.find(x=>x.id===id),before);
});
