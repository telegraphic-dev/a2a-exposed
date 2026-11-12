import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateContent,fromProtocolParts,toProtocolParts}from'../content.mjs';
import {makeMessageCarrier,readMessageCarrier}from'../carriers.mjs';
import {generateIdentity,seal,open,EXTENSION}from'../index.mjs';
const message={kind:'message',authorRole:'user',parts:[{kind:'text',text:'synthetic-private-canary',mediaType:'text/markdown',metadata:{source:'untrusted'}},{kind:'data',data:{nested:[1,true,null],instruction:'untrusted'},mediaType:'application/json',metadata:{}},{kind:'file',file:{name:'',bytes:'AAECAw=='},mediaType:'application/octet-stream',metadata:{}}],metadata:{title:'encrypted title'},extensions:['urn:example:private'],referenceTaskIds:['related-task']};
const binding={contextId:'context',messageId:'message',taskId:null,role:'user',state:null,kind:'message'};
const sender=await generateIdentity('https://sender.example.com/card'),recipient=await generateIdentity('https://recipient.example.com/card');
test('canonical parts round-trip across both protocol versions without losing mediaType/names/metadata',()=>{
 for(const version of ['0.3','1.0'])assert.deepEqual(fromProtocolParts(toProtocolParts(message.parts,version),version),message.parts);
 const empty={kind:'file',file:{name:'',bytes:''},mediaType:null,metadata:{}};assert.deepEqual(fromProtocolParts(toProtocolParts([empty],'1.0'),'1.0'),[empty]);
 assert.deepEqual(validateContent(message,binding),message);
 const copy=validateContent(message,binding);copy.parts[0].text='changed';assert.equal(message.parts[0].text,'synthetic-private-canary');
});
test('invalid/mixed/URI/delta/extra representations refuse instead of truncating or fetching',()=>{
 let calls=0;const fetch=globalThis.fetch;globalThis.fetch=()=>{calls++;throw Error('must not fetch');};try{
  for(const [part,version] of [[{kind:'file',file:{uri:'https://files.example.com/private'}},'0.3'],[{url:'https://files.example.com/private'},'1.0'],[{text:'a',data:{}},'1.0'],[{kind:'text',text:'a',extra:'dropped'},'0.3'],[{text:'a',mediaType:null},'1.0']])assert.throws(()=>fromProtocolParts([part],version));
  assert.throws(()=>fromProtocolParts(Array.from({length:101},()=>({text:'a'})),'1.0'));assert.equal(calls,0);
 }finally{globalThis.fetch=fetch;}
 let getters=0;const part={kind:'text'};Object.defineProperty(part,'text',{enumerable:true,get(){getters++;return 'do not execute';}});assert.throws(()=>fromProtocolParts([part],'0.3'));assert.equal(getters,0);
 for(const change of [x=>x.extra=true,x=>x.parts[0].metadata=null,x=>x.referenceTaskIds=['x'.repeat(201)],x=>x.parts[0].text='\ud800',x=>x.authorRole='agent']){const copy=structuredClone(message);change(copy);assert.throws(()=>validateContent(copy,binding));}
});
test('snapshot profile enforces revision linkage shape, terminal state and nested logical role',()=>{
 const header={...binding,taskId:'task',role:'agent',kind:'status',state:'completed'},snapshot={kind:'snapshot',authorRole:'agent',requestDigest:'A'.repeat(43),revision:0,previousDigest:null,state:'completed',statusMessage:{...message,authorRole:'agent',requestDigest:'A'.repeat(43)},artifacts:[{artifactId:'artifact',name:'private name',description:'private description',parts:message.parts,metadata:{},extensions:[]}],metadata:{},terminal:true};
 assert.deepEqual(validateContent(snapshot,header),snapshot);
 for(const change of [x=>x.terminal=false,x=>x.previousDigest='A'.repeat(43),x=>x.revision=0.5,x=>x.statusMessage.authorRole='user',x=>x.artifacts.push(x.artifacts[0]),x=>x.artifacts[0].append=true,x=>x.kind='artifact']){const copy=structuredClone(snapshot);change(copy);assert.throws(()=>validateContent(copy,header));}
 const next={...snapshot,revision:1,previousDigest:'A'.repeat(43)};assert.deepEqual(validateContent(next,header),next);
 assert.throws(()=>validateContent({...message,authorRole:'agent',requestDigest:'A'.repeat(43)},{...binding,role:'agent'}));
});
test('sealed carriers preserve exact bindings and contain no original plaintext in either version',async()=>{
 const content=validateContent(message,binding),envelope=await seal({identity:sender,recipient:recipient.bundle,binding,content});
 for(const version of ['0.3','1.0']){
  const carrier=makeMessageCarrier(envelope,version),text=JSON.stringify(carrier);assert.ok(!text.includes('synthetic-private-canary'));assert.ok(!text.includes('encrypted title'));assert.equal(carrier.extensions[0],EXTENSION);
  const extracted=readMessageCarrier(text,version);assert.deepEqual(validateContent(await open({envelope:extracted,identity:recipient,sender:sender.bundle,recipient:recipient.bundle,expected:binding}),extracted.header),message);
  for(const change of [x=>x.messageId='different',x=>x.contextId='different',x=>x.taskId='injected',x=>x.parts.push({text:'cleartext'}),x=>x.metadata={leak:'cleartext'},x=>x.parts[0].metadata[EXTENSION].v=2]){const copy=structuredClone(carrier);change(copy);assert.throws(()=>readMessageCarrier(JSON.stringify(copy),version));}
  assert.throws(()=>readMessageCarrier(text.replace('"messageId":"message"','"messageId":"message","messageId":"message"'),version));
 }
});
test('packaged schemas are strict objects with profile limitations explicit',()=>{
 for(const name of ['content','envelope']){const schema=JSON.parse(fs.readFileSync(new URL('../schemas/'+name+'.schema.json',import.meta.url)));assert.equal(schema.$schema,'https://json-schema.org/draft/2020-12/schema');assert.ok(schema.description.includes('runtime'));}
});

test('nested schema-rejected envelope mutations are refused by structural maker and reader',async()=>{
 const envelope=await seal({identity:sender,recipient:recipient.bundle,binding,content:message});
 const edits=[x=>x.header.extra='must-not-escape-in-clear',x=>x.v=2,x=>x.recipient={unexpected:'shape'},x=>x.signature={untrusted:'object'}];
 for(const version of ['0.3','1.0']){
  const original=makeMessageCarrier(envelope,version);
  const nullTask=structuredClone(original);nullTask.taskId=null;assert.throws(()=>readMessageCarrier(JSON.stringify(nullTask),version));
  for(const edit of edits){const changed=structuredClone(envelope);edit(changed);assert.throws(()=>makeMessageCarrier(changed,version));const carrier=structuredClone(original);carrier.parts[0].data=changed;assert.throws(()=>readMessageCarrier(JSON.stringify(carrier),version));}
 }
});
