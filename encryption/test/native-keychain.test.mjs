// Real OS credential store round trip (#384). It writes to the current user's
// macOS Keychain, Linux Secret Service or Windows Credential Manager, so it only
// runs when A2A_NATIVE_KEYCHAIN_TEST=1 on a disposable CI runner. It deletes every
// entry it created. It runs unattended and cannot show or answer an OS consent
// prompt, so it does not establish prompt behavior on a person's desktop.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalState, restoreBackup, stores } from "../local-state.mjs";
import { nativeCredentialOperation } from "../native-store.mjs";
import { generateIdentity, seal, open } from "../index.mjs";

const enabled = process.env.A2A_NATIVE_KEYCHAIN_TEST === "1";
const skip = enabled ? false : "writes to the OS credential store; set A2A_NATIVE_KEYCHAIN_TEST=1 only on a disposable runner";
const cardUrl = "https://native.example.com/.well-known/agent-card.json";
const passphrase = Buffer.from("synthetic native keychain backup passphrase");

function filesUnder(dir) {
 return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath ?? entry.path, entry.name));
}
function assertAbsent(dir, secrets, { except = [] } = {}) {
 for (const file of filesUnder(dir)) {
  if (except.includes(file)) continue;
  const bytes = fs.readFileSync(file);
  for (const secret of secrets) assert.equal(bytes.includes(Buffer.from(secret)), false, `private key material found in ${path.relative(dir, file)}`);
 }
}

test("native keychain keys survive restart, rotation, backup and loss without file fallback", { skip }, async t => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-native-keychain-"));
 const config = path.join(dir, "config"), calls = [], written = new Map();
 let state, archive;
 // Count every provider call. Record each entry before writing so cleanup also covers a failed set.
 const keyring = async (input, allowOsConsent, onSpawn) => {
  calls.push(input.op);
  if (input.op === "set") written.set(input.account, { namespace: input.namespace, account: input.account });
  return nativeCredentialOperation(input, { allowOsConsent, onSpawn, timeoutMs: 20000 });
 };
 const native = (op, entry) => nativeCredentialOperation({ op, ...entry }, { allowOsConsent: true, timeoutMs: 20000 });
 t.after(async () => {
  state?.close(); archive?.close();
  for (const entry of written.values()) { try { await native("delete", entry); } catch {} }
  for (const entry of written.values()) assert.ok(await native("get", entry) == null, "test credential entries are removed");
  fs.rmSync(dir, { recursive: true, force: true });
 });

 const listed = (await stores()).stores.find(store => store.id === "keychain");
 assert.equal(listed.available, true, "the platform keyring binding loads");

 state = new LocalState(config, { create: true, keyring });
 await assert.rejects(state.initialize({ store: "keychain", cardUrl }), { code: "key_store_consent" });
 assert.deepEqual(calls, [], "missing consent never reaches the provider");
 const created = await state.initialize({ store: "keychain", cardUrl, allowOsConsent: true });
 assert.equal(created.key_store, "keychain");
 assert.deepEqual(calls, ["set"]);
 const first = written.get(created.id + "/" + created.bundle.keyId);
 assert.ok(first, "the provider entry is named by identity and key ID");

 // The provider holds the private key. No key file or fallback copy exists locally.
 const stored = JSON.parse(await native("get", first));
 const secrets = [stored.signing, stored.encryption];
 for (const secret of secrets) assert.equal(typeof secret, "string");
 assert.deepEqual(filesUnder(config).filter(file => file.endsWith(".key")), []);
 assertAbsent(config, secrets);
 assert.equal(JSON.stringify(state.status()).includes(stored.signing), false);
 assert.equal(state.status().identities[0].private_key_status, "not_checked", "status never reads the provider");

 // A new process-level handle reopens the same provider entry.
 state.close(); state = new LocalState(config, { write: true, keyring }); calls.length = 0;
 await assert.rejects(state.loadIdentity(created.id), { code: "key_store_consent" });
 assert.deepEqual(calls, []);
 const loaded = await state.loadIdentity(created.id, { allowOsConsent: true });
 assert.deepEqual(calls, ["get"]);
 assert.equal(loaded.bundle.keyId, created.bundle.keyId);
 const remote = await generateIdentity("https://remote.example.com/.well-known/agent-card.json");
 const binding = { contextId: "native-context", messageId: "native-message", taskId: null, role: "user", state: null, kind: "message" };
 const envelope = await seal({ identity: remote, recipient: loaded.bundle, binding, content: { text: "synthetic native keychain content" } });
 assert.deepEqual(await open({ envelope, identity: loaded, sender: remote.bundle, recipient: loaded.bundle, expected: binding }), { text: "synthetic native keychain content" });

 // Rotation writes a second provider entry and keeps the first for archive reads.
 calls.length = 0;
 await assert.rejects(state.rotateLocal({ id: created.id, approvalDigest: state.rotationPlan(created.id).approval_digest, ownerApproved: true }), { code: "key_store_consent" });
 assert.deepEqual(calls, []);
 const rotated = await state.rotateLocal({ id: created.id, approvalDigest: state.rotationPlan(created.id).approval_digest, ownerApproved: true, allowOsConsent: true });
 assert.equal(rotated.key_store, "keychain");
 const second = written.get(rotated.id + "/" + rotated.bundle.keyId);
 assert.ok(second);
 const rotatedStored = JSON.parse(await native("get", second)), rotatedSecrets = [rotatedStored.signing, rotatedStored.encryption];
 assert.equal((await state.loadIdentity(created.id, { allowOsConsent: true })).bundle.keyId, created.bundle.keyId);
 assert.equal((await state.loadIdentity(rotated.id, { allowOsConsent: true })).bundle.keyId, rotated.bundle.keyId);
 assertAbsent(config, [...secrets, ...rotatedSecrets]);

 // A backup reads both provider entries only with consent and restores to protected files.
 const backup = path.join(dir, "backup.json");
 calls.length = 0;
 await assert.rejects(state.createBackup({ destination: backup, passphrase }), { code: "key_store_consent" });
 assert.deepEqual(calls, []);
 assert.equal(fs.existsSync(backup), false);
 const saved = await state.createBackup({ destination: backup, passphrase, allowOsConsent: true });
 assert.equal(saved.archived_credentials, 2);
 assertAbsent(dir, [...secrets, ...rotatedSecrets]);
 const restored = path.join(dir, "restored");
 await restoreBackup({ source: backup, destination: restored, passphrase, store: "file", acknowledgeReplayRollback: true });
 archive = new LocalState(restored, { write: true, keyring: async () => assert.fail("a restored file store never calls the provider") });
 const fromFile = await archive.loadIdentity(created.id);
 assert.equal(fromFile.bundle.keyId, created.bundle.keyId);
 assert.deepEqual(await open({ envelope, identity: fromFile, sender: remote.bundle, recipient: fromFile.bundle, expected: binding }), { text: "synthetic native keychain content" });

 // Losing the provider entry refuses reads. Nothing creates a replacement key or file.
 await native("delete", first);
 calls.length = 0;
 await assert.rejects(state.loadIdentity(created.id, { allowOsConsent: true }), { code: "key_lost" });
 assert.deepEqual(calls, ["get"]);
 assert.equal(state.status().identities.length, 2);
 assert.deepEqual(filesUnder(config).filter(file => file.endsWith(".key")), []);
 assert.equal((await state.loadIdentity(rotated.id, { allowOsConsent: true })).bundle.keyId, rotated.bundle.keyId, "other entries are unaffected");
});
