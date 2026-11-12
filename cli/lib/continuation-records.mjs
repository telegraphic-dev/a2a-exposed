// Internal synchronous record codec only. No files, stores, approval adapters or grants.
import path from 'node:path';
import {createHmac,timingSafeEqual} from 'node:crypto';

export class ContinuationRecordError extends Error {
 constructor(code='continuation_record_invalid'){super(code);this.code=code;}
}
const fail=(code)=>{throw new ContinuationRecordError(code);};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ALIAS=/^[A-Za-z0-9_-]{1,80}$/,VARIABLE=/^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MEMBER=['grant_id','pairing_identity','alias','endpoint','credential_variable','credential_source','credential_mac','process_mac','trust_record_digest','trust_record_version','local_id','local_bundle_digest','peer_bundle_digest','policy','verification','pairing_provenance','pairing_decision_id'];
const PLAN=['config_identity','canonical_root','epoch','baseline_revision','target_revision','source_mac','set_id','plan_nonce','members','excluded_aliases'];
const clone=value=>{const text=canonical(value);if(Buffer.byteLength(text)>1024*1024)fail();return JSON.parse(text);};
// Match the SDK canonical byte contract without loading optional SDK dependencies.
function canonical(value,depth=0){
 if(depth>32)fail();
 if(value===null||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='string'){for(const c of value){const n=c.codePointAt(0);if(n>=0xd800&&n<=0xdfff)fail();}return JSON.stringify(value);}
 if(typeof value==='number'){if(!Number.isFinite(value))fail();return JSON.stringify(value);}
 if(Array.isArray(value)){
  if(Object.getPrototypeOf(value)!==Array.prototype||Reflect.ownKeys(value).length!==value.length+1)fail();
  const items=[];for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!Object.hasOwn(d,'value'))fail();items.push(canonical(d.value,depth+1));}return '['+items.join(',')+']';
 }
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Reflect.ownKeys(value).length!==Object.keys(value).length)fail();
 return '{'+Object.keys(value).sort().map(k=>{const d=Object.getOwnPropertyDescriptor(value,k);if(!d||!Object.hasOwn(d,'value'))fail();return canonical(k)+':'+canonical(d.value,depth+1);}).join(',')+'}';
}
function exact(v,keys){if(!v||Array.isArray(v)||Object.keys(v).sort().join('\0')!==[...keys].sort().join('\0'))fail();}
function uuid(v){if(typeof v!=='string'||!UUID.test(v))fail();}
function digest(v){if(typeof v!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(v)||Buffer.from(v,'base64url').toString('base64url')!==v)fail();}
function integer(v){if(!Number.isSafeInteger(v)||v<0)fail();}
function ordered(values){if(!Array.isArray(values)||values.length>1000)fail();for(let i=0;i<values.length;i++)if(typeof values[i]!=='string'||i&&Buffer.compare(Buffer.from(values[i-1]),Buffer.from(values[i]))>=0)fail();}
function same(a,b){if(canonical(a)!==canonical(b))fail('continuation_record_mismatch');}
function bytes(v){
 if(!ArrayBuffer.isView(v)||![Buffer.prototype,Uint8Array.prototype].includes(Object.getPrototypeOf(v))||Reflect.ownKeys(v).length!==32)fail();
 const values=[];for(let i=0;i<32;i++){const d=Object.getOwnPropertyDescriptor(v,String(i));if(!d||!Object.hasOwn(d,'value')||!Number.isInteger(d.value)||d.value<0||d.value>255)fail();values.push(d.value);}return Buffer.from(values);
}
function member(m){
 exact(m,MEMBER);for(const k of ['grant_id','local_id','pairing_decision_id'])uuid(m[k]);for(const k of ['pairing_identity','credential_mac','trust_record_digest','local_bundle_digest','peer_bundle_digest'])digest(m[k]);integer(m.trust_record_version);
 if(typeof m.alias!=='string'||!ALIAS.test(m.alias)||typeof m.credential_variable!=='string'||!VARIABLE.test(m.credential_variable)||!['file','environment'].includes(m.credential_source)||m.policy!=='required'||m.verification!=='independent'||!['approved-connect','local-adoption'].includes(m.pairing_provenance))fail();
 if(m.credential_source==='file'){if(m.process_mac!==null)fail();}else digest(m.process_mac);
 if(typeof m.endpoint!=='string')fail();let url;try{url=new URL(m.endpoint);}catch{fail();}if(url.href!==m.endpoint||url.protocol!=='https:'||url.username||url.password||url.search||url.hash)fail();
}
function packet(v){exact(v,['payload','process_mac','mac']);digest(v.process_mac);digest(v.mac);}

export function createContinuationRecords(keyBytes,processNonce,binding){
 const key=bytes(keyBytes),nonce=bytes(processNonce).toString('base64url'),b=clone(binding);
 exact(b,['root','config_identity','epoch','set_id']);for(const k of ['config_identity','epoch','set_id'])uuid(b[k]);if(typeof b.root!=='string'||!path.isAbsolute(b.root)||path.resolve(b.root)!==b.root||b.root.includes('\0'))fail();
 const B=[b.root,b.config_identity,b.epoch,b.set_id];
 const H=(domain,value)=>createHmac('sha256',key).update(domain+'\n'+canonical(value)).digest('base64url');
 const compareMac=(actual,expected)=>{digest(actual);if(!timingSafeEqual(Buffer.from(actual,'base64url'),Buffer.from(expected,'base64url')))fail('continuation_mac_mismatch');};
 const memberMac=m=>H('sealed continuation member v1',[B,m]);
 const processMac=m=>H('sealed continuation process v1',[B,m.grant_id,nonce]);
 function planPayload(p){
  exact(p,PLAN);same([p.canonical_root,p.config_identity,p.epoch,p.set_id],B);integer(p.baseline_revision);integer(p.target_revision);if(p.target_revision!==p.baseline_revision+1||p.baseline_revision===Number.MAX_SAFE_INTEGER)fail();digest(p.source_mac);digest(p.plan_nonce);
  if(!Array.isArray(p.members)||!p.members.length||p.members.length>1000)fail();p.members.forEach(member);ordered(p.members.map(m=>m.grant_id));ordered(p.excluded_aliases);p.excluded_aliases.forEach(a=>{if(!ALIAS.test(a))fail();});
  for(const field of ['alias','pairing_identity','credential_variable'])if(new Set(p.members.map(m=>m[field])).size!==p.members.length)fail();
  if(p.members.some(m=>p.excluded_aliases.includes(m.alias)))fail();
 }
 function planRecord(value){
  exact(value,['plan','membership_mac','plan_mac']);planPayload(value.plan);const Q=value.plan.members.map(m=>[m.grant_id,memberMac(m)]);
  compareMac(value.membership_mac,H('sealed continuation membership v1',[B,Q,value.plan.excluded_aliases]));compareMac(value.plan_mac,H('sealed continuation plan v1',[value.plan,value.membership_mac]));return Q;
 }
 function attestationRecord(value,plan){
  exact(value,['attestation','attestation_mac']);const a=value.attestation;exact(a,['id','config_identity','canonical_root','epoch','plan_mac','comparisons','decision_id','created_ms','expires_ms']);uuid(a.id);uuid(a.decision_id);same([a.canonical_root,a.config_identity,a.epoch],[b.root,b.config_identity,b.epoch]);same(a.plan_mac,plan.plan_mac);integer(a.created_ms);integer(a.expires_ms);if(a.expires_ms<=a.created_ms||a.expires_ms-a.created_ms>600000)fail();
  if(!Array.isArray(a.comparisons)||a.comparisons.length!==plan.plan.members.length)fail();a.comparisons.forEach((c,i)=>{exact(c,['grant_id','approved_proposal_digest','compared_safety_code_mac','current_trust_digest','current_trust_version']);const m=plan.plan.members[i];same(c.grant_id,m.grant_id);digest(c.approved_proposal_digest);digest(c.compared_safety_code_mac);same(c.current_trust_digest,m.trust_record_digest);same(c.current_trust_version,m.trust_record_version);});compareMac(value.attestation_mac,H('sealed continuation attestation v1',a));
 }
 function intentRecord(value){
  exact(value,['id','record','intent_mac','attestation']);uuid(value.id);const r=value.record;exact(r,['plan','membership_mac','plan_mac','attestation_id','attestation_mac']);const p={plan:r.plan,membership_mac:r.membership_mac,plan_mac:r.plan_mac};planRecord(p);attestationRecord(value.attestation,p);same(r.attestation_id,value.attestation.attestation.id);same(r.attestation_mac,value.attestation.attestation_mac);compareMac(value.intent_mac,H('sealed continuation intent v1',[value.id,r]));return p;
 }
 function abandonValue(intentId,m,source,value){
  if(value===null)return{state:'absent',value_mac:null};if(typeof value!=='string')fail();
  return{state:value===''?'empty':'nonempty',value_mac:H('sealed continuation abandon value v1',[b.root,b.config_identity,b.epoch,intentId,m.grant_id,source,m.credential_variable,value])};
 }
 function observations(value,intent){
  if(!value||typeof value!=='object'||Array.isArray(value))fail();const p=intent.record.plan;
  if(value.kind==='finalize'){
   exact(value,['kind','source_mac','current_member_macs']);same(value.source_mac,p.source_mac);same(value.current_member_macs,p.members.map(m=>[m.grant_id,memberMac(m)]));
   for(const m of p.members)if(m.credential_source==='environment')compareMac(m.process_mac,processMac(m));
   return;
  }
  if(value.kind!=='no-grant-abandon')fail();exact(value,['kind','source_mac','members']);digest(value.source_mac);if(!Array.isArray(value.members)||value.members.length!==p.members.length)fail();
  value.members.forEach((o,i)=>{
   exact(o,['grant_id','original_member_mac','process_status','current_process_mac','environment','file']);const m=p.members[i];same(o.grant_id,m.grant_id);compareMac(o.original_member_mac,memberMac(m));
   same(o.process_status,m.credential_source==='file'?'not-applicable':m.process_mac===processMac(m)?'same':'unavailable');
   compareMac(o.current_process_mac,H('sealed continuation abandon process v1',[b.root,b.config_identity,b.epoch,intent.id,nonce]));
   for(const source of ['environment','file']){const v=o[source];exact(v,['state','value_mac']);if(!['absent','empty','nonempty'].includes(v.state))fail();if(v.state==='absent'){if(v.value_mac!==null)fail();}else{digest(v.value_mac);const empty=abandonValue(intent.id,m,source,'').value_mac;if(v.state==='empty')compareMac(v.value_mac,empty);else if(v.value_mac===empty)fail();}}
  });
 }
 function reconciliationRecord(value,intent){
  packet(value);const x=value.payload;exact(x,['action','root','config_identity','epoch','authority_revision','intent_id','set_id','authority_checkpoint','intent_mac','authority_set_state','sdk_row','observations','attestation_mac','approval_nonce']);
  if(!['abandon','finish-abandon','finalize-exact-set'].includes(x.action))fail();same([x.root,x.config_identity,x.epoch,x.set_id],B);same(x.intent_id,intent.id);same(x.intent_mac,intent.intent_mac);same(x.attestation_mac,intent.record.attestation_mac);integer(x.authority_revision);same(x.authority_revision,intent.record.plan.target_revision);digest(x.approval_nonce);
  if(!['I','S','C','R'].includes(x.authority_checkpoint)||![null,'committed'].includes(x.authority_set_state))fail();
  same(x.authority_set_state,['C','R'].includes(x.authority_checkpoint)?'committed':null);
  if(x.sdk_row!==null){const s=x.sdk_row;exact(s,['config_id','intent_id','set_id','epoch','target_revision','membership_mac','state']);same([s.config_id,s.intent_id,s.set_id,s.epoch,s.target_revision,s.membership_mac],[b.config_identity,intent.id,b.set_id,b.epoch,x.authority_revision,intent.record.membership_mac]);if(!['staged','ready','void'].includes(s.state))fail();}
  const state=x.sdk_row?.state;
  if(x.action==='finish-abandon'){if(!['I','C'].includes(x.authority_checkpoint)||state!=='void')fail();}
  else if(x.action==='finalize-exact-set'){if(x.authority_checkpoint!=='R'||state!=='ready'||x.observations?.kind!=='finalize')fail();}
  else if(!(x.authority_checkpoint==='I'&&x.sdk_row===null||['S','C'].includes(x.authority_checkpoint)&&state==='staged'||x.authority_checkpoint==='R'&&state==='ready'))fail();
  if(x.action!=='finalize-exact-set'&&x.observations?.kind!=='no-grant-abandon')fail();observations(x.observations,intent);compareMac(value.process_mac,H('sealed continuation reconcile process v1',[B,intent.id,nonce]));compareMac(value.mac,H('sealed continuation reconcile v2',[x,value.process_mac]));
 }
 return{
  sourceMac(input){const s=clone(input);exact(s,['configEnv','peers']);for(const v of Object.values(s))if(v!==null&&typeof v!=='string')fail();return H('sealed continuation source v1',[b.root,b.config_identity,b.epoch,[['config.env',s.configEnv!==null,s.configEnv],['peers.json',s.peers!==null,s.peers]]]);},
  bindMember(input,token){const m=clone(input);exact(m,MEMBER.filter(k=>!['credential_mac','process_mac'].includes(k)));if(typeof token!=='string'||token==='')fail();canonical(token);m.credential_mac=H('sealed continuation credential v1',[B,m.grant_id,m.credential_variable,m.credential_source,token]);m.process_mac=m.credential_source==='environment'?processMac(m):null;member(m);return m;},
  bindPlan(input){const v=clone(input);exact(v,['baseline_revision','source_mac','plan_nonce','members','excluded_aliases']);const p={config_identity:b.config_identity,canonical_root:b.root,epoch:b.epoch,set_id:b.set_id,...v,target_revision:v.baseline_revision+1};planPayload(p);const Q=p.members.map(m=>[m.grant_id,memberMac(m)]),membership_mac=H('sealed continuation membership v1',[B,Q,p.excluded_aliases]);return{plan:p,membership_mac,plan_mac:H('sealed continuation plan v1',[p,membership_mac])};},
  // Privileged adapter supplies evidence; a MAC does not establish human comparison.
  bindAttestation(plan,input){plan=clone(plan);planRecord(plan);const v=clone(input);exact(v,['id','comparisons','decision_id','created_ms','expires_ms']);const a={id:v.id,config_identity:b.config_identity,canonical_root:b.root,epoch:b.epoch,plan_mac:plan.plan_mac,...v};
   if(!Array.isArray(a.comparisons))fail();a.comparisons=a.comparisons.map(c=>{exact(c,['grant_id','approved_proposal_digest','compared_safety_code','current_trust_digest','current_trust_version']);if(typeof c.compared_safety_code!=='string'||!/^\d{5}( \d{5}){11}$/.test(c.compared_safety_code))fail();const {compared_safety_code,...other}=c;return{...other,compared_safety_code_mac:H('sealed continuation comparison v1',[B,c.grant_id,c.approved_proposal_digest,compared_safety_code])};});
   const result={attestation:a,attestation_mac:H('sealed continuation attestation v1',a)};attestationRecord(result,plan);return result;},
  bindIntent(id,plan,attestation){uuid(id);plan=clone(plan);attestation=clone(attestation);planRecord(plan);attestationRecord(attestation,plan);const record={...plan,attestation_id:attestation.attestation.id,attestation_mac:attestation.attestation_mac},result={id,record,intent_mac:H('sealed continuation intent v1',[id,record]),attestation};intentRecord(result);return result;},
  authenticateIntent(value){value=clone(value);intentRecord(value);return value;},
  assertFresh(value,now){value=clone(value);intentRecord(value);integer(now);const a=value.attestation.attestation;if(now<a.created_ms||now>=a.expires_ms)fail('continuation_attestation_expired');return value;},
  observeAbandonment(value,input){value=clone(value);intentRecord(value);const v=clone(input);exact(v,['source_mac','environment','fileValues']);digest(v.source_mac);for(const obj of [v.environment,v.fileValues]){if(!obj||Array.isArray(obj)||typeof obj!=='object')fail();for(const val of Object.values(obj))if(typeof val!=='string')fail();}
   const result={kind:'no-grant-abandon',source_mac:v.source_mac,members:value.record.plan.members.map(m=>({grant_id:m.grant_id,original_member_mac:memberMac(m),process_status:m.credential_source==='file'?'not-applicable':m.process_mac===processMac(m)?'same':'unavailable',current_process_mac:H('sealed continuation abandon process v1',[b.root,b.config_identity,b.epoch,value.id,nonce]),environment:abandonValue(value.id,m,'environment',Object.hasOwn(v.environment,m.credential_variable)?v.environment[m.credential_variable]:null),file:abandonValue(value.id,m,'file',Object.hasOwn(v.fileValues,m.credential_variable)?v.fileValues[m.credential_variable]:null)}))};observations(result,value);return result;},
  bindReconciliation(value,input){value=clone(value);intentRecord(value);const x=clone(input),process_mac=H('sealed continuation reconcile process v1',[B,value.id,nonce]);const result={payload:x,process_mac,mac:H('sealed continuation reconcile v2',[x,process_mac])};reconciliationRecord(result,value);return result;},
  authenticateReconciliation(value,approval){value=clone(value);intentRecord(value);approval=clone(approval);reconciliationRecord(approval,value);return approval;},
  assertUnchanged(value,approval,current){value=clone(value);intentRecord(value);approval=clone(approval);current=clone(current);reconciliationRecord(approval,value);reconciliationRecord(current,value);same(approval,current);return true;}
 };
}
