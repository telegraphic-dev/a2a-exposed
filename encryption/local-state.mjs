// Local-only custody/trust foundation. These APIs do not enroll a Worker or send traffic.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { nativeCredentialOperation } from "./native-store.mjs";
import { generateIdentity, verifyBundle, canonicalJSON, parseJSON, seal } from "./index.mjs";

const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() });
const b64 = value => Buffer.from(value).toString("base64url");
const hash = (label, value) => createHash("sha256").update(label + "\n" + canonicalJSON(value)).digest("base64url");
const queues = new Map();
const inflight = new Set();
const UUID = /^[a-f0-9-]{36}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const POLICIES = ["off", "required", "allow-server-readable"];
export class LocalStateError extends Error {
 constructor(code, next = "Run keys status --json and keys stores --json; no remote settings were changed.") { super(next); this.code = code; this.next = next; }
}
const fail = (code, next) => { throw new LocalStateError(code, next); };
const copy = value => JSON.parse(JSON.stringify(value));
function stateError(error) {
 if (error instanceof LocalStateError) return error;
 if ([5, 6].includes(error?.errcode)) return new LocalStateError("state_busy", "Another local process holds the store. Read keys status --json after it finishes; no automatic retry or replacement was made.");
 if (error?.code === "ERR_SQLITE_ERROR" || error instanceof SyntaxError) return new LocalStateError("state_corrupt", "Local state could not be read safely. Preserve it and use a matching version or trusted backup; do not initialize over it.");
 if (["native_outcome_unknown", "native_process_unreaped", "key_store_unavailable", "key_store_consent"].includes(error?.code)) return new LocalStateError(error.code, "Read keys status --json and reconcile the exact pending key operation before retrying; no native write/deletion outcome is assumed.");
 if (["EACCES", "EPERM", "ELOOP"].includes(error?.code)) return new LocalStateError("key_store_permissions");
 return new LocalStateError("state_unavailable");
}
function pageInputs(limit, cursor) {
 if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(cursor) || cursor < 0) fail("listing_inputs", "Run keys status --json or peer keys inspect --to ALIAS --json, then use --limit 1..100 and the exact returned nonnegative continuation.");
}

function permissions(file, directory = false) {
 const stat = fs.lstatSync(file);
 if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) fail("key_store_permissions");
 if (process.platform !== "win32") {
  if ((stat.mode & 0o077) || stat.uid !== process.getuid()) fail("key_store_permissions", "Use an owner-only key directory (0700) and files (0600), then run keys status --json.");
 } else {
  // Require a current-user-only ACL. Do not assume chmod protects Windows files.
  const script = "$p=[Console]::In.ReadToEnd();$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$a=Get-Acl -LiteralPath $p;$bad=@($a.Access | Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -notin @($me,'S-1-5-18')});if($bad.Count -gt 0){exit 1}";
  try { execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input: file, stdio: ["pipe", "ignore", "ignore"], timeout: 5000 }); }
  catch { fail("key_store_permissions", "Use a current-user-only Windows ACL; then run keys stores --json. No fallback was selected."); }
 }
 return stat;
}
function protect(file) {
 if (process.platform !== "win32") fs.chmodSync(file, fs.statSync(file).isDirectory() ? 0o700 : 0o600);
 else {
  const script = "$p=[Console]::In.ReadToEnd();$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$a=Get-Acl -LiteralPath $p;$a.SetAccessRuleProtection($true,$false);foreach($r in @($a.Access)){$a.RemoveAccessRuleAll($r)};$a.SetOwner($me);$r=New-Object System.Security.AccessControl.FileSystemAccessRule($me,'FullControl','Allow');$a.AddAccessRule($r);Set-Acl -LiteralPath $p -AclObject $a";
  try { execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input: file, stdio: ["pipe", "ignore", "ignore"], timeout: 5000 }); }
  catch { fail("key_store_permissions"); }
 }
 permissions(file, fs.statSync(file).isDirectory());
}
function privateRead(file, max = 16384) {
 const before = permissions(file); const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
 try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > max || stat.dev !== before.dev || stat.ino !== before.ino || (process.platform !== "win32" && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) fail("key_file"); return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(fd)); }
 finally { fs.closeSync(fd); }
}
function privateWrite(file, value) {
 const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
 try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
 protect(file);
 // Persist directory entries where the platform supports directory fsync. The recovery intent
 // remains authoritative if the filesystem or native provider has an uncertain outcome.
 let parent;
 try { parent = fs.openSync(path.dirname(file), "r"); fs.fsyncSync(parent); }
 catch (error) { if (process.platform !== "win32" && !["EINVAL", "ENOTSUP", "EBADF"].includes(error.code)) throw error; }
 finally { if (parent !== undefined) fs.closeSync(parent); }
}
async function serialize(identity) {
 return JSON.stringify({ v: 1, signing: b64(await crypto.subtle.exportKey("pkcs8", identity.signingKey)), encryption: b64(await suite.kem.serializePrivateKey(identity.encryptionKey)) });
}
async function deserialize(value, bundle) {
 try {
  const data = parseJSON(value);
  if (Object.keys(data).sort().join() !== ["v", "signing", "encryption"].sort().join() || data.v !== 1) fail("key_unreadable");
  for (const field of ["signing", "encryption"]) if (typeof data[field] !== "string" || !/^[A-Za-z0-9_-]+$/.test(data[field]) || Buffer.from(data[field], "base64url").toString("base64url") !== data[field]) fail("key_unreadable");
  const signing = Buffer.from(data.signing, "base64url"), encryption = Buffer.from(data.encryption, "base64url");
  if (encryption.length !== 32 || signing.length > 256) fail("key_unreadable");
  return { bundle, signingKey: await crypto.subtle.importKey("pkcs8", signing, "Ed25519", true, ["sign"]), encryptionKey: await suite.kem.deserializePrivateKey(encryption) };
 } catch { fail("key_unreadable", "Private key data failed validation. Preserve it and restore a trusted backup; no key replacement or trust change was made."); }
}

async function nativeStore(input, allowOsConsent, onSpawn) {
 return nativeCredentialOperation(input, { allowOsConsent, onSpawn });
}

export async function stores() {
 let native = false; try { await import("@napi-rs/keyring"); native = ["darwin", "linux", "win32"].includes(process.platform); } catch {}
 return { ok: true, stores: [{ id: "file", available: true, private_keys: "protected local files", unattended: true }, { id: "keychain", available: native, backend: process.platform === "linux" ? "secret-service (no kernel fallback)" : process.platform === "darwin" ? "macOS Keychain" : "Windows Credential Manager", readiness: "not probed; owner authorization may be required", unattended: false }], next: "Select --store file or keychain explicitly; keychain never silently falls back." };
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS key_operations(id TEXT PRIMARY KEY,kind TEXT NOT NULL,public_json TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,created_ms INTEGER NOT NULL,owner_pid INTEGER NOT NULL,broker_pid INTEGER);
CREATE TABLE IF NOT EXISTS identities(id TEXT PRIMARY KEY,bundle TEXT NOT NULL,store TEXT NOT NULL,credential_namespace TEXT NOT NULL,live_state TEXT NOT NULL,created_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS trust(peer TEXT PRIMARY KEY,version INTEGER NOT NULL,record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trust_history(peer TEXT NOT NULL,version INTEGER NOT NULL,record TEXT NOT NULL,digest TEXT NOT NULL,approved_ms INTEGER NOT NULL,PRIMARY KEY(peer,version));
CREATE TABLE IF NOT EXISTS proposals(digest TEXT PRIMARY KEY,peer TEXT NOT NULL,expected_digest TEXT NOT NULL,expected_version INTEGER NOT NULL,proposal TEXT NOT NULL,state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS replay(local_id TEXT NOT NULL,sender TEXT NOT NULL,message_id TEXT NOT NULL,digest TEXT NOT NULL,context TEXT NOT NULL,task_id TEXT,created_ms INTEGER NOT NULL,PRIMARY KEY(local_id,sender,message_id));
CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,local_id TEXT NOT NULL,sender TEXT NOT NULL,message_id TEXT NOT NULL,envelope TEXT NOT NULL,state TEXT NOT NULL,created_ms INTEGER NOT NULL);
`;
function validateSchema(db) {
 const expected = new DatabaseSync(":memory:");
 try {
  expected.exec(SCHEMA);
  const query = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
  if (JSON.stringify(db.prepare(query).all()) !== JSON.stringify(expected.prepare(query).all())) fail("state_corrupt");
  if (db.prepare("PRAGMA quick_check(1)").get().quick_check !== "ok") fail("state_corrupt");
 } finally { expected.close(); }
}
export class LocalState {
 constructor(configDir, { create = false, write = create, keyring = nativeStore } = {}) {
  this.db = null; this.writable = write; this.keyring = keyring;
  try {
   this.root = path.join(path.resolve(configDir), "encryption");
   if (create && !write) fail("state_readonly");
   if (!fs.existsSync(this.root)) {
    if (!create) return;
    fs.mkdirSync(path.resolve(configDir), { recursive: true, mode: 0o700 });
    try { fs.mkdirSync(this.root, { mode: 0o700 }); protect(this.root); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
   }
   permissions(this.root, true); this.root = fs.realpathSync(this.root); const file = path.join(this.root, "state.sqlite");
   if (!fs.existsSync(file) && !create) return;
   if (fs.existsSync(file)) permissions(file);
   this.db = new DatabaseSync(file, { readOnly: !write }); if (write) protect(file);
   this.db.exec("PRAGMA busy_timeout=5000;");
   if (create) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
     const version = this.db.prepare("PRAGMA user_version").get().user_version;
     const objects = this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().n;
     if (version === 0 && objects === 0) {
      this.db.exec(SCHEMA);
      this.db.prepare("INSERT INTO meta VALUES('config_id',?)").run(randomUUID());
      this.db.exec("PRAGMA user_version=1");
     } else if (version !== 1) fail("state_version_unsupported", "Use the matching local-state version or restore a trusted backup to a new directory; existing state was not replaced.");
     this.db.exec("COMMIT");
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
   }
   if (this.db.prepare("PRAGMA user_version").get().user_version !== 1) fail("state_version_unsupported", "Use the matching CLI/local-state version; no automatic migration or replacement was performed.");
   validateSchema(this.db);
   if (!UUID.test(this.db.prepare("SELECT value FROM meta WHERE key='config_id'").get()?.value || "")) fail("state_corrupt");
   if (write) this.db.exec("PRAGMA foreign_keys=ON;");
  } catch (error) { try { this.db?.close(); } catch {} this.db = null; throw stateError(error); }
 }

 close() { this.db?.close(); this.db = null; }
 ready() { if (!this.db) fail("keys_unconfigured", "Run keys stores --json, then keys init with an explicit --store and --card-url in this config directory."); }
 configId() { this.ready(); return this.db.prepare("SELECT value FROM meta WHERE key='config_id'").get().value; }
 async locked(action) {
  this.ready(); if (!this.writable) fail("state_readonly");
  const previous = queues.get(this.root) || Promise.resolve(); let release;
  const own = new Promise(resolve => { release = resolve; }), tail = previous.then(() => own); queues.set(this.root, tail);
  await previous;
  try { this.db.exec("BEGIN IMMEDIATE"); const result = await action(); this.db.exec("COMMIT"); return result; }
  catch (error) { try { this.db.exec("ROLLBACK"); } catch {} if (error instanceof LocalStateError) throw error; fail("state_unavailable"); }
  finally { release(); if (queues.get(this.root) === tail) queues.delete(this.root); }
 }
 status({ limit = 20, identityCursor = 0, operationCursor = 0 } = {}) {
  pageInputs(limit, identityCursor); pageInputs(limit, operationCursor);
  if (!this.db) return { ok: true, configured: false, identities: [], operations: [], next: "Run keys stores --json before keys init." };
  const rows = this.db.prepare("SELECT rowid AS cursor,id,bundle,store,live_state,created_ms FROM identities WHERE rowid>? ORDER BY rowid LIMIT ?").all(identityCursor, limit + 1);
  const identities = rows.slice(0, limit).map(row => ({ id: row.id, bundle: JSON.parse(row.bundle), key_store: row.store, live_state: row.live_state, created_ms: row.created_ms }));
  const opRows = this.db.prepare("SELECT rowid AS cursor,id,public_json,digest,state,created_ms,broker_pid FROM key_operations WHERE rowid>? ORDER BY rowid LIMIT ?").all(operationCursor, limit + 1);
  const operations = opRows.slice(0, limit).map(row => ({ id: row.id, operation: JSON.parse(row.public_json), digest: row.digest, state: row.state, created_ms: row.created_ms, broker_pid: row.broker_pid }));
  return { ok: true, configured: Boolean(this.db.prepare("SELECT id FROM identities LIMIT 1").get()), config_identity: this.configId(), identities, operations, next_identity_cursor: rows.length > limit ? rows[limit - 1].cursor : null, next_operation_cursor: opRows.length > limit ? opRows[limit - 1].cursor : null, next: "Continue listings with the returned cursors. For pending key creation, reconcile the exact operation/digest; do not repeat initialization." };
 }

 row(id) { this.ready(); const row = this.db.prepare("SELECT * FROM identities WHERE id=?").get(id); if (!row) fail("key_unknown", "Select an exact identity ID from keys status --json."); return row; }
 async privateGet(row, allowOsConsent) {
  const bundle = JSON.parse(row.bundle), account = row.id + "/" + bundle.keyId;
  if (row.store === "keychain" && allowOsConsent !== true) fail("key_store_consent");
  try {
   const value = row.store === "file" ? privateRead(path.join(this.root, row.id + ".key")) : await this.keyring({ op: "get", namespace: row.credential_namespace, account }, allowOsConsent);
   if (typeof value !== "string") fail("key_lost", "The private key is unavailable. Restore a trusted protected backup or plan an explicit key replacement; do not change peer trust automatically.");
   return value;
  } catch (error) {
   if (error instanceof LocalStateError) throw error;
   if (error.code === "ENOENT") fail("key_lost", "The private key file is missing. Restore a trusted protected backup; old encrypted history may be unreadable.");
   fail("key_store_unavailable");
  }
 }
 async initialize({ store, cardUrl, allowOsConsent = false, now = Date.now() }) {
  if (!["file", "keychain"].includes(store)) fail("key_store", "Select --store from keys stores --json; no store is chosen automatically.");
  if (store === "keychain" && allowOsConsent !== true) fail("key_store_consent", "OS credential access needs explicit true consent; use the file store for unattended operation. Run keys stores --json.");
  const identity = await generateIdentity(cardUrl, now), value = await serialize(identity), id = randomUUID(), namespace = randomUUID(), opId = randomUUID();
  const operation = { v: 1, kind: "initialize", id: opId, identityId: id, bundle: identity.bundle, store, namespace, account: id + "/" + identity.bundle.keyId, fileRef: id + ".key", created_ms: now };
  const digest = hash("a2a-exposed local key operation v1", operation);
  // Commit public intent before a file or OS credential can be written. Keep every intent for recovery.
  await this.locked(async () => {
   if (this.db.prepare("SELECT id FROM identities LIMIT 1").get()) fail("keys_exist", "This config already has keys. Run keys status --json; existing private keys are never overwritten.");
   if (this.db.prepare("SELECT id FROM key_operations WHERE state IN ('prepared','writing','secret-written','uncertain') LIMIT 1").get()) fail("initialization_pending", "Run keys status --json and reconcile the exact recorded initialization intent before retrying; do not create another key.");
   this.db.prepare("INSERT INTO key_operations(id,kind,public_json,digest,state,created_ms,owner_pid) VALUES(?,?,?,?,?,?,?)").run(opId, "initialize", JSON.stringify(operation), digest, "prepared", now, process.pid);
  });
  inflight.add(opId);
  try {
   this.db.prepare("UPDATE key_operations SET state='writing' WHERE id=?").run(opId);
   if (store === "file") privateWrite(path.join(this.root, operation.fileRef), value + "\n");
   else await this.keyring({ op: "set", namespace, account: operation.account, value }, allowOsConsent, pid => this.db.prepare("UPDATE key_operations SET broker_pid=? WHERE id=?").run(pid, opId));
   this.db.prepare("UPDATE key_operations SET state='secret-written' WHERE id=?").run(opId);
   return await this.locked(async () => {
    this.db.prepare("INSERT INTO identities VALUES(?,?,?,?,?,?)").run(id, JSON.stringify(identity.bundle), store, namespace, "local-only", now);
    this.db.prepare("UPDATE key_operations SET state='committed' WHERE id=?").run(opId);
    return { ok: true, id, bundle: identity.bundle, key_store: store, live_state: "local-only", operation_id: opId, next: "Fresh keys remain local; no Worker enrollment or pairing trust was changed." };
   });
  } catch {
   try { this.db.prepare("UPDATE key_operations SET state='uncertain' WHERE id=? AND state<>'committed'").run(opId); } catch {}
   const error = new LocalStateError("initialization_uncertain", "Key creation may have written local credentials. Run keys status --json and recover this exact intent; do not repeat initialization or delete keys automatically.");
   error.details = { operation_id: opId, operation_digest: digest, key_store: store }; throw error;
  } finally { inflight.delete(opId); }
 }
 async reconcileInitialization({ operationId, expectedDigest, action, ownerApproved = false, allowOsConsent = false }) {
  if (ownerApproved !== true || !["adopt", "abandon-if-absent"].includes(action)) fail("owner_approval_required", "List recovery intents with keys status --json, then select an exact operation/digest and explicit recovery action approved by the human.");
  this.ready();
  const row = this.db.prepare("SELECT * FROM key_operations WHERE id=? AND kind='initialize'").get(operationId);
  if (!row || row.digest !== expectedDigest || row.state === "committed") fail("approval_stale", "Run keys status --json; the recovery intent or its state changed.");
  if (inflight.has(operationId)) fail("operation_in_progress", "The original initialization is still running; inspect keys status --json after it exits.");
  if (["prepared", "writing"].includes(row.state) && row.owner_pid !== process.pid) {
   try { process.kill(row.owner_pid, 0); fail("operation_in_progress"); } catch (error) { if (error instanceof LocalStateError || error.code !== "ESRCH") throw new LocalStateError("operation_in_progress"); }
  }
  if (row.broker_pid) {
   try { process.kill(row.broker_pid, 0); fail("operation_in_progress", "The recorded credential broker may still be running. Wait for confirmed process exit before reconciliation; no provider outcome is assumed."); }
   catch (error) { if (error instanceof LocalStateError || error.code !== "ESRCH") throw new LocalStateError("operation_in_progress"); }
  }
  const op = JSON.parse(row.public_json);
  if (hash("a2a-exposed local key operation v1", op) !== expectedDigest || !UUID.test(op.identityId) || op.fileRef !== op.identityId + ".key" || !UUID.test(op.namespace) || op.account !== op.identityId + "/" + op.bundle?.keyId || !["file", "keychain"].includes(op.store)) fail("state_corrupt");
  let value;
  if (op.store === "keychain") {
   if (allowOsConsent !== true) fail("key_store_consent");
   value = await this.keyring({ op: "get", namespace: op.namespace, account: op.account }, allowOsConsent);
  } else {
   try { value = privateRead(path.join(this.root, op.fileRef)); }
   catch (error) { if (error.code !== "ENOENT") throw error; value = null; }
  }
  if (value === null || value === undefined) {
   if (action !== "abandon-if-absent") fail("key_lost", "The recorded key is absent at this observation. Choose abandon-if-absent explicitly to permit a new initialization; the old intent remains catalogued for late native completion.");
   return this.locked(async () => {
    this.db.prepare("UPDATE key_operations SET state='observed-absent' WHERE id=? AND digest=?").run(operationId, expectedDigest);
    return { ok: true, operation_id: operationId, observed_absent: true, retained_intent: true, next: "No credential was deleted. The retained intent can be inspected again if a late native write appears." };
   });
  }
  if (action !== "adopt") fail("credential_present", "The recorded credential exists. Adopt the exact intent to recover it; it was not deleted or overwritten.");
  const identity = await deserialize(value, op.bundle);
  await seal({ identity, recipient: op.bundle, binding: { contextId: randomUUID(), messageId: randomUUID(), taskId: null, role: "user", state: null, kind: "message" }, content: { purpose: "recover-local-key-check" } });
  return this.locked(async () => {
   const current = this.db.prepare("SELECT state,digest FROM key_operations WHERE id=?").get(operationId);
   if (!current || current.digest !== expectedDigest || current.state === "committed") fail("approval_stale");
   if (this.db.prepare("SELECT id FROM identities LIMIT 1").get()) {
    this.db.prepare("UPDATE key_operations SET state='orphan-retained' WHERE id=?").run(operationId);
    return { ok: true, operation_id: operationId, retained_orphan: true, next: "Another identity is active. This older credential remains tracked for archive/recovery; no active identity or trust was replaced." };
   }
   this.db.prepare("INSERT INTO identities VALUES(?,?,?,?,?,?)").run(op.identityId, JSON.stringify(op.bundle), op.store, op.namespace, "local-only", op.created_ms);
   this.db.prepare("UPDATE key_operations SET state='committed' WHERE id=?").run(operationId);
   return { ok: true, id: op.identityId, operation_id: operationId, recovered: true, bundle: op.bundle, next: "The original local key was recovered; no replacement, enrollment or pairing change occurred." };
  });
 }
 async loadIdentity(id, { allowOsConsent = false, purpose = "archive" } = {}) {
  const row = this.row(id);
  if (purpose !== "archive") fail("traffic_disabled", "Encrypted traffic is not enabled by local custody initialization.");
  const identity = await deserialize(await this.privateGet(row, allowOsConsent), JSON.parse(row.bundle));
  await seal({ identity, recipient: identity.bundle, binding: { contextId: randomUUID(), messageId: randomUUID(), taskId: null, role: "user", state: null, kind: "message" }, content: { purpose: "local-key-pair-check" } });
  return identity;
 }
 inspect(peer, { limit = 20, proposalCursor = 0, historyVersion = 0 } = {}) {
  pageInputs(limit, proposalCursor); pageInputs(limit, historyVersion);
  this.ready(); const row = this.db.prepare("SELECT * FROM trust WHERE peer=?").get(peer);
  const current = row ? JSON.parse(row.record) : null;
  const proposalRows = this.db.prepare("SELECT rowid AS cursor,digest,proposal,state FROM proposals WHERE peer=? AND state='pending' AND rowid>? ORDER BY rowid LIMIT ?").all(peer, proposalCursor, limit + 1);
  const proposals = proposalRows.slice(0, limit).map(x => ({ digest: x.digest, proposal: JSON.parse(x.proposal), state: x.state }));
  const pending = this.db.prepare("SELECT digest FROM proposals WHERE peer=? AND state='pending' LIMIT 1").get(peer);
  const historyRows = this.db.prepare("SELECT version,record,digest,approved_ms FROM trust_history WHERE peer=? AND version>? ORDER BY version LIMIT ?").all(peer, historyVersion, limit + 1);
  const history = historyRows.slice(0, limit).map(x => ({ version: x.version, record: JSON.parse(x.record), digest: x.digest, approved_ms: x.approved_ms }));
  return { ok: true, config_identity: this.configId(), peer, current, history, next_proposal_cursor: proposalRows.length > limit ? proposalRows[limit - 1].cursor : null, next_history_version: historyRows.length > limit ? historyRows[limit - 1].version : null, live_state: pending ? "change-pending" : current?.state || "unpinned", pairing: "not-checked", policies: [...POLICIES], verification_choices: ["tofu", "independent"], current_digest: row ? hash("a2a-exposed sealed trust record v1", current) : "none", current_version: row?.version || 0, proposals };
 }
 async propose({ peer, localId, bundle, pairingIdentity, expectedCurrent, policy, verification, operation = "enroll", now = Date.now() }) {
  if (typeof peer !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(peer) || !KEY.test(pairingIdentity || "") || !POLICIES.includes(policy) || !["tofu", "independent"].includes(verification) || !["enroll", "rotate", "re-pair", "policy", "verify", "revoke"].includes(operation)) fail("proposal_inputs", "Run peer keys inspect --to ALIAS --json, then supply explicit policy, verification, pairing identity and expected current digest.");
  await verifyBundle(bundle, { cardUrl: bundle.cardUrl, identityKey: bundle.identityKey, now });
  return this.locked(async () => {
   const local = this.row(localId), current = this.inspect(peer);
   if (expectedCurrent !== current.current_digest) fail("approval_stale", "Run peer keys inspect --to ALIAS --json; the full trust record changed.");
   const localBundle = JSON.parse(local.bundle);
   const proposal = { v: 1, configIdentity: this.configId(), localIdentity: localBundle.identityKey, localKeyId: localBundle.keyId, localBundleDigest: hash("a2a-exposed sealed bundle v1", localBundle), localId, peer, peerEndpoint: bundle.cardUrl, pairingIdentity, currentRecordDigest: current.current_digest, currentRecordVersion: current.current_version, newBundleDigest: hash("a2a-exposed sealed bundle v1", bundle), newBundle: bundle, newPolicy: policy, operation, verificationDecision: verification, proposalNonce: b64(randomBytes(32)) };
   const digest = hash("a2a-exposed sealed trust proposal v1", proposal);
   this.db.prepare("INSERT INTO proposals VALUES(?,?,?,?,?,?)").run(digest, peer, current.current_digest, current.current_version, JSON.stringify(proposal), "pending");
   return { ok: true, peer, digest, proposal, next: "The proposal grants no trust. Ask the human to approve this exact digest after any required independent verification." };
  });
 }
 async approve({ peer, digest, expectedCurrent, ownerApproved = false, independentVerified = false, verifiedProposalDigest, rePairVerified = false }) {
  if (ownerApproved !== true) fail("owner_approval_required", "The human must approve the exact proposal digest; peer messages and hosted mirrors do not authorize it.");
  return this.locked(async () => {
   const row = this.db.prepare("SELECT * FROM proposals WHERE digest=? AND peer=? AND state='pending'").get(digest, peer), current = this.inspect(peer);
   if (!row || expectedCurrent !== current.current_digest || row.expected_digest !== current.current_digest || row.expected_version !== current.current_version) fail("approval_stale", "Run peer keys inspect --to ALIAS --json and approve the current exact proposal.");
   const proposal = JSON.parse(row.proposal);
   if (hash("a2a-exposed sealed trust proposal v1", proposal) !== digest || hash("a2a-exposed sealed bundle v1", JSON.parse(this.row(proposal.localId).bundle)) !== proposal.localBundleDigest) fail("approval_stale");
   if (proposal.verificationDecision === "independent" && (independentVerified !== true || verifiedProposalDigest !== digest)) fail("independent_verification_required", "Compare the locally computed safety code through another trusted channel; a hosted comparison is not independent verification.");
   const identityChanged = current.current && (current.current.bundle.identityKey !== proposal.newBundle.identityKey || current.current.pairingIdentity !== proposal.pairingIdentity || current.current.localId !== proposal.localId);
   if (identityChanged && rePairVerified !== true) fail("re_pair_required", "Complete a separately human-approved pairing and re-verify the identity before approving this proposal.");
   if (identityChanged && (proposal.verificationDecision !== "independent" || independentVerified !== true || verifiedProposalDigest !== digest)) fail("independent_verification_required", "Identity changes require a new independent-verification proposal and comparison of that exact proposal's safety code after human-approved re-pairing.");
   const version = current.current_version + 1;
   const record = { v: 1, configIdentity: this.configId(), localId: proposal.localId, localKeyId: proposal.localKeyId, localBundleDigest: proposal.localBundleDigest, peer, peerEndpoint: proposal.peerEndpoint, pairingIdentity: proposal.pairingIdentity, bundle: proposal.newBundle, policy: proposal.newPolicy, verification: proposal.verificationDecision, state: proposal.operation === "revoke" ? "revoked" : proposal.verificationDecision === "independent" ? "independently-verified" : "tofu-pinned", version };
   this.db.prepare("INSERT INTO trust_history VALUES(?,?,?,?,?)").run(peer, version, JSON.stringify(record), hash("a2a-exposed sealed trust record v1", record), Date.now());
   this.db.prepare("INSERT INTO trust VALUES(?,?,?) ON CONFLICT(peer) DO UPDATE SET version=excluded.version,record=excluded.record").run(peer, version, JSON.stringify(record));
   this.db.prepare("UPDATE proposals SET state='superseded' WHERE peer=? AND state='pending' AND digest<>?").run(peer, digest);
   this.db.prepare("UPDATE proposals SET state='approved' WHERE digest=?").run(digest);
   return { ok: true, peer, record, digest: hash("a2a-exposed sealed trust record v1", record), next: "Local trust only; no server pairing or access was changed." };
  });
 }
 async reject({ peer, digest }) { return this.locked(async () => { const result = this.db.prepare("UPDATE proposals SET state='rejected' WHERE peer=? AND digest=? AND state='pending'").run(peer, digest); if (!result.changes) fail("approval_stale"); return { ok: true, peer, digest, rejected: true }; }); }
 safetyCode(localId, peer, { proposalDigest } = {}) {
  const local = JSON.parse(this.row(localId).bundle), inspection = this.inspect(peer);
  let other, verification, source;
  if (proposalDigest) {
   const row = this.db.prepare("SELECT proposal,expected_digest FROM proposals WHERE digest=? AND peer=? AND state='pending'").get(proposalDigest, peer);
   if (!row) fail("approval_stale", "Select an exact pending proposal digest from peer keys inspect --to ALIAS --json.");
   const proposal = JSON.parse(row.proposal);
   if (hash("a2a-exposed sealed trust proposal v1", proposal) !== proposalDigest || proposal.localId !== localId || proposal.configIdentity !== this.configId() || row.expected_digest !== inspection.current_digest || proposal.localBundleDigest !== hash("a2a-exposed sealed bundle v1", local)) fail("approval_stale");
   other = proposal.newBundle; verification = "proposed-unapproved"; source = "proposal";
  } else {
   if (inspection.live_state === "change-pending") fail("proposal_required", "A key change is pending. Select its exact proposal digest from peer keys inspect --to ALIAS --json before comparing a code.");
   const current = inspection.current;
   if (!current || current.localId !== localId || current.localBundleDigest !== hash("a2a-exposed sealed bundle v1", local)) fail("key_unknown", "Select a locally approved peer from peer keys inspect --to ALIAS --json.");
   other = current.bundle; verification = current.verification; source = "current";
  }
  if (local.identityKey === other.identityKey) fail("same_identity");
  const tuples = [local, other].map(x => ({ cardUrl: x.cardUrl, identityKey: x.identityKey, keyId: x.keyId })).sort((a, b) => Buffer.compare(Buffer.from(a.identityKey, "base64url"), Buffer.from(b.identityKey, "base64url")) || a.cardUrl.localeCompare(b.cardUrl));
  const bytes = createHash("sha256").update("a2a-exposed sealed safety v1\n" + canonicalJSON(tuples)).digest("hex");
  const digits = (BigInt("0x" + bytes) % (10n ** 60n)).toString().padStart(60, "0");
  return { ok: true, config_identity: this.configId(), local_id: localId, peer, source, ...(proposalDigest ? { proposal_digest: proposalDigest } : {}), code: digits.match(/.{5}/g).join(" "), verification, next: "Compare every group through another trusted channel. This read-only code grants no trust; approve only its exact proposal digest." };
 }
}

// Public surface returns fixed recovery errors. Private provider/SQLite/JSON strings never escape.
for (const name of ["status", "initialize", "reconcileInitialization", "loadIdentity", "inspect", "propose", "approve", "reject", "safetyCode"]) {
 const action = LocalState.prototype[name];
 LocalState.prototype[name] = action.constructor.name === "AsyncFunction"
  ? async function (...args) { try { return await action.apply(this, args); } catch (error) { throw stateError(error); } }
  : function (...args) { try { return action.apply(this, args); } catch (error) { throw stateError(error); } };
}
