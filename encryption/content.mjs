// Lossless supported-part mapping and exact decrypted-content validation.
// Validation is not replay authorization or model delivery; trust/ledger gates remain required.
import {canonicalJSON,parseJSON,EncryptionError,MAX_PLAINTEXT} from './index.mjs';
const refuse=code=>{throw new EncryptionError(code||'content_unsupported');};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const exact=(value,keys)=>object(value)&&Object.keys(value).sort().join('\0')===[...keys].sort().join('\0');
const optional=(value,required,allowed)=>object(value)&&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>allowed.includes(key));
const string=(value,max)=>typeof value==='string'&&[...value].length<=max;
const nullable=(value,max)=>value===null||string(value,max);
const id=value=>typeof value==='string'&&/^[\x21-\x7e]{1,200}$/.test(value);
const digest=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value)&&Buffer.from(value,'base64url').toString('base64url')===value;
const states=['submitted','working','input-required','completed','failed','canceled','rejected','auth-required'];
const terminal=new Set(['completed','failed','canceled','rejected']);
function base64(value){return typeof value==='string'&&Buffer.from(value,'base64').toString('base64')===value;}
function metadata(value){if(!object(value))refuse();}
function parts(values){
 if(!Array.isArray(values)||values.length<1||values.length>100)refuse();
 for(const part of values){
  if(!object(part)||!nullable(part.mediaType,256))refuse();metadata(part.metadata);
  if(part.kind==='text'){if(!exact(part,['kind','text','mediaType','metadata'])||!string(part.text,200000))refuse();}
  else if(part.kind==='data'){if(!exact(part,['kind','data','mediaType','metadata'])||!object(part.data))refuse();}
  else if(part.kind==='file'){if(!exact(part,['kind','file','mediaType','metadata'])||!exact(part.file,['name','bytes'])||!nullable(part.file.name,512)||!base64(part.file.bytes))refuse();}
  else refuse();
 }
}
function strings(value,max,predicate){if(!Array.isArray(value)||value.length>max||value.some(x=>!predicate(x)))refuse();}
function message(value){
 if(!exact(value,['kind','authorRole','parts','metadata','extensions','referenceTaskIds',...(value?.authorRole==='agent'?['requestDigest']:[])])||value.kind!=='message'||!['user','agent'].includes(value.authorRole))refuse();
 if(value.authorRole==='agent'&&!digest(value.requestDigest))refuse('request_binding_required');
 parts(value.parts);metadata(value.metadata);strings(value.extensions,100,x=>string(x,4096)&&x.length>0);strings(value.referenceTaskIds,100,id);
}
export function validateContent(value,header,{expectedRequestDigest}={}){
 try{
  const text=canonicalJSON(value);if(Buffer.byteLength(text)>MAX_PLAINTEXT-128)refuse('content_too_large');
  if(!object(header)||!['user','agent'].includes(header.role)||!id(header.contextId)||!id(header.messageId)||(header.taskId!==null&&!id(header.taskId)))refuse();
  if(header.taskId===null&&(header.role!=='user'||header.kind!=='message'))refuse();
  if(header.kind==='message'){
   message(value);if(header.state!==null||value.authorRole!==header.role)refuse('message_role_unsupported');
  }else if(header.kind==='status'){
   if(!exact(value,['kind','authorRole','revision','previousDigest','state','statusMessage','artifacts','metadata','terminal',...(value?.authorRole==='agent'?['requestDigest']:[])])||value.kind!=='snapshot'||value.authorRole!==header.role||header.taskId===null||!states.includes(value.state)||value.state!==header.state||value.terminal!==terminal.has(value.state)||!Number.isSafeInteger(value.revision)||value.revision<0||(value.revision===0?value.previousDigest!==null:!digest(value.previousDigest)))refuse();
   if(value.authorRole==='agent'&&!digest(value.requestDigest))refuse('request_binding_required');
   if(value.statusMessage!==null){message(value.statusMessage);if(value.statusMessage.authorRole!==value.authorRole||(value.authorRole==='agent'&&value.statusMessage.requestDigest!==value.requestDigest))refuse();}
   metadata(value.metadata);if(!Array.isArray(value.artifacts)||value.artifacts.length>100)refuse();const seen=new Set();
   for(const artifact of value.artifacts){if(!exact(artifact,['artifactId','name','description','parts','metadata','extensions'])||!id(artifact.artifactId)||seen.has(artifact.artifactId)||!nullable(artifact.name,512)||!nullable(artifact.description,4000))refuse();seen.add(artifact.artifactId);parts(artifact.parts);metadata(artifact.metadata);strings(artifact.extensions,100,x=>string(x,4096)&&x.length>0);}
  }else refuse('content_kind_unsupported');
  if(expectedRequestDigest!==undefined&&value.requestDigest!==expectedRequestDigest)refuse('request_binding_mismatch');
  return parseJSON(text);
 }catch(error){if(error instanceof EncryptionError)throw error;refuse();}
}
export function fromProtocolParts(value,version){
 try{
  // Clone/validate JSON representation before touching values; never execute getters.
  const raw=parseJSON(canonicalJSON(value));if(!['0.3','1.0'].includes(version)||!Array.isArray(raw)||raw.length<1||raw.length>100)refuse();
  const mapped=raw.map(part=>{
   let kind;if(version==='0.3')kind=part?.kind;else if(object(part)){const choices=['text','data','raw','url'].filter(key=>Object.hasOwn(part,key));if(choices.length!==1)refuse();kind=choices[0]==='raw'||choices[0]==='url'?'file':choices[0];}
   if(object(part)&&Object.hasOwn(part,'mediaType')&&typeof part.mediaType!=='string')refuse();
   const common={kind,mediaType:part?.mediaType??null,metadata:part?.metadata===undefined?{}:part.metadata};
   if(kind==='text'){if(!optional(part,version==='0.3'?['kind','text']:['text'],version==='0.3'?['kind','text','mediaType','metadata']:['text','mediaType','metadata']))refuse();return {...common,text:part.text};}
   if(kind==='data'){if(!optional(part,version==='0.3'?['kind','data']:['data'],version==='0.3'?['kind','data','mediaType','metadata']:['data','mediaType','metadata']))refuse();return {...common,data:part.data};}
   if(kind==='file'){
    if(version==='0.3'){
     if(!optional(part,['kind','file'],['kind','file','metadata'])||!optional(part.file,['bytes'],['bytes','name','mimeType']))refuse('file_uri_unsupported');
     for(const key of ['name','mimeType'])if(Object.hasOwn(part.file,key)&&typeof part.file[key]!=='string')refuse();
     return {...common,mediaType:part.file.mimeType??null,file:{name:part.file.name??null,bytes:part.file.bytes}};
    }
    if(!optional(part,['raw'],['raw','filename','mediaType','metadata']))refuse('file_uri_unsupported');if(Object.hasOwn(part,'filename')&&typeof part.filename!=='string')refuse();return {...common,file:{name:part.filename??null,bytes:part.raw}};
   }
   refuse();
  });
  parts(mapped);return mapped;
 }catch(error){if(error instanceof EncryptionError)throw error;refuse();}
}
export function toProtocolParts(value,version){
 try{
  const copy=parseJSON(canonicalJSON(value));parts(copy);if(!['0.3','1.0'].includes(version))refuse();
  return copy.map(part=>{
   const meta={metadata:part.metadata};
   if(part.kind==='file')return version==='0.3'?{kind:'file',file:{bytes:part.file.bytes,...(part.file.name===null?{}:{name:part.file.name}),...(part.mediaType===null?{}:{mimeType:part.mediaType})},...meta}:{raw:part.file.bytes,...(part.file.name===null?{}:{filename:part.file.name}),...(part.mediaType===null?{}:{mediaType:part.mediaType}),...meta};
   return {...(version==='0.3'?{kind:part.kind}:{}),[part.kind]:part[part.kind],...(part.mediaType===null?{}:{mediaType:part.mediaType}),...meta};
  });
 }catch(error){if(error instanceof EncryptionError)throw error;refuse();}
}
