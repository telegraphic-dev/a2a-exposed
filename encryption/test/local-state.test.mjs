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
 const accepted=await state.approve({peer:"remote",digest:p.digest,expectedCurrent:"none",ownerApproved:true,independentVerified:true});
 assert.equal(accepted.record.state,"independently-verified");
 const replacement=await generateIdentity("https://remote.example.com/card");
 const next=await proposal(state,own.id,accepted.digest,{bundle:replacement.bundle,pairingIdentity:replacement.bundle.identityKey,operation:"re-pair"});
 await assert.rejects(state.approve({peer:"remote",digest:next.digest,expectedCurrent:accepted.digest,ownerApproved:true,independentVerified:true}),{code:"re_pair_required"});
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
