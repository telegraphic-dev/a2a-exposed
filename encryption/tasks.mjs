// Structural Task extraction only: routing state and array order never authenticate content.
import {EXTENSION,EncryptionError,canonicalJSON,parseJSON}from'./index.mjs';
import {readMessageCarrier,readReceiptCarrier,readAssignedCarrier}from'./carriers.mjs';
const fail=()=>{throw new EncryptionError('task_carrier_invalid');};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fields=(value,required,optional=[])=>object(value)&&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const id=value=>typeof value==='string'&&/^[\x21-\x7e]{1,200}$/.test(value);
const states=['submitted','working','input-required','completed','failed','canceled','rejected','auth-required'];
const wireState=(state,version)=>version==='0.3'?state:'TASK_STATE_'+state.toUpperCase().replaceAll('-','_');
function marker(value){return fields(value,[EXTENSION])&&fields(value[EXTENSION],['v'])&&value[EXTENSION].v===1;}
function event(value,version,taskId,contextId,current,routingState){
 if(!object(value))fail();const raw=canonicalJSON(value);let envelope=null,receipt=null;
 if(Object.hasOwn(value,'metadata')){
  if(value.parts?.[0]?.data!==undefined)({envelope,receipt}=readAssignedCarrier(raw,version));
  else receipt=readReceiptCarrier(raw,version);
 }else envelope=readMessageCarrier(raw,version);
 if(receipt&&(receipt.contextId!==contextId||receipt.taskId!==taskId))fail();
 if(envelope){const h=envelope.header;
  if(h.contextId!==contextId||(h.taskId===null?(current||h.role!=='user'||h.kind!=='message'):h.taskId!==taskId))fail();
  if((current&&h.role!=='agent')||(h.role==='user'&&h.kind!=='message'))fail();
  if(current&&h.kind==='status'&&h.state!==routingState)fail();
 }
 return {type:envelope?'envelope':'receipt',envelope,receipt};
}
export function readTaskCarrier(text,version){
 try{
  if(typeof text!=='string'||Buffer.byteLength(text)>1024*1024||!['0.3','1.0'].includes(version))fail();
  const task=parseJSON(text);
  if(!fields(task,['id','contextId','status',...(version==='0.3'?['kind']:[])],['artifacts','history','metadata'])||(version==='0.3'&&task.kind!=='task')||!id(task.id)||!id(task.contextId)||(Object.hasOwn(task,'artifacts')&&(!Array.isArray(task.artifacts)||task.artifacts.length!==0)))fail();
  if(Object.hasOwn(task,'metadata')&&(!object(task.metadata)||(Object.keys(task.metadata).length!==0&&!marker(task.metadata))))fail();
  if(!fields(task.status,['state'],['message','timestamp']))fail();
  const routingState=states.find(state=>wireState(state,version)===task.status.state);if(!routingState)fail();
  if(Object.hasOwn(task.status,'timestamp')){const value=task.status.timestamp;if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)||(!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,19)!==value.slice(0,19)))fail();}
  if(Object.hasOwn(task,'history')&&(!Array.isArray(task.history)||task.history.length>1000))fail();
  const history=(task.history||[]).map(value=>event(value,version,task.id,task.contextId,false,routingState));
  const status=Object.hasOwn(task.status,'message')?event(task.status.message,version,task.id,task.contextId,true,routingState):null;
  // Reject conflicting duplicates and immutable-receipt changes, without trusting array ordering.
  const seen=new Map();let assignment=null;
  for(const item of [...history,...(status?[status]:[])]){
   const key=item.envelope?item.envelope.header.role+'\n'+item.envelope.header.messageId:'agent\n'+item.receipt.ackId,value=canonicalJSON(item.envelope||item.receipt);
   if(seen.has(key)&&seen.get(key)!==value)fail();seen.set(key,value);
   if(item.receipt){const encoded=canonicalJSON(item.receipt);if(assignment!==null&&assignment!==encoded)fail();assignment=encoded;}
  }
  return {taskId:task.id,contextId:task.contextId,routingState,status,history,authentication:'unverified',routingOnly:status?.envelope==null,historyOrder:'untrusted'};
 }catch(error){if(error instanceof EncryptionError&&error.code==='task_carrier_invalid')throw error;fail();}
}
export function makeTaskCarrier(value,version){
 try{
  value=parseJSON(canonicalJSON(value));if(!fields(value,['taskId','contextId','routingState'],['statusMessage','history','metadata','timestamp']))fail();
  const {taskId,contextId,routingState,statusMessage,history=[],metadata,timestamp}=value;
  if(!states.includes(routingState)||!['0.3','1.0'].includes(version))fail();
  const task={...(version==='0.3'?{kind:'task'}:{}),id:taskId,contextId,status:{state:wireState(routingState,version),...(statusMessage===undefined?{}:{message:statusMessage}),...(timestamp===undefined?{}:{timestamp})},artifacts:[],history,...(metadata===undefined?{}:{metadata})};
  const raw=canonicalJSON(task);readTaskCarrier(raw,version);return parseJSON(raw);
 }catch{fail();}
}
