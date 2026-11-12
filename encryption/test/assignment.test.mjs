import test from 'node:test';
import assert from 'node:assert/strict';
import {generateIdentity,seal,canonicalJSON}from'../index.mjs';
import {createAssignment,verifyAssignment,openAssignedResponse,envelopeDigest,validateAssignmentStructure}from'../assignment.mjs';
const now=Date.now(),sender=await generateIdentity('https://sender.example.com/card',now),recipient=await generateIdentity('https://recipient.example.com/card',now);
const message={kind:'message',authorRole:'user',parts:[{kind:'text',text:'synthetic request',mediaType:null,metadata:{}}],metadata:{},extensions:[],referenceTaskIds:[]};
const binding={contextId:'shared-context',messageId:'request-1',taskId:null,role:'user',state:null,kind:'message'};
async function request(messageId='request-1'){return seal({identity:sender,recipient:recipient.bundle,binding:{...binding,messageId},content:message,now});}
async function response(req,text='synthetic response',requestDigest){return seal({identity:recipient,recipient:sender.bundle,binding:{...binding,messageId:'response-'+text.replaceAll(' ','-'),taskId:'assigned-task',role:'agent'},content:{...message,authorRole:'agent',parts:[{kind:'text',text,mediaType:null,metadata:{}}],requestDigest:requestDigest??await envelopeDigest(req)},now});}
const opts=(req,extra={})=>({requestEnvelope:req,senderBundle:sender.bundle,recipientBundle:recipient.bundle,now,...extra});
test('receipt-only assignment authenticates exact request and task, without a model-consumption claim',async()=>{
 const req=await request(),created=await createAssignment({identity:recipient,senderBundle:sender.bundle,requestEnvelope:req,taskId:'assigned-task',now});
 assert.equal(created.receipt.responseDigest,null);assert.deepEqual(created.requestContent,message);assert.equal(created.untrusted,true);
 assert.deepEqual(await verifyAssignment(opts(req,{receipt:created.receipt,expectedTaskId:'assigned-task'})),created.receipt);
 await assert.rejects(verifyAssignment(opts(req,{receipt:created.receipt,expectedTaskId:'different-task'})));
 for(const edit of [x=>x.taskId='different',x=>x.contextId='different',x=>x.requestMessageId='different',x=>x.requestDigest='A'.repeat(43),x=>x.from=structuredClone(x.to),x=>x.extra='must reject',x=>x.ackId='not-a-uuid']){const copy=structuredClone(created.receipt);edit(copy);await assert.rejects(verifyAssignment(opts(req,{receipt:copy})));}
});
test('co-carried response digest and inner request digest reject swapped first-seen replies',async()=>{
 const req1=await request('request-1'),req2=await request('request-2'),reply1=await response(req1,'reply one'),reply2=await response(req2,'reply two');
 const one=await createAssignment({identity:recipient,senderBundle:sender.bundle,requestEnvelope:req1,taskId:'assigned-task',responseEnvelope:reply1,now});
 const opened=await openAssignedResponse({receipt:one.receipt,requestEnvelope:req1,responseEnvelope:reply1,identity:sender,recipientBundle:recipient.bundle,now});assert.equal(opened.content.parts[0].text,'reply one');assert.equal(opened.untrusted,true);
 await assert.rejects(verifyAssignment(opts(req1,{receipt:one.receipt,responseEnvelope:reply2})),{code:'response_binding_mismatch'});
 await assert.rejects(verifyAssignment(opts(req2,{receipt:one.receipt,responseEnvelope:reply1})),{code:'assignment_binding_mismatch'});
 await assert.rejects(createAssignment({identity:recipient,senderBundle:sender.bundle,requestEnvelope:req1,taskId:'assigned-task',responseEnvelope:reply2,now}),{code:'request_binding_mismatch'});
 const nullAck=await createAssignment({identity:recipient,senderBundle:sender.bundle,requestEnvelope:req1,taskId:'assigned-task',now});await assert.rejects(verifyAssignment(opts(req1,{receipt:nullAck.receipt,responseEnvelope:reply1})),{code:'response_binding_mismatch'});
 // Even an authenticated peer's self-signed but cross-request response cannot pass content correlation.
 const body={...one.receipt,responseDigest:await envelopeDigest(reply2)};delete body.signature;
 const malicious={...body,signature:Buffer.from(await crypto.subtle.sign('Ed25519',recipient.signingKey,new TextEncoder().encode('a2a-exposed sealed assignment v1\n'+canonicalJSON(body)))).toString('base64url')};
 await verifyAssignment(opts(req1,{receipt:malicious,responseEnvelope:reply2}));await assert.rejects(openAssignedResponse({receipt:malicious,requestEnvelope:req1,responseEnvelope:reply2,identity:sender,recipientBundle:recipient.bundle,now}),{code:'request_binding_mismatch'});
});
test('creator refuses unopened requests, wrong signing key and unsupported unassigned-agent binding',async()=>{
 const req=await request(),stranger=await generateIdentity('https://stranger.example.com/card',now);
 await assert.rejects(createAssignment({identity:stranger,senderBundle:sender.bundle,requestEnvelope:req,taskId:'assigned-task',now}));
 await assert.rejects(createAssignment({identity:{...recipient,signingKey:stranger.signingKey},senderBundle:sender.bundle,requestEnvelope:req,taskId:'assigned-task',now}));
 const changed=structuredClone(req);changed.header.taskId='already-assigned';await assert.rejects(createAssignment({identity:recipient,senderBundle:sender.bundle,requestEnvelope:changed,taskId:'other',now}));
 const bad=structuredClone(req);bad.signature='A'.repeat(86);await assert.rejects(createAssignment({identity:recipient,senderBundle:sender.bundle,requestEnvelope:bad,taskId:'task',now}));
 assert.throws(()=>validateAssignmentStructure({v:1,private:'never echo'}));
});
test('live verification retains freshness checks; archive verification is explicit and creates no work',async()=>{
 const then=now-31*86400000,a=await generateIdentity('https://old-sender.example.com/card',then),b=await generateIdentity('https://old-recipient.example.com/card',then);
 const req=await seal({identity:a,recipient:b.bundle,binding,content:message,now:then}),created=await createAssignment({identity:b,senderBundle:a.bundle,requestEnvelope:req,taskId:'old-task',now:then});
 await assert.rejects(verifyAssignment({receipt:created.receipt,requestEnvelope:req,senderBundle:a.bundle,recipientBundle:b.bundle,now}),{code:'replay'});
 assert.equal((await verifyAssignment({receipt:created.receipt,requestEnvelope:req,senderBundle:a.bundle,recipientBundle:b.bundle,now,purpose:'archive'})).taskId,'old-task');
 for(const invalid of [NaN,-1,0.5,Infinity])await assert.rejects(verifyAssignment({receipt:created.receipt,requestEnvelope:req,senderBundle:a.bundle,recipientBundle:b.bundle,now:invalid}));
});

test('receipt-only and co-carried variants round-trip without accepting plaintext/altered bindings',async()=>{
 const {makeReceiptCarrier,readReceiptCarrier,makeAssignedCarrier,readAssignedCarrier,readMessageCarrier}=await import('../carriers.mjs');
 const req=await request(),reply=await response(req),control=await createAssignment({identity:recipient,senderBundle:sender.bundle,requestEnvelope:req,taskId:'assigned-task',now}),withReply=await createAssignment({identity:recipient,senderBundle:sender.bundle,requestEnvelope:req,taskId:'assigned-task',responseEnvelope:reply,now});
 for(const version of ['0.3','1.0']){
  const fixed=makeReceiptCarrier(control.receipt,version);assert.deepEqual(readReceiptCarrier(JSON.stringify(fixed),version),control.receipt);fixed.parts[0].text='untrusted injected text';assert.throws(()=>readReceiptCarrier(JSON.stringify(fixed),version));
  const carrier=makeAssignedCarrier(reply,withReply.receipt,version),parsed=readAssignedCarrier(JSON.stringify(carrier),version);assert.deepEqual(parsed.receipt,withReply.receipt);assert.deepEqual(parsed.envelope,reply);
  assert.throws(()=>readMessageCarrier(JSON.stringify(carrier),version)); // Never drop receipt metadata.
  assert.throws(()=>makeAssignedCarrier(reply,control.receipt,version));assert.throws(()=>makeReceiptCarrier(withReply.receipt,version));
  const swapped=structuredClone(carrier);swapped.metadata[(await import('../index.mjs')).EXTENSION].assignment.taskId='other-task';assert.throws(()=>readAssignedCarrier(JSON.stringify(swapped),version));
 }
});

function replaceObject(target,value){for(const key of Object.keys(target))delete target[key];Object.assign(target,structuredClone(value));}
test('opening uses the same entry snapshot whose ciphertext digest was verified across awaits',async()=>{
 const req=await request(),a=await response(req,'original answer'),b=await response(req,'mutated answer');
 const signed=await createAssignment({identity:recipient,senderBundle:sender.bundle,requestEnvelope:req,taskId:'assigned-task',responseEnvelope:a,now});
 const mutable=structuredClone(a),encoded=canonicalJSON(a),native=crypto.subtle.digest;let mutated=false;
 crypto.subtle.digest=async function(algorithm,data){const result=await native.call(this,algorithm,data);if(!mutated&&Buffer.from(data).toString('utf8')===encoded){mutated=true;replaceObject(mutable,b);}return result;};
 let opened;try{opened=await openAssignedResponse({receipt:signed.receipt,requestEnvelope:req,responseEnvelope:mutable,identity:sender,recipientBundle:recipient.bundle,now});}finally{crypto.subtle.digest=native;}
 assert.equal(mutated,true);assert.equal(opened.content.parts[0].text,'original answer');assert.equal(mutable.header.messageId,b.header.messageId);assert.notEqual(signed.receipt.responseDigest,await envelopeDigest(b));
});
test('assignment creator self-opens, hashes and signs one response snapshot despite async mutation',async()=>{
 const req=await request('request-1'),other=await request('request-2'),a=await response(req,'original answer'),b=await response(other,'wrong-request answer');
 const mutable=structuredClone(a),native=crypto.subtle.digest;let mutated=false;
 crypto.subtle.digest=async function(algorithm,data){const result=await native.call(this,algorithm,data);if(!mutated&&Buffer.from(result).toString('base64url')===a.header.commitment){mutated=true;replaceObject(mutable,b);}return result;};
 let signed;try{signed=await createAssignment({identity:recipient,senderBundle:sender.bundle,requestEnvelope:req,taskId:'assigned-task',responseEnvelope:mutable,now});}finally{crypto.subtle.digest=native;}
 assert.equal(mutated,true);assert.equal(signed.receipt.responseDigest,await envelopeDigest(a));assert.notEqual(signed.receipt.responseDigest,await envelopeDigest(b));
 assert.equal((await openAssignedResponse({receipt:signed.receipt,requestEnvelope:req,responseEnvelope:a,identity:sender,recipientBundle:recipient.bundle,now})).content.parts[0].text,'original answer');
});
