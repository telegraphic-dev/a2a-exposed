import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalState, stores, restoreBackup } from "../local-state.mjs";
import { generateIdentity, seal, open } from "../index.mjs";
const remote = await generateIdentity("https://remote.example.com/card");
const pairingIdentity = remote.bundle.identityKey;
function fixture(t) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-local-state-"));
 const state = new LocalState(dir, { create: true });
 t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); }); return { state, dir };
}
const recoveryDigest = (state,id,action) => state.status().operations.find(x=>x.id===id).recovery_choices.find(x=>x.action===action).approval_digest;
const init = state => state.initialize({ store: "file", cardUrl: "https://local.example.com/card" });

test("read-only discovery does not create state or private credentials", async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"a2a-key-list-")); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const state=new LocalState(dir); t.after(()=>state.close()); assert.equal(state.status().configured,false);
 assert.deepEqual(fs.readdirSync(dir),[]);
 const result=await stores(); assert.equal(result.stores[0].id,"file"); assert.equal(result.stores[0].unattended,true);
 assert.deepEqual(fs.readdirSync(dir),[]);
});

test("fresh local file keys survive restart and never appear in status or SQLite", async t => {
 const {state,dir}=fixture(t); const result=await init(state);
 assert.equal(result.key_store,"file");assert.equal(result.live_state,"local-only");
 const keyFile=path.join(dir,"encryption",result.id+".key");
 assert.equal(fs.statSync(keyFile).mode&0o777,0o600);assert.equal(fs.statSync(path.dirname(keyFile)).mode&0o777,0o700);
 const privateValue=JSON.parse(fs.readFileSync(keyFile));
 assert.ok(!JSON.stringify(state.status()).includes(privateValue.signing));
 assert.ok(!fs.readFileSync(path.join(dir,"encryption/state.sqlite")).includes(Buffer.from(privateValue.encryption)));
 state.close(); const reopened=new LocalState(dir);t.after(()=>reopened.close());
 assert.equal(reopened.status().identities[0].bundle.keyId,result.bundle.keyId);
 const identity=await reopened.loadIdentity(result.id);
 const binding={contextId:"context",messageId:"message",taskId:null,role:"user",state:null,kind:"message"};
 const envelope=await seal({identity,recipient:remote.bundle,binding,content:{parts:[{text:"restart-canary"}]}});
 assert.deepEqual(await open({envelope,identity:remote,sender:identity.bundle,recipient:remote.bundle,expected:binding}),{parts:[{text:"restart-canary"}]});
 await assert.rejects(reopened.loadIdentity(result.id,{purpose:"send"}),{code:"traffic_disabled"});
});

test("a private key that does not match its public identity refuses without replacement", async t => {
 const {state,dir}=fixture(t),other=fixture(t);const result=await init(state),foreign=await init(other.state);
 const keyFile=path.join(dir,"encryption",result.id+".key"),value=JSON.parse(fs.readFileSync(keyFile));
 const foreignSigning=JSON.parse(fs.readFileSync(path.join(other.dir,"encryption",foreign.id+".key"))).signing;
 const damaged=JSON.stringify({...value,signing:foreignSigning});fs.writeFileSync(keyFile,damaged);
 const files=fs.readdirSync(path.join(dir,"encryption")).filter(f=>f.endsWith(".key"));
 await assert.rejects(state.loadIdentity(result.id),error=>error.code==="key_mismatch"&&/does not match this identity's public key.*no key replacement/.test(error.next)&&!error.next.includes(foreignSigning));
 assert.equal(fs.readFileSync(keyFile,"utf8"),damaged);
 assert.deepEqual(fs.readdirSync(path.join(dir,"encryption")).filter(f=>f.endsWith(".key")),files);
});

test("explicit stores and OS consent fail closed; file keys are never overwritten", async t => {
 const {state}=fixture(t);
 await assert.rejects(state.initialize({cardUrl:"https://local.example.com/card"}),{code:"key_store"});
 await assert.rejects(state.initialize({store:"keychain",cardUrl:"https://local.example.com/card"}),{code:"key_store_consent"});
 assert.equal(state.status().configured,false);
 const result=await init(state); await assert.rejects(init(state),{code:"keys_exist"});
 assert.equal(state.status().identities[0].id,result.id);
});

test("protected-file symlinks and broad permissions are rejected", async t => {
 const {state,dir}=fixture(t);const result=await init(state),file=path.join(dir,"encryption",result.id+".key");
 fs.chmodSync(file,0o644);await assert.rejects(state.loadIdentity(result.id),{code:"key_store_permissions"});fs.chmodSync(file,0o600);
 const moved=file+".held";fs.renameSync(file,moved);fs.symlinkSync(moved,file);
 await assert.rejects(state.loadIdentity(result.id),{code:"key_store_permissions"});
});

async function proposal(state,id,expectedCurrent="none",changes={}) {
 return state.propose({peer:"remote",localId:id,bundle:remote.bundle,pairingIdentity,expectedCurrent,policy:"required",verification:"tofu",...changes});
}
test("exact trust proposal binds full policy and requires owner approval; restart persists pins", async t => {
 const {state,dir}=fixture(t);const own=await init(state);
 const p=await proposal(state,own.id);
 assert.equal(state.inspect("remote").live_state,"change-pending");assert.equal(state.inspect("remote").current,null);
 await assert.rejects(state.approve({peer:"remote",digest:p.digest,expectedCurrent:"none"}),{code:"owner_approval_required"});
 const accepted=await state.approve({peer:"remote",digest:p.digest,expectedCurrent:"none",ownerApproved:true});
 assert.equal(accepted.record.state,"tofu-pinned");assert.equal(accepted.record.policy,"required");
 const change=await proposal(state,own.id,accepted.digest,{policy:"off",operation:"policy"});
 assert.notEqual(change.digest,p.digest);assert.equal(change.proposal.newPolicy,"off");
 await assert.rejects(state.approve({peer:"remote",digest:p.digest,expectedCurrent:accepted.digest,ownerApproved:true}),{code:"approval_stale"});
 state.close();const again=new LocalState(dir,{write:true});t.after(()=>again.close());
 assert.equal(again.inspect("remote").current.policy,"required");assert.equal(again.inspect("remote").proposals.at(-1).digest,change.digest);
 const changed=await again.approve({peer:"remote",digest:change.digest,expectedCurrent:accepted.digest,ownerApproved:true});
 assert.equal(changed.record.policy,"off");assert.equal(changed.record.version,2);
 assert.equal(again.inspect("remote").history.length,2);assert.equal(again.inspect("remote").history[0].record.policy,"required");
});

test("verification and identity changes are held without separate human decisions", async t => {
 const {state}=fixture(t);const own=await init(state);
 const p=await proposal(state,own.id,"none",{verification:"independent"});
 await assert.rejects(state.approve({peer:"remote",digest:p.digest,expectedCurrent:"none",ownerApproved:true}),{code:"independent_verification_required"});
 const accepted=await state.approve({peer:"remote",digest:p.digest,expectedCurrent:"none",ownerApproved:true,independentVerified:true,verifiedProposalDigest:p.digest});
 assert.equal(accepted.record.state,"independently-verified");
 const replacement=await generateIdentity("https://remote.example.com/card");
 const next=await proposal(state,own.id,accepted.digest,{bundle:replacement.bundle,pairingIdentity:replacement.bundle.identityKey,operation:"re-pair"});
 await assert.rejects(state.approve({peer:"remote",digest:next.digest,expectedCurrent:accepted.digest,ownerApproved:true,independentVerified:true,verifiedProposalDigest:next.digest}),{code:"re_pair_required"});
 assert.equal(state.inspect("remote").current.bundle.identityKey,remote.bundle.identityKey);
});

test("concurrent proposals compare-and-swap full trust state; rejection names exact digest", async t => {
 const {state}=fixture(t);const own=await init(state);
 const [a,b]=await Promise.all([proposal(state,own.id),proposal(state,own.id)]);assert.notEqual(a.digest,b.digest);
 const accepted=await state.approve({peer:"remote",digest:a.digest,expectedCurrent:"none",ownerApproved:true});
 await assert.rejects(state.approve({peer:"remote",digest:b.digest,expectedCurrent:"none",ownerApproved:true}),{code:"approval_stale"});
 const p=await proposal(state,own.id,accepted.digest,{policy:"off",operation:"policy"});
 await state.reject({peer:"remote",digest:p.digest});await assert.rejects(state.reject({peer:"remote",digest:p.digest}),{code:"approval_stale"});
 assert.equal(state.inspect("remote").current.policy,"required");
});

test("existing status is read-only and cannot approve or initialize", async t => {
 const {state,dir}=fixture(t);const own=await init(state);state.close();
 const file=path.join(dir,"encryption/state.sqlite"),before=fs.readFileSync(file),mtime=fs.statSync(file).mtimeMs;
 const readonly=new LocalState(dir);t.after(()=>readonly.close());assert.equal(readonly.status().configured,true);
 await assert.rejects(readonly.propose({peer:"remote",localId:own.id,bundle:remote.bundle,pairingIdentity,expectedCurrent:"none",policy:"required",verification:"tofu"}),{code:"state_readonly"});
 assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.statSync(file).mtimeMs,mtime);
});

test("lost private files return actionable key loss without private paths", async t => {
 const {state,dir}=fixture(t);const own=await init(state);fs.unlinkSync(path.join(dir,"encryption",own.id+".key"));
 await assert.rejects(state.loadIdentity(own.id),error=>error.code==="key_lost"&&!String(error).includes(dir));
});


test("file initialization failure remains tracked and blocks duplicate creation until exact recovery", async t => {
 const {state,dir}=fixture(t);
 state.db.exec("CREATE TRIGGER fail_init BEFORE INSERT ON identities BEGIN SELECT RAISE(FAIL,'synthetic initialization failure'); END");
 await assert.rejects(init(state),{code:"initialization_uncertain"});
 const listing=state.status();assert.equal(listing.configured,false);assert.equal(listing.operations.length,1);assert.equal(listing.operations[0].state,"uncertain");
 const original=listing.operations[0];assert.equal(fs.readdirSync(path.join(dir,"encryption")).filter(x=>x.endsWith('.key')).length,1);
 await assert.rejects(init(state),{code:"initialization_pending"});
 assert.equal(state.status().operations.length,1);
 state.db.exec("DROP TRIGGER fail_init");state.close();const recovered=new LocalState(dir,{write:true});t.after(()=>recovered.close());
 await assert.rejects(recovered.reconcileInitialization({operationId:original.id,expectedDigest:"wrong",action:"adopt",approvalDigest:recoveryDigest(recovered,original.id,"adopt"),ownerApproved:true}),{code:"approval_stale"});
 const result=await recovered.reconcileInitialization({operationId:original.id,expectedDigest:original.digest,action:"adopt",approvalDigest:recoveryDigest(recovered,original.id,"adopt"),ownerApproved:true});
 assert.equal(result.id,original.operation.identityId);assert.equal(recovered.status().operations[0].state,"committed");
 assert.equal(fs.readdirSync(path.join(dir,"encryption")).filter(x=>x.endsWith('.key')).length,1);
});

test("mock native late success stays catalogued and recovery never replaces an active key", async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"a2a-native-intent-")),values=new Map();let late;
 const keyring=async input=>{const key=input.namespace+input.account;if(input.op==='set'){late={key,value:input.value};throw Error('synthetic uncertain native write');}return values.get(key)??null;};
 const state=new LocalState(dir,{create:true,keyring});t.after(()=>{state.close();values.clear();fs.rmSync(dir,{recursive:true,force:true});});
 await assert.rejects(state.initialize({store:'keychain',cardUrl:'https://local.example.com/card',allowOsConsent:true}),{code:'initialization_uncertain'});
 const intent=state.status().operations[0];assert.equal(intent.operation.store,'keychain');
 await assert.rejects(init(state),{code:'initialization_pending'});
 await state.reconcileInitialization({operationId:intent.id,expectedDigest:intent.digest,action:'abandon-if-absent',approvalDigest:recoveryDigest(state,intent.id,'abandon-if-absent'),ownerApproved:true,allowOsConsent:true});
 const active=await init(state);values.set(late.key,late.value);
 const result=await state.reconcileInitialization({operationId:intent.id,expectedDigest:intent.digest,action:'adopt',approvalDigest:recoveryDigest(state,intent.id,'adopt'),ownerApproved:true,allowOsConsent:true});
 assert.equal(result.retained_orphan,true);assert.equal(state.status().identities[0].id,active.id);
 assert.equal(state.status().operations.find(x=>x.id===intent.id).state,'orphan-retained');assert.equal(values.size,1);
});

test("native consent accepts only literal true before an injectable provider is called", async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"a2a-consent-"));let calls=0;const values=new Map();
 const keyring=async input=>{calls++;const key=input.namespace+input.account;if(input.op==='set'){values.set(key,input.value);return;}return values.get(key);};
 const state=new LocalState(dir,{create:true,keyring});t.after(()=>{state.close();values.clear();fs.rmSync(dir,{recursive:true,force:true});});
 for(const value of [false,'false',0,1,null,{},[]])await assert.rejects(state.initialize({store:'keychain',cardUrl:'https://local.example.com/card',allowOsConsent:value}),{code:'key_store_consent'});
 assert.equal(calls,0);assert.equal(state.status().operations.length,0);
 const own=await state.initialize({store:'keychain',cardUrl:'https://local.example.com/card',allowOsConsent:true});const after=calls;
 for(const value of [false,'false',0,1,null,{},[]])await assert.rejects(state.loadIdentity(own.id,{allowOsConsent:value}),{code:'key_store_consent'});
 assert.equal(calls,after);
});

test("proposed safety codes work before approval and bind exact proposal, key tuple and local identity", async t => {
 const {state}=fixture(t);const own=await init(state),p=await proposal(state,own.id,'none',{verification:'independent'});
 const proposed=state.safetyCode(own.id,'remote',{proposalDigest:p.digest});
 assert.equal(proposed.verification,'proposed-unapproved');assert.equal(proposed.proposal_digest,p.digest);assert.match(proposed.code,/^(?:[0-9]{5} ){11}[0-9]{5}$/);
 assert.throws(()=>state.safetyCode(own.id,'remote'),{code:'proposal_required'});
 await assert.rejects(state.approve({peer:'remote',digest:p.digest,expectedCurrent:'none',ownerApproved:true,independentVerified:true,verifiedProposalDigest:'old-digest'}),{code:'independent_verification_required'});
 const accepted=await state.approve({peer:'remote',digest:p.digest,expectedCurrent:'none',ownerApproved:true,independentVerified:true,verifiedProposalDigest:p.digest});
 assert.equal(state.safetyCode(own.id,'remote').code,proposed.code);
 const changed=await generateIdentity('https://remote.example.com/card');const next=await proposal(state,own.id,accepted.digest,{bundle:changed.bundle,operation:'re-pair',verification:'independent'});
 const replacement=state.safetyCode(own.id,'remote',{proposalDigest:next.digest});assert.notEqual(replacement.code,proposed.code);
 assert.throws(()=>state.safetyCode(own.id,'remote'),{code:'proposal_required'});
});

test("identity replacement always requires exact independent verification plus a re-pair outcome", async t => {
 const {state}=fixture(t);const own=await init(state),first=await proposal(state,own.id);
 const accepted=await state.approve({peer:'remote',digest:first.digest,expectedCurrent:'none',ownerApproved:true});
 const changed=await generateIdentity('https://remote.example.com/card');
 const tofu=await proposal(state,own.id,accepted.digest,{bundle:changed.bundle,pairingIdentity:changed.bundle.identityKey,operation:'re-pair'});
 await assert.rejects(state.approve({peer:'remote',digest:tofu.digest,expectedCurrent:accepted.digest,ownerApproved:true,rePairVerified:true}),{code:'independent_verification_required'});
 const exact=await proposal(state,own.id,accepted.digest,{bundle:changed.bundle,pairingIdentity:changed.bundle.identityKey,operation:'re-pair',verification:'independent'});
 await assert.rejects(state.approve({peer:'remote',digest:exact.digest,expectedCurrent:accepted.digest,ownerApproved:true,independentVerified:true,verifiedProposalDigest:exact.digest}),{code:'re_pair_required'});
 const approved=await state.approve({peer:'remote',digest:exact.digest,expectedCurrent:accepted.digest,ownerApproved:true,rePairVerified:true,independentVerified:true,verifiedProposalDigest:exact.digest});
 assert.equal(approved.record.verification,'independent');
});

test("local readbacks are bounded and preserve exact continuation choices", async t => {
 const {state}=fixture(t);const own=await init(state);
 for(let i=0;i<25;i++)await proposal(state,own.id);
 const first=state.inspect('remote',{limit:10});assert.equal(first.proposals.length,10);assert.ok(first.next_proposal_cursor);
 const second=state.inspect('remote',{limit:10,proposalCursor:first.next_proposal_cursor});assert.equal(second.proposals.length,10);assert.notEqual(second.proposals[0].digest,first.proposals[0].digest);
 const third=state.inspect('remote',{limit:10,proposalCursor:second.next_proposal_cursor});assert.equal(third.proposals.length,5);assert.equal(third.next_proposal_cursor,null);assert.equal(third.live_state,'change-pending');
 for(const limit of [0,101,Infinity,'2'])assert.throws(()=>state.status({limit}),{code:'listing_inputs'});
});

test("corrupt/foreign local state is preserved and returns fixed schema errors", async t => {
 const {state,dir}=fixture(t);state.db.exec('PRAGMA user_version=99');state.close();
 const file=path.join(dir,'encryption/state.sqlite'),before=fs.readFileSync(file);
 assert.throws(()=>new LocalState(dir),{code:'state_version_unsupported'});assert.deepEqual(fs.readFileSync(file),before);
 fs.writeFileSync(file,'synthetic-corrupt-private-path-canary');
 assert.throws(()=>new LocalState(dir),error=>error.code==='state_corrupt'&&!String(error).includes(dir)&&!String(error).includes('canary'));
 assert.equal(fs.readFileSync(file,'utf8'),'synthetic-corrupt-private-path-canary');
});

test('reconciliation refuses a recorded broker that is still alive',async t=>{
 const {state}=fixture(t);
 state.db.exec("CREATE TRIGGER fail_identity BEFORE INSERT ON identities BEGIN SELECT RAISE(FAIL,'fault'); END;");
 await assert.rejects(init(state),{code:'initialization_uncertain'});
 const op=state.status().operations[0];
 state.db.prepare('UPDATE key_operations SET broker_pid=? WHERE id=?').run(process.pid,op.id);
 await assert.rejects(state.reconcileInitialization({operationId:op.id,expectedDigest:op.digest,action:'adopt',approvalDigest:recoveryDigest(state,op.id,'adopt'),ownerApproved:true}),{code:'operation_in_progress'});
 assert.equal(state.status().identities.length,0);
});


test("status reports missing file keys without reading or replacing private material", async t => {
 const { state, dir } = fixture(t), result = await init(state);
 const keyFile = path.join(dir, "encryption", result.id + ".key");
 assert.equal(state.status().identities[0].private_key_status, "present");
 fs.renameSync(keyFile, keyFile + ".held");
 const row = state.status().identities[0];
 assert.equal(row.private_key_status, "key_missing");
 assert.match(row.next, /Restore the original private key.*do not run keys init/);
 assert.equal(row.live_state, "local-only");
 assert.equal(fs.existsSync(keyFile), false);
 fs.renameSync(keyFile + ".held", keyFile);
 assert.equal(state.status().identities[0].private_key_status, "present");
});

test("independent verification ceremony binds the exact pinned keys to the compared code", async t => {
 const {state}=fixture(t);const own=await init(state),first=await proposal(state,own.id);
 const pinned=await state.approve({peer:'remote',digest:first.digest,expectedCurrent:'none',ownerApproved:true});
 assert.equal(pinned.record.state,'tofu-pinned');
 const code=state.safetyCode(own.id,'remote').code;
 await assert.rejects(state.verifyIndependent({peer:'remote',localId:own.id,code}),{code:'owner_approval_required'});
 for(const bad of ['', '1234', code.slice(0,-1), code+'1', code.replace(/^./,'x'), null, 42])await assert.rejects(state.verifyIndependent({peer:'remote',localId:own.id,code:bad,ownerApproved:true}),{code:'safety_code_format'});
 const wrong=code.replace(/^(\d)/,d=>String((Number(d)+1)%10));
 await assert.rejects(state.verifyIndependent({peer:'remote',localId:own.id,code:wrong,ownerApproved:true}),{code:'safety_code_mismatch'});
 await assert.rejects(state.verifyIndependent({peer:'missing',localId:own.id,code,ownerApproved:true}),{code:'key_unknown'});
 let view=state.inspect('remote');assert.equal(view.current.state,'tofu-pinned');assert.equal(view.current_digest,pinned.digest);assert.equal(view.proposals.length,0);
 // Spacing differences are accepted; the digits must match exactly.
 const verified=await state.verifyIndependent({peer:'remote',localId:own.id,code:code.replace(/ /g,'  '),ownerApproved:true});
 assert.equal(verified.changed,true);assert.equal(verified.record.state,'independently-verified');assert.equal(verified.record.verification,'independent');
 assert.equal(verified.record.version,2);assert.equal(verified.code,code);assert.equal(verified.peer_key_id,remote.bundle.keyId);
 assert.equal(JSON.stringify(verified.record.bundle),JSON.stringify(pinned.record.bundle));
 view=state.inspect('remote');assert.equal(view.live_state,'independently-verified');assert.equal(view.history.length,2);assert.equal(view.proposals.length,0);
 assert.equal(state.safetyCode(own.id,'remote').verification,'independent');assert.equal(state.safetyCode(own.id,'remote').code,code);
 const again=await state.verifyIndependent({peer:'remote',localId:own.id,code,ownerApproved:true});
 assert.equal(again.changed,false);assert.equal(state.inspect('remote').current_version,2);
});

test("independent verification refuses revoked, pending and foreign pins without a trust change", async t => {
 const {state}=fixture(t);const own=await init(state),first=await proposal(state,own.id);
 const pinned=await state.approve({peer:'remote',digest:first.digest,expectedCurrent:'none',ownerApproved:true});
 const code=state.safetyCode(own.id,'remote').code;
 const other=await generateIdentity('https://remote.example.com/card');
 await proposal(state,own.id,pinned.digest,{bundle:other.bundle,pairingIdentity:other.bundle.identityKey,operation:'re-pair',verification:'independent'});
 await assert.rejects(state.verifyIndependent({peer:'remote',localId:own.id,code,ownerApproved:true}),{code:'proposal_required'});
 const {state:second}=fixture(t);const own2=await init(second),p2=await proposal(second,own2.id);
 const pin2=await second.approve({peer:'remote',digest:p2.digest,expectedCurrent:'none',ownerApproved:true});const code2=second.safetyCode(own2.id,'remote').code;
 const revoke=await proposal(second,own2.id,pin2.digest,{operation:'revoke'});await second.approve({peer:'remote',digest:revoke.digest,expectedCurrent:pin2.digest,ownerApproved:true});
 await assert.rejects(second.verifyIndependent({peer:'remote',localId:own2.id,code:code2,ownerApproved:true}),{code:'pin_revoked'});
 assert.equal(second.inspect('remote').current.state,'revoked');
});

test("a SQLite fault inside the verification transaction rolls back proposal and trust together", async t => {
 const {state}=fixture(t);const own=await init(state),first=await proposal(state,own.id);
 const pinned=await state.approve({peer:'remote',digest:first.digest,expectedCurrent:'none',ownerApproved:true});
 const code=state.safetyCode(own.id,'remote').code;
 const count=()=>state.db.prepare("SELECT COUNT(*) AS n FROM proposals").get().n;const before=count();
 // A temporary trigger on this connection fails the trust-history write after the proposal row was inserted.
 state.db.exec("CREATE TEMP TRIGGER fault_history BEFORE INSERT ON main.trust_history BEGIN SELECT RAISE(ABORT,'injected'); END;");
 await assert.rejects(state.verifyIndependent({peer:'remote',localId:own.id,code,ownerApproved:true}),{code:'state_unavailable'});
 assert.equal(count(),before);const view=state.inspect('remote');
 assert.equal(view.current.state,'tofu-pinned');assert.equal(view.current_digest,pinned.digest);assert.equal(view.history.length,1);assert.equal(view.live_state,'tofu-pinned');
 state.db.exec("DROP TRIGGER temp.fault_history");
 state.db.exec("CREATE TEMP TRIGGER fault_trust BEFORE UPDATE ON main.trust BEGIN SELECT RAISE(ABORT,'injected'); END;");
 await assert.rejects(state.verifyIndependent({peer:'remote',localId:own.id,code,ownerApproved:true}),{code:'state_unavailable'});
 assert.equal(count(),before);assert.equal(state.inspect('remote').history.length,1);assert.equal(state.inspect('remote').current.state,'tofu-pinned');
 state.db.exec("DROP TRIGGER temp.fault_trust");
 const ok=await state.verifyIndependent({peer:'remote',localId:own.id,code,ownerApproved:true});assert.equal(ok.record.state,'independently-verified');
});

test("signer rotation needs the exact approved plan, retires the old identity and holds its pins", async t => {
 const {state,dir}=fixture(t);const own=await init(state),first=await proposal(state,own.id);
 const pinned=await state.approve({peer:'remote',digest:first.digest,expectedCurrent:'none',ownerApproved:true});
 // A message sealed to the old key before rotation stays readable afterwards.
 const binding={contextId:'old-context',messageId:'old-message',taskId:null,role:'user',state:null,kind:'message'};
 const oldBundle=state.row(own.id).bundle;const envelope=await seal({identity:remote,recipient:JSON.parse(oldBundle),binding,content:{parts:[{text:'before-rotation'}]}});
 const plan=state.signerRotationPlan(own.id);
 assert.equal(plan.plan.action,'rotate-signing-identity');assert.deepEqual(plan.plan.heldPins,[{peer:'remote',version:1,state:'tofu-pinned'}]);
 assert.equal(plan.plan.cardUrl,'https://local.example.com/card');
 await assert.rejects(state.rotateSigner({id:own.id,approvalDigest:plan.approval_digest}),{code:'owner_approval_required'});
 await assert.rejects(state.rotateSigner({id:own.id,approvalDigest:'x'.repeat(43),ownerApproved:true}),{code:'approval_stale'});
 assert.equal(state.row(own.id).live_state,'local-only');assert.equal(state.status().identities.length,1);
 const rotated=await state.rotateSigner({id:own.id,approvalDigest:plan.approval_digest,ownerApproved:true});
 assert.equal(rotated.previous_id,own.id);assert.deepEqual(rotated.held_pins,['remote']);
 const fresh=JSON.parse(state.row(rotated.id).bundle),old=JSON.parse(oldBundle);
 assert.notEqual(fresh.identityKey,old.identityKey);assert.notEqual(fresh.keyId,old.keyId);assert.equal(fresh.cardUrl,old.cardUrl);
 assert.equal(state.row(own.id).live_state,'retired');assert.equal(state.row(rotated.id).live_state,'local-only');
 assert.equal(fs.statSync(path.join(dir,'encryption',rotated.id+'.key')).mode&0o777,0o600);
 // The old key opens old history and never signs or approves again.
 const archived=await state.loadIdentity(own.id);
 assert.deepEqual(await open({envelope,identity:archived,sender:remote.bundle,recipient:archived.bundle,expected:binding}),{parts:[{text:'before-rotation'}]});
 process.env.A2A_SEALED_ENABLED='1';t.after(()=>{delete process.env.A2A_SEALED_ENABLED;});
 await assert.rejects(state.loadIdentity(own.id,{purpose:'traffic'}),{code:'traffic_disabled'});
 assert.throws(()=>state.safetyCode(own.id,'remote'),{code:'key_retired'});
 await assert.rejects(proposal(state,own.id,pinned.digest,{operation:'verify',verification:'independent'}),{code:'key_retired'});
 assert.throws(()=>state.signerRotationPlan(own.id),{code:'key_retired'});
 // The pin is unchanged and still bound to the retired key until a new human-approved pairing.
 const view=state.inspect('remote');assert.equal(view.current.localId,own.id);assert.equal(view.current_digest,pinned.digest);
 // The fresh identity can be pinned through a new pairing under a new alias.
 const repair=await state.propose({peer:'remote-2',localId:rotated.id,bundle:remote.bundle,pairingIdentity,expectedCurrent:'none',policy:'required',verification:'tofu'});
 const repinned=await state.approve({peer:'remote-2',digest:repair.digest,expectedCurrent:'none',ownerApproved:true});
 assert.equal(repinned.record.localId,rotated.id);
 const code=state.safetyCode(rotated.id,'remote-2').code;
 const verified=await state.verifyIndependent({peer:'remote-2',localId:rotated.id,code,ownerApproved:true});assert.equal(verified.record.state,'independently-verified');
});

test("a rotated store keeps schema v6 and its backup restores both identities", async t => {
 const {state,dir}=fixture(t);const own=await init(state);
 const plan=state.signerRotationPlan(own.id);const rotated=await state.rotateSigner({id:own.id,approvalDigest:plan.approval_digest,ownerApproved:true});
 const passphrase=Buffer.from('synthetic passphrase'),source=path.join(dir,'rotated-backup.json');
 await state.createBackup({destination:source,passphrase});
 const archive=path.join(dir,'archive');const restored=await restoreBackup({source,destination:archive,passphrase,store:'file',acknowledgeReplayRollback:true});
 assert.equal(restored.archive_only,true);
 const copy=new LocalState(archive);t.after(()=>copy.close());
 const rows=Object.fromEntries(copy.status().identities.map(row=>[row.id,row.live_state]));
 // A restore is archive-only for every identity; both the retired and the fresh key are present.
 assert.deepEqual(rows,{[own.id]:'archive-only',[rotated.id]:'archive-only'});
});

test("a fault while committing a signer rotation leaves the old identity active and the intent recoverable", async t => {
 const {state}=fixture(t);const own=await init(state);const plan=state.signerRotationPlan(own.id);
 state.db.exec("CREATE TEMP TRIGGER fault_identity BEFORE INSERT ON main.identities BEGIN SELECT RAISE(ABORT,'injected'); END;");
 await assert.rejects(state.rotateSigner({id:own.id,approvalDigest:plan.approval_digest,ownerApproved:true}),{code:'rotation_uncertain'});
 state.db.exec("DROP TRIGGER temp.fault_identity");
 assert.equal(state.row(own.id).live_state,'local-only');assert.equal(state.status().identities.length,1);
 const pending=state.status().operations.find(op=>op.state==='uncertain');assert.ok(pending,'the interrupted intent stays listed for exact recovery');
 assert.equal(pending.operation.kind,'rotate-signer');assert.equal(pending.operation.previousId,own.id);
 assert.throws(()=>state.signerRotationPlan(own.id),{code:'initialization_pending'});
 // Exact recovery completes the approved rotation: the old key is retired and the new one adopted.
 const recovered=await state.reconcileInitialization({operationId:pending.id,expectedDigest:pending.digest,action:'adopt',approvalDigest:recoveryDigest(state,pending.id,'adopt'),ownerApproved:true});
 assert.equal(recovered.recovered,true);assert.equal(recovered.id,pending.operation.identityId);
 assert.equal(state.row(own.id).live_state,'retired');assert.equal(state.row(recovered.id).live_state,'local-only');
 assert.notEqual(JSON.parse(state.row(recovered.id).bundle).identityKey,JSON.parse(state.row(own.id).bundle).identityKey);
});

test("rotatedPins lists only non-revoked pins on a retired key", async t => {
 const {state}=fixture(t);const own=await init(state),first=await proposal(state,own.id);
 const pinned=await state.approve({peer:'remote',digest:first.digest,expectedCurrent:'none',ownerApproved:true});
 assert.deepEqual(state.rotatedPins(),[]);
 const plan=state.signerRotationPlan(own.id);await state.rotateSigner({id:own.id,approvalDigest:plan.approval_digest,ownerApproved:true});
 assert.deepEqual(state.rotatedPins(),[{peer:'remote',local_id:own.id}]);
 // Revoking the held pin releases it; history stays.
 // Any other proposal on the retired key is refused.
 await assert.rejects(state.propose({peer:'remote',localId:own.id,bundle:remote.bundle,pairingIdentity,expectedCurrent:pinned.digest,policy:'required',verification:'independent',operation:'verify'}),{code:'key_retired'});
 const revoke=await state.propose({peer:'remote',localId:own.id,bundle:remote.bundle,pairingIdentity,expectedCurrent:pinned.digest,policy:'required',verification:'tofu',operation:'revoke'});
 const revoked=await state.approve({peer:'remote',digest:revoke.digest,expectedCurrent:pinned.digest,ownerApproved:true});
 assert.equal(revoked.record.state,'revoked');assert.deepEqual(state.rotatedPins(),[]);
});
