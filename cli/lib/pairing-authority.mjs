// Internal optional-encryption authority store; no CLI command activates it yet.
// Only cooperating local host writers may call mutate. No grant/credential/approval is created here.
import {createContinuationSourceSnapshot,ContinuationSourceError} from './continuation-sources.mjs';
import fs from 'node:fs';import path from 'node:path';import{createHash,createHmac,randomBytes,timingSafeEqual,randomUUID}from'node:crypto';import{createRequire}from'node:module';
const require=createRequire(import.meta.url),UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export class PairingAuthorityError extends Error{constructor(code){super(code);this.code=code;this.next=code.startsWith('authority_recovery')?'Read planPairingAuthorityRecovery for this configuration, obtain human approval of that exact plan, and use its listed revision, intent, action and approval token. Quarantine never resumes grants.':code==='authority_reverification_required'?'Keep grant authorization suspended. Fresh saved-grant verification and explicit resume are not implemented; do not reset authority or resend.':'Preserve the original pairing/configuration and authority files. Inspect authority status and original encrypted message IDs; do not regenerate, resend or assume a failed operation rolled back.';}}
const fail=code=>{throw new PairingAuthorityError(code);};
const names=['config.env','peers.json'],activeLeases=new Map();
function check(file,directory=false){if(process.platform==='win32')fail('authority_platform_unverified');const s=fs.lstatSync(file);if(s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile())||s.uid!==process.getuid()||(s.mode&0o077))fail('authority_permissions');return s;}
function locations(configDir){const requested=path.resolve(configDir);check(requested,true);const root=fs.realpathSync(requested);return{requested,root,db:path.join(root,'pairing-authority.sqlite'),marker:path.join(root,'pairing-authority.json')};}
function read(file,limit=1024*1024){let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o077)||s.size>limit)fail('authority_permissions');const bytes=Buffer.alloc(limit+1);let total=0;for(;;){const n=fs.readSync(fd,bytes,total,bytes.length-total,null);if(n===0)break;total+=n;if(total>limit)fail('authority_permissions');}return bytes.subarray(0,total);}finally{if(fd!==undefined)fs.closeSync(fd);}}
function sources(root){const hash=createHash('sha256').update('a2a-exposed local pairing sources v1\n');for(const name of names){let bytes;try{check(path.join(root,name));bytes=read(path.join(root,name));}catch(error){if(error.code!=='ENOENT')throw error;}hash.update(name+'\n'+(bytes===undefined?'absent':bytes.length)+'\n');if(bytes){hash.update(bytes);bytes.fill(0);}}return hash.digest('base64url');}
function close(db){try{db?.close();}catch{fail('authority_unavailable');}}
function exists(file){try{fs.lstatSync(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
function marker(p){check(p.marker);let value;try{value=JSON.parse(read(p.marker,4096).toString('utf8'));}catch{fail('authority_marker_invalid');}if(!value||Object.keys(value).sort().join(',')!=='configIdentity,v'||value.v!==1||!UUID.test(value.configIdentity||''))fail('authority_marker_invalid');return value;}
function open(p,{readonly=false}={}){check(p.db);const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(p.db,{readOnly:readonly});try{db.exec('PRAGMA busy_timeout=50; PRAGMA trusted_schema=OFF;');if(db.prepare('PRAGMA user_version').get().user_version!==2||db.prepare("SELECT type FROM sqlite_schema WHERE name='authority'").get()?.type!=='table'||db.prepare('PRAGMA table_info(authority)').all().map(r=>r.name).join(',')!=='id,config_id,revision,source_hash,pending,suspended,recovery_key')fail('authority_schema');return db;}catch(error){db.close();throw error;}}
function row(db,configIdentity){const r=db.prepare('SELECT * FROM authority WHERE id=1').get();if(!r||db.prepare('SELECT COUNT(*) AS n FROM authority').get().n!==1||r.config_id!==configIdentity||!UUID.test(r.config_id)||!Number.isSafeInteger(r.revision)||r.revision<0||!(/^[A-Za-z0-9_-]{43}$/).test(r.source_hash)||r.pending!==null&&!UUID.test(r.pending)||![0,1].includes(r.suspended)||typeof r.recovery_key!=='string'||!(/^[A-Za-z0-9_-]{43}$/).test(r.recovery_key)||Buffer.from(r.recovery_key,'base64url').toString('base64url')!==r.recovery_key)fail('authority_state_invalid');return r;}
function matching(p,r,{allowSuspended=false}={}){if(r.pending!==null)fail('authority_write_pending');if(sources(p.root)!==r.source_hash)fail('authority_external_change');if(r.suspended&&!allowSuspended)fail('authority_reverification_required');}
function state(p,expected){if(!exists(p.db)&&!exists(p.marker))fail('authority_missing');if(!exists(p.db)||!exists(p.marker))fail('authority_initialization_incomplete');const m=marker(p);if(m.configIdentity!==expected)fail('authority_identity_mismatch');return m;}
function sameInstance(a,b){return a.dev===b.dev&&a.ino===b.ino;}
function captureAnchor(p,configIdentity){
 const root=check(p.root,true);state(p,configIdentity);
 const anchor={root:p.root,requested:p.requested,rootInstance:root,markerInstance:check(p.marker),dbInstance:check(p.db),configIdentity};
 assertAnchor(p,anchor);return anchor;
}
function assertAnchor(p,anchor){
 if(p.root!==anchor.root||!sameInstance(check(p.root,true),anchor.rootInstance)||fs.realpathSync(p.requested)!==anchor.root||fs.realpathSync(anchor.requested)!==anchor.root)fail('authority_changed');
 if(!sameInstance(check(p.marker),anchor.markerInstance)||!sameInstance(check(p.db),anchor.dbInstance)||marker(p).configIdentity!==anchor.configIdentity)fail('authority_changed');
 // Marker parsing is path I/O too: identities are checked again after it, root last.
 if(!sameInstance(check(p.marker),anchor.markerInstance)||!sameInstance(check(p.db),anchor.dbInstance)||fs.realpathSync(p.requested)!==anchor.root||fs.realpathSync(anchor.requested)!==anchor.root||!sameInstance(check(p.root,true),anchor.rootInstance))fail('authority_changed');
}
function partialAnchor(p,configIdentity){return{root:p.root,requested:p.requested,rootInstance:check(p.root,true),dbInstance:null,markerInstance:null,configIdentity};}
function assertPartial(p,anchor){
 const root=()=>{if(!sameInstance(check(p.root,true),anchor.rootInstance)||fs.realpathSync(p.requested)!==anchor.root)fail('authority_changed');};root();
 for(const [file,instance]of [[p.db,anchor.dbInstance],[p.marker,anchor.markerInstance]]){if(instance===null){if(exists(file))fail('authority_changed');}else if(!sameInstance(check(file),instance))fail('authority_changed');}
 root();
}
function createPrivate(file,value=''){
 let fd;try{fd=fs.openSync(file,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK,0o600);const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o077))fail('authority_permissions');fs.writeFileSync(fd,value);fs.fsyncSync(fd);return s;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
function heldLease(p){return activeLeases.get(p.root)||[...activeLeases.values()].find(v=>v.anchor.requested===p.requested);}
function operationAnchor(p,configIdentity,write=false){
 const held=heldLease(p);if(!held)return captureAnchor(p,configIdentity);
 if(held.configIdentity!==configIdentity)fail('authority_identity_mismatch');assertAnchor(p,held.anchor);if(write)fail('authority_busy');return held.anchor;
}
function mapped(error){if(error instanceof PairingAuthorityError)return error;if(error?.code==='ERR_SQLITE_ERROR'&&/busy|locked/i.test(error.message||''))return new PairingAuthorityError('authority_busy');return new PairingAuthorityError('authority_unavailable');}
export function initializePairingAuthority(configDir,{configIdentity}={}){
 let db;
 try{
  if(typeof configIdentity!=='string'||!UUID.test(configIdentity))fail('authority_identity_required');const p=locations(configDir),held=heldLease(p);if(held){assertAnchor(p,held.anchor);fail('authority_already_exists');}
  const anchor=partialAnchor(p,configIdentity);if(exists(p.db)||exists(p.marker))fail('authority_already_exists');assertPartial(p,anchor);
  const fingerprint=sources(p.root);assertPartial(p,anchor);anchor.dbInstance=createPrivate(p.db);assertPartial(p,anchor);
  const {DatabaseSync}=require('node:sqlite');db=new DatabaseSync(p.db);assertPartial(p,anchor);db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');assertPartial(p,anchor);
  db.exec('CREATE TABLE authority(id INTEGER PRIMARY KEY CHECK(id=1),config_id TEXT NOT NULL,revision INTEGER NOT NULL,source_hash TEXT NOT NULL,pending TEXT,suspended INTEGER NOT NULL,recovery_key TEXT NOT NULL); PRAGMA user_version=2;');
  db.prepare('INSERT INTO authority VALUES(1,?,0,?,NULL,0,?)').run(configIdentity,fingerprint,randomBytes(32).toString('base64url'));assertPartial(p,anchor);db.exec('COMMIT');assertPartial(p,anchor);
  anchor.markerInstance=createPrivate(p.marker,JSON.stringify({v:1,configIdentity})+'\n');assertAnchor(p,anchor);if(sources(p.root)!==fingerprint)fail('authority_external_change');const final=row(db,configIdentity);if(final.revision!==0||final.pending!==null||final.suspended!==0||final.source_hash!==fingerprint)fail('authority_changed');assertAnchor(p,anchor);
  return{ok:true,configIdentity,revision:0};
 }catch(error){try{db?.exec('ROLLBACK');}catch{}throw mapped(error);}finally{close(db);}
}
export function inspectPairingAuthority(configDir){
 let db;
 try{
  if(!exists(path.resolve(configDir)))return{configured:false};const p=locations(configDir),held=heldLease(p);if(held)assertAnchor(p,held.anchor);
  const partial=partialAnchor(p),hasDB=exists(p.db),hasMarker=exists(p.marker);if(hasDB)partial.dbInstance=check(p.db);if(hasMarker)partial.markerInstance=check(p.marker);assertPartial(p,partial);
  if(!hasDB&&!hasMarker)return{configured:false};if(!hasDB||!hasMarker)return{configured:false,incomplete:true};
  const m=marker(p),anchor=held?.anchor||{...partial,configIdentity:m.configIdentity};if(m.configIdentity!==anchor.configIdentity)fail('authority_changed');assertAnchor(p,anchor);
  db=open(p,{readonly:true});assertAnchor(p,anchor);const r=row(db,m.configIdentity),sourceMismatch=sources(p.root)!==r.source_hash,after=row(db,m.configIdentity);if(JSON.stringify(r)!==JSON.stringify(after))fail('authority_changed');assertAnchor(p,anchor);
  return{configured:true,configIdentity:r.config_id,revision:r.revision,writePending:r.pending!==null,intentId:r.pending,sourceMismatch,suspended:r.suspended===1};
 }catch(error){throw mapped(error);}finally{close(db);}
}
export function readPairingAuthorityRevision(configDir,{configIdentity}={}){
 let db;
 try{const p=locations(configDir),anchor=operationAnchor(p,configIdentity);db=open(p,{readonly:true});assertAnchor(p,anchor);const before=row(db,configIdentity);matching(p,before);const after=row(db,configIdentity);if(before.revision!==after.revision||before.pending!==after.pending||before.source_hash!==after.source_hash)fail('authority_changed');assertAnchor(p,anchor);return before.revision;}catch(error){throw mapped(error);}finally{close(db);}
}
export async function withPairingAuthorityLease(configDir,{configIdentity}={},action){
 let db;
 try{if(typeof action!=='function')fail('authority_action_required');const p=locations(configDir),anchor=operationAnchor(p,configIdentity,true);db=open(p);db.exec('BEGIN IMMEDIATE');assertAnchor(p,anchor);const r=row(db,configIdentity);matching(p,r);assertAnchor(p,anchor);activeLeases.set(p.root,{db,configIdentity,anchor});try{const result=await action(r.revision);assertAnchor(p,anchor);matching(p,r);assertAnchor(p,anchor);return result;}finally{activeLeases.delete(p.root);}}catch(error){throw mapped(error);}finally{try{db?.exec('ROLLBACK');}catch{}close(db);}
}
export function mutatePairingAuthority(configDir,{configIdentity,expectedRevision}={},action){
 let db;
 try{
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)fail('authority_revision_required');if(typeof action!=='function')fail('authority_action_required');
  const p=locations(configDir),anchor=operationAnchor(p,configIdentity,true);db=open(p);db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');assertAnchor(p,anchor);
  const current=row(db,configIdentity);matching(p,current,{allowSuspended:true});assertAnchor(p,anchor);
  if(current.revision!==expectedRevision)fail('authority_revision_stale');if(current.revision===Number.MAX_SAFE_INTEGER)fail('authority_revision_exhausted');const intent=randomUUID(),revision=current.revision+1;
  // Durable barrier precedes any multi-file mutation. A crash between phases remains held.
  db.prepare('UPDATE authority SET revision=?,pending=? WHERE id=1').run(revision,intent);assertAnchor(p,anchor);db.exec('COMMIT');
  assertAnchor(p,anchor);db.exec('BEGIN IMMEDIATE');assertAnchor(p,anchor);const pending=row(db,configIdentity);
  if(pending.pending!==intent||pending.revision!==revision)fail('authority_changed');if(sources(p.root)!==current.source_hash)fail('authority_external_change');assertAnchor(p,anchor);
  const result=action();if(result&&typeof result.then==='function'){Promise.resolve(result).catch(()=>{});fail('authority_async_writer');}
  assertAnchor(p,anchor);const currentHash=sources(p.root);assertAnchor(p,anchor);
  db.prepare('UPDATE authority SET source_hash=?,pending=NULL WHERE id=1 AND pending=?').run(currentHash,intent);assertAnchor(p,anchor);db.exec('COMMIT');
  assertAnchor(p,anchor);if(sources(p.root)!==currentHash)fail('authority_external_change');assertAnchor(p,anchor);return{ok:true,revision};
 }catch(error){try{db?.exec('ROLLBACK');}catch{}throw mapped(error);}finally{close(db);}
}

function authoritySnapshot(configDir,{configIdentity}={},reader){
 let db,owned=false;
 try{if(typeof reader!=='function')fail('authority_action_required');const p=locations(configDir),held=heldLease(p);let anchor;
  if(held){if(held.configIdentity!==configIdentity)fail('authority_identity_mismatch');anchor=held.anchor;assertAnchor(p,anchor);db=held.db;}else{anchor=captureAnchor(p,configIdentity);db=open(p);owned=true;db.exec('BEGIN IMMEDIATE');assertAnchor(p,anchor);}
  const before=row(db,configIdentity);matching(p,before);assertAnchor(p,anchor);const value=reader(before,p);if(value&&typeof value.then==='function'){Promise.resolve(value).catch(()=>{});fail('authority_async_reader');}assertAnchor(p,anchor);matching(p,row(db,configIdentity));assertAnchor(p,anchor);return{revision:before.revision,value};
 }catch(error){throw mapped(error);}finally{if(owned){try{db?.exec('ROLLBACK');}catch{}close(db);}}
}


export function readPairingAuthoritySnapshot(configDir,options={},reader){
 if(typeof reader!=='function')fail('authority_action_required');
 return authoritySnapshot(configDir,options,before=>reader(before.revision));
}

// Privileged synchronous reader only. No command uses this path and suspension still refuses.
export function readContinuationSourceSnapshot(configDir,options={},reader){
 if(typeof reader!=='function')fail('authority_action_required');
 return authoritySnapshot(configDir,options,(before,p)=>{
  const buffers=new Map();let live=true;
  try{
   const hash=createHash('sha256').update('a2a-exposed local pairing sources v1\n');
   for(const name of names){let value=null;try{check(path.join(p.root,name));value=read(path.join(p.root,name));}catch(error){if(error.code!=='ENOENT')throw error;}buffers.set(name,value);hash.update(name+'\n'+(value===null?'absent':value.length)+'\n');if(value!==null)hash.update(value);}
   // Bind the ACTUAL parsed bytes, not just fingerprints observed before and after the callback.
   if(hash.digest('base64url')!==before.source_hash)fail('authority_external_change');
   let snapshot;try{snapshot=createContinuationSourceSnapshot({configEnv:buffers.get('config.env'),peers:buffers.get('peers.json')});}catch(error){if(error instanceof ContinuationSourceError)fail('authority_source_invalid');throw error;}
   const view=Object.freeze(Object.fromEntries(['sourceTexts','inspectInventory','select','abandonmentValues'].map(name=>[name,(...args)=>{if(!live)fail('authority_snapshot_expired');return snapshot[name](...args);}])));
   return reader(view,before.revision);
  }finally{live=false;for(const bytes of buffers.values())bytes?.fill(0);}
 });
}

const RECOVERY_ACTION='quarantine-current-files';
function recoveryToken(p,r,currentHash,anchor){return createHmac('sha256',Buffer.from(r.recovery_key,'base64url')).update('a2a-exposed authority recovery v2\n'+JSON.stringify([p.root,r.config_id,r.revision,r.pending,r.suspended,r.source_hash,currentHash,RECOVERY_ACTION,[anchor.rootInstance.dev,anchor.rootInstance.ino,anchor.markerInstance.dev,anchor.markerInstance.ino,anchor.dbInstance.dev,anchor.dbInstance.ino]])).digest('base64url');}
function needsRecovery(r,currentHash){return r.pending!==null||r.source_hash!==currentHash;}
export function planPairingAuthorityRecovery(configDir,{configIdentity}={}){
 let db;
 try{const p=locations(configDir),anchor=operationAnchor(p,configIdentity);db=open(p,{readonly:true});assertAnchor(p,anchor);const before=row(db,configIdentity),currentHash=sources(p.root),after=row(db,configIdentity);if(JSON.stringify(before)!==JSON.stringify(after))fail('authority_changed');assertAnchor(p,anchor);
  const reasons=[...(before.pending!==null?['pending-write']:[]),...(before.source_hash!==currentHash?['source-drift']:[])];
  const result={configIdentity,revision:before.revision,pendingIntent:before.pending,suspended:before.suspended===1,reasons,choices:needsRecovery(before,currentHash)?[{action:RECOVERY_ACTION,approvalToken:recoveryToken(p,before,currentHash,anchor),consequence:'files-retained-grants-suspended'}]:[]};assertAnchor(p,anchor);return result;
 }catch(error){throw mapped(error);}finally{close(db);}
}
export function quarantinePairingAuthority(configDir,{configIdentity,expectedRevision,expectedIntent,action,approvalToken,ownerApproved=false}={}){
 let db;
 try{
  if(ownerApproved!==true)fail('authority_recovery_approval_required');
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||action!==RECOVERY_ACTION||typeof approvalToken!=='string'||!(/^[A-Za-z0-9_-]{43}$/).test(approvalToken)||Buffer.from(approvalToken,'base64url').toString('base64url')!==approvalToken)fail('authority_recovery_inputs');
  const p=locations(configDir),anchor=operationAnchor(p,configIdentity,true);db=open(p);db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');assertAnchor(p,anchor);const before=row(db,configIdentity),currentHash=sources(p.root);assertAnchor(p,anchor);
  if(before.revision!==expectedRevision||before.pending!==expectedIntent||!needsRecovery(before,currentHash)||!timingSafeEqual(Buffer.from(approvalToken,'base64url'),Buffer.from(recoveryToken(p,before,currentHash,anchor),'base64url')))fail('authority_recovery_stale');
  if(before.revision===Number.MAX_SAFE_INTEGER)fail('authority_revision_exhausted');
  db.prepare('UPDATE authority SET revision=?,source_hash=?,pending=NULL,suspended=1 WHERE id=1').run(before.revision+1,currentHash);assertAnchor(p,anchor);db.exec('COMMIT');assertAnchor(p,anchor);if(sources(p.root)!==currentHash)fail('authority_external_change');assertAnchor(p,anchor);
  return{ok:true,configIdentity,revision:before.revision+1,suspended:true,files:'retained',next:'Grant authorization remains suspended. Repair/re-pair and independently review the exact saved grant before any future resume; no credential, key or message was regenerated or resent.'};
 }catch(error){try{db?.exec('ROLLBACK');}catch{}throw mapped(error);}finally{close(db);}
}
