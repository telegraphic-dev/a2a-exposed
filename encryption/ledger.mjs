// Local durable acceptance only. No network/model callbacks are invoked by this API.
import {randomUUID,createHash}from'node:crypto';
import {LocalState,LocalStateError}from'./local-state.mjs';
import {EXTENSION,EncryptionError,canonicalJSON,parseJSON,validateEnvelopeStructure,verifyEnvelopeSignature,verifyBundle,open,seal}from'./index.mjs';
import {createAssignment,envelopeDigest,verifyAssignment,validateAssignmentStructure,openAssignedResponse}from'./assignment.mjs';
import {validateContent}from'./content.mjs';
import {makeReceiptCarrier}from'./carriers.mjs';
import {readTaskCarrier}from'./tasks.mjs';
export class LedgerError extends LocalStateError{constructor(code,next='Preserve local state and inspect pending delivery/receipt IDs; no automatic new-message retry was performed.'){super(code,next);this.code=code;this.next=next;}}
const fail=(code,next)=>{throw new LedgerError(code,next);};
const id=value=>typeof value==='string'&&/^[\x21-\x7e]{1,200}$/.test(value);
const bundleHash=value=>createHash('sha256').update('a2a-exposed sealed bundle v1\n'+canonicalJSON(value)).digest('base64url');
const binding=h=>Object.fromEntries(['contextId','messageId','taskId','role','state','kind'].map(key=>[key,h[key]]));
function page(limit,cursor){if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(cursor)||cursor<0)fail('listing_inputs','Use an explicit limit 1..100 and the exact nonnegative returned cursor.');}
export class DeliveryLedger{
 constructor(state){if(!(state instanceof LocalState))fail('local_store_required');this.state=state;}
 resolve(localId,peer,{pairingIdentity,pairingVerified}={}){
  this.state.ready();if(this.state.db.prepare("SELECT value FROM meta WHERE key='restore_paused'").get()?.value==='1')fail('restore_archive_only');
  if(pairingVerified!==true)fail('pairing_unverified','The trusted local transport must verify its existing human-authorized pairing; peer/server assertions do not grant it.');
  const inspection=this.state.inspect(peer),record=inspection.current,local=this.state.row(localId),bundle=parseJSON(local.bundle);
  if(!record||!['tofu-pinned','independently-verified'].includes(inspection.live_state)||record.state==='revoked'||record.policy==='off')fail('trust_not_ready','Inspect the exact local peer proposal/policy; pending, revoked or off trust cannot authorize sealed delivery.');
  if(record.pairingIdentity!==pairingIdentity||record.configIdentity!==this.state.configId()||record.localId!==localId||local.live_state!=='local-only'||record.localBundleDigest!==bundleHash(bundle)||record.localKeyId!==bundle.keyId)fail('trust_binding_changed');
  if(bundle.identityKey===record.bundle.identityKey)fail('same_identity');
  return {localId,peer,bundle,remote:record.bundle,record,digest:inspection.current_digest,localIdentity:bundle.identityKey,peerIdentity:record.bundle.identityKey,pairingIdentity};
 }
 assertPin(pin,attestation){const current=this.resolve(pin.localId,pin.peer,attestation);if(current.digest!==pin.digest)fail('trust_binding_changed');return current;}
 async receiveInitial({localId,peer,envelope,observedTaskId,protocol,activatedExtension,pairingIdentity,pairingVerified=false,allowOsConsent=false,now=Date.now()}={}){
  envelope=validateEnvelopeStructure(envelope);if(activatedExtension!==EXTENSION||!['0.3','1.0'].includes(protocol))fail('extension_not_activated');
  if(!id(observedTaskId)||envelope.header.taskId!==null||envelope.header.role!=='user'||envelope.header.kind!=='message')fail('initial_assignment_inputs');
  const attestation={pairingIdentity,pairingVerified},pin=this.resolve(localId,peer,attestation);
  // Reject bad public signatures/bindings before any native/file credential read.
  await verifyEnvelopeSignature({envelope,sender:pin.remote,recipient:pin.bundle,now});
  const identity=await this.state.loadIdentity(localId,{allowOsConsent});
  const prepared=await createAssignment({identity,senderBundle:pin.remote,requestEnvelope:envelope,taskId:observedTaskId,now});
  const digest=await envelopeDigest(envelope),deliveryId=randomUUID(),h=envelope.header;
  return this.state.locked(async()=>{
   this.assertPin(pin,attestation);
   const prior=this.state.db.prepare('SELECT * FROM replay WHERE local_id=? AND sender=? AND message_id=?').get(pin.localIdentity,pin.peerIdentity,h.messageId);
   if(prior){
    if(prior.digest!==digest||prior.context!==h.contextId||prior.task_id!==observedTaskId)fail('replay_conflict');
    const assignment=this.state.db.prepare("SELECT * FROM assignments WHERE local_identity=? AND peer_identity=? AND request_message_id=? AND direction='inbound'").get(pin.localIdentity,pin.peerIdentity,h.messageId);
    const delivery=this.state.db.prepare('SELECT id,state FROM deliveries WHERE local_id=? AND sender=? AND message_id=?').get(pin.localIdentity,pin.peerIdentity,h.messageId);
    if(!assignment||!delivery)fail('ledger_corrupt');
    return {ok:true,duplicate:true,deliveryId:delivery.id,deliveryState:delivery.state,receipt:parseJSON(assignment.receipt),taskId:assignment.task_id,next:'The original durable acceptance is reused. Do not deliver a second task or create a new acknowledgment.'};
   }
   if(this.state.db.prepare("SELECT request_message_id FROM assignments WHERE local_identity=? AND peer_identity=? AND task_id=? AND direction='inbound'").get(pin.localIdentity,pin.peerIdentity,observedTaskId))fail('assignment_conflict');
   this.state.db.prepare('INSERT INTO replay VALUES(?,?,?,?,?,?,?)').run(pin.localIdentity,pin.peerIdentity,h.messageId,digest,h.contextId,observedTaskId,now);
   this.state.db.prepare('INSERT INTO assignments VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(pin.localIdentity,pin.peerIdentity,h.messageId,'inbound',prepared.receipt.ackId,peer,h.contextId,digest,observedTaskId,canonicalJSON(prepared.receipt),protocol,pin.digest,localId,'pending');
   this.state.db.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?)').run(deliveryId,pin.localIdentity,pin.peerIdentity,h.messageId,canonicalJSON(envelope),'pending',now);
   this.state.db.prepare('INSERT INTO delivery_provenance VALUES(?,?,?,?,?,?)').run(deliveryId,peer,pin.digest,pin.record.version,localId,digest);
   // Receipt escapes only after LocalState.locked has committed all four rows.
   return {ok:true,duplicate:false,deliveryId,deliveryState:'pending',receipt:prepared.receipt,taskId:observedTaskId,next:'Request locally opened and durably queued. The local consumer has not acknowledged it; publish only this stable signed receipt.'};
  });
 }
 async receiveFollowup({localId,peer,envelope,observedTaskId,protocol,activatedExtension,pairingIdentity,pairingVerified=false,allowOsConsent=false,now=Date.now()}={}){
  envelope=validateEnvelopeStructure(envelope);const h=envelope.header;
  if(activatedExtension!==EXTENSION||!['0.3','1.0'].includes(protocol))fail('extension_not_activated');
  if(!id(observedTaskId)||h.taskId!==observedTaskId||h.role!=='user'||h.kind!=='message')fail('followup_inputs');
  const attestation={pairingIdentity,pairingVerified},pin=this.resolve(localId,peer,attestation);
  const check=()=>{const assignment=this.state.db.prepare("SELECT * FROM assignments WHERE local_identity=? AND peer_identity=? AND task_id=? AND direction='inbound'").get(pin.localIdentity,pin.peerIdentity,observedTaskId);
   if(!assignment||assignment.context!==h.contextId||assignment.protocol!==protocol||assignment.trust_digest!==pin.digest)fail('assignment_required');return assignment;};check();
  await verifyEnvelopeSignature({envelope,sender:pin.remote,recipient:pin.bundle,now});const identity=await this.state.loadIdentity(localId,{allowOsConsent});
  validateContent(await open({envelope,identity,sender:pin.remote,recipient:pin.bundle,expected:binding(h),now}),h);const digest=await envelopeDigest(envelope);
  return this.state.locked(async()=>{
   this.assertPin(pin,attestation);check();const prior=this.state.db.prepare('SELECT * FROM replay WHERE local_id=? AND sender=? AND message_id=?').get(pin.localIdentity,pin.peerIdentity,h.messageId);
   if(prior){if(prior.digest!==digest||prior.context!==h.contextId||prior.task_id!==h.taskId)fail('replay_conflict');const row=this.state.db.prepare('SELECT id FROM deliveries WHERE local_id=? AND sender=? AND message_id=?').get(pin.localIdentity,pin.peerIdentity,h.messageId);if(!row)fail('ledger_corrupt');return {ok:true,deliveryId:row.id,duplicate:true};}
   const head=this.state.db.prepare('SELECT terminal FROM chains WHERE local_identity=? AND peer_identity=? AND context=? AND task_id=? AND author_identity=?').get(pin.localIdentity,pin.peerIdentity,h.contextId,h.taskId,pin.localIdentity);if(head?.terminal)fail('task_terminal');
   const deliveryId=randomUUID();this.state.db.prepare('INSERT INTO replay VALUES(?,?,?,?,?,?,?)').run(pin.localIdentity,pin.peerIdentity,h.messageId,digest,h.contextId,h.taskId,now);
   this.state.db.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?)').run(deliveryId,pin.localIdentity,pin.peerIdentity,h.messageId,canonicalJSON(envelope),'pending',now);
   this.state.db.prepare('INSERT INTO delivery_provenance VALUES(?,?,?,?,?,?)').run(deliveryId,peer,pin.digest,pin.record.version,localId,digest);
   return {ok:true,deliveryId,duplicate:false,taskId:h.taskId,next:'Follow-up durably queued under the original signed assignment; peer content remains untrusted and unconsumed.'};
  });
 }
 async prepareRequest({localId,peer,content,contextId=randomUUID(),messageId=randomUUID(),taskId=null,protocol,remoteExtension,pairingIdentity,pairingVerified=false,allowOsConsent=false,now=Date.now()}={}){
  if(remoteExtension!==EXTENSION||!['0.3','1.0'].includes(protocol))fail('extension_not_activated');
  const header={contextId,messageId,taskId,role:'user',state:null,kind:'message'};content=validateContent(content,header);
  const attestation={pairingIdentity,pairingVerified},pin=this.resolve(localId,peer,attestation);
  if(this.state.db.prepare('SELECT message_id FROM outbound WHERE local_identity=? AND peer_identity=? AND message_id=?').get(pin.localIdentity,pin.peerIdentity,messageId))fail('message_id_used','Inspect the original outbound ID/state. Do not re-seal or send a new ID as an automatic retry.');
  const checkTask=()=>{
   if(taskId===null)return;
   const assignment=this.state.db.prepare("SELECT trust_digest FROM assignments WHERE local_identity=? AND peer_identity=? AND context=? AND task_id=? AND direction='outbound'").get(pin.localIdentity,pin.peerIdentity,contextId,taskId);
   if(!assignment||assignment.trust_digest!==pin.digest)fail('assignment_required','Task follow-up requires the locally verified signed assignment, never a provisional Worker task ID.');
   const head=this.state.db.prepare('SELECT terminal FROM chains WHERE local_identity=? AND peer_identity=? AND context=? AND task_id=? AND author_identity=?').get(pin.localIdentity,pin.peerIdentity,contextId,taskId,pin.peerIdentity);if(head?.terminal)fail('task_terminal','Start a new request/task for new work; the authenticated terminal task cannot be reopened.');
  };checkTask();
  const identity=await this.state.loadIdentity(localId,{allowOsConsent}),envelope=await seal({identity,recipient:pin.remote,binding:header,content,now}),digest=await envelopeDigest(envelope);
  return this.state.locked(async()=>{
   this.assertPin(pin,attestation);checkTask();
   if(this.state.db.prepare('SELECT message_id FROM outbound WHERE local_identity=? AND peer_identity=? AND message_id=?').get(pin.localIdentity,pin.peerIdentity,messageId))fail('message_id_used');
   this.state.db.prepare('INSERT INTO outbound VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(pin.localIdentity,pin.peerIdentity,messageId,peer,contextId,taskId,digest,canonicalJSON(envelope),pin.digest,localId,null,'prepared',null,protocol,now);
   return {ok:true,messageId,contextId,taskId,protocol,deliveryStatus:'not-sent',state:'prepared',next:'Ciphertext is durably prepared and self-opened. Begin exactly this ID once; no transport request was made.'};
  });
 }
 async prepareResponse({localId,peer,requestMessageId,content,messageId=randomUUID(),protocol,remoteExtension,pairingIdentity,pairingVerified=false,allowOsConsent=false,now=Date.now()}={}){
  content=parseJSON(canonicalJSON(content));
  if(remoteExtension!==EXTENSION||!['0.3','1.0'].includes(protocol))fail('extension_not_activated');
  const attestation={pairingIdentity,pairingVerified},pin=this.resolve(localId,peer,attestation);
  const request=this.state.db.prepare('SELECT r.*,d.envelope,p.trust_digest FROM replay r JOIN deliveries d ON d.local_id=r.local_id AND d.sender=r.sender AND d.message_id=r.message_id JOIN delivery_provenance p ON p.id=d.id WHERE r.local_id=? AND r.sender=? AND r.message_id=?').get(pin.localIdentity,pin.peerIdentity,requestMessageId);
  if(!request||request.trust_digest!==pin.digest)fail('request_binding_mismatch');
  const incoming=validateEnvelopeStructure(request.envelope);
  const assignment=this.state.db.prepare("SELECT * FROM assignments WHERE local_identity=? AND peer_identity=? AND task_id=? AND direction='inbound'").get(pin.localIdentity,pin.peerIdentity,request.task_id);
  if(!assignment||assignment.context!==request.context||assignment.trust_digest!==pin.digest||assignment.protocol!==protocol||incoming.header.role!=='user'||(incoming.header.taskId===null?assignment.request_message_id!==requestMessageId:incoming.header.taskId!==assignment.task_id))fail('assignment_required');
  if(await envelopeDigest(incoming)!==request.digest)fail('ledger_corrupt');
  const headQuery=this.state.db.prepare('SELECT * FROM chains WHERE local_identity=? AND peer_identity=? AND context=? AND task_id=? AND author_identity=?');
  const headArgs=[pin.localIdentity,pin.peerIdentity,request.context,request.task_id,pin.localIdentity],head=headQuery.get(...headArgs);
  if(head?.terminal)fail('task_terminal');
  if(content.requestDigest!==undefined&&content.requestDigest!==request.digest)fail('request_binding_mismatch');content.requestDigest=request.digest;
  if(content.kind==='snapshot'){
   const revision=head?head.revision+1:0,previousDigest=head?head.digest:null;
   if((content.revision!==undefined&&content.revision!==revision)||(content.previousDigest!==undefined&&content.previousDigest!==previousDigest))fail('chain_conflict');
   content.revision=revision;content.previousDigest=previousDigest;
  }
  const header={contextId:request.context,messageId,taskId:request.task_id,role:'agent',state:content.kind==='snapshot'?content.state:null,kind:content.kind==='snapshot'?'status':'message'};content=validateContent(content,header);
  const identity=await this.state.loadIdentity(localId,{allowOsConsent}),envelope=await seal({identity,recipient:pin.remote,binding:header,content,now}),digest=await envelopeDigest(envelope);
  return this.state.locked(async()=>{
   this.assertPin(pin,attestation);const current=headQuery.get(...headArgs);if((current?.digest??null)!==(head?.digest??null))fail('chain_conflict');
   if(this.state.db.prepare('SELECT message_id FROM outbound WHERE local_identity=? AND peer_identity=? AND message_id=?').get(pin.localIdentity,pin.peerIdentity,messageId))fail('message_id_used');
   this.state.db.prepare('INSERT INTO outbound VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(pin.localIdentity,pin.peerIdentity,messageId,peer,request.context,request.task_id,digest,canonicalJSON(envelope),pin.digest,localId,request.digest,'prepared',null,protocol,now);
   if(content.kind==='snapshot')this.state.db.prepare('INSERT INTO chains VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(local_identity,peer_identity,context,task_id,author_identity) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,state=excluded.state,terminal=excluded.terminal').run(...headArgs,content.revision,digest,content.state,content.terminal?1:0);
   return {ok:true,messageId,contextId:request.context,taskId:request.task_id,deliveryStatus:'not-sent',state:'prepared',...(content.kind==='snapshot'?{revision:content.revision}:{}),next:'Correlated response ciphertext and any snapshot head are committed together. Begin this exact ID once; no transport was performed.'};
  });
 }
 outboundRow(pin,messageId){const row=this.state.db.prepare('SELECT * FROM outbound WHERE local_identity=? AND peer_identity=? AND message_id=?').get(pin.localIdentity,pin.peerIdentity,messageId);if(!row)fail('outbound_unknown');if(row.trust_digest!==pin.digest||row.local_key_id!==pin.localId)fail('delivery_trust_changed');return row;}
 async beginTransmission({localId,peer,messageId,pairingIdentity,pairingVerified=false,now=Date.now()}={}){
  const attestation={pairingIdentity,pairingVerified},pin=this.resolve(localId,peer,attestation),row=this.outboundRow(pin,messageId);
  if(row.state!=='prepared')fail('outbound_already_attempted','Delivery may already have occurred. Inspect this exact outbound ID; never automatically retry with another ID or plaintext.');
  const envelope=validateEnvelopeStructure(row.envelope),checkTerminal=()=>{if(envelope.header.role==='user'&&row.task_id!==null&&this.state.db.prepare('SELECT terminal FROM chains WHERE local_identity=? AND peer_identity=? AND context=? AND task_id=? AND author_identity=?').get(pin.localIdentity,pin.peerIdentity,row.context,row.task_id,pin.peerIdentity)?.terminal)fail('task_terminal');};checkTerminal();
  await verifyEnvelopeSignature({envelope,sender:pin.bundle,recipient:pin.remote,now});if(await envelopeDigest(envelope)!==row.digest)fail('ledger_corrupt');
  return this.state.locked(async()=>{
   this.assertPin(pin,attestation);checkTerminal();const current=this.outboundRow(pin,messageId);if(current.state!=='prepared')fail('outbound_already_attempted');if(current.envelope!==row.envelope||current.digest!==row.digest)fail('ledger_corrupt');
   this.state.db.prepare("UPDATE outbound SET state='transmitting' WHERE local_identity=? AND peer_identity=? AND message_id=? AND state='prepared'").run(pin.localIdentity,pin.peerIdentity,messageId);
   return {ok:true,messageId,envelope,protocol:row.protocol,deliveryStatus:'unknown',retryable:false,next:'One transmission is authorized for this cached ciphertext. Persist the observed result; a crash/timeout remains unknown, not permission to re-send.'};
  });
 }
 async recordTransport({localId,peer,messageId,pairingIdentity,pairingVerified=false,outcome,provisionalTaskId=null,extensionEcho}={}){
  if(!['unknown','rejected','transport-accepted'].includes(outcome))fail('transport_result_invalid');
  const attestation={pairingIdentity,pairingVerified},pin=this.resolve(localId,peer,attestation);
  return this.state.locked(async()=>{
   this.assertPin(pin,attestation);const row=this.outboundRow(pin,messageId);if(row.state==='prepared')fail('outbound_not_started');
   let observed=outcome;if(observed==='transport-accepted'&&(extensionEcho!==EXTENSION||!id(provisionalTaskId)||(row.task_id!==null&&row.task_id!==provisionalTaskId)))observed='unknown';
   const rank={'prepared':0,'transmitting':1,'unknown':2,'rejected':2,'transport-accepted':3,'peer-assigned':4};
   if(rank[row.state]===undefined)fail('ledger_corrupt');
   if(rank[observed]>=rank[row.state])this.state.db.prepare('UPDATE outbound SET state=?,transport_task_id=? WHERE local_identity=? AND peer_identity=? AND message_id=?').run(observed,id(provisionalTaskId)?provisionalTaskId:row.transport_task_id,pin.localIdentity,pin.peerIdentity,messageId);
   const current=this.outboundRow(pin,messageId);return {ok:true,messageId,state:current.state,deliveryStatus:current.state==='peer-assigned'?'locally-opened':current.state==='transport-accepted'?'transport-accepted':current.state==='rejected'?'rejected':'unknown',retryable:false,provisionalTaskId:current.transport_task_id,next:'A Worker ID/extension echo is routing metadata only. Wait for the exact peer-signed assignment; never infer peer/model consumption or use plaintext fallback.'};
  });
 }
 listOutbound({limit=20,cursor=0}={}){
  page(limit,cursor);this.state.ready();const rows=this.state.db.prepare('SELECT rowid AS cursor,message_id,peer,context,task_id,state,transport_task_id,protocol FROM outbound WHERE rowid>? ORDER BY rowid LIMIT ?').all(cursor,limit+1);
  return {ok:true,configIdentity:this.state.configId(),outbound:rows.slice(0,limit).map(row=>({messageId:row.message_id,peer:row.peer,contextId:row.context,taskId:row.task_id,state:row.state,provisionalTaskId:row.transport_task_id,protocol:row.protocol,retryable:false})),nextCursor:rows.length>limit?rows[limit-1].cursor:null,next:'Inspect pending IDs before another action; unknown/transmitting entries never authorize an automatic fresh-message retry.'};
 }
 #answeredUserRequest(pin,digest,contextId,taskId){
  const request=this.state.db.prepare('SELECT * FROM outbound WHERE local_identity=? AND peer_identity=? AND digest=?').get(pin.localIdentity,pin.peerIdentity,digest);
  // Only prepareRequest writes a null reference_digest. Responses always name the inbound request they answer.
  if(!request||request.reference_digest!==null||request.context!==contextId||request.trust_digest!==pin.digest||request.local_key_id!==pin.localId||!['transmitting','unknown','rejected','transport-accepted','peer-assigned'].includes(request.state))fail('request_binding_mismatch');
  const envelope=validateEnvelopeStructure(request.envelope),h=envelope.header,identity=bundle=>({cardUrl:bundle.cardUrl,identityKey:bundle.identityKey,keyId:bundle.keyId});
  if(h.role!=='user'||h.kind!=='message'||h.state!==null||h.contextId!==contextId||h.messageId!==request.message_id||h.taskId!==request.task_id||createHash('sha256').update(canonicalJSON(envelope)).digest('base64url')!==digest||canonicalJSON(h.from)!==canonicalJSON(identity(pin.bundle))||canonicalJSON(h.to)!==canonicalJSON(identity(pin.remote)))fail('request_binding_mismatch');
  const assignment=this.state.db.prepare("SELECT * FROM assignments WHERE local_identity=? AND peer_identity=? AND context=? AND task_id=? AND direction='outbound'").get(pin.localIdentity,pin.peerIdentity,contextId,taskId);
  if(!assignment||assignment.trust_digest!==pin.digest||(request.task_id===null?assignment.request_message_id!==request.message_id:request.task_id!==taskId))fail('assignment_required');
  return {request,assignment};
 }
 #queueVerifiedResponse(pin,envelope,content,digest,now){
  const h=envelope.header;this.#answeredUserRequest(pin,content.requestDigest,h.contextId,h.taskId);
  const prior=this.state.db.prepare('SELECT * FROM replay WHERE local_id=? AND sender=? AND message_id=?').get(pin.localIdentity,pin.peerIdentity,h.messageId);
  if(prior){if(prior.digest!==digest||prior.context!==h.contextId||prior.task_id!==h.taskId)fail('replay_conflict');const delivery=this.state.db.prepare('SELECT id FROM deliveries WHERE local_id=? AND sender=? AND message_id=?').get(pin.localIdentity,pin.peerIdentity,h.messageId);if(!delivery)fail('ledger_corrupt');return {deliveryId:delivery.id,duplicate:true};}
  if(content.kind!=='snapshot'&&this.state.db.prepare('SELECT terminal FROM chains WHERE local_identity=? AND peer_identity=? AND context=? AND task_id=? AND author_identity=?').get(pin.localIdentity,pin.peerIdentity,h.contextId,h.taskId,pin.peerIdentity)?.terminal)fail('task_terminal');
  if(content.kind==='snapshot'){
   const head=this.state.db.prepare('SELECT * FROM chains WHERE local_identity=? AND peer_identity=? AND context=? AND task_id=? AND author_identity=?').get(pin.localIdentity,pin.peerIdentity,h.contextId,h.taskId,pin.peerIdentity);
   if(!head){if(content.revision!==0||content.previousDigest!==null)fail('provenance_incomplete');}
   else if(head.terminal||content.revision!==head.revision+1||content.previousDigest!==head.digest)fail(content.revision>head.revision+1?'provenance_incomplete':'chain_conflict');
   this.state.db.prepare('INSERT INTO chains VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(local_identity,peer_identity,context,task_id,author_identity) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,state=excluded.state,terminal=excluded.terminal').run(pin.localIdentity,pin.peerIdentity,h.contextId,h.taskId,pin.peerIdentity,content.revision,digest,content.state,content.terminal?1:0);
  }
  const deliveryId=randomUUID();this.state.db.prepare('INSERT INTO replay VALUES(?,?,?,?,?,?,?)').run(pin.localIdentity,pin.peerIdentity,h.messageId,digest,h.contextId,h.taskId,now);
  this.state.db.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?)').run(deliveryId,pin.localIdentity,pin.peerIdentity,h.messageId,canonicalJSON(envelope),'pending',now);
  this.state.db.prepare('INSERT INTO delivery_provenance VALUES(?,?,?,?,?,?)').run(deliveryId,pin.peer,pin.digest,pin.record.version,pin.localId,digest);
  return {deliveryId,duplicate:false};
 }
 #recordAssignment(pin,requestMessageId,verified,protocol){
  const prior=this.state.db.prepare("SELECT receipt FROM assignments WHERE local_identity=? AND peer_identity=? AND request_message_id=? AND direction='outbound'").get(pin.localIdentity,pin.peerIdentity,requestMessageId);
  if(prior){if(prior.receipt!==canonicalJSON(verified))fail('assignment_conflict');}
  else{
   if(this.state.db.prepare("SELECT request_message_id FROM assignments WHERE local_identity=? AND peer_identity=? AND task_id=? AND direction='outbound'").get(pin.localIdentity,pin.peerIdentity,verified.taskId))fail('assignment_conflict');
   this.state.db.prepare('INSERT INTO assignments VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(pin.localIdentity,pin.peerIdentity,requestMessageId,'outbound',verified.ackId,pin.peer,verified.contextId,verified.requestDigest,verified.taskId,canonicalJSON(verified),protocol,pin.digest,pin.localId,'received');
  }
  this.state.db.prepare("UPDATE outbound SET state='peer-assigned' WHERE local_identity=? AND peer_identity=? AND message_id=?").run(pin.localIdentity,pin.peerIdentity,requestMessageId);return prior;
 }
 async acceptAssignment({localId,peer,requestMessageId,receipt,responseEnvelope=null,enqueueResponse=true,observedTaskId,observedContextId,responseKind,protocol,activatedExtension,pairingIdentity,pairingVerified=false,allowOsConsent=false,now=Date.now()}={}){
  if(typeof enqueueResponse!=='boolean')fail('response_mode_invalid');
  receipt=validateAssignmentStructure(receipt);responseEnvelope=responseEnvelope===null?null:validateEnvelopeStructure(responseEnvelope);
  if(responseKind!=='task'||activatedExtension!==EXTENSION||!id(observedTaskId)||receipt.contextId!==observedContextId)fail('task_response_required');
  const attestation={pairingIdentity,pairingVerified},pin=this.resolve(localId,peer,attestation),outbound=this.outboundRow(pin,requestMessageId);
  if(outbound.task_id!==null||outbound.state==='prepared'||protocol!==outbound.protocol)fail('initial_assignment_inputs');
  const request=validateEnvelopeStructure(outbound.envelope);if(await envelopeDigest(request)!==outbound.digest)fail('ledger_corrupt');
  const verified=await verifyAssignment({receipt,requestEnvelope:request,senderBundle:pin.bundle,recipientBundle:pin.remote,responseEnvelope,expectedTaskId:observedTaskId,now});
  let responseContent,digest;
  if(responseEnvelope!==null){await verifyEnvelopeSignature({envelope:responseEnvelope,sender:pin.remote,recipient:pin.bundle,now});if(enqueueResponse){const identity=await this.state.loadIdentity(localId,{allowOsConsent});responseContent=(await openAssignedResponse({receipt:verified,requestEnvelope:request,responseEnvelope,identity,recipientBundle:pin.remote,now})).content;digest=await envelopeDigest(responseEnvelope);}}
  return this.state.locked(async()=>{
   this.assertPin(pin,attestation);const current=this.outboundRow(pin,requestMessageId);if(current.state==='prepared'||current.digest!==outbound.digest||current.envelope!==outbound.envelope)fail('ledger_corrupt');
   const prior=this.#recordAssignment(pin,requestMessageId,verified,protocol);
   const delivery=responseContent?this.#queueVerifiedResponse(pin,responseEnvelope,responseContent,digest,now):null;
   return {ok:true,taskId:verified.taskId,contextId:verified.contextId,assignmentAuthenticated:true,responseHeld:responseEnvelope!==null&&!enqueueResponse,duplicate:!!prior,...(delivery||{}),next:'Task assignment is peer-signed and locally pinned. Any response is durably queued, not yet consumed by the local model.'};
  });
 }
 async acceptResponse({localId,peer,envelope,observedTaskId,observedContextId,responseKind,activatedExtension,pairingIdentity,pairingVerified=false,allowOsConsent=false,now=Date.now()}={}){
  envelope=validateEnvelopeStructure(envelope);const h=envelope.header;
  if(responseKind!=='task'||activatedExtension!==EXTENSION||h.taskId!==observedTaskId||h.contextId!==observedContextId||h.role!=='agent')fail('task_response_required');
  const attestation={pairingIdentity,pairingVerified},pin=this.resolve(localId,peer,attestation);
  const assignment=this.state.db.prepare("SELECT trust_digest FROM assignments WHERE local_identity=? AND peer_identity=? AND context=? AND task_id=? AND direction='outbound'").get(pin.localIdentity,pin.peerIdentity,h.contextId,h.taskId);if(!assignment||assignment.trust_digest!==pin.digest)fail('assignment_required');
  await verifyEnvelopeSignature({envelope,sender:pin.remote,recipient:pin.bundle,now});const identity=await this.state.loadIdentity(localId,{allowOsConsent});
  const content=validateContent(await open({envelope,identity,sender:pin.remote,recipient:pin.bundle,expected:binding(h),now}),h),digest=await envelopeDigest(envelope);
  return this.state.locked(async()=>{this.assertPin(pin,attestation);return {ok:true,...this.#queueVerifiedResponse(pin,envelope,content,digest,now),next:'Authenticated response queued under its existing assignment; local model consumption remains separate.'};});
 }

 async #verifyRetainedTaskAssignment(pin,outbound,existing,request,task,protocol,now){
  // Closed local-cache path only. Never use this to admit a new request, assignment or incoming envelope.
  const {assignment}=this.#answeredUserRequest(pin,outbound.digest,task.contextId,task.taskId);
  if(existing.receipt!==assignment.receipt||existing.protocol!==protocol||existing.trust_digest!==pin.digest||existing.request_digest!==outbound.digest||existing.local_key_id!==pin.localId)fail('assignment_conflict');
  const receipt=validateAssignmentStructure(existing.receipt),identity=b=>({cardUrl:b.cardUrl,identityKey:b.identityKey,keyId:b.keyId});
  if(receipt.requestDigest!==outbound.digest||receipt.requestMessageId!==outbound.message_id||receipt.contextId!==outbound.context||receipt.taskId!==existing.task_id||receipt.ackId!==existing.ack_id||canonicalJSON(receipt.from)!==canonicalJSON(identity(pin.remote))||canonicalJSON(receipt.to)!==canonicalJSON(identity(pin.bundle)))fail('assignment_conflict');
  await verifyBundle(pin.bundle,{cardUrl:pin.bundle.cardUrl,identityKey:pin.bundle.identityKey,now});await verifyBundle(pin.remote,{cardUrl:pin.remote.cardUrl,identityKey:pin.remote.identityKey,now});
  for(const [value,key,domain] of [[request,pin.bundle.identityKey,'a2a-exposed sealed envelope v1\n'],[receipt,pin.remote.identityKey,'a2a-exposed sealed assignment v1\n']]){
   const {signature,...body}=value,publicKey=await crypto.subtle.importKey('raw',Buffer.from(key,'base64url'),'Ed25519',false,['verify']);
   if(!await crypto.subtle.verify('Ed25519',publicKey,Buffer.from(signature,'base64url'),new TextEncoder().encode(domain+canonicalJSON(body))))fail('verification_failed');
  }
  return receipt;
 }
 async acceptTask({localId,peer,requestMessageId,rawTask,protocol,activatedExtension,pairingIdentity,pairingVerified=false,allowOsConsent=false,authorizationGuard,withAuthorizationLease,now=Date.now()}={}){
  if((authorizationGuard!==undefined||withAuthorizationLease!==undefined)&&(typeof authorizationGuard!=='function'||typeof withAuthorizationLease!=='function'))fail('authorization_guard_invalid');
  const task=readTaskCarrier(rawTask,protocol);if(activatedExtension!==EXTENSION)fail('extension_not_activated');
  const attestation={pairingIdentity,pairingVerified},pin=this.resolve(localId,peer,attestation),outbound=this.outboundRow(pin,requestMessageId),request=validateEnvelopeStructure(outbound.envelope);
  if(outbound.reference_digest!==null||outbound.task_id!==null||outbound.context!==task.contextId||outbound.protocol!==protocol||!['transmitting','unknown','rejected','transport-accepted','peer-assigned'].includes(outbound.state)||request.header.role!=='user'||request.header.kind!=='message'||request.header.taskId!==null||request.header.messageId!==requestMessageId||request.header.contextId!==task.contextId||await envelopeDigest(request)!==outbound.digest)fail('request_binding_mismatch');
  const events=[...task.history,...(task.status?[task.status]:[])],control=events.find(item=>item.receipt),existing=this.state.db.prepare("SELECT * FROM assignments WHERE local_identity=? AND peer_identity=? AND request_message_id=? AND direction='outbound'").get(pin.localIdentity,pin.peerIdentity,requestMessageId);
  let receipt;
  if(existing){
   if(control&&canonicalJSON(control.receipt)!==existing.receipt)fail('assignment_conflict');
   receipt=await this.#verifyRetainedTaskAssignment(pin,outbound,existing,request,task,protocol,now);
  }else{
   await verifyEnvelopeSignature({envelope:request,sender:pin.bundle,recipient:pin.remote,now});
   if(!control)fail('assignment_required');receipt=await verifyAssignment({receipt:control.receipt,requestEnvelope:request,senderBundle:pin.bundle,recipientBundle:pin.remote,responseEnvelope:control.envelope,expectedTaskId:task.taskId,now});
  }
  if(receipt.requestDigest!==outbound.digest||receipt.requestMessageId!==requestMessageId||receipt.contextId!==task.contextId||receipt.taskId!==task.taskId)fail('assignment_conflict');
  if(existing&&(existing.trust_digest!==pin.digest||existing.protocol!==protocol||existing.receipt!==canonicalJSON(receipt)))fail('assignment_conflict');
  const candidates=new Map();
  for(const item of events){if(!item.envelope)continue;const envelope=item.envelope,h=envelope.header,digest=await envelopeDigest(envelope);
   if(h.role==='user'){
    const cached=this.outboundRow(pin,h.messageId);
    if(cached.reference_digest!==null||cached.context!==task.contextId||cached.protocol!==protocol||!['transmitting','unknown','rejected','transport-accepted','peer-assigned'].includes(cached.state)||cached.digest!==digest||cached.envelope!==canonicalJSON(envelope)||(h.taskId===null?h.messageId!==requestMessageId:h.taskId!==task.taskId))fail('request_binding_mismatch');
   }else{await verifyEnvelopeSignature({envelope,sender:pin.remote,recipient:pin.bundle,now});candidates.set(digest,{envelope,digest});}
  }
  // Authenticate all public signatures/receipt before any credential read or ledger mutation.
  const verified=[];
  if(candidates.size){const identity=await this.state.loadIdentity(localId,{allowOsConsent});for(const candidate of candidates.values()){
   const content=validateContent(await open({envelope:candidate.envelope,identity,sender:pin.remote,recipient:pin.bundle,expected:binding(candidate.envelope.header),now}),candidate.envelope.header,{expectedRequestDigest:receipt.responseDigest===candidate.digest?receipt.requestDigest:undefined});verified.push({...candidate,content});
  }}
  // Only decrypted, commitment-checked revision numbers order snapshots. Server array order/timestamps are ignored.
  verified.sort((a,b)=>(a.content.kind==='snapshot'?1:0)-(b.content.kind==='snapshot'?1:0)||(a.content.kind==='snapshot'?a.content.revision-b.content.revision:0));
  return this.state.locked(async()=>{
   this.assertPin(pin,attestation);const current=this.outboundRow(pin,requestMessageId);if(!['transmitting','unknown','rejected','transport-accepted','peer-assigned'].includes(current.state)||current.reference_digest!==null||current.task_id!==null||current.protocol!==protocol||current.digest!==outbound.digest||current.envelope!==outbound.envelope)fail('request_binding_mismatch');
   this.#recordAssignment(pin,requestMessageId,receipt,protocol);
   const knownHead=this.state.db.prepare('SELECT terminal FROM chains WHERE local_identity=? AND peer_identity=? AND context=? AND task_id=? AND author_identity=?').get(pin.localIdentity,pin.peerIdentity,task.contextId,task.taskId,pin.peerIdentity);
   if(knownHead?.terminal||verified.some(item=>item.content.kind==='snapshot'&&item.content.terminal)){
    for(const item of verified)if(item.content.kind==='message'&&!this.state.db.prepare('SELECT digest FROM replay WHERE local_id=? AND sender=? AND message_id=?').get(pin.localIdentity,pin.peerIdentity,item.envelope.header.messageId))fail('task_terminal','Unsequenced agent messages cannot be placed before or after the known/incoming terminal snapshot. Use signed snapshot content; archive opening is not enabled. No new delivery was committed.');
   }
   const deliveries=verified.map(item=>this.#queueVerifiedResponse(pin,item.envelope,item.content,item.digest,now));
   const head=this.state.db.prepare('SELECT revision,digest,state,terminal FROM chains WHERE local_identity=? AND peer_identity=? AND context=? AND task_id=? AND author_identity=?').get(pin.localIdentity,pin.peerIdentity,task.contextId,task.taskId,pin.peerIdentity);
   return {ok:true,taskId:task.taskId,contextId:task.contextId,assignmentAuthenticated:true,deliveries,currentPeerState:head?{revision:head.revision,digest:head.digest,state:head.state,terminal:head.terminal===1}:null,transportRoutingState:task.routingState,transportStateAuthenticated:false,next:'Only signed contiguous snapshots establish peer state. Content remains durably queued and untrusted until explicit local read/consumption; no network request or model callback was made.'};
  },{authorizationGuard,withAuthorizationLease});
 }

 listDeliveries({limit=20,cursor=0}={}){
  page(limit,cursor);this.state.ready();if(this.state.db.prepare('SELECT d.id FROM deliveries d LEFT JOIN delivery_provenance p ON p.id=d.id WHERE p.id IS NULL LIMIT 1').get())fail('ledger_corrupt');const rows=this.state.db.prepare('SELECT d.rowid AS cursor,d.id,d.message_id,d.state,d.created_ms,p.peer FROM deliveries d JOIN delivery_provenance p ON p.id=d.id WHERE d.rowid>? ORDER BY d.rowid LIMIT ?').all(cursor,limit+1);
  return {ok:true,configIdentity:this.state.configId(),deliveries:rows.slice(0,limit).map(row=>({deliveryId:row.id,messageId:row.message_id,state:row.state,createdMs:row.created_ms,peer:row.peer})),nextCursor:rows.length>limit?rows[limit-1].cursor:null,next:'Use the same stable delivery ID for read/ack; repeated reads are at-least-once until explicit acknowledgment.'};
 }
 async readDelivery({deliveryId,pairingIdentity,pairingVerified=false,allowOsConsent=false,now=Date.now()}={}){
  this.state.ready();const row=this.state.db.prepare('SELECT d.*,p.peer,p.trust_digest,p.local_key_id,p.envelope_digest FROM deliveries d JOIN delivery_provenance p ON p.id=d.id WHERE d.id=?').get(deliveryId);
  if(!row)fail('delivery_unknown');if(row.state==='acknowledged')return {ok:true,deliveryId,alreadyAcknowledged:true,content:null};
  const attestation={pairingIdentity,pairingVerified},pin=this.resolve(row.local_key_id,row.peer,attestation);
  if(pin.digest!==row.trust_digest||pin.localIdentity!==row.local_id||pin.peerIdentity!==row.sender)fail('delivery_trust_changed');
  const envelope=validateEnvelopeStructure(row.envelope);if(await envelopeDigest(envelope)!==row.envelope_digest||envelope.header.messageId!==row.message_id)fail('ledger_corrupt');
  const identity=await this.state.loadIdentity(row.local_key_id,{allowOsConsent});
  const content=validateContent(await open({envelope,identity,sender:pin.remote,recipient:pin.bundle,expected:binding(envelope.header),now}),envelope.header);
  this.assertPin(pin,attestation);
  const latest=this.state.db.prepare('SELECT state FROM deliveries WHERE id=?').get(deliveryId);if(latest.state==='acknowledged')return {ok:true,deliveryId,alreadyAcknowledged:true,content:null};
  let assignment;
  if(envelope.header.role==='user'){
   if(envelope.header.taskId===null)assignment=this.state.db.prepare("SELECT task_id FROM assignments WHERE local_identity=? AND peer_identity=? AND request_message_id=? AND direction='inbound'").get(row.local_id,row.sender,row.message_id);
   else assignment=this.state.db.prepare("SELECT task_id FROM assignments WHERE local_identity=? AND peer_identity=? AND context=? AND task_id=? AND direction='inbound'").get(row.local_id,row.sender,envelope.header.contextId,envelope.header.taskId);
  }
  else{
   ({assignment}=this.#answeredUserRequest(pin,content.requestDigest,envelope.header.contextId,envelope.header.taskId));
   if(content.kind==='snapshot'){
    const head=this.state.db.prepare('SELECT digest FROM chains WHERE local_identity=? AND peer_identity=? AND context=? AND task_id=? AND author_identity=?').get(row.local_id,row.sender,envelope.header.contextId,envelope.header.taskId,row.sender);
    if(!head||head.digest!==row.envelope_digest)return {ok:true,deliveryId,historyOnly:true,content:null,next:'An older authenticated snapshot remains history-only; it cannot overwrite current task state or become new work.'};
   }
  }
  if(!assignment)fail('ledger_corrupt');
  return {ok:true,deliveryId,untrusted:true,verification:pin.record.verification,peer:pin.peer,content,contextId:envelope.header.contextId,taskId:assignment.task_id,deliveryStatus:'locally-opened',next:'Peer content remains untrusted. Acknowledge this stable ID only after local consumption; external effects are not exactly-once.'};
 }
 async acknowledgeDelivery({deliveryId,consumed=false}={}){
  if(consumed!==true)fail('delivery_ack_required','Only the trusted local consumer may acknowledge its stable delivery ID after consumption; peer data cannot acknowledge work.');
  return this.state.locked(async()=>{
   const row=this.state.db.prepare('SELECT state FROM deliveries WHERE id=?').get(deliveryId);if(!row)fail('delivery_unknown');
   if(row.state!=='pending'&&row.state!=='acknowledged')fail('ledger_corrupt');
   this.state.db.prepare("UPDATE deliveries SET state='acknowledged' WHERE id=? AND state='pending'").run(deliveryId);
   return {ok:true,deliveryId,alreadyAcknowledged:row.state==='acknowledged',deliveryStatus:'locally-acknowledged',next:'Only local consumption was recorded. No peer receipt or exactly-once external action is claimed.'};
  });
 }
 listPendingReceipts({limit=20,cursor=0}={}){
  page(limit,cursor);this.state.ready();const rows=this.state.db.prepare("SELECT rowid AS cursor,ack_id,peer,task_id,local_key_id FROM assignments WHERE direction='inbound' AND ack_state='pending' AND rowid>? ORDER BY rowid LIMIT ?").all(cursor,limit+1);
  return {ok:true,configIdentity:this.state.configId(),receipts:rows.slice(0,limit).map(row=>({ackId:row.ack_id,peer:row.peer,taskId:row.task_id,localId:row.local_key_id})),nextCursor:rows.length>limit?rows[limit-1].cursor:null,next:'Prepare the exact cached receipt under current pairing/trust before publishing; never re-sign another assignment.'};
 }
 prepareReceipt({localId,peer,ackId,pairingIdentity,pairingVerified=false}={}){
  const pin=this.resolve(localId,peer,{pairingIdentity,pairingVerified});
  const row=this.state.db.prepare("SELECT * FROM assignments WHERE local_identity=? AND peer_identity=? AND ack_id=? AND direction='inbound'").get(pin.localIdentity,pin.peerIdentity,ackId);
  if(!row)fail('assignment_unknown');if(row.trust_digest!==pin.digest||row.local_key_id!==localId)fail('delivery_trust_changed');
  const receipt=parseJSON(row.receipt);return {ok:true,ackId,taskId:row.task_id,protocol:row.protocol,carrier:makeReceiptCarrier(receipt,row.protocol),transportStatus:row.ack_state,next:'Publish this exact cached control receipt only. This API did not send it and does not claim peer receipt.'};
 }
 async markReceiptTransport({localId,peer,ackId,pairingIdentity,pairingVerified=false,transportAccepted=false}={}){
  if(transportAccepted!==true)fail('receipt_transport_unknown','Keep the cached receipt pending; an unknown transport result is not proof of publication.');
  const attestation={pairingIdentity,pairingVerified},pin=this.resolve(localId,peer,attestation);
  return this.state.locked(async()=>{
   this.assertPin(pin,attestation);const row=this.state.db.prepare("SELECT trust_digest FROM assignments WHERE local_identity=? AND peer_identity=? AND ack_id=? AND direction='inbound'").get(pin.localIdentity,pin.peerIdentity,ackId);
   if(!row||row.trust_digest!==pin.digest)fail('assignment_unknown');
   this.state.db.prepare("UPDATE assignments SET ack_state='transport-accepted' WHERE local_identity=? AND peer_identity=? AND ack_id=? AND direction='inbound'").run(pin.localIdentity,pin.peerIdentity,ackId);
   return {ok:true,ackId,deliveryStatus:'transport-accepted',next:'Transport acceptance is recorded; peer verification/model consumption is not attested.'};
  });
 }
}
for(const name of ['receiveInitial','receiveFollowup','prepareRequest','prepareResponse','beginTransmission','recordTransport','listOutbound','acceptAssignment','acceptResponse','acceptTask','listDeliveries','readDelivery','acknowledgeDelivery','listPendingReceipts','prepareReceipt','markReceiptTransport']){
 const action=DeliveryLedger.prototype[name],map=error=>{if(error instanceof LedgerError||error instanceof LocalStateError||error instanceof EncryptionError)return error;return new LedgerError('ledger_unavailable');};
 DeliveryLedger.prototype[name]=action.constructor.name==='AsyncFunction'?async function(...args){try{return await action.apply(this,args);}catch(error){throw map(error);}}:function(...args){try{return action.apply(this,args);}catch(error){throw map(error);}};
}
