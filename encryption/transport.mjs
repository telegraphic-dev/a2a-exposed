// Privileged sealed-only JSON-RPC adapter. No CLI route or Worker capability is enabled here.
import{randomUUID}from'node:crypto';
import{DeliveryLedger}from'./ledger.mjs';import{LocalStateError}from'./local-state.mjs';
import{EXTENSION,EncryptionError,canonicalJSON,parseJSON}from'./index.mjs';import{makeMessageCarrier}from'./carriers.mjs';import{readTaskCarrier}from'./tasks.mjs';
class TransportError extends Error{constructor(code){super(code);this.code=code;}}
const fail=code=>{throw new TransportError(code);};
const clock=v=>Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
const id=v=>typeof v==='string'&&/^[\x21-\x7e]{1,200}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('\0')===[...keys].sort().join('\0');
const sealedSet=value=>[...new Set((value||'').split(',').map(v=>v.trim()).filter(v=>v.startsWith('https://a2a.exposed/ext/sealed/')))].sort();
function echo(headers,protocol){
 const standard=headers.get('A2A-Extensions'),legacy=headers.get('X-A2A-Extensions'),wanted=canonicalJSON([EXTENSION]);
 if(standard===null||(protocol==='0.3'&&legacy===null))fail('extension_not_confirmed');
 if(standard!==null&&canonicalJSON(sealedSet(standard))!==wanted)fail('extension_not_confirmed');
 if(legacy!==null&&canonicalJSON(sealedSet(legacy))!==wanted)fail('extension_not_confirmed');
}
async function text(response){
 const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>1024*1024))fail('response_too_large');
 const reader=response.body?.getReader();if(!reader)fail('response_invalid');let size=0;const bytes=new Uint8Array(1024*1024);
 try{for(;;){const {done,value}=await reader.read();if(done)break;if(!(value instanceof Uint8Array))fail('response_invalid');if(size+value.byteLength>bytes.byteLength)fail('response_too_large');bytes.set(value,size);size+=value.byteLength;}return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size));}
 finally{try{await reader.cancel();}catch{}reader.releaseLock();}
}
export class SealedJsonRpcClient{
 constructor({ledger,localId,peer,protocol,card,getPairing,withPairingLease,fetchImpl=globalThis.fetch,timeoutMs=15000}={}){
  if(!(ledger instanceof DeliveryLedger)||typeof localId!=='string'||!(/^[a-f0-9-]{36}$/).test(localId)||typeof peer!=='string'||!(/^[A-Za-z0-9_-]{1,80}$/).test(peer)||!['0.3','1.0'].includes(protocol)||typeof getPairing!=='function'||typeof withPairingLease!=='function'||typeof fetchImpl!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)fail('transport_options');
  this.ledger=ledger;this.localId=localId;this.peer=peer;this.protocol=protocol;this.card=parseJSON(canonicalJSON(card));this.getPairing=getPairing;this.withPairingLease=withPairingLease;this.fetch=fetchImpl;this.timeoutMs=timeoutMs;const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}};freeze(this.card);Object.freeze(this);
 }
 #binding(){
  // Only the trusted local host may supply this fresh saved-grant/credential snapshot. Never take it from a peer body.
  const pairing=parseJSON(canonicalJSON(this.getPairing()));
  if(!exact(pairing,['identity','endpoint','token','verified','revision'])||!Number.isSafeInteger(pairing.revision)||pairing.revision<0||pairing.verified!==true||typeof pairing.token!=='string'||!(/^[\x21-\x7e]{1,4096}$/).test(pairing.token))fail('pairing_unverified');
  const scope={localId:this.localId,peer:this.peer,pairingIdentity:pairing.identity,pairingVerified:true},pin=this.ledger.resolve(this.localId,this.peer,scope);
  let url;try{url=new URL(pairing.endpoint);}catch{fail('endpoint_binding_changed');}
  if(url.protocol!=='https:'||url.href!==pairing.endpoint||url.username||url.password||url.search||url.hash||url.origin!==new URL(pin.remote.cardUrl).origin||pairing.endpoint!==pin.record.peerEndpoint)fail('endpoint_binding_changed');
  const extensions=this.card?.capabilities?.extensions,sealed=Array.isArray(extensions)?extensions.filter(e=>typeof e?.uri==='string'&&e.uri.startsWith('https://a2a.exposed/ext/sealed/')):[];
  if(sealed.length!==1||!exact(sealed[0],['uri','required','params',...(Object.hasOwn(sealed[0],'description')?['description']:[])])||(Object.hasOwn(sealed[0],'description')&&(typeof sealed[0].description!=='string'||sealed[0].description.length>4096))||sealed[0].uri!==EXTENSION||sealed[0].required!==false||!exact(sealed[0].params,['bundle','responseKind'])||sealed[0].params.responseKind!=='task'||canonicalJSON(sealed[0].params.bundle)!==canonicalJSON(pin.remote))fail('capability_unconfirmed');
  const interfaces=this.card.supportedInterfaces;
  if(interfaces!==undefined&&!Array.isArray(interfaces))fail('interface_routing_unsupported');
  const selected=(interfaces||[]).filter(i=>i?.url===pairing.endpoint&&i.protocolVersion===this.protocol),rpc=selected.filter(i=>i.protocolBinding==='JSONRPC');
  if(rpc.length){for(const i of rpc)if(!exact(i,['url','protocolVersion','protocolBinding',...(Object.hasOwn(i,'tenant')?['tenant']:[])])||(Object.hasOwn(i,'tenant')&&i.tenant!==''))fail('interface_routing_unsupported');}
  else{
   if(selected.length||this.protocol!=='0.3'||(this.card.protocolVersion!==undefined&&!['0.3','0.3.0'].includes(this.card.protocolVersion))||((interfaces||[]).length&&this.card.protocolVersion===undefined))fail('interface_routing_unsupported');
   const additional=this.card.additionalInterfaces;if(additional!==undefined&&!Array.isArray(additional))fail('interface_routing_unsupported');
   const extra=(additional||[]).filter(i=>i?.url===pairing.endpoint&&i.transport==='JSONRPC');
   if(extra.some(i=>!exact(i,['url','transport'])))fail('interface_routing_unsupported');
   const main=this.card.url===pairing.endpoint&&(this.card.preferredTransport===undefined||this.card.preferredTransport==='JSONRPC');
   if(!extra.length&&!main)fail('interface_routing_unsupported');
   if(Object.hasOwn(this.card,'tenant')&&this.card.tenant!=='')fail('interface_routing_unsupported');
  }
  return{scope,pin,pairing};
 }
 #recheck(original){const current=this.#binding();if(current.pin.digest!==original.pin.digest||canonicalJSON(current.pairing)!==canonicalJSON(original.pairing))fail('pairing_changed');return current;}
 #commitGuard(binding){try{this.#recheck(binding);return true;}catch{throw new LocalStateError('authorization_changed','The current local pairing, endpoint or effective credential changed; no new delivery was committed.');}}
 #attempted(messageId){return this.ledger.state.db.prepare('SELECT state FROM outbound WHERE local_key_id=? AND peer=? AND message_id=?').all(this.localId,this.peer,messageId).some(row=>row.state!=='prepared');}
 async #rpc(binding,method,params,onSubmit=()=>{}){
  const id=randomUUID(),headers={'content-type':'application/json',accept:'application/json','user-agent':'a2a-exposed-sealed-client','A2A-Version':this.protocol,'A2A-Extensions':EXTENSION,authorization:'Bearer '+binding.pairing.token};if(this.protocol==='0.3')headers['X-A2A-Extensions']=EXTENSION;
  const request={jsonrpc:'2.0',id,method,params},body=canonicalJSON(request);if(Buffer.byteLength(body)>1024*1024)fail('request_too_large');
  const init={method:'POST',headers,body,redirect:'error',signal:AbortSignal.timeout(this.timeoutMs)};onSubmit();const response=await this.fetch(binding.pairing.endpoint,init);
  try{
  if(response.redirected||(response.url&&response.url!==binding.pairing.endpoint)||response.status>=300&&response.status<400)fail('transport_redirect_refused');
  if(response.status!==200)fail('transport_rejected');if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')fail('response_invalid');echo(response.headers,this.protocol);
  const data=parseJSON(await text(response));if(!exact(data,['jsonrpc','id','result'])||data.jsonrpc!=='2.0'||data.id!==id)fail('rpc_response_invalid');return data.result;
  }catch(error){try{await response.body?.cancel();}catch{}throw error;}
 }
 async send({messageId,now=Date.now()}={}){
  let submitted=false,prior=false,binding;
  try{
   if(!id(messageId))fail('message_id_required');
   prior=this.#attempted(messageId);if(!clock(now))fail('clock_invalid');
   binding=this.#binding();const saved=this.ledger.outboundRow(binding.pin,messageId);const envelope=parseJSON(saved.envelope);if(saved.protocol!==this.protocol||envelope.header.role!=='user'||envelope.header.kind!=='message'||saved.reference_digest!==null)fail('request_binding_mismatch');
   const started=await this.ledger.beginTransmission({...binding.scope,messageId,now});this.#recheck(binding);const message=makeMessageCarrier(started.envelope,this.protocol);
   // Construct/validate bytes before marking submission; all later failures retain known sealed readability.
   const params={message,configuration:this.protocol==='1.0'?{returnImmediately:true}:{blocking:false}};canonicalJSON(params);
   const result=await this.#rpc(binding,this.protocol==='1.0'?'SendMessage':'message/send',params,()=>{submitted=true;}),task=this.protocol==='1.0'?(exact(result,['task'])?result.task:fail('task_response_required')):result;
   const rawTask=canonicalJSON(task),parsed=readTaskCarrier(rawTask,this.protocol);this.#recheck(binding);
   await this.ledger.recordTransport({...binding.scope,messageId,outcome:'transport-accepted',provisionalTaskId:parsed.taskId,extensionEcho:EXTENSION});
   // A follow-up uses the initial locally signed assignment, never the provisional Task ID.
   const initial=saved.task_id===null?messageId:this.ledger.state.db.prepare("SELECT request_message_id FROM assignments WHERE local_identity=? AND peer_identity=? AND context=? AND task_id=? AND direction='outbound'").get(binding.pin.localIdentity,binding.pin.peerIdentity,saved.context,saved.task_id)?.request_message_id;if(!initial)fail('assignment_required');
   const accepted=await this.ledger.acceptTask({...binding.scope,requestMessageId:initial,rawTask,protocol:this.protocol,activatedExtension:EXTENSION,authorizationGuard:()=>this.#commitGuard(binding),withAuthorizationLease:this.withPairingLease,now});
   return{ok:true,code:'sealed_task_received',operation:'send',deliveryStatus:accepted.deliveries.length?'locally-opened':'transport-accepted',next:'Inspect stable local delivery IDs. No model consumption or exactly-once external effect is claimed.',details:{messageId,taskId:accepted.taskId,assignmentAuthenticated:accepted.assignmentAuthenticated,deliveries:accepted.deliveries,currentPeerState:accepted.currentPeerState,privacy:{serverReadable:false,contentMode:'sealed'}}};
  }catch(error){if(!submitted&&id(messageId)){try{prior=prior||this.#attempted(messageId);}catch{prior=true;}if(error?.code==='outbound_already_attempted')prior=true;}if(submitted&&binding){try{await this.ledger.recordTransport({...binding.scope,messageId,outcome:'unknown'});}catch{}}
   return this.#failure(error,'send',submitted||prior?'unknown':'not-sent',{...(id(messageId)?{messageId}:{}),privacy:submitted?{serverReadable:false,contentMode:'sealed'}:prior?{serverReadable:'unknown',contentMode:'unknown'}:{serverReadable:'unknown',contentMode:'not-sent'}});
  }
 }
 async poll({requestMessageId,now=Date.now()}={}){
  try{
   if(!id(requestMessageId))fail('request_message_id_required');if(!clock(now))fail('clock_invalid');
   const binding=this.#binding(),row=this.ledger.outboundRow(binding.pin,requestMessageId),assignment=this.ledger.state.db.prepare("SELECT * FROM assignments WHERE local_identity=? AND peer_identity=? AND request_message_id=? AND direction='outbound'").get(binding.pin.localIdentity,binding.pin.peerIdentity,requestMessageId);
   if(!assignment||assignment.trust_digest!==binding.pin.digest||assignment.protocol!==this.protocol||row.reference_digest!==null||row.task_id!==null||row.protocol!==this.protocol)fail('assignment_required');
   const result=await this.#rpc(binding,this.protocol==='1.0'?'GetTask':'tasks/get',{id:assignment.task_id}),rawTask=canonicalJSON(result);this.#recheck(binding);
   const accepted=await this.ledger.acceptTask({...binding.scope,requestMessageId,rawTask,protocol:this.protocol,activatedExtension:EXTENSION,authorizationGuard:()=>this.#commitGuard(binding),withAuthorizationLease:this.withPairingLease,now});
   return{ok:true,code:'sealed_task_received',operation:'read',deliveryStatus:accepted.deliveries.length?'locally-opened':'transport-accepted',next:'Read stable local delivery IDs explicitly; transport polling did not consume model work.',details:{taskId:accepted.taskId,deliveries:accepted.deliveries,currentPeerState:accepted.currentPeerState,transportRoutingState:accepted.transportRoutingState,transportStateAuthenticated:false}};
  }catch(error){return this.#failure(error,'read','unknown',{});}
 }
 #failure(error,operation,deliveryStatus,details){return{ok:false,code:error instanceof TransportError||error instanceof EncryptionError||error instanceof LocalStateError?error.code:'transport_failed',operation,deliveryStatus,retryable:false,next:'Preserve the original local message/assignment IDs and inspect their state. Never automatically resend with a new ID, alternate endpoint, protocol version or plaintext.',details};}
}
