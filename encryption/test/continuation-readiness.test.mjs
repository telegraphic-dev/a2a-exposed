import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {LocalState} from '../local-state.mjs';
import {generateIdentity,canonicalJSON} from '../index.mjs';
const hash=(label,x)=>createHash('sha256').update(label+'\n'+canonicalJSON(x)).digest('base64url');
const host={assertAuthority:()=>true,withAuthorityLease:async run=>run()}; // Synthetic host, not human approval.
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-readiness-')),s=new LocalState(dir,{create:true});t.after(()=>{s.close();fs.rmSync(dir,{recursive:true,force:true});});
 const local=await s.initialize({store:'file',cardUrl:'https://local.example.com/card'}),remote=await generateIdentity('https://peer.example.com/card');
 const p=await s.propose({peer:'peer',localId:local.id,bundle:remote.bundle,peerEndpoint:'https://peer.example.com/rpc',pairingIdentity:Buffer.alloc(32,7).toString('base64url'),expectedCurrent:'none',policy:'required',verification:'independent'});
 const approved=await s.approve({peer:'peer',digest:p.digest,expectedCurrent:'none',ownerApproved:true,independentVerified:true,verifiedProposalDigest:p.digest});
 const r=approved.record,m={alias:r.peer,endpoint:r.peerEndpoint,pairing_identity:r.pairingIdentity,trust_record_digest:approved.digest,trust_record_version:r.version,local_id:r.localId,local_bundle_digest:r.localBundleDigest,peer_bundle_digest:hash('a2a-exposed sealed bundle v1',r.bundle),policy:'required',verification:'independent'};
 return{dir,s,local,remote,p,m};
}
async function ready(s,m,fn){return s._withMaintenanceQueue(host,async q=>{q.begin();if(fn)return fn(q);assert.equal(await q.assertReadiness([m]),true);q.rollback();});}
function updateTrust(s,patch){const row=s.db.prepare('SELECT * FROM trust').get(),r={...JSON.parse(row.record),...patch};s.db.prepare('UPDATE trust SET record=?').run(JSON.stringify(r));return hash('a2a-exposed sealed trust record v1',r);}

test('exact independent required trust with usable file keys is read-only and never stages or admits',async t=>{
 const {s,m}=await fixture(t),before=s.db.prepare('SELECT * FROM trust').all();await ready(s,m);assert.deepEqual(s.db.prepare('SELECT * FROM trust').all(),before);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM host_grant_sets').get().n,0);
});
test('every expected trust binding is exact and unknown fields or duplicate aliases/identities refuse',async t=>{
 const {s,m}=await fixture(t);
 for(const patch of [{endpoint:'https://peer.example.com/other'},{pairing_identity:Buffer.alloc(32,8).toString('base64url')},{trust_record_digest:Buffer.alloc(32,8).toString('base64url')},{trust_record_version:2},{local_id:randomUUID()},{local_bundle_digest:Buffer.alloc(32,8).toString('base64url')},{peer_bundle_digest:Buffer.alloc(32,8).toString('base64url')}])await assert.rejects(ready(s,{...m,...patch}),{code:'host_readiness_changed'});
 for(const patch of [{policy:'off'},{verification:'tofu'},{extra:true},{trust_record_version:0},{endpoint:'https://peer.example.com/rpc#x'}])await assert.rejects(ready(s,{...m,...patch}),{code:'host_readiness_invalid'});
 await assert.rejects(ready(s,m,async q=>q.assertReadiness([m,m])),{code:'host_readiness_invalid'});
});
test('matching caller digest cannot override revoked, tofu or weakened policy records',async t=>{
 for(const patch of [{state:'revoked'},{state:'tofu-pinned',verification:'tofu'},{policy:'off'},{policy:'allow-server-readable'},{configIdentity:randomUUID()},{version:2}]){const {s,m}=await fixture(t);m.trust_record_digest=updateTrust(s,patch);await assert.rejects(ready(s,m),{code:'host_readiness_changed'});}
});
test('pending proposal and any unfinished key operation refuse without consuming decisions',async t=>{
 const {s,m,p}=await fixture(t);s.db.prepare("UPDATE proposals SET state='pending'").run();await assert.rejects(ready(s,m),{code:'host_readiness_pending'});s.db.prepare("UPDATE proposals SET state='approved'").run();
 for(const phase of ['prepared','writing','secret-written','uncertain','abandoned']){s.db.prepare('INSERT INTO key_operations VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),'rotate','{}','synthetic',phase,1,1,null,0);await assert.rejects(ready(s,m),{code:'host_readiness_pending'});s.db.prepare("DELETE FROM key_operations WHERE state!='committed'").run();}assert.equal(s.db.prepare('SELECT state FROM proposals WHERE digest=?').get(p.digest).state,'approved');
});
test('lost, changed, corrupt and retired private keys refuse; native stores never prompt',async t=>{
 for(const mode of ['lost','changed','corrupt','retired','native']){const {s,m,local}=await fixture(t),file=path.join(s.root,local.id+'.key');if(mode==='lost')fs.unlinkSync(file);if(mode==='changed')fs.writeFileSync(file,JSON.stringify({v:1,signing:'AA',encryption:'AA'}));if(mode==='corrupt')fs.writeFileSync(file,'private-canary-invalid');if(mode==='retired')s.db.prepare("UPDATE identities SET live_state='retired'").run();if(mode==='native')s.db.prepare("UPDATE identities SET store='keychain'").run();await assert.rejects(ready(s,m),e=>typeof e.code==='string'&&!e.message.includes('private-canary'));}
});
test('input is captured before host callbacks and getters are never evaluated',async t=>{
 const {s,m}=await fixture(t);let getter=false;const bad={...m};Object.defineProperty(bad,'alias',{enumerable:true,get(){getter=true;return'peer';}});await assert.rejects(ready(s,bad),{code:'host_readiness_invalid'});assert.equal(getter,false);
 await ready(s,m,async q=>{const values=[{...m}],pending=q.assertReadiness(values);values[0].endpoint='https://changed.example.com/';assert.equal(await pending,true);q.rollback();});
});
test('readiness rechecks the aggregate after provider awaits and before returning',async t=>{
 for(const mode of ['trust','proposal','key','archive','clock']){const {s,m}=await fixture(t),get=s.privateGet,clock=Date.now;s.privateGet=async function(...args){const result=await get.apply(this,args);if(mode==='trust')updateTrust(s,{policy:'off'});if(mode==='proposal')s.db.prepare("UPDATE proposals SET state='pending'").run();if(mode==='key')s.db.prepare("UPDATE identities SET live_state='retired'").run();if(mode==='archive')s.db.prepare("INSERT INTO meta VALUES('restore_paused','1')").run();if(mode==='clock'){const now=clock();Date.now=()=>now-10000;}return result;};try{await assert.rejects(ready(s,m));}finally{Date.now=clock;s.privateGet=get;}}
});
test('readiness requires the live SDK transaction and view, and rechecks archive hold',async t=>{
 const {s,m}=await fixture(t);let escaped;await s._withMaintenanceQueue(host,async q=>{escaped=q;await assert.rejects(q.assertReadiness([m]),{code:'maintenance_transaction_state'});});await assert.rejects(escaped.assertReadiness([m]),{code:'maintenance_queue_expired'});s.db.prepare("INSERT INTO meta VALUES('restore_paused','1')").run();await assert.rejects(ready(s,m),{code:'restore_archive_only'});
});

test('a forged bundle with a matching record digest still fails signature validation',async t=>{
 const {s,m}=await fixture(t),r=JSON.parse(s.db.prepare('SELECT record FROM trust').get().record);r.bundle.signature=Buffer.alloc(64,1).toString('base64url');s.db.prepare('UPDATE trust SET record=?').run(JSON.stringify(r));m.trust_record_digest=hash('a2a-exposed sealed trust record v1',r);m.peer_bundle_digest=hash('a2a-exposed sealed bundle v1',r.bundle);await assert.rejects(ready(s,m));
});
test('native readiness refuses before any credential provider call',async t=>{
 const {s,m}=await fixture(t);let calls=0;s.privateGet=async()=>{calls++;throw Error('must not probe');};s.db.prepare("UPDATE identities SET store='keychain'").run();await assert.rejects(ready(s,m),{code:'host_readiness_native_gated'});assert.equal(calls,0);
});
test('all members and earlier private files are rechecked after the last member await',async t=>{
 const {s,m,local}=await fixture(t),remote=await generateIdentity('https://other.example.com/card');
 const p=await s.propose({peer:'other',localId:local.id,bundle:remote.bundle,pairingIdentity:Buffer.alloc(32,9).toString('base64url'),expectedCurrent:'none',policy:'required',verification:'independent'}),a=await s.approve({peer:'other',digest:p.digest,expectedCurrent:'none',ownerApproved:true,independentVerified:true,verifiedProposalDigest:p.digest});
 const second={...m,alias:'other',endpoint:remote.bundle.cardUrl,pairing_identity:a.record.pairingIdentity,trust_record_digest:a.digest,peer_bundle_digest:hash('a2a-exposed sealed bundle v1',remote.bundle)},get=s.privateGet;let calls=0;
 s.privateGet=async function(...args){const result=await get.apply(this,args);if(++calls===2)fs.renameSync(path.join(s.root,local.id+'.key'),path.join(s.root,'synthetic-held.key'));return result;};
 await assert.rejects(ready(s,m,async q=>{await q.assertReadiness([m,second]);q.rollback();}));assert.equal(calls,2);
});
