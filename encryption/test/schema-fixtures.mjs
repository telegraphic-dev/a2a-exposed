// Public synthetic fixtures only; no private keys are exported or printed.
import fs from 'node:fs';
import {makeTaskCarrier}from'../tasks.mjs';
import {createAssignment,envelopeDigest}from'../assignment.mjs';
import {makeReceiptCarrier,makeAssignedCarrier}from'../carriers.mjs';
import {generateIdentity,seal}from'../index.mjs';
import {makeMessageCarrier}from'../carriers.mjs';
const message={kind:'message',authorRole:'user',parts:[{kind:'text',text:'synthetic schema fixture',mediaType:'text/plain',metadata:{}},{kind:'file',file:{name:'fixture.bin',bytes:'AAE='},mediaType:'application/octet-stream',metadata:{}}],metadata:{},extensions:[],referenceTaskIds:[]};
const snapshot={kind:'snapshot',authorRole:'agent',requestDigest:'A'.repeat(43),revision:0,previousDigest:null,state:'completed',statusMessage:{...message,authorRole:'agent',requestDigest:'A'.repeat(43)},artifacts:[],metadata:{},terminal:true};
const sender=await generateIdentity('https://sender.example.com/card'),recipient=await generateIdentity('https://recipient.example.com/card');
const envelope=await seal({identity:sender,recipient:recipient.bundle,binding:{contextId:'synthetic-context',messageId:'synthetic-message',taskId:null,role:'user',state:null,kind:'message'},content:message});
const requestDigest=await envelopeDigest(envelope);snapshot.requestDigest=requestDigest;snapshot.statusMessage.requestDigest=requestDigest;
const response=await seal({identity:recipient,recipient:sender.bundle,binding:{contextId:'synthetic-context',messageId:'synthetic-response',taskId:'synthetic-task',role:'agent',state:null,kind:'message'},content:{...message,authorRole:'agent',requestDigest}});
const receipt=(await createAssignment({identity:recipient,senderBundle:sender.bundle,requestEnvelope:envelope,taskId:'synthetic-task'})).receipt;
const assigned=(await createAssignment({identity:recipient,senderBundle:sender.bundle,requestEnvelope:envelope,taskId:'synthetic-task',responseEnvelope:response})).receipt;
fs.writeFileSync(process.argv[2],JSON.stringify({message,snapshot,envelope,receipt,capability:{uri:"https://a2a.exposed/ext/sealed/v1",required:false,params:{bundle:recipient.bundle,responseKind:"task"}},receiptCarriers:{'0.3':makeReceiptCarrier(receipt,'0.3'),'1.0':makeReceiptCarrier(receipt,'1.0')},assignedCarriers:{'0.3':makeAssignedCarrier(response,assigned,'0.3'),'1.0':makeAssignedCarrier(response,assigned,'1.0')},carriers:{'0.3':makeMessageCarrier(envelope,'0.3'),'1.0':makeMessageCarrier(envelope,'1.0')},taskCarriers:Object.fromEntries(['0.3','1.0'].map(version=>[version,[makeTaskCarrier({taskId:'synthetic-task',contextId:'synthetic-context',routingState:'submitted'},version),makeTaskCarrier({taskId:'synthetic-task',contextId:'synthetic-context',routingState:'working',statusMessage:makeReceiptCarrier(receipt,version),history:[makeMessageCarrier(envelope,version)]},version),makeTaskCarrier({taskId:'synthetic-task',contextId:'synthetic-context',routingState:'working',statusMessage:makeAssignedCarrier(response,assigned,version)},version)]]))},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({ok:true,synthetic:true,privateKeysExported:false}));
