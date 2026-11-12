// Structural carrier validation only. Signature, trust, replay and assignment validation are separate gates.
import {createHash}from'node:crypto';
import {validateAssignmentStructure}from'./assignment.mjs';
import {EXTENSION,canonicalJSON,parseJSON,EncryptionError,validateEnvelopeStructure} from './index.mjs';
const fail=()=>{throw new EncryptionError('carrier_invalid');};
const fields=(value,names)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('\0')===[...names].sort().join('\0');
const id=value=>typeof value==='string'&&/^[\x21-\x7e]{1,200}$/.test(value);
function headerBinding(envelope){
 if(!fields(envelope,['v','suite','header','recipient','sender','signature']))fail();const h=envelope.header;
 if(!h||!id(h.contextId)||!id(h.messageId)||(h.taskId!==null&&!id(h.taskId))||!['user','agent'].includes(h.role)||!['message','status'].includes(h.kind))fail();
 return h;
}
export function makeMessageCarrier(envelope,version){
 if(!['0.3','1.0'].includes(version))fail();const copy=validateEnvelopeStructure(envelope),h=headerBinding(copy);
 const result={...(version==='0.3'?{kind:'message'}:{}),messageId:h.messageId,contextId:h.contextId,...(h.taskId===null?{}:{taskId:h.taskId}),role:version==='0.3'?h.role:h.role==='agent'?'ROLE_AGENT':'ROLE_USER',parts:[{...(version==='0.3'?{kind:'data'}:{}),data:copy,metadata:{[EXTENSION]:{v:1}}}],extensions:[EXTENSION]};
 if(Buffer.byteLength(canonicalJSON(result))>1024*1024)fail();return result;
}
export function readMessageCarrier(text,version){
 if(typeof text!=='string'||!['0.3','1.0'].includes(version))fail();const carrier=parseJSON(text),names=['messageId','contextId','role','parts','extensions',...(version==='0.3'?['kind']:[]),...(carrier?.taskId===undefined?[]:['taskId'])];
 if(!fields(carrier,names)||(version==='0.3'&&carrier.kind!=='message')||!Array.isArray(carrier.parts)||carrier.parts.length!==1||!Array.isArray(carrier.extensions)||carrier.extensions.length!==1||carrier.extensions[0]!==EXTENSION)fail();
 const part=carrier.parts[0];if(!fields(part,['data','metadata',...(version==='0.3'?['kind']:[])])||(version==='0.3'&&part.kind!=='data')||!fields(part.metadata,[EXTENSION])||!fields(part.metadata[EXTENSION],['v'])||part.metadata[EXTENSION].v!==1)fail();
 if(Object.hasOwn(carrier,'taskId')&&!id(carrier.taskId))fail();
 const envelope=validateEnvelopeStructure(part.data),h=headerBinding(envelope),role=version==='0.3'?h.role:h.role==='agent'?'ROLE_AGENT':'ROLE_USER';
 if(carrier.messageId!==h.messageId||carrier.contextId!==h.contextId||(carrier.taskId??null)!==h.taskId||carrier.role!==role)fail();return envelope;
}

// Assignment-bearing variants never silently discard their control receipt.
export function makeReceiptCarrier(receipt,version){
 if(!['0.3','1.0'].includes(version))fail();const value=validateAssignmentStructure(receipt);if(value.responseDigest!==null)fail();
 return {...(version==='0.3'?{kind:'message'}:{}),messageId:value.ackId,contextId:value.contextId,taskId:value.taskId,role:version==='0.3'?'agent':'ROLE_AGENT',parts:[{...(version==='0.3'?{kind:'text'}:{}),text:'[encrypted request accepted]'}],extensions:[EXTENSION],metadata:{[EXTENSION]:{v:1,assignment:value}}};
}
export function readReceiptCarrier(text,version){
 if(typeof text!=='string')fail();const value=parseJSON(text);if(!fields(value,['messageId','contextId','taskId','role','parts','extensions','metadata',...(version==='0.3'?['kind']:[])])||!fields(value.metadata,[EXTENSION])||!fields(value.metadata[EXTENSION],['v','assignment'])||value.metadata[EXTENSION].v!==1)fail();
 const receipt=validateAssignmentStructure(value.metadata[EXTENSION].assignment),expected=makeReceiptCarrier(receipt,version);if(canonicalJSON(value)!==canonicalJSON(expected))fail();return receipt;
}
function assignedBindings(envelope,receipt){
 const h=envelope.header;if(receipt.responseDigest===null||receipt.responseDigest!==createHash('sha256').update(canonicalJSON(envelope)).digest('base64url')||canonicalJSON(receipt.from)!==canonicalJSON(h.from)||canonicalJSON(receipt.to)!==canonicalJSON(h.to)||receipt.contextId!==h.contextId||receipt.taskId!==h.taskId||h.role!=='agent')fail();
}
export function makeAssignedCarrier(envelope,receipt,version){
 const carrier=makeMessageCarrier(envelope,version),value=validateAssignmentStructure(receipt);assignedBindings(carrier.parts[0].data,value);carrier.metadata={[EXTENSION]:{v:1,assignment:value}};if(Buffer.byteLength(canonicalJSON(carrier))>1024*1024)fail();return carrier;
}
export function readAssignedCarrier(text,version){
 if(typeof text!=='string')fail();const value=parseJSON(text);if(!value||typeof value!=='object'||Array.isArray(value))fail();if(!fields(value.metadata,[EXTENSION])||!fields(value.metadata[EXTENSION],['v','assignment'])||value.metadata[EXTENSION].v!==1)fail();
 const receipt=validateAssignmentStructure(value.metadata[EXTENSION].assignment),{metadata,...rest}=value,envelope=readMessageCarrier(canonicalJSON(rest),version);assignedBindings(envelope,receipt);return {envelope,receipt};
}
