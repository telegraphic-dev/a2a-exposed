import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalState, stores } from "../local-state.mjs";
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
