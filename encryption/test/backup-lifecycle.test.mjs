import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {LocalState,restoreBackup} from '../local-state.mjs';
import {openBackup,sealBackup} from '../backup.mjs';
import {generateIdentity,seal,open} from '../index.mjs';
const passphrase=Buffer.from('synthetic backup lifecycle passphrase');
const remote=await generateIdentity('https://remote.example.com/card');
const binding={contextId:'archive-context',messageId:'archive-message',taskId:null,role:'user',state:null,kind:'message'};
function fixture(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-backup-lifecycle-'));const state=new LocalState(path.join(dir,'source'),{create:true,...options});
 t.after(()=>{state.close();fs.rmSync(dir,{recursive:true,force:true});});return {dir,state,backup:path.join(dir,'backup.json'),destination:path.join(dir,'restored')};
}
async function initialized(state){return state.initialize({store:'file',cardUrl:'https://local.example.com/card'});}
test('protected snapshot restores keys and trust/replay/outbox archives, with every write held',async t=>{
 const {dir,state,backup,destination}=fixture(t),created=await initialized(state),identity=await state.loadIdentity(created.id);
 const envelope=await seal({identity,recipient:remote.bundle,binding,content:{text:'synthetic-backup-private-content'}});
 const proposal=await state.propose({peer:'remote',localId:created.id,bundle:remote.bundle,pairingIdentity:remote.bundle.identityKey,expectedCurrent:'none',policy:'required',verification:'tofu'});
 await state.approve({peer:'remote',digest:proposal.digest,expectedCurrent:'none',ownerApproved:true});
 state.db.prepare('INSERT INTO replay VALUES(?,?,?,?,?,?,?)').run(created.id,remote.bundle.identityKey,'message-1','digest','context',null,Date.now());
 state.db.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?)').run('delivery-1',created.id,remote.bundle.identityKey,'message-1',JSON.stringify(envelope),'pending',Date.now());
 const originalConfig=state.configId(),original=JSON.parse(fs.readFileSync(path.join(dir,'source/encryption',created.id+'.key')));
 const result=await state.createBackup({destination:backup,passphrase});assert.equal(result.archived_credentials,1);assert.equal(fs.statSync(backup).mode&0o777,0o600);
 const ciphertext=fs.readFileSync(backup,'utf8');for(const secret of [original.signing,original.encryption,'synthetic-backup-private-content'])assert.ok(!ciphertext.includes(secret));
 const restored=await restoreBackup({source:backup,destination,passphrase,store:'file',acknowledgeReplayRollback:true});assert.equal(restored.archive_only,true);assert.notEqual(restored.config_identity,originalConfig);
 const archive=new LocalState(destination,{write:true});t.after(()=>archive.close());assert.equal(archive.status().archive_only,true);assert.equal(archive.inspect('remote').live_state,'archive-only');
 assert.equal(archive.db.prepare('SELECT COUNT(*) AS n FROM replay').get().n,1);assert.equal(archive.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n,1);
 const recovered=await archive.loadIdentity(created.id);assert.deepEqual(await open({envelope,identity:recovered,sender:identity.bundle,recipient:remote.bundle,expected:binding,purpose:'sender'}),{text:'synthetic-backup-private-content'});
 await assert.rejects(initialized(archive),{code:'restore_archive_only'});await assert.rejects(archive.approve({peer:'remote',digest:proposal.digest,expectedCurrent:'none',ownerApproved:true}),{code:'restore_archive_only'});
 await assert.rejects(archive.loadIdentity(created.id,{purpose:'send'}),{code:'traffic_disabled'});
 const again=path.join(dir,'second-backup.json');await archive.createBackup({destination:again,passphrase});const second=path.join(dir,'second-restore');await restoreBackup({source:again,destination:second,passphrase,store:'file',acknowledgeReplayRollback:true});
});
test('restore refuses wrong passphrase, missing ack, existing target and malformed snapshots before installing',async t=>{
 const {dir,state,backup,destination}=fixture(t);await initialized(state);await state.createBackup({destination:backup,passphrase});
 await assert.rejects(restoreBackup({source:backup,destination,passphrase,store:'file'}),{code:'restore_ack_required'});
 await assert.rejects(restoreBackup({source:backup,destination,passphrase:Buffer.from('different synthetic password'),store:'file',acknowledgeReplayRollback:true}),{code:'backup_unreadable'});assert.ok(!fs.existsSync(destination));
 await assert.rejects(restoreBackup({source:backup,destination,passphrase,store:'keychain',acknowledgeReplayRollback:true}),{code:'restore_store'});
 const encrypted=fs.readFileSync(backup,'utf8');
 for(const edit of [s=>s.rows.identities[0].id='../escape',s=>s.credentials[0].value='invalid-key',s=>s.rows.key_operations[0].public_json='{}',s=>s.rows.trust.push({unknown:'field'}),s=>s.extra='unexpected']){
  const snapshot=openBackup(encrypted,passphrase);edit(snapshot);const file=path.join(dir,'invalid-backup.json');fs.writeFileSync(file,sealBackup(snapshot,passphrase),{mode:0o600});
  await assert.rejects(restoreBackup({source:file,destination,passphrase,store:'file',acknowledgeReplayRollback:true}));assert.ok(!fs.existsSync(destination));
 }
 fs.mkdirSync(destination,{mode:0o700});const marker=path.join(destination,'keep');fs.writeFileSync(marker,'preserve');await assert.rejects(restoreBackup({source:backup,destination,passphrase,store:'file',acknowledgeReplayRollback:true}),{code:'restore_destination_exists'});assert.equal(fs.readFileSync(marker,'utf8'),'preserve');
});
test('backup refuses lost keys, pending writes, insecure source and output overwrite',async t=>{
 const {dir,state,backup,destination}=fixture(t);const created=await initialized(state);await state.createBackup({destination:backup,passphrase});const original=fs.readFileSync(backup);
 await assert.rejects(state.createBackup({destination:backup,passphrase}));assert.deepEqual(fs.readFileSync(backup),original);
 fs.chmodSync(backup,0o644);await assert.rejects(restoreBackup({source:backup,destination,passphrase,store:'file',acknowledgeReplayRollback:true}),{code:'key_store_permissions'});assert.ok(!fs.existsSync(destination));
 fs.rmSync(path.join(dir,'source/encryption',created.id+'.key'));const missing=path.join(dir,'missing.json');await assert.rejects(state.createBackup({destination:missing,passphrase}),{code:'key_lost'});assert.ok(!fs.existsSync(missing));
 state.db.prepare("UPDATE key_operations SET state='uncertain'").run();await assert.rejects(state.createBackup({destination:missing,passphrase}),{code:'backup_recovery_required'});assert.ok(!fs.existsSync(missing));
});
test('mock native credentials require explicit consent for backup, restore converts only to selected file store',async t=>{
 const values=new Map(),calls=[];const keyring=async input=>{calls.push(input.op);const key=input.namespace+input.account;if(input.op==='set'){values.set(key,input.value);return;}return values.get(key)??null;};
 const {state,backup,destination}=fixture(t,{keyring});await state.initialize({store:'keychain',allowOsConsent:true,cardUrl:'https://local.example.com/card'});
 const before=calls.length;await assert.rejects(state.createBackup({destination:backup,passphrase}),{code:'key_store_consent'});assert.equal(calls.length,before);assert.ok(!fs.existsSync(backup));
 await state.createBackup({destination:backup,passphrase,allowOsConsent:true});const count=calls.length;await restoreBackup({source:backup,destination,passphrase,store:'file',acknowledgeReplayRollback:true});assert.equal(calls.length,count);
 const archive=new LocalState(destination);t.after(()=>archive.close());assert.equal(archive.status().identities[0].key_store,'file');await archive.loadIdentity(archive.status().identities[0].id);
});

test('failed staged install preserves a protected archive-only store and never replaces a concurrent target',async t=>{
 const {state,backup,destination}=fixture(t);await initialized(state);await state.createBackup({destination:backup,passphrase});
 const rename=fs.renameSync;let injected=false;
 fs.renameSync=(from,to)=>{if(to===path.join(destination,'encryption')){injected=true;fs.mkdirSync(to,{mode:0o700});fs.writeFileSync(path.join(to,'keep'),'preserve',{mode:0o600});}return rename(from,to);};
 try{await assert.rejects(restoreBackup({source:backup,destination,passphrase,store:'file',acknowledgeReplayRollback:true}),{code:'restore_staging_incomplete'});}finally{fs.renameSync=rename;}
 assert.equal(injected,true);assert.equal(fs.readFileSync(path.join(destination,'encryption/keep'),'utf8'),'preserve');
 const stage=fs.readdirSync(destination).find(name=>name.startsWith('.restore-'));assert.ok(stage);
 const staged=new LocalState(path.join(destination,stage),{write:true});t.after(()=>staged.close());assert.equal(staged.status().archive_only,true);await assert.rejects(initialized(staged),{code:'restore_archive_only'});
 assert.equal(fs.statSync(path.join(destination,stage)).mode&0o777,0o700);
});
