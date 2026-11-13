// Internal optional-encryption authority store; no CLI command activates it yet.
// Only cooperating local host writers may call mutate. No grant/credential/approval is created here.
import {createContinuationSourceSnapshot,ContinuationSourceError} from './continuation-sources.mjs';
import {installContinuationTables,prepareContinuationIntent,readContinuationIntent,commitContinuationMembers} from './continuation-tables.mjs';
import {installContinuationProvenanceAuthority,assertContinuationProvenanceAuthorityInventory} from './continuation-provenance-authority.mjs';
import {createContinuationRecords} from './continuation-records.mjs';
import fs from 'node:fs';import path from 'node:path';import{createHash,createHmac,randomBytes,timingSafeEqual,randomUUID,createPublicKey,verify}from'node:crypto';import{createRequire}from'node:module';
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
function open(p,{readonly=false,schema=2}={}){check(p.db);const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(p.db,{readOnly:readonly});try{db.exec('PRAGMA busy_timeout=50; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;');if(db.prepare('PRAGMA user_version').get().user_version!==schema||db.prepare("SELECT type FROM sqlite_schema WHERE name='authority'").get()?.type!=='table'||db.prepare('PRAGMA table_info(authority)').all().map(r=>r.name).join(',')!==(schema===4?'id,config_id,canonical_root,revision,source_hash,pending,suspended,recovery_key,suspension_epoch,active_set,current_signer_id':'id,config_id,revision,source_hash,pending,suspended,recovery_key'+(schema===3?',suspension_epoch,active_set':'')))fail('authority_schema');return db;}catch(error){db.close();throw error;}}
function row(db,configIdentity,schema=2){if(schema===3)assertContinuationAuthorityInventory(db);const r=db.prepare('SELECT * FROM authority WHERE id=1').get();if(!r||db.prepare('SELECT COUNT(*) AS n FROM authority').get().n!==1||r.config_id!==configIdentity||!UUID.test(r.config_id)||!Number.isSafeInteger(r.revision)||r.revision<0||!(/^[A-Za-z0-9_-]{43}$/).test(r.source_hash)||r.pending!==null&&!UUID.test(r.pending)||![0,1].includes(r.suspended)||typeof r.recovery_key!=='string'||!(/^[A-Za-z0-9_-]{43}$/).test(r.recovery_key)||Buffer.from(r.recovery_key,'base64url').toString('base64url')!==r.recovery_key)fail('authority_state_invalid');if(schema===3)validateContinuationAuthorityRow(db,r);return r;}
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
function initializeAuthority(configDir,{configIdentity}={},schema=2){
 let db;
 try{
  if(typeof configIdentity!=='string'||!UUID.test(configIdentity))fail('authority_identity_required');const p=locations(configDir),held=heldLease(p);if(held){assertAnchor(p,held.anchor);fail('authority_already_exists');}
  const anchor=partialAnchor(p,configIdentity);if(exists(p.db)||exists(p.marker))fail('authority_already_exists');assertPartial(p,anchor);
  const fingerprint=sources(p.root);if(schema>=3)strictSourceSnapshot(p.root,fingerprint);assertPartial(p,anchor);anchor.dbInstance=createPrivate(p.db);assertPartial(p,anchor);
  const {DatabaseSync}=require('node:sqlite');db=new DatabaseSync(p.db);assertPartial(p,anchor);db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');assertPartial(p,anchor);
  if(schema>=3){db.exec('PRAGMA trusted_schema=OFF');if(schema===4)installContinuationProvenanceAuthority(db);else installContinuationAuthority(db);}else db.exec('CREATE TABLE authority(id INTEGER PRIMARY KEY CHECK(id=1),config_id TEXT NOT NULL,revision INTEGER NOT NULL,source_hash TEXT NOT NULL,pending TEXT,suspended INTEGER NOT NULL,recovery_key TEXT NOT NULL); PRAGMA user_version=2;');
  if(schema===4)db.prepare('INSERT INTO authority VALUES(1,?,?,0,?,NULL,1,?,?,NULL,NULL)').run(configIdentity,p.root,fingerprint,randomBytes(32).toString('base64url'),randomUUID());
  else if(schema===3)db.prepare('INSERT INTO authority VALUES(1,?,0,?,NULL,1,?,?,NULL)').run(configIdentity,fingerprint,randomBytes(32).toString('base64url'),randomUUID());
  else db.prepare('INSERT INTO authority VALUES(1,?,0,?,NULL,0,?)').run(configIdentity,fingerprint,randomBytes(32).toString('base64url'));const initialized=schema===4?freshProvenanceRow(db,p,configIdentity):null;assertPartial(p,anchor);db.exec('COMMIT');assertPartial(p,anchor);
  anchor.markerInstance=createPrivate(p.marker,JSON.stringify({v:1,configIdentity})+'\n');assertAnchor(p,anchor);if(sources(p.root)!==fingerprint)fail('authority_external_change');if(schema===4)db.exec('BEGIN');const final=schema===4?freshProvenanceRow(db,p,configIdentity):row(db,configIdentity,schema);if(schema===4&&JSON.stringify(final)!==JSON.stringify(initialized))fail('authority_changed');if(final.revision!==0||final.pending!==null||final.suspended!==(schema>=3?1:0)||final.source_hash!==fingerprint)fail('authority_changed');assertAnchor(p,anchor);
  if(schema===4){db.exec('ROLLBACK');assertAnchor(p,anchor);}
  return{ok:true,configIdentity,revision:0};
 }catch(error){try{db?.exec('ROLLBACK');}catch{}throw mapped(error);}finally{close(db);}
}
export function initializePairingAuthority(configDir,options={}){return initializeAuthority(configDir,options);}

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

// Fresh schema-3 foundation only. Schema-2 commands/writers deliberately refuse
// this store. No command calls these entry points; no eligibility transition exists.
const continuationProcessNonce=randomBytes(32);
const canonicalDigest=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v)&&Buffer.from(v,'base64url').toString('base64url')===v;
function installContinuationAuthority(db){
 installContinuationTables(db);
 const uuid=c=>`length(CAST(${c} AS BLOB))=36 AND ${c} NOT GLOB '*[^0-9a-f-]*' AND substr(${c},9,1)='-' AND substr(${c},14,1)='-' AND substr(${c},19,1)='-' AND substr(${c},24,1)='-' AND length(replace(${c},'-',''))=32 AND substr(${c},15,1)='4' AND substr(${c},20,1) IN ('8','9','a','b')`;
 const digest=c=>`length(CAST(${c} AS BLOB))=43 AND ${c} NOT GLOB '*[^A-Za-z0-9_-]*' AND substr(${c},43,1) IN ('A','E','I','M','Q','U','Y','c','g','k','o','s','w','0','4','8')`;
 db.exec(`CREATE TABLE authority(
 id INTEGER PRIMARY KEY CHECK(id=1),config_id TEXT NOT NULL CHECK(${uuid('config_id')}),
 revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),
 source_hash TEXT NOT NULL CHECK(${digest('source_hash')}),pending TEXT REFERENCES continuation_intents(id),
 suspended INTEGER NOT NULL CHECK(suspended IN (0,1)),recovery_key TEXT NOT NULL CHECK(${digest('recovery_key')}),
 suspension_epoch TEXT NOT NULL CHECK(${uuid('suspension_epoch')}),active_set TEXT REFERENCES grant_sets(id),
 CHECK((pending IS NULL OR suspended=1) AND (suspended=0 OR active_set IS NULL)),
 CHECK(suspended=1 OR active_set IS NOT NULL)
 ) STRICT;
 CREATE TRIGGER authority_initial BEFORE INSERT ON authority WHEN NEW.revision!=0 OR NEW.pending IS NOT NULL OR NEW.suspended!=1 OR NEW.active_set IS NOT NULL OR EXISTS(SELECT 1 FROM authority) BEGIN SELECT RAISE(ABORT,'authority initial state'); END;
 CREATE TRIGGER authority_retained BEFORE DELETE ON authority BEGIN SELECT RAISE(ABORT,'authority retained'); END;
 CREATE TRIGGER authority_identity BEFORE UPDATE ON authority WHEN NEW.id IS NOT OLD.id OR NEW.config_id IS NOT OLD.config_id OR NEW.recovery_key IS NOT OLD.recovery_key OR NEW.revision<OLD.revision BEGIN SELECT RAISE(ABORT,'authority immutable'); END;
 CREATE TRIGGER authority_pending BEFORE UPDATE ON authority WHEN NEW.pending IS NOT NULL AND NOT EXISTS(SELECT 1 FROM continuation_intents WHERE id=NEW.pending AND epoch=NEW.suspension_epoch AND target_revision=NEW.revision AND state IN ('prepared','set-committed')) BEGIN SELECT RAISE(ABORT,'authority pending binding'); END;
 CREATE TRIGGER authority_active BEFORE UPDATE ON authority WHEN NEW.active_set IS NOT NULL AND NOT EXISTS(SELECT 1 FROM grant_sets s JOIN continuation_intents i ON i.id=s.intent_id WHERE s.id=NEW.active_set AND s.epoch=NEW.suspension_epoch AND s.target_revision=NEW.revision AND s.state='eligible' AND i.state='eligible' AND NEW.pending IS NULL AND NEW.suspended=0) BEGIN SELECT RAISE(ABORT,'authority active binding'); END;
 PRAGMA user_version=3;`);
}
// Exact schema for this disabled physical foundation only. Build the reference
// independently in memory; candidate SQL is never executed or adopted. Row
// authentication and physical namespace anchoring remain separate requirements.
let continuationAuthorityInventory;
const continuationSchema=db=>JSON.stringify(db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all());
function assertContinuationAuthorityInventory(db){
 if(db.prepare('PRAGMA main.user_version').get().user_version!==3||db.prepare('PRAGMA foreign_keys').get().foreign_keys!==1||db.prepare('PRAGMA trusted_schema').get().trusted_schema!==0)fail('authority_schema');
 for(const pragma of ['ignore_check_constraints','writable_schema'])if(db.prepare(`PRAGMA ${pragma}`).get()[pragma]!==0)fail('authority_schema');
 if(db.prepare('SELECT COUNT(*) n FROM temp.sqlite_schema').get().n!==0||db.prepare('PRAGMA database_list').all().some(r=>!['main','temp'].includes(r.name)))fail('authority_schema');
 if(continuationAuthorityInventory===undefined){
  const {DatabaseSync}=require('node:sqlite'),reference=new DatabaseSync(':memory:');
  try{
   reference.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE');
   installContinuationAuthority(reference);continuationAuthorityInventory=continuationSchema(reference);
  }finally{reference.close();}
 }
 if(continuationSchema(db)!==continuationAuthorityInventory)fail('authority_schema');
}
function validateContinuationAuthorityRow(db,r){
 if(!UUID.test(r.suspension_epoch||'')||r.active_set!==null&&!UUID.test(r.active_set)||!canonicalDigest(r.source_hash)||r.suspended===1&&r.active_set!==null||r.suspended===0&&(r.active_set===null||r.pending!==null))fail('authority_state_invalid');
 const pending=db.prepare("SELECT * FROM continuation_intents WHERE state IN ('prepared','set-committed')").all();
 if(pending.length!==(r.pending===null?0:1)||r.pending!==null&&(pending[0].id!==r.pending||pending[0].epoch!==r.suspension_epoch||pending[0].target_revision!==r.revision||r.suspended!==1))fail('authority_state_invalid');
 if(r.active_set!==null){const set=db.prepare("SELECT s.id FROM grant_sets s JOIN continuation_intents i ON i.id=s.intent_id WHERE s.id=? AND s.epoch=? AND s.target_revision=? AND s.state='eligible' AND i.state='eligible'").get(r.active_set,r.suspension_epoch,r.revision);if(!set)fail('authority_state_invalid');}
}
function strictSourceSnapshot(root,expectedHash){
 const buffers=new Map();try{
  for(const name of names){let bytes=null;try{check(path.join(root,name));bytes=read(path.join(root,name));}catch(error){if(error.code!=='ENOENT')throw error;}buffers.set(name,bytes);}
  const hash=createHash('sha256').update('a2a-exposed local pairing sources v1\n');for(const name of names){const value=buffers.get(name);hash.update(name+'\n'+(value===null?'absent':value.length)+'\n');if(value!==null)hash.update(value);}if(hash.digest('base64url')!==expectedHash)fail('authority_external_change');
  return createContinuationSourceSnapshot({configEnv:buffers.get('config.env'),peers:buffers.get('peers.json')});
 }catch(error){if(error instanceof ContinuationSourceError)fail('authority_source_invalid');throw error;}finally{for(const bytes of buffers.values())bytes?.fill(0);}
}
// Verification-only draft profile. This code never creates a key or signs a
// decision. The protected trust root must be provisioned by the future trusted
// local human adapter, independently of model/peer-controlled request inputs.
function humanDecisionCheck(root,records,intent,signature){
 const file=path.join(root,'continuation-human-key.pem');
 if(typeof signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(signature)||Buffer.from(signature,'base64url').toString('base64url')!==signature)fail('authority_human_signature_required');
 const instance=check(file),bytes=read(file,4096),text=bytes.toString('utf8');let key;
 try{key=createPublicKey(text);}catch{fail('authority_human_key_invalid');}
 if(key.asymmetricKeyType!=='ed25519'||text!==key.export({type:'spki',format:'pem'}))fail('authority_human_key_invalid');
 const message=Buffer.from('a2a-exposed continuation human decision v1\n'+records.authorityRows(intent).attestation.record);
 if(!verify(null,message,key,Buffer.from(signature,'base64url')))fail('authority_human_signature_invalid');
 return()=>{if(!sameInstance(check(file),instance)||!read(file,4096).equals(bytes))fail('authority_human_key_changed');};
}
function continuationPublic(r){return Object.freeze({schema:3,configIdentity:r.config_id,revision:r.revision,epoch:r.suspension_epoch,activeSet:r.active_set,intentId:r.pending,suspended:r.suspended===1});}
// No migration/adoption/reset option. Existing schema-1/2 files stay byte-for-byte.
export function initializeContinuationAuthority(configDir,options={}){return initializeAuthority(configDir,options,3);}
export function inspectContinuationAuthority(configDir,{configIdentity}={}){
 let db;try{const p=locations(configDir),anchor=operationAnchor(p,configIdentity);db=open(p,{readonly:true,schema:3});db.exec('BEGIN');assertAnchor(p,anchor);const r=row(db,configIdentity,3),sourceMismatch=sources(p.root)!==r.source_hash;authenticateContinuationAuthority(db,r,p);assertAnchor(p,anchor);return{...continuationPublic(r),sourceMismatch};}catch(error){throw mapped(error);}finally{try{db?.exec('ROLLBACK');}catch{}close(db);}
}

// Disabled fresh-only physical schema-4 foundation. No CLI, writer, signer
// selection or grant path calls these APIs. Nonempty history always refuses;
// this diagnostic never authenticates retained provenance or authorizes a grant.
function freshProvenanceRow(db,p,configIdentity){
 assertContinuationProvenanceAuthorityInventory(db);
 const r=db.prepare('SELECT *,CAST(canonical_root AS BLOB) AS root_bytes FROM main.authority WHERE id=1').get();
 if(!r||db.prepare('SELECT COUNT(*) n FROM main.authority').get().n!==1)fail('authority_state_invalid');
 let root;try{root=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(r.root_bytes);}catch{fail('authority_state_invalid');}
 if(r.config_id!==configIdentity||!UUID.test(r.config_id)||root!==r.canonical_root||root!==p.root||r.revision!==0||!canonicalDigest(r.source_hash)||!canonicalDigest(r.recovery_key)||!UUID.test(r.suspension_epoch)||r.pending!==null||r.active_set!==null||r.current_signer_id!==null||r.suspended!==1)fail('authority_fresh_required');
 for(const table of ['continuation_attestations','continuation_intents','grant_sets','grant_members','continuation_signer_enrollments','continuation_enrollment_plans','continuation_decision_receipts'])if(db.prepare(`SELECT COUNT(*) n FROM main.${table}`).get().n!==0)fail('authority_fresh_required');
 return r;
}
export function initializeFreshContinuationProvenanceAuthority(configDir,options={}){return initializeAuthority(configDir,options,4);}
export function inspectFreshContinuationProvenanceAuthority(configDir,{configIdentity}={}){
 let db;
 try{
  const p=locations(configDir),anchor=operationAnchor(p,configIdentity);
  db=open(p,{readonly:true,schema:4});db.exec('BEGIN');assertAnchor(p,anchor);
  const before=freshProvenanceRow(db,p,configIdentity),sourceMismatch=sources(p.root)!==before.source_hash;
  const after=freshProvenanceRow(db,p,configIdentity);if(JSON.stringify(before)!==JSON.stringify(after))fail('authority_changed');assertAnchor(p,anchor);db.exec('ROLLBACK');assertAnchor(p,anchor);
  return Object.freeze({schema:4,configIdentity:before.config_id,revision:0,epoch:before.suspension_epoch,suspended:true,currentSigner:null,intentId:null,activeSet:null,sourceMismatch});
 }catch(error){throw mapped(error);}finally{try{db?.exec('ROLLBACK');}catch{}close(db);}
}

function authenticateContinuationAuthority(db,r,p){
 for(const [setId,intentId] of r.pending!==null?[[db.prepare('SELECT set_id FROM continuation_intents WHERE id=?').get(r.pending).set_id,r.pending]]:r.active_set!==null?[[r.active_set,db.prepare('SELECT intent_id FROM grant_sets WHERE id=?').get(r.active_set).intent_id]]:[]){const records=createContinuationRecords(Buffer.from(r.recovery_key,'base64url'),continuationProcessNonce,{root:p.root,config_identity:r.config_id,epoch:r.suspension_epoch,set_id:setId});readContinuationIntent(db,records,intentId);}
}
function own(value,key){const d=value&&Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,'value'))fail('authority_continuation_invalid');return d.value;}
// One physical connection, separate explicit FULL transactions. The private view
// is for the future coordinator; it does not expose raw SQL or an allowSuspended
// grant lease. Only nonauthorizing I/S/C/R checkpoints are implemented here.
export async function withContinuationAuthorityMaintenance(configDir,{configIdentity}={},action){
 let db,live=false,p,registered=false,current=null,attempted=null,preparedCheck=null;
 try{
  if(typeof action!=='function')fail('authority_action_required');p=locations(configDir);const anchor=operationAnchor(p,configIdentity,true);
  db=open(p,{schema:3});db.exec('PRAGMA synchronous=FULL');assertAnchor(p,anchor);live=true;
  activeLeases.set(p.root,{db,configIdentity,anchor});registered=true;
  function guard(transaction=true){
   if(!live)fail('authority_maintenance_expired');assertAnchor(p,anchor);
   if(transaction&&(!db.isTransaction||current===null))fail('authority_transaction_required');
   const r=row(db,configIdentity,3);if(current!==null&&JSON.stringify(r)!==JSON.stringify(current))fail('authority_changed');
   if(sources(p.root)!==r.source_hash)fail('authority_external_change');assertAnchor(p,anchor);return r;
  }
  function codec(setId){const r=guard();if(typeof setId!=='string'||!UUID.test(setId))fail('authority_continuation_invalid');return createContinuationRecords(Buffer.from(r.recovery_key,'base64url'),continuationProcessNonce,{root:p.root,config_identity:configIdentity,epoch:r.suspension_epoch,set_id:setId});}
  function sourceCheck(records,intent,before,environment,now){
   const capturedAt=Date.now(),plan=intent.record.plan;
   return()=>{const elapsed=Date.now()-capturedAt;if(elapsed<0)fail('authority_clock_regression');records.assertFresh(intent,now+elapsed);
    const source=strictSourceSnapshot(p.root,before.source_hash);if(records.sourceMac(source.sourceTexts())!==plan.source_mac)fail('authority_external_change');
    const selected=source.select({selected:plan.members.map(m=>m.alias).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))),excluded:plan.excluded_aliases},environment);
    for(const member of plan.members){const actual=selected.find(s=>s.alias===member.alias);const {credential_mac,process_mac,...unbound}=member,expected=records.bindMember({...unbound,credential_source:actual.credential_source},actual.token);if(new URL(actual.legacy_url).href!==member.endpoint||actual.credential_variable!==member.credential_variable||actual.credential_source!==member.credential_source||credential_mac!==expected.credential_mac||process_mac!==expected.process_mac)fail('authority_continuation_changed');}
    guard();};
  }
  const authenticated=r=>authenticateContinuationAuthority(db,r,p);
  const view=Object.freeze({
   begin(){guard(false);if(db.isTransaction)fail('authority_transaction_open');db.exec('BEGIN IMMEDIATE');current=null;try{current=row(db,configIdentity,3);guard();authenticated(current);}catch(error){try{db.exec('ROLLBACK');}catch{}current=null;throw error;}},
   commit(){guard();preparedCheck?.();authenticated(current);db.exec('COMMIT');current=null;preparedCheck=null;guard(false);},
   rollback(){if(!live)fail('authority_maintenance_expired');if(!db.isTransaction)fail('authority_transaction_required');db.exec('ROLLBACK');current=null;preparedCheck=null;guard(false);},
   transactionState(){if(!live)fail('authority_maintenance_expired');return db.isTransaction?'open':'idle';},
   snapshot(){const r=guard();authenticated(r);return continuationPublic(r);},
   readSources(reader){const r=guard();if(typeof reader!=='function')fail('authority_action_required');const source=strictSourceSnapshot(p.root,r.source_hash);let sourceLive=true;const scoped=Object.freeze(Object.fromEntries(['sourceTexts','inspectInventory','select','abandonmentValues'].map(name=>[name,(...args)=>{if(!sourceLive)fail('authority_snapshot_expired');guard();return source[name](...args);}])));try{const result=reader(scoped);if(result&&typeof result.then==='function'){Promise.resolve(result).catch(()=>{});fail('authority_async_reader');}guard();return result;}finally{sourceLive=false;}},
   // Internal codec output includes private MACs. A host's ability to MAC a
   // record is not human comparison evidence. All escaped methods expire.
   records(setId){const records=codec(setId);return Object.freeze(Object.fromEntries(Object.keys(records).map(name=>[name,(...args)=>{guard();return records[name](...args);}])));},
   prepareIntent(input,{environment=process.env,now=Date.now()}={}){
    const before=guard();if(before.pending!==null||before.active_set!==null||before.suspended!==1)fail('authority_write_pending');
    const setId=own(own(own(input,'record'),'plan'),'set_id'),records=codec(setId),intent=records.assertFresh(input,now),plan=intent.record.plan;
    if(plan.baseline_revision!==before.revision||plan.target_revision!==before.revision+1||before.revision===Number.MAX_SAFE_INTEGER)fail('authority_revision_stale');
    const checkPlan=sourceCheck(records,intent,before,environment,now);checkPlan();
    guard();attempted={intentId:intent.id,setId};db.exec('SAVEPOINT authority_prepare');try{
     prepareContinuationIntent(db,records,intent,now);
     const changed=db.prepare('UPDATE authority SET revision=?,pending=?,active_set=NULL,suspended=1 WHERE id=1 AND config_id=? AND revision=? AND pending IS NULL AND active_set IS NULL AND suspended=1 AND suspension_epoch=? AND source_hash=?').run(plan.target_revision,intent.id,configIdentity,before.revision,before.suspension_epoch,before.source_hash).changes;
     if(changed!==1)fail('authority_changed');current=row(db,configIdentity,3);guard();authenticated(current);db.exec('RELEASE authority_prepare');preparedCheck=checkPlan;return continuationPublic(current);
    }catch(error){try{db.exec('ROLLBACK TO authority_prepare; RELEASE authority_prepare');current=before;}catch{fail('authority_rollback_unknown');}throw error;}
   },
   // Draft privileged pre-I path. A signature is evidence from a separately
   // provisioned local signer, never proof of remote identity. No command or UI
   // provisions that signer/trust root; all traffic and eligibility remain off.
   async prepareVerifiedIntent(input,sdk,{signature,environment=process.env,now=Date.now()}={}){
    const before=guard();if(preparedCheck!==null||before.pending!==null||before.active_set!==null||before.suspended!==1)fail('authority_write_pending');
    const records=codec(own(own(own(input,'record'),'plan'),'set_id')),intent=records.assertFresh(input,now),plan=intent.record.plan;
    if(plan.baseline_revision!==before.revision||plan.target_revision!==before.revision+1)fail('authority_revision_stale');
    const checkHuman=humanDecisionCheck(p.root,records,intent,signature),checkPlan=sourceCheck(records,intent,before,environment,now);
    if(typeof sdk?._withMaintenanceQueue!=='function')fail('authority_sdk_required');
    const fields=['alias','endpoint','pairing_identity','trust_record_digest','trust_record_version','local_id','local_bundle_digest','peer_bundle_digest','policy','verification'];
    const members=plan.members.map(m=>Object.fromEntries(fields.map(k=>[k,m[k]])));let scope=true,committed=false,witness;
    const checkAll=()=>{checkHuman();checkPlan();};checkAll();attempted={intentId:intent.id,setId:plan.set_id};
    try{
     await sdk._withMaintenanceQueue({withAuthorityLease:async run=>{guard();return await run();},assertAuthority:stage=>{
      if(!scope)return false;
      if(committed){if(stage!=='exit'||db.isTransaction)return false;checkHuman();guard(false);return witness===JSON.stringify(row(db,configIdentity,3));}
      guard();checkAll();return true;
     }},async q=>{
      q.begin();if(q.configurationIdentity()!==configIdentity)fail('authority_sdk_config');
      if(q.inspectGrant(intent.id)!==null)fail('authority_stage_reconciliation_required');
      if(await q.assertReadiness(members)!==true)fail('authority_sdk_readiness');checkAll();
      const a=intent.attestation.attestation,comparisons=q.compareApproved(members,a.comparisons.map(c=>c.approved_proposal_digest)).map((c,n)=>({grant_id:plan.members[n].grant_id,...c}));
      const actual=records.bindAttestation({plan,membership_mac:intent.record.membership_mac,plan_mac:intent.record.plan_mac},{id:a.id,decision_id:a.decision_id,created_ms:a.created_ms,expires_ms:a.expires_ms,comparisons});
      if(actual.attestation_mac!==intent.record.attestation_mac)fail('authority_human_comparison_changed');
      checkAll();view.prepareIntent(intent,{environment,now});
      // Both reserved transactions remain held through the authority I COMMIT.
      // No SDK write is made; releasing readiness early is forbidden.
      preparedCheck=()=>{checkAll();if(q.transactionState()!=='open')fail('authority_sdk_readiness');};
      witness=JSON.stringify(row(db,configIdentity,3));view.commit();committed=true;q.rollback();
     });
     if(!committed)fail('authority_prepare_incomplete');return{...continuationPublic(guard(false)),checkpoint:'I'};
    }finally{scope=false;}
   },
   // Phase 2 starts only from a durable I. Own authority BEFORE acquiring the
   // SDK queue, commit S before C, and release the queue before reacquiring A.
   // This does not implement R/E, recovery, human approval or grant admission.
   async stageIntent(input,sdk,{environment=process.env,now=Date.now()}={}){
    const before=guard();if(preparedCheck!==null||before.pending===null||before.active_set!==null||before.suspended!==1)fail('authority_stage_state');
    const records=codec(own(own(own(input,'record'),'plan'),'set_id')),intent=records.assertFresh(input,now),plan=intent.record.plan;
    const stored=readContinuationIntent(db,records,intent.id);
    if(before.pending!==intent.id||before.revision!==plan.target_revision||stored.state!=='prepared'||stored.intent.intent_mac!==intent.intent_mac)fail('authority_stage_state');
    if(typeof sdk?._withMaintenanceQueue!=='function')fail('authority_sdk_required');
    const checkPlan=sourceCheck(records,intent,before,environment,now);checkPlan();attempted={intentId:intent.id,setId:plan.set_id};
    const binding={config_id:configIdentity,intent_id:intent.id,set_id:plan.set_id,epoch:plan.epoch,target_revision:plan.target_revision,membership_mac:intent.record.membership_mac};
    const fields=['alias','endpoint','pairing_identity','trust_record_digest','trust_record_version','local_id','local_bundle_digest','peer_bundle_digest','policy','verification'];
    const members=plan.members.map(m=>Object.fromEntries(fields.map(k=>[k,m[k]])));let committed=false,scope=true,witness;
    const exactC=()=>JSON.stringify([row(db,configIdentity,3),db.prepare('SELECT * FROM continuation_intents WHERE id=?').get(intent.id),db.prepare('SELECT * FROM grant_sets WHERE id=?').get(plan.set_id),db.prepare('SELECT * FROM grant_members WHERE set_id=? ORDER BY grant_id COLLATE BINARY').all(plan.set_id)]);
    try{
     await sdk._withMaintenanceQueue({withAuthorityLease:async run=>{guard();return await run();},assertAuthority:stage=>{
      if(!scope)return false;
      if(committed){if(stage!=='exit'||db.isTransaction)return false;guard(false);return witness===exactC();}
      guard();checkPlan();return true;
     }},async q=>{
      q.begin();if(q.inspectGrant(intent.id)!==null)fail('authority_stage_reconciliation_required');
      if(await q.assertReadiness(members)!==true)fail('authority_sdk_readiness');checkPlan();
      q.stageGrant(binding);q.commit(); // S is durable; a later failure retains it.
      checkPlan();commitContinuationMembers(db,records,intent);current=row(db,configIdentity,3);authenticated(current);
      preparedCheck=checkPlan;witness=exactC();view.commit();committed=true; // C, still suspended.
     });
     if(!committed)fail('authority_stage_incomplete');return{...continuationPublic(guard(false)),checkpoint:'C'};
    }finally{scope=false;}
   },
   // Suspended phase-3 groundwork only: C -> R with readiness rechecked in
   // a NEW reserved SDK transaction. E/admission is deliberately absent.
   async readyIntent(input,sdk,{environment=process.env,now=Date.now()}={}){
    const before=guard();if(preparedCheck!==null||before.pending===null||before.active_set!==null||before.suspended!==1)fail('authority_ready_state');
    const records=codec(own(own(own(input,'record'),'plan'),'set_id')),intent=records.assertFresh(input,now),plan=intent.record.plan;
    const stored=readContinuationIntent(db,records,intent.id);
    if(before.pending!==intent.id||before.revision!==plan.target_revision||stored.state!=='set-committed'||stored.intent.intent_mac!==intent.intent_mac)fail('authority_ready_state');
    if(typeof sdk?._withMaintenanceQueue!=='function')fail('authority_sdk_required');
    const checkPlan=sourceCheck(records,intent,before,environment,now);checkPlan();attempted={intentId:intent.id,setId:plan.set_id};
    const binding={config_id:configIdentity,intent_id:intent.id,set_id:plan.set_id,epoch:plan.epoch,target_revision:plan.target_revision,membership_mac:intent.record.membership_mac};
    const fields=['alias','endpoint','pairing_identity','trust_record_digest','trust_record_version','local_id','local_bundle_digest','peer_bundle_digest','policy','verification'];
    const members=plan.members.map(m=>Object.fromEntries(fields.map(k=>[k,m[k]])));
    const exactC=()=>JSON.stringify([row(db,configIdentity,3),db.prepare('SELECT * FROM continuation_intents WHERE id=?').get(intent.id),db.prepare('SELECT * FROM grant_sets WHERE id=?').get(plan.set_id),db.prepare('SELECT * FROM grant_members WHERE set_id=? ORDER BY grant_id COLLATE BINARY').all(plan.set_id)]);
    const witness=exactC();let finished=false,scope=true;
    const exactStage=(q,state)=>{const actual=q.inspectGrant(intent.id);if(!actual||actual.state!==state||Object.keys(actual).length!==Object.keys(binding).length+1||Object.keys(binding).some(k=>actual[k]!==binding[k]))fail('authority_ready_binding');};
    try{
     await sdk._withMaintenanceQueue({withAuthorityLease:async run=>{guard();return await run();},assertAuthority:stage=>{
      if(!scope)return false;
      if(finished){if(stage!=='exit'||db.isTransaction)return false;guard(false);return witness===exactC();}
      guard();checkPlan();authenticated(current);return witness===exactC();
     }},async q=>{
      q.begin();exactStage(q,'staged');
      if(await q.assertReadiness(members)!==true)fail('authority_sdk_readiness');checkPlan();
      q.transitionGrant(binding,'staged','ready');q.commit(); // R is durable, never E.
      q.begin(); // Fresh snapshot after the cross-process gap at R COMMIT.
      exactStage(q,'ready');if(await q.assertReadiness(members)!==true)fail('authority_sdk_readiness');
      checkPlan();authenticated(current);if(witness!==exactC())fail('authority_changed');
      // Keep the final SDK reserved transaction through the authority checks.
      // The future E CAS belongs here. For now authority stays unchanged at C.
      view.rollback();q.rollback();finished=true;
     });
     if(!finished)fail('authority_ready_incomplete');return{...continuationPublic(guard(false)),checkpoint:'R'};
    }finally{scope=false;}
   }
  });
  guard(false);const result=await action(view);if(db.isTransaction)fail('authority_transaction_open');guard(false);return result;
 }catch(error){const result=mapped(error);if(attempted)Object.assign(result,attempted,{checkpoint:'unknown'});throw result;}finally{
  live=false;let cleanupError;
  try{if(db?.isTransaction)db.exec('ROLLBACK');}catch{cleanupError=new PairingAuthorityError('authority_rollback_unknown');}
  if(registered)activeLeases.delete(p.root);
  try{close(db);}catch(error){cleanupError??=mapped(error);}
  // A cleanup failure may follow a durable checkpoint. It must not discard
  // its original IDs merely because it is thrown outside the action catch.
  if(cleanupError){if(attempted)Object.assign(cleanupError,attempted,{checkpoint:'unknown'});throw cleanupError;}
 }
}
