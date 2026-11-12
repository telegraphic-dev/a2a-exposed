import test from'node:test';import assert from'node:assert/strict';
import{EXTENSION,generateIdentity,seal,canonicalJSON}from'../index.mjs';
import{createAssignment,envelopeDigest}from'../assignment.mjs';
import{makeMessageCarrier,makeReceiptCarrier,makeAssignedCarrier}from'../carriers.mjs';
import{makeTaskCarrier,readTaskCarrier}from'../tasks.mjs';
const sender=await generateIdentity('https://sender.example.com/card'),recipient=await generateIdentity('https://recipient.example.com/card');
const body={kind:'message',authorRole:'user',parts:[{kind:'text',text:'synthetic private task content',mediaType:null,metadata:{}}],metadata:{},extensions:[],referenceTaskIds:[]};
const initial=await seal({identity:sender,recipient:recipient.bundle,binding:{contextId:'context',messageId:'request',taskId:null,role:'user',kind:'message',state:null},content:body}),requestDigest=await envelopeDigest(initial);
const snapshot=await seal({identity:recipient,recipient:sender.bundle,binding:{contextId:'context',messageId:'status-0',taskId:'task',role:'agent',kind:'status',state:'completed'},content:{kind:'snapshot',authorRole:'agent',requestDigest,revision:0,previousDigest:null,state:'completed',statusMessage:null,artifacts:[],metadata:{},terminal:true}});
const receipt=(await createAssignment({identity:recipient,senderBundle:sender.bundle,requestEnvelope:initial,taskId:'task'})).receipt;
const assigned=(await createAssignment({identity:recipient,senderBundle:sender.bundle,requestEnvelope:initial,taskId:'task',responseEnvelope:snapshot})).receipt;
const parse=(value,version)=>readTaskCarrier(canonicalJSON(value),version);
const fixture=version=>makeTaskCarrier({taskId:'task',contextId:'context',routingState:'completed',statusMessage:makeMessageCarrier(snapshot,version),history:[makeMessageCarrier(initial,version),makeReceiptCarrier(receipt,version),makeMessageCarrier(snapshot,version)],metadata:{[EXTENSION]:{v:1}},timestamp:'2026-11-12T12:00:00.000Z'},version);
for(const version of ['0.3','1.0']){
 test('Task '+version+' preserves opaque history/control and marks all routing/order untrusted',()=>{
  const value=fixture(version),result=parse(value,version);assert.equal(result.taskId,'task');assert.equal(result.authentication,'unverified');assert.equal(result.historyOrder,'untrusted');assert.equal(result.routingOnly,false);assert.deepEqual(result.status.envelope,snapshot);assert.deepEqual(result.history[1].receipt,receipt);assert.equal(result.history[0].envelope.header.taskId,null);assert.ok(!canonicalJSON(value).includes('synthetic private task content'));
  const pending=makeTaskCarrier({taskId:'task',contextId:'context',routingState:'canceled'},version);assert.equal(parse(pending,version).routingOnly,true);assert.equal(parse(pending,version).status,null);delete pending.artifacts;assert.equal(parse(pending,version).routingOnly,true);for(const artifacts of [null,{},''])assert.throws(()=>parse({...pending,artifacts},version),{code:'task_carrier_invalid'});const controlled=makeTaskCarrier({taskId:'task',contextId:'context',routingState:'working',statusMessage:makeReceiptCarrier(receipt,version)},version);assert.equal(parse(controlled,version).routingOnly,true);
 });
 test('Task '+version+' binds nested contexts/tasks/state/version and rejects plaintext extras/artifacts',()=>{
  const original=fixture(version),mutations=[v=>v.id='other',v=>v.contextId='other',v=>v.artifacts.push({artifactId:'leak',parts:[]}),v=>v.extra='cleartext',v=>v.status.extra='cleartext',v=>v.status.state=version==='0.3'?'working':'TASK_STATE_WORKING',v=>v.status.message.role=version==='0.3'?'user':'ROLE_USER',v=>v.history[0].contextId='other',v=>v.history[1].taskId='other',v=>v.history[2].parts.push({text:'leak'}),v=>v.metadata={other:'leak'},v=>v.history=null,v=>v.status.message=null,v=>v.status.message.parts[0].data.header.extra='leak',v=>v.status.state='TASK_STATE_UNKNOWN',v=>v.status.timestamp='2026-02-30T12:00:00Z'];
  for(const mutate of mutations){const value=structuredClone(original);mutate(value);assert.throws(()=>parse(value,version),{code:'task_carrier_invalid'});}
  assert.throws(()=>parse(original,version==='0.3'?'1.0':'0.3'),{code:'task_carrier_invalid'});
 });
 test('Task '+version+' preserves co-carried receipt and refuses immutable receipt changes/conflicting duplicate IDs',()=>{
  const carrier=makeAssignedCarrier(snapshot,assigned,version),value=makeTaskCarrier({taskId:'task',contextId:'context',routingState:'completed',statusMessage:makeMessageCarrier(snapshot,version),history:[carrier]},version);assert.deepEqual(parse(value,version).history[0].receipt,assigned);
  const conflicting=fixture(version);conflicting.history.push(makeAssignedCarrier(snapshot,assigned,version));assert.throws(()=>parse(conflicting,version),{code:'task_carrier_invalid'});
  const changed=fixture(version);const collision=structuredClone(changed.history[2]);collision.parts[0].data.signature='A'.repeat(86);changed.history.push(collision);assert.throws(()=>parse(changed,version),{code:'task_carrier_invalid'});
 });
 test('Task '+version+' preserves server order without inferring chain continuity or validating signatures',()=>{
  const value=fixture(version);value.history.reverse();const result=parse(value,version);assert.equal(result.history[0].envelope.header.messageId,'status-0');
  const forged=fixture(version);forged.history=[];forged.status.message.parts[0].data.signature='A'.repeat(86);assert.equal(parse(forged,version).authentication,'unverified');
 });
}
test('raw duplicate keys, over-size bodies, invalid IDs and builder getters refuse before side effects',()=>{
 const valid=canonicalJSON(fixture('0.3'));assert.throws(()=>readTaskCarrier(canonicalJSON(makeReceiptCarrier(receipt,'0.3')),'0.3'),{code:'task_carrier_invalid'});assert.throws(()=>readTaskCarrier(canonicalJSON({jsonrpc:'2.0',id:1,result:fixture('0.3')}),'0.3'),{code:'task_carrier_invalid'});assert.throws(()=>readTaskCarrier(valid.replace('"id":"task"','"id":"task","id":"task"'),'0.3'),{code:'task_carrier_invalid'});assert.throws(()=>readTaskCarrier(' '.repeat(1024*1024+1),'0.3'),{code:'task_carrier_invalid'});
 let calls=0;const options={taskId:'task',contextId:'context',routingState:'working'};Object.defineProperty(options,'statusMessage',{enumerable:true,get(){calls++;return null;}});assert.throws(()=>makeTaskCarrier(options,'0.3'),{code:'task_carrier_invalid'});assert.equal(calls,0);
 for(const value of [null,'', 'a'.repeat(201)])assert.throws(()=>makeTaskCarrier({taskId:value,contextId:'context',routingState:'working'},'0.3'),{code:'task_carrier_invalid'});
 assert.throws(()=>makeTaskCarrier({taskId:'task',contextId:'context',routingState:'working',extra:true},'0.3'),{code:'task_carrier_invalid'});
});
