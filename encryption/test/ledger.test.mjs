import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {LocalState,restoreBackup}from'../local-state.mjs';
import {DeliveryLedger}from'../ledger.mjs';
import {EXTENSION,generateIdentity,seal,canonicalJSON}from'../index.mjs';
import {verifyAssignment}from'../assignment.mjs';
const sender=await generateIdentity('https://sender.example.com/card');
const content={kind:'message',authorRole:'user',parts:[{kind:'text',text:'synthetic-ledger-private-canary',mediaType:null,metadata:{}}],metadata:{},extensions:[],referenceTaskIds:[]};
const binding={contextId:'context',messageId:'request',taskId:null,role:'user',state:null,kind:'message'};
async function fixture(t,{keyring}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-delivery-ledger-')),state=new LocalState(path.join(dir,'recipient'),{create:true,...(keyring?{keyring}:{})});t.after(()=>{state.close();fs.rmSync(dir,{recursive:true,force:true});});
 const local=await state.initialize({store:keyring?'keychain':'file',cardUrl:'https://recipient.example.com/card',allowOsConsent:!!keyring});
 const proposal=await state.propose({peer:'sender',localId:local.id,bundle:sender.bundle,pairingIdentity:sender.bundle.identityKey,expectedCurrent:'none',policy:'required',verification:'tofu'});await state.approve({peer:'sender',digest:proposal.digest,expectedCurrent:'none',ownerApproved:true});
 const envelope=await seal({identity:sender,recipient:local.bundle,binding,content}),ledger=new DeliveryLedger(state);
 const options={localId:local.id,peer:'sender',envelope,observedTaskId:'assigned-task',protocol:'1.0',activatedExtension:EXTENSION,pairingIdentity:sender.bundle.identityKey,pairingVerified:true,allowOsConsent:!!keyring};
 return {dir,state,local,ledger,envelope,options};
}
test('initial acceptance commits assignment/replay/ciphertext outbox before exposing one cached receipt',async t=>{
 const {dir,state,local,ledger,envelope,options}=await fixture(t),accepted=await ledger.receiveInitial(options);
 assert.equal(accepted.duplicate,false);assert.equal(accepted.deliveryState,'pending');assert.equal(state.db.prepare('SELECT COUNT(*) AS n FROM replay').get().n,1);assert.equal(state.db.prepare('SELECT COUNT(*) AS n FROM assignments').get().n,1);assert.equal(state.db.prepare('SELECT COUNT(*) AS n FROM delivery_provenance').get().n,1);
 await verifyAssignment({receipt:accepted.receipt,requestEnvelope:envelope,senderBundle:sender.bundle,recipientBundle:local.bundle,expectedTaskId:'assigned-task'});
 assert.ok(!fs.readFileSync(path.join(dir,'recipient/encryption/state.sqlite')).includes(Buffer.from('synthetic-ledger-private-canary')));
 const duplicate=await ledger.receiveInitial(options);assert.equal(duplicate.deliveryId,accepted.deliveryId);assert.deepEqual(duplicate.receipt,accepted.receipt);assert.equal(duplicate.duplicate,true);
 const attestation={deliveryId:accepted.deliveryId,pairingIdentity:sender.bundle.identityKey,pairingVerified:true};
 const first=await ledger.readDelivery(attestation),again=await ledger.readDelivery(attestation);assert.deepEqual(first.content,content);assert.equal(first.untrusted,true);assert.equal(again.deliveryId,first.deliveryId);
 await assert.rejects(ledger.acknowledgeDelivery({deliveryId:first.deliveryId}),{code:'delivery_ack_required'});await ledger.acknowledgeDelivery({deliveryId:first.deliveryId,consumed:true});assert.equal((await ledger.readDelivery(attestation)).content,null);assert.equal((await ledger.acknowledgeDelivery({deliveryId:first.deliveryId,consumed:true})).alreadyAcknowledged,true);
});
test('failed commit exposes no receipt/partial replay and restart reuses the original committed IDs',async t=>{
 const {dir,state,ledger,options}=await fixture(t);
 state.db.exec("CREATE TRIGGER fail_delivery BEFORE INSERT ON delivery_provenance BEGIN SELECT RAISE(FAIL,'private-fault-canary'); END");
 await assert.rejects(ledger.receiveInitial(options),error=>error.code==='state_unavailable'&&!String(error).includes('private-fault-canary'));
 for(const table of ['replay','assignments','deliveries','delivery_provenance'])assert.equal(state.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0);
 state.db.exec('DROP TRIGGER fail_delivery');const accepted=await ledger.receiveInitial(options);state.close();const reopened=new LocalState(path.join(dir,'recipient'),{write:true});t.after(()=>reopened.close());const resumed=new DeliveryLedger(reopened);
 const duplicate=await resumed.receiveInitial(options);assert.equal(duplicate.deliveryId,accepted.deliveryId);assert.deepEqual(duplicate.receipt,accepted.receipt);assert.equal(resumed.listDeliveries().deliveries.length,1);assert.equal(resumed.listPendingReceipts().receipts[0].ackId,accepted.receipt.ackId);
});
test('changed message/context/task, pairing, activation and malformed signatures never queue new work',async t=>{
 const {state,local,ledger,options}=await fixture(t);await ledger.receiveInitial(options);
 await assert.rejects(ledger.receiveInitial({...options,observedTaskId:'reassigned-task'}),{code:'replay_conflict'});
 const changed=await seal({identity:sender,recipient:local.bundle,binding:{...binding,contextId:'different-context'},content});await assert.rejects(ledger.receiveInitial({...options,envelope:changed}),{code:'replay_conflict'});
 const collision=await seal({identity:sender,recipient:local.bundle,binding:{...binding,messageId:'different-request',contextId:'different-context'},content});await assert.rejects(ledger.receiveInitial({...options,envelope:collision}),{code:'assignment_conflict'});
 await assert.rejects(ledger.receiveInitial({...options,pairingVerified:false}),{code:'pairing_unverified'});await assert.rejects(ledger.receiveInitial({...options,pairingIdentity:'A'.repeat(43)}),{code:'trust_binding_changed'});await assert.rejects(ledger.receiveInitial({...options,activatedExtension:'wrong'}),{code:'extension_not_activated'});
 const invalid=structuredClone(options.envelope);invalid.signature='A'.repeat(86);await assert.rejects(ledger.receiveInitial({...options,envelope:invalid}));assert.equal(state.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n,1);
});
test('bad public signature rejects before mock-native read and trust changes during crypto prevent commit',async t=>{
 const values=new Map();let gets=0;const keyring=async input=>{const key=input.namespace+input.account;if(input.op==='set'){values.set(key,input.value);return;}gets++;return values.get(key);};
 const {state,ledger,options}=await fixture(t,{keyring});const bad=structuredClone(options.envelope);bad.signature='A'.repeat(86);await assert.rejects(ledger.receiveInitial({...options,envelope:bad}));assert.equal(gets,0);
 const previous=state.loadIdentity.bind(state);state.loadIdentity=async(...args)=>{const identity=await previous(...args);await state.propose({peer:'sender',localId:options.localId,bundle:sender.bundle,pairingIdentity:sender.bundle.identityKey,expectedCurrent:state.inspect('sender').current_digest,policy:'required',verification:'tofu'});return identity;};
 await assert.rejects(ledger.receiveInitial(options),{code:'trust_not_ready'});assert.equal(state.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n,0);
});
test('receipt publication and model consumption are separate, explicit and retain cached proofs',async t=>{
 const {ledger,options}=await fixture(t),accepted=await ledger.receiveInitial(options);
 const publication={localId:options.localId,peer:'sender',ackId:accepted.receipt.ackId,pairingIdentity:sender.bundle.identityKey,pairingVerified:true};
 const before=ledger.prepareReceipt(publication);assert.equal(before.transportStatus,'pending');assert.equal(before.carrier.parts[0].text,'[encrypted request accepted]');
 await assert.rejects(ledger.markReceiptTransport(publication),{code:'receipt_transport_unknown'});await ledger.markReceiptTransport({...publication,transportAccepted:true});assert.equal(ledger.listPendingReceipts().receipts.length,0);assert.equal(ledger.listDeliveries().deliveries[0].state,'pending');assert.deepEqual(ledger.prepareReceipt(publication).carrier,before.carrier);
});
test('archive-only restore retains delivery/replay/receipt state but cannot create or consume live work',async t=>{
 const {dir,state,ledger,options}=await fixture(t),accepted=await ledger.receiveInitial(options),backup=path.join(dir,'backup.json'),destination=path.join(dir,'restored'),passphrase=Buffer.from('synthetic ledger backup passphrase');
 await state.createBackup({destination:backup,passphrase});await restoreBackup({source:backup,destination,passphrase,store:'file',acknowledgeReplayRollback:true});const restored=new LocalState(destination,{write:true});t.after(()=>restored.close());const archive=new DeliveryLedger(restored);
 assert.equal(archive.listDeliveries().deliveries[0].deliveryId,accepted.deliveryId);assert.equal(archive.listPendingReceipts().receipts[0].ackId,accepted.receipt.ackId);await assert.rejects(archive.receiveInitial(options),{code:'restore_archive_only'});await assert.rejects(archive.readDelivery({deliveryId:accepted.deliveryId,pairingIdentity:sender.bundle.identityKey,pairingVerified:true}),{code:'restore_archive_only'});
 assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM replay').get().n,1);
});

test('two independent receiver processes return one committed receipt and delivery identity',{timeout:15000},async t=>{
 const {dir,state,options}=await fixture(t),{fork}=await import('node:child_process'),{fileURLToPath}=await import('node:url');
 const packet=path.join(dir,'public-ciphertext.json');fs.writeFileSync(packet,JSON.stringify(options),{mode:0o600});
 function child(){const proc=fork(fileURLToPath(new URL('./fixtures/receive-process.mjs',import.meta.url)),[path.join(dir,'recipient'),packet],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});t.after(()=>{if(proc.exitCode===null&&proc.signalCode===null)proc.kill('SIGKILL');});let readyResolve,resultResolve;const ready=new Promise(r=>readyResolve=r),result=new Promise(r=>resultResolve=r);proc.on('message',value=>value.ready?readyResolve():resultResolve(value));const exit=new Promise((resolve,reject)=>{proc.once('error',reject);proc.once('exit',code=>code===0?resolve():reject(Error('synthetic receiver child failed')));});return{proc,ready,result,exit};}
 const a=child(),b=child();await Promise.all([a.ready,b.ready]);a.proc.send('start');b.proc.send('start');const [one,two]=await Promise.all([a.result,b.result]);await Promise.all([a.exit,b.exit]);assert.equal(one.ok,true);assert.equal(two.ok,true);assert.equal(one.deliveryId,two.deliveryId);assert.equal(one.ackId,two.ackId);assert.notEqual(one.duplicate,two.duplicate);
 assert.equal(state.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n,1);assert.equal(state.db.prepare('SELECT COUNT(*) AS n FROM assignments').get().n,1);
});
test('revocation/rotation holds accepted pending work and receipt publication without discarding history',async t=>{
 const {state,ledger,local,options}=await fixture(t),accepted=await ledger.receiveInitial(options),before=state.inspect('sender');
 const proposal=await state.propose({peer:'sender',localId:local.id,bundle:sender.bundle,pairingIdentity:sender.bundle.identityKey,expectedCurrent:before.current_digest,policy:'required',verification:'tofu',operation:'revoke'});await state.approve({peer:'sender',digest:proposal.digest,expectedCurrent:before.current_digest,ownerApproved:true});
 await assert.rejects(ledger.readDelivery({deliveryId:accepted.deliveryId,pairingIdentity:sender.bundle.identityKey,pairingVerified:true}),{code:'trust_not_ready'});assert.throws(()=>ledger.prepareReceipt({localId:local.id,peer:'sender',ackId:accepted.receipt.ackId,pairingIdentity:sender.bundle.identityKey,pairingVerified:true}),{code:'trust_not_ready'});assert.equal(ledger.listDeliveries().deliveries[0].state,'pending');assert.equal(ledger.listPendingReceipts().receipts.length,1);
});

test('replay namespace survives receiving-key rotation and re-verification',async t=>{
 const {state,local,ledger,options}=await fixture(t);await ledger.receiveInitial(options);
 const rotated=await state.rotateLocal({id:local.id,approvalDigest:state.rotationPlan(local.id).approval_digest,ownerApproved:true}),current=state.inspect('sender');
 const proposal=await state.propose({peer:'sender',localId:rotated.id,bundle:sender.bundle,pairingIdentity:sender.bundle.identityKey,expectedCurrent:current.current_digest,policy:'required',verification:'independent'});await state.approve({peer:'sender',digest:proposal.digest,expectedCurrent:current.current_digest,ownerApproved:true,independentVerified:true,verifiedProposalDigest:proposal.digest});
 const sameMessage=await seal({identity:sender,recipient:rotated.bundle,binding,content});await assert.rejects(ledger.receiveInitial({...options,localId:rotated.id,envelope:sameMessage}),{code:'replay_conflict'});
 assert.equal(state.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n,1);
 const newRequest=await seal({identity:sender,recipient:rotated.bundle,binding:{...binding,messageId:'fresh-request'},content});await ledger.receiveInitial({...options,localId:rotated.id,envelope:newRequest,observedTaskId:'fresh-task'});assert.equal(state.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n,2);
});


test('cross-context initial requests racing in separate processes cannot bind the same stable task',{timeout:15000},async t=>{
 const {dir,state,local,options}=await fixture(t),{fork}=await import('node:child_process'),{fileURLToPath}=await import('node:url');
 const other=await seal({identity:sender,recipient:local.bundle,binding:{...binding,contextId:'other-context',messageId:'other-request'},content});const files=[path.join(dir,'one.json'),path.join(dir,'two.json')];fs.writeFileSync(files[0],JSON.stringify(options),{mode:0o600});fs.writeFileSync(files[1],JSON.stringify({...options,envelope:other}),{mode:0o600});
 function child(packet){const proc=fork(fileURLToPath(new URL('./fixtures/receive-process.mjs',import.meta.url)),[path.join(dir,'recipient'),packet],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});t.after(()=>{if(proc.exitCode===null&&proc.signalCode===null)proc.kill('SIGKILL');});let rr,dr;const ready=new Promise(r=>rr=r),done=new Promise(r=>dr=r);proc.on('message',value=>value.ready?rr():dr(value));const exit=new Promise((resolve,reject)=>{proc.once('error',reject);proc.once('exit',code=>code===0?resolve():reject(Error('synthetic child failed')));});return{proc,ready,done,exit};}
 const a=child(files[0]),b=child(files[1]);await Promise.all([a.ready,b.ready]);a.proc.send('start');b.proc.send('start');const results=await Promise.all([a.done,b.done]);await Promise.all([a.exit,b.exit]);assert.equal(results.filter(x=>x.ok).length,1);assert.equal(results.find(x=>!x.ok).code,'assignment_conflict');
 for(const table of ['replay','assignments','deliveries','delivery_provenance'])assert.equal(state.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,1);
});
