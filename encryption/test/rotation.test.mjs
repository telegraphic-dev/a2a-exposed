import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {LocalState,restoreBackup} from '../local-state.mjs';
import {generateIdentity,seal,open} from '../index.mjs';
const remote=await generateIdentity('https://remote.example.com/card');
const passphrase=Buffer.from('synthetic rotation backup passphrase');
function fixture(t,options={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-key-rotation-'));const state=new LocalState(path.join(dir,'source'),{create:true,...options});t.after(()=>{state.close();fs.rmSync(dir,{recursive:true,force:true});});return {dir,state};}
const init=state=>state.initialize({store:'file',cardUrl:'https://local.example.com/card'});
const approve=(state,id)=>({id,approvalDigest:state.rotationPlan(id).approval_digest,ownerApproved:true});
async function pin(state,localId,expectedCurrent='none',verification='tofu'){
 return state.propose({peer:'remote',localId,bundle:remote.bundle,pairingIdentity:remote.bundle.identityKey,expectedCurrent,policy:'required',verification});
}
test('rotation retains old archive keys, keeps signing identity and holds old peer pins',async t=>{
 const {dir,state}=fixture(t),first=await init(state),old=await state.loadIdentity(first.id);
 const binding={contextId:'context',messageId:'old',taskId:null,role:'user',state:null,kind:'message'};
 const envelope=await seal({identity:old,recipient:remote.bundle,binding,content:{text:'old synthetic archive'}});
 const pending=await pin(state,first.id);await state.approve({peer:'remote',digest:pending.digest,expectedCurrent:'none',ownerApproved:true});
 const oldTrust=state.inspect('remote').current_digest,oldFile=fs.readFileSync(path.join(state.root,first.id+'.key'));
 const plan=approve(state,first.id),second=await state.rotateLocal(plan);assert.notEqual(first.id,second.id);assert.notEqual(first.bundle.keyId,second.bundle.keyId);assert.equal(first.bundle.identityKey,second.bundle.identityKey);
 assert.deepEqual(fs.readFileSync(path.join(state.root,first.id+'.key')),oldFile);assert.equal(state.row(first.id).live_state,'retired');assert.equal(state.row(second.id).live_state,'local-only');assert.equal(state.inspect('remote').live_state,'change-pending');assert.equal(state.inspect('remote').current_digest,oldTrust);
 const oldAgain=await state.loadIdentity(first.id);assert.deepEqual(await open({envelope,identity:oldAgain,sender:old.bundle,recipient:remote.bundle,expected:binding,purpose:'sender'}),{text:'old synthetic archive'});
 await assert.rejects(state.rotateLocal(plan),{code:'key_retired'});await assert.rejects(pin(state,first.id,oldTrust),{code:'key_retired'});
 const tofu=await pin(state,second.id,oldTrust);await assert.rejects(state.approve({peer:'remote',digest:tofu.digest,expectedCurrent:oldTrust,ownerApproved:true}),{code:'independent_verification_required'});
 const verified=await pin(state,second.id,oldTrust,'independent');await state.approve({peer:'remote',digest:verified.digest,expectedCurrent:oldTrust,ownerApproved:true,independentVerified:true,verifiedProposalDigest:verified.digest});assert.equal(state.inspect('remote').live_state,'independently-verified');
 const backup=path.join(dir,'rotated-backup.json'),destination=path.join(dir,'restored');await state.createBackup({destination:backup,passphrase});await restoreBackup({source:backup,destination,passphrase,store:'file',acknowledgeReplayRollback:true});
 const archive=new LocalState(destination);t.after(()=>archive.close());assert.equal(archive.status().identities.length,2);await archive.loadIdentity(first.id);await archive.loadIdentity(second.id);
});
test('uncertain rotation preserves old active key and recovers the original new key without duplication',async t=>{
 const {state}=fixture(t),first=await init(state);
 state.db.exec("CREATE TRIGGER fail_rotation BEFORE INSERT ON identities BEGIN SELECT RAISE(FAIL,'synthetic fault'); END");
 await assert.rejects(state.rotateLocal(approve(state,first.id)),{code:'rotation_uncertain'});assert.equal(state.row(first.id).live_state,'local-only');assert.equal(state.status().identities.length,1);
 assert.throws(()=>state.rotationPlan(first.id),{code:'initialization_pending'});const op=state.status().operations.find(x=>x.operation.kind==='rotate');assert.equal(op.state,'uncertain');
 state.db.exec('DROP TRIGGER fail_rotation');const recovered=await state.reconcileInitialization({operationId:op.id,expectedDigest:op.digest,action:'adopt',approvalDigest:op.recovery_choices.find(x=>x.action==='adopt').approval_digest,ownerApproved:true});
 assert.equal(recovered.id,op.operation.identityId);assert.equal(state.row(first.id).live_state,'retired');assert.equal(state.status().identities.length,2);assert.equal(fs.readdirSync(state.root).filter(x=>x.endsWith('.key')).length,2);
});
test('concurrent rotation plans produce one committed version and no untracked files',async t=>{
 const {state}=fixture(t),first=await init(state),plan=approve(state,first.id);
 const result=await Promise.allSettled([state.rotateLocal(plan),state.rotateLocal(plan)]);assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.ok(['initialization_pending','key_retired','approval_stale'].includes(result.find(x=>x.status==='rejected').reason.code));assert.equal(state.status().identities.length,2);assert.equal(state.status().operations.length,2);assert.equal(fs.readdirSync(state.root).filter(x=>x.endsWith('.key')).length,2);
});
test('rotation refuses lost old keys, invalid inputs and nonboolean native consent without replacing identity',async t=>{
 const values=new Map(),calls=[];const keyring=async input=>{calls.push(input.op);const key=input.namespace+input.account;if(input.op==='set'){values.set(key,input.value);return;}return values.get(key)??null;};
 const {state}=fixture(t,{keyring}),first=await state.initialize({store:'keychain',allowOsConsent:true,cardUrl:'https://local.example.com/card'}),plan=approve(state,first.id),before=calls.length;
 await assert.rejects(state.rotateLocal({...plan,ownerApproved:false}),{code:'owner_approval_required'});await assert.rejects(state.rotateLocal({...plan,approvalDigest:'wrong'}),{code:'approval_stale'});
 for(const now of [-1,0.5,NaN,Infinity])await assert.rejects(state.rotateLocal({...plan,allowOsConsent:true,now}),{code:'clock_invalid'});
 for(const consent of [false,'false',1,null,{}])await assert.rejects(state.rotateLocal({...plan,allowOsConsent:consent}),{code:'key_store_consent'});assert.equal(calls.length,before);
 values.clear();await assert.rejects(state.rotateLocal({...plan,allowOsConsent:true}),{code:'key_lost'});assert.equal(state.status().identities.length,1);assert.equal(state.status().operations.length,1);
});
