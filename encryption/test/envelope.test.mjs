import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { generateIdentity, verifyBundle, seal, open, canonicalJSON, parseJSON, SUITE, MAX_PLAINTEXT } from "../index.mjs";

const now = Date.parse("2026-11-12T00:00:00.000Z");
const binding = { contextId: "context-1", messageId: "message-1", taskId: null, role: "user", kind: "message", state: null };
const alice = await generateIdentity("https://alice.example.com/.well-known/agent-card.json", now);
const bob = await generateIdentity("https://bob.example.com/.well-known/agent-card.json", now);
const content = { parts: [{ text: "private canary" }, { data: { private: ["value", 123] } }], metadata: { secret: "metadata-canary" }, artifacts: [{ name: "private-name", parts: [{ bytes: "Ynl0ZXM=", mediaType: "text/plain" }] }] };
const envelope = await seal({ identity: alice, recipient: bob.bundle, binding, content, now });
const opening = { envelope, sender: alice.bundle, recipient: bob.bundle, expected: binding, now };

// Public deterministic RFC 9180 test material, never real account keys.
test("pinned hpke-js matches official X25519/HKDF-SHA256/ChaCha20Poly1305 base vector", async () => {
 const { vector: v } = JSON.parse(fs.readFileSync(new URL("hpke-rfc9180.json", import.meta.url)));
 const h = value => new Uint8Array(Buffer.from(value, "hex"));
 const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() });
 const recipient = await suite.kem.deriveKeyPair(h(v.ikmR));
 assert.equal(Buffer.from(await suite.kem.serializePublicKey(recipient.publicKey)).toString("hex"), v.pkRm);
 const sender = await suite.createSenderContext({ recipientPublicKey: recipient.publicKey, info: h(v.info), ekm: h(v.ikmE) });
 assert.equal(Buffer.from(sender.enc).toString("hex"), v.enc);
 const receiver = await suite.createRecipientContext({ recipientKey: recipient.privateKey, info: h(v.info), enc: sender.enc });
 for (const row of v.encryptions) {
  const ct = await sender.seal(h(row.pt), h(row.aad));
  assert.equal(Buffer.from(ct).toString("hex"), row.ct);
  assert.equal(Buffer.from(await receiver.open(ct, h(row.aad))).toString("hex"), row.pt);
 }
});

test("recipient and sender can each open their independently encapsulated history copy", async () => {
 assert.deepEqual(await open({ ...opening, identity: bob }), content);
 assert.deepEqual(await open({ ...opening, identity: alice, purpose: "sender" }), content);
 assert.deepEqual(await open({ ...opening, envelope: JSON.stringify(envelope), identity: bob }), content);
 assert.notEqual(envelope.sender.enc, envelope.recipient.enc);
 assert.equal(envelope.suite, SUITE);
 for (const canary of ["private canary", "private-name", "metadata-canary", "Ynl0ZXM="]) assert.ok(!JSON.stringify(envelope).includes(canary));
});

test("fresh encapsulation and hidden nonce prevent deterministic public content commitments", async () => {
 const second = await seal({ identity: alice, recipient: bob.bundle, binding, content, now });
 assert.notEqual(second.header.commitment, envelope.header.commitment);
 assert.notEqual(second.sender.ct, envelope.sender.ct);
 assert.deepEqual(await open({ ...opening, envelope: second, identity: alice, purpose: "sender" }), content);
});

test("reject header, ciphertext, signature and outer-binding changes without disclosing input", async () => {
 const mutations = [
  e => e.header.contextId = "other-context", e => e.header.messageId = "other-message", e => e.header.taskId = "other-task",
  e => e.header.role = "agent", e => e.header.state = "completed", e => e.header.kind = "artifact",
  e => e.header.from.keyId = e.header.to.keyId, e => e.header.to.identityKey = e.header.from.identityKey,
  e => e.header.sentAt = new Date(now + 1000).toISOString(), e => e.recipient.ct = e.sender.ct,
  e => e.sender = structuredClone(e.recipient), e => e.signature = e.signature.slice(1),
  e => e.recipient.enc += "=", e => e.secret = "untrusted-private-error-canary",
 ];
 for (const mutate of mutations) {
  const changed = structuredClone(envelope); mutate(changed);
  await assert.rejects(open({ ...opening, envelope: changed, identity: bob }), error => {
   assert.ok(!String(error).includes("untrusted-private-error-canary")); return Boolean(error.code);
  });
 }
 for (const key of Object.keys(binding)) {
  await assert.rejects(open({ ...opening, expected: { ...binding, [key]: "wrong" }, identity: bob }));
 }
});

test("wrong identity/key and unsupported suite fail closed", async () => {
 await assert.rejects(open({ ...opening, identity: alice }), { code: "key_lost" });
 await assert.rejects(open({ ...opening, identity: bob, sender: bob.bundle }), { code: "key_changed" });
 await assert.rejects(open({ ...opening, identity: bob, envelope: { ...envelope, suite: "other" } }), { code: "extension_unsupported" });
 await assert.rejects(verifyBundle(bob.bundle, { cardUrl: alice.bundle.cardUrl, identityKey: bob.bundle.identityKey, now }), { code: "key_changed" });
});

test("live freshness bounds, size limits and full JSON integrity are enforced", async () => {
 await assert.rejects(open({ ...opening, identity: bob, now: now + 31 * 86400000 }), { code: "replay" });
 await assert.rejects(open({ ...opening, identity: bob, now: now - 300001 }), { code: "replay" });
 await assert.rejects(seal({ identity: alice, recipient: bob.bundle, binding, content: "x".repeat(MAX_PLAINTEXT), now }), { code: "content_too_large" });
 assert.throws(() => parseJSON('{"x":1,"\\u0078":2}'));
 assert.throws(() => parseJSON('{"x":[{"y":1,"y":2}]}'));
 assert.throws(() => parseJSON('"\\ud800"'));
 assert.throws(() => parseJSON('1e999'));
 assert.throws(() => canonicalJSON([,1]));
 assert.throws(() => canonicalJSON({ value: undefined }));
 assert.throws(() => canonicalJSON({ get secret() { throw Error("must never call getter"); } }));
 assert.throws(() => canonicalJSON(Array.from({ length: 35 }).reduce(value => [value], 1)));
 assert.equal(canonicalJSON({ z: 1e30, a: -0, "€": "Unicode" }), '{"a":0,"z":1e+30,"€":"Unicode"}');
 assert.deepEqual(parseJSON('{"arr": [true, false, null, -1.23e-4, "a\\\"b"]}'), { arr: [true,false,null,-1.23e-4,'a"b'] });
});

test("malformed public input always returns fixed errors and never raw input", async () => {
 const canary="secret-must-not-echo";
 await assert.rejects(seal({identity:{bundle:{cardUrl:canary}},recipient:{},binding,content,now}), error => error.code && !String(error).includes(canary));
 await assert.rejects(generateIdentity("https://example.com/card?secret="+canary,now), error => error.code && !String(error).includes(canary));
 for (const size of [200,201,256,257]) {
  const chosen={...binding,messageId:"x".repeat(size)};
  if(size===200) assert.ok(await seal({identity:alice,recipient:bob.bundle,binding:chosen,content,now}));
  else await assert.rejects(seal({identity:alice,recipient:bob.bundle,binding:chosen,content,now}));
 }
});

test("a valid sender signature cannot make different plaintext satisfy the one commitment", async () => {
 const suite=new CipherSuite({kem:new DhkemX25519HkdfSha256(),kdf:new HkdfSha256(),aead:new Chacha20Poly1305()});
 const e=new TextEncoder();const raw=value=>new Uint8Array(Buffer.from(value,"base64url"));const b64=value=>Buffer.from(value).toString("base64url");
 const original=await suite.createRecipientContext({recipientKey:bob.encryptionKey,enc:raw(envelope.recipient.enc),info:e.encode("a2a-exposed sealed v1 recipient")});
 const payload=JSON.parse(new TextDecoder().decode(await original.open(raw(envelope.recipient.ct),e.encode(canonicalJSON(envelope.header)))));
 payload.content={parts:[{text:"different dishonest content"}]};
 const context=await suite.createSenderContext({recipientPublicKey:await suite.kem.deserializePublicKey(raw(bob.bundle.encryptionKey)),info:e.encode("a2a-exposed sealed v1 recipient")});
 const changed=structuredClone(envelope);
 changed.recipient={enc:b64(context.enc),ct:b64(await context.seal(e.encode(canonicalJSON(payload)),e.encode(canonicalJSON(changed.header))))};
 const {signature,...body}=changed;
 changed.signature=b64(await crypto.subtle.sign("Ed25519",alice.signingKey,e.encode("a2a-exposed sealed envelope v1\n"+canonicalJSON(body))));
 await assert.rejects(open({...opening,envelope:changed,identity:bob}),{code:"verification_failed"});
 // The signature covers the other copy too, but does not prove it opens.
 assert.deepEqual(await open({...opening,envelope:changed,identity:alice,purpose:"sender"}),content);
});

test("canonical arrays reject sparse disguises, accessors, symbols and custom methods without executing them", () => {
 const sparse=new Array(1); sparse.extra=1;
 assert.throws(()=>canonicalJSON(sparse),{code:"content_unsupported"});
 let calls=0; const getter=[];Object.defineProperty(getter,"0",{get(){calls++;return 1;},enumerable:true});
 assert.throws(()=>canonicalJSON(getter),{code:"content_unsupported"});assert.equal(calls,0);
 const symbol=[1];symbol[Symbol("hidden")]=2;assert.throws(()=>canonicalJSON(symbol),{code:"content_unsupported"});
 const overridden=[1];overridden.map=()=>{calls++;return []};assert.throws(()=>canonicalJSON(overridden),{code:"content_unsupported"});assert.equal(calls,0);
 class CustomArray extends Array{};assert.throws(()=>canonicalJSON(new CustomArray(1)),{code:"content_unsupported"});
 const object={};Object.defineProperty(object,"hidden",{value:1});assert.throws(()=>canonicalJSON(object),{code:"content_unsupported"});
 assert.equal(canonicalJSON([1,{x:[true,null]}]),'[1,{"x":[true,null]}]');
});

test("invalid clocks and inconsistent local archive keys are refused", async () => {
 for(const bad of [NaN,Infinity,-1,0.5,"now"]) {
  await assert.rejects(generateIdentity("https://example.com/card",bad));
  await assert.rejects(open({...opening,identity:bob,now:bad}));
  await assert.rejects(verifyBundle(bob.bundle,{cardUrl:bob.bundle.cardUrl,identityKey:bob.bundle.identityKey,now:bad}));
 }
 await assert.rejects(seal({identity:{...alice,encryptionKey:bob.encryptionKey},recipient:bob.bundle,binding,content,now}));
});
