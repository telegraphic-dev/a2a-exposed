// Signed assignment primitives. Publication requires the later atomic replay/outbox transaction.
import {randomUUID}from'node:crypto';
import {canonicalJSON,parseJSON,validateEnvelopeStructure,validatePeerStructure,verifyBundle,open,EncryptionError}from'./index.mjs';
import {validateContent}from'./content.mjs';
const fail=code=>{throw new EncryptionError(code||'assignment_invalid');};
const encoder=new TextEncoder();
const peer=bundle=>({cardUrl:bundle.cardUrl,identityKey:bundle.identityKey,keyId:bundle.keyId});
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('\0')===[...keys].sort().join('\0');
const id=value=>typeof value==='string'&&/^[\x21-\x7e]{1,200}$/.test(value);
function raw(value,size){if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value))fail();const bytes=Buffer.from(value,'base64url');if(bytes.length!==size||bytes.toString('base64url')!==value)fail();return bytes;}
const digest=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',encoder.encode(canonicalJSON(value)))).toString('base64url');
const binding=header=>Object.fromEntries(['contextId','messageId','taskId','role','state','kind'].map(key=>[key,header[key]]));
const same=(left,right)=>canonicalJSON(left)===canonicalJSON(right);
const snapshotBundle=value=>parseJSON(canonicalJSON(value));
function snapshotIdentity(value){if(!value||typeof value!=='object')fail();return {bundle:snapshotBundle(value.bundle),signingKey:value.signingKey,encryptionKey:value.encryptionKey};}
function time(now){if(!Number.isSafeInteger(now)||now<0||now>8640000000000000)fail();}
export function validateAssignmentStructure(value){
 const receipt=typeof value==='string'?parseJSON(value):parseJSON(canonicalJSON(value));
 if(!exact(receipt,['v','kind','requestDigest','from','to','contextId','requestMessageId','taskId','responseKind','responseDigest','ackId','signature'])||receipt.v!==1||receipt.kind!=='assignment'||receipt.responseKind!=='task'||!id(receipt.contextId)||!id(receipt.requestMessageId)||!id(receipt.taskId)||typeof receipt.ackId!=='string'||!(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/).test(receipt.ackId))fail();
 validatePeerStructure(receipt.from);validatePeerStructure(receipt.to);raw(receipt.requestDigest,32);if(receipt.responseDigest!==null)raw(receipt.responseDigest,32);raw(receipt.signature,64);return receipt;
}
export async function envelopeDigest(envelope){return digest(validateEnvelopeStructure(envelope));}
async function validateContext({requestEnvelope,senderBundle,recipientBundle,now,purpose}){
 time(now);if(!['live','archive'].includes(purpose))fail();const request=validateEnvelopeStructure(requestEnvelope),h=request.header;
 if(h.taskId!==null||h.role!=='user'||h.kind!=='message'||h.state!==null||!same(h.from,peer(senderBundle))||!same(h.to,peer(recipientBundle)))fail();
 if(purpose==='live'&&(Date.parse(h.sentAt)<now-30*86400000||Date.parse(h.sentAt)>now+300000))fail('replay');
 await verifyBundle(senderBundle,{cardUrl:senderBundle.cardUrl,identityKey:senderBundle.identityKey,now});await verifyBundle(recipientBundle,{cardUrl:recipientBundle.cardUrl,identityKey:recipientBundle.identityKey,now});return request;
}
export async function verifyAssignment({receipt:input,requestEnvelope,senderBundle,recipientBundle,responseEnvelope=null,expectedTaskId,now=Date.now(),purpose='live'}={}){
 try{
  requestEnvelope=validateEnvelopeStructure(requestEnvelope);senderBundle=snapshotBundle(senderBundle);recipientBundle=snapshotBundle(recipientBundle);responseEnvelope=responseEnvelope===null?null:validateEnvelopeStructure(responseEnvelope);
  const receipt=validateAssignmentStructure(input),request=await validateContext({requestEnvelope,senderBundle,recipientBundle,now,purpose}),h=request.header;
  if(!same(receipt.from,peer(recipientBundle))||!same(receipt.to,peer(senderBundle))||receipt.contextId!==h.contextId||receipt.requestMessageId!==h.messageId||receipt.requestDigest!==await envelopeDigest(request)||(expectedTaskId!==undefined&&receipt.taskId!==expectedTaskId))fail('assignment_binding_mismatch');
  const {signature,...body}=receipt;const key=await crypto.subtle.importKey('raw',raw(recipientBundle.identityKey,32),'Ed25519',false,['verify']);
  if(!await crypto.subtle.verify('Ed25519',key,raw(signature,64),encoder.encode('a2a-exposed sealed assignment v1\n'+canonicalJSON(body))))fail();
  if(responseEnvelope===null){if(receipt.responseDigest!==null)fail('response_binding_required');}
  else{
   const response=validateEnvelopeStructure(responseEnvelope),r=response.header;
   if(receipt.responseDigest===null||receipt.responseDigest!==await envelopeDigest(response)||!same(r.from,peer(recipientBundle))||!same(r.to,peer(senderBundle))||r.contextId!==h.contextId||r.taskId!==receipt.taskId||r.role!=='agent')fail('response_binding_mismatch');
  }
  return receipt;
 }catch(error){if(error instanceof EncryptionError)throw error;fail();}
}
export async function createAssignment({identity,senderBundle,requestEnvelope,taskId,responseEnvelope=null,ackId=randomUUID(),now=Date.now()}={}){
 try{
  identity=snapshotIdentity(identity);senderBundle=snapshotBundle(senderBundle);requestEnvelope=validateEnvelopeStructure(requestEnvelope);responseEnvelope=responseEnvelope===null?null:validateEnvelopeStructure(responseEnvelope);
  const request=await validateContext({requestEnvelope,senderBundle,recipientBundle:identity.bundle,now,purpose:'live'});
  const requestContent=validateContent(await open({envelope:request,identity,sender:senderBundle,recipient:identity.bundle,expected:binding(request.header),now}),request.header);
  if(!id(taskId))fail();const requestDigest=await envelopeDigest(request);
  if(responseEnvelope!==null){
   const response=validateEnvelopeStructure(responseEnvelope),h=response.header;
   if(h.contextId!==request.header.contextId||h.taskId!==taskId||h.role!=='agent')fail();
   validateContent(await open({envelope:response,identity,sender:identity.bundle,recipient:senderBundle,expected:binding(h),purpose:'sender',now}),h,{expectedRequestDigest:requestDigest});
  }
  const body={v:1,kind:'assignment',requestDigest,from:peer(identity.bundle),to:peer(senderBundle),contextId:request.header.contextId,requestMessageId:request.header.messageId,taskId,responseKind:'task',responseDigest:responseEnvelope===null?null:await envelopeDigest(responseEnvelope),ackId};
  const receipt={...body,signature:Buffer.from(await crypto.subtle.sign('Ed25519',identity.signingKey,encoder.encode('a2a-exposed sealed assignment v1\n'+canonicalJSON(body)))).toString('base64url')};
  await verifyAssignment({receipt,requestEnvelope:request,senderBundle,recipientBundle:identity.bundle,responseEnvelope,expectedTaskId:taskId,now});
  return {receipt,requestContent,untrusted:true}; // No durable acceptance/model-consumption claim.
 }catch(error){if(error instanceof EncryptionError)throw error;fail();}
}
export async function openAssignedResponse({receipt,requestEnvelope,responseEnvelope,identity,recipientBundle,now=Date.now()}={}){
 try{
  receipt=validateAssignmentStructure(receipt);requestEnvelope=validateEnvelopeStructure(requestEnvelope);responseEnvelope=validateEnvelopeStructure(responseEnvelope);identity=snapshotIdentity(identity);recipientBundle=snapshotBundle(recipientBundle);
  const verified=await verifyAssignment({receipt,requestEnvelope,senderBundle:identity.bundle,recipientBundle,responseEnvelope,now});
  const response=validateEnvelopeStructure(responseEnvelope),content=validateContent(await open({envelope:response,identity,sender:recipientBundle,recipient:identity.bundle,expected:binding(response.header),now}),response.header,{expectedRequestDigest:verified.requestDigest});
  return {receipt:verified,content,untrusted:true}; // Ledger/trust approval remains outside this primitive.
 }catch(error){if(error instanceof EncryptionError)throw error;fail();}
}
