// Local-only custody/trust foundation. These APIs do not enroll a Worker or send traffic.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { generateIdentity, verifyBundle, canonicalJSON, parseJSON, seal } from "./index.mjs";

const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() });
const b64 = value => Buffer.from(value).toString("base64url");
const hash = (label, value) => createHash("sha256").update(label + "\n" + canonicalJSON(value)).digest("base64url");
const queues = new Map();
const UUID = /^[a-f0-9-]{36}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const POLICIES = ["off", "required", "allow-server-readable"];
export class LocalStateError extends Error {
 constructor(code, next = "Run keys status --json and keys stores --json; no remote settings were changed.") { super(next); this.code = code; this.next = next; }
}
const fail = (code, next) => { throw new LocalStateError(code, next); };
const copy = value => JSON.parse(JSON.stringify(value));
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
 permissions(file); const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
 try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > max) fail("key_file"); return fs.readFileSync(fd, "utf8"); }
 finally { fs.closeSync(fd); }
}
function privateWrite(file, value) {
 const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
 try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
 protect(file);
}
async function serialize(identity) {
 return JSON.stringify({ v: 1, signing: b64(await crypto.subtle.exportKey("pkcs8", identity.signingKey)), encryption: b64(await suite.kem.serializePrivateKey(identity.encryptionKey)) });
}
async function deserialize(value, bundle) {
 const data = parseJSON(value);
 if (data.v !== 1 || typeof data.signing !== "string" || typeof data.encryption !== "string") fail("key_lost");
 return { bundle, signingKey: await crypto.subtle.importKey("pkcs8", Buffer.from(data.signing, "base64url"), "Ed25519", true, ["sign"]), encryptionKey: await suite.kem.deserializePrivateKey(Buffer.from(data.encryption, "base64url")) };
}
async function nativeStore(input, allowOsConsent) {
 if (!allowOsConsent) fail("key_store_consent", "OS credential access may require owner authorization. Explicitly allow OS consent, or select the protected file store from keys stores --json for unattended use. No fallback was selected.");
 return new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./keyring-worker.mjs", import.meta.url))], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env: { PATH: process.env.PATH, ...(process.env.HOME ? { HOME: process.env.HOME } : {}), ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}) } });
  let output = "", finished = false;
  const finish = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
  const timer = setTimeout(() => { child.kill(); finish(new LocalStateError("key_store_unavailable")); }, 5000);
  child.on("error", () => finish(new LocalStateError("key_store_unavailable")));
  child.stdout.on("data", chunk => { output += chunk; if (Buffer.byteLength(output) > 16384) { child.kill(); finish(new LocalStateError("key_store_unavailable")); } });
  child.on("close", code => { try { const data = JSON.parse(output); if (code || data.ok !== true) throw Error(); finish(null, data.value); } catch { finish(new LocalStateError("key_store_unavailable")); } });
  child.stdin.on("error", () => finish(new LocalStateError("key_store_unavailable")));
  child.stdin.end(JSON.stringify(input));
 });
}
export async function stores() {
 let native = false; try { await import("@napi-rs/keyring"); native = ["darwin", "linux", "win32"].includes(process.platform); } catch {}
 return { ok: true, stores: [{ id: "file", available: true, private_keys: "protected local files", unattended: true }, { id: "keychain", available: native, backend: process.platform === "linux" ? "secret-service (no kernel fallback)" : process.platform === "darwin" ? "macOS Keychain" : "Windows Credential Manager", readiness: "not probed; owner authorization may be required", unattended: false }], next: "Select --store file or keychain explicitly; keychain never silently falls back." };
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS identities(id TEXT PRIMARY KEY,bundle TEXT NOT NULL,store TEXT NOT NULL,credential_namespace TEXT NOT NULL,live_state TEXT NOT NULL,created_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS trust(peer TEXT PRIMARY KEY,version INTEGER NOT NULL,record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trust_history(peer TEXT NOT NULL,version INTEGER NOT NULL,record TEXT NOT NULL,digest TEXT NOT NULL,approved_ms INTEGER NOT NULL,PRIMARY KEY(peer,version));
CREATE TABLE IF NOT EXISTS proposals(digest TEXT PRIMARY KEY,peer TEXT NOT NULL,expected_digest TEXT NOT NULL,expected_version INTEGER NOT NULL,proposal TEXT NOT NULL,state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS replay(local_id TEXT NOT NULL,sender TEXT NOT NULL,message_id TEXT NOT NULL,digest TEXT NOT NULL,context TEXT NOT NULL,task_id TEXT,created_ms INTEGER NOT NULL,PRIMARY KEY(local_id,sender,message_id));
CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,local_id TEXT NOT NULL,sender TEXT NOT NULL,message_id TEXT NOT NULL,envelope TEXT NOT NULL,state TEXT NOT NULL,created_ms INTEGER NOT NULL);
`;
export class LocalState {
 constructor(configDir, { create = false, write = create, keyring = nativeStore } = {}) {
  this.root = path.join(path.resolve(configDir), "encryption"); this.keyring = keyring; this.db = null; this.writable = write;
  if (create && !write) fail("state_readonly");
  if (!fs.existsSync(this.root)) {
   if (!create) return;
   fs.mkdirSync(path.resolve(configDir), { recursive: true, mode: 0o700 });
   fs.mkdirSync(this.root, { mode: 0o700 }); protect(this.root);
  }
  permissions(this.root, true); this.root = fs.realpathSync(this.root); const file = path.join(this.root, "state.sqlite");
  if (!fs.existsSync(file) && !create) return;
  if (fs.existsSync(file)) permissions(file);
  this.db = new DatabaseSync(file, { readOnly: !write }); if (write) protect(file);
  this.db.exec("PRAGMA busy_timeout=5000;");
  if (write) this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;");
  if (create) {
   this.db.exec(SCHEMA);
   this.db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('config_id',?)").run(randomUUID());
  }
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
 status() {
  if (!this.db) return { ok: true, configured: false, identities: [], next: "Run keys stores --json before keys init." };
  const identities = this.db.prepare("SELECT id,bundle,store,live_state,created_ms FROM identities ORDER BY created_ms,id").all().map(row => ({ id: row.id, bundle: JSON.parse(row.bundle), key_store: row.store, live_state: row.live_state, created_ms: row.created_ms }));
  return { ok: true, configured: identities.length > 0, config_identity: this.configId(), identities, next: "Keys are local only; no Worker enrollment or pairing trust was changed." };
 }
 row(id) { this.ready(); const row = this.db.prepare("SELECT * FROM identities WHERE id=?").get(id); if (!row) fail("key_unknown", "Select an exact identity ID from keys status --json."); return row; }
 async privateGet(row, allowOsConsent) {
  const bundle = JSON.parse(row.bundle), account = row.id + "/" + bundle.keyId;
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
  const identity = await generateIdentity(cardUrl, now), value = await serialize(identity), id = randomUUID(), namespace = randomUUID();
  return this.locked(async () => {
   if (this.db.prepare("SELECT id FROM identities LIMIT 1").get()) fail("keys_exist", "This config already has keys. Run keys status --json; existing private keys are never overwritten.");
   const bundle = identity.bundle;
   if (store === "file") privateWrite(path.join(this.root, id + ".key"), value + "\n");
   else await this.keyring({ op: "set", namespace, account: id + "/" + bundle.keyId, value }, allowOsConsent);
   this.db.prepare("INSERT INTO identities VALUES(?,?,?,?,?,?)").run(id, JSON.stringify(bundle), store, namespace, "local-only", now);
   return { ok: true, id, bundle, key_store: store, live_state: "local-only", next: "Fresh keys remain local; enroll and approve exact peer keys only through the reviewed owner flow." };
  });
 }
 async loadIdentity(id, { allowOsConsent = false, purpose = "archive" } = {}) {
  const row = this.row(id);
  if (purpose !== "archive") fail("traffic_disabled", "Encrypted traffic is not enabled by local custody initialization.");
  const identity = await deserialize(await this.privateGet(row, allowOsConsent), JSON.parse(row.bundle));
  await seal({ identity, recipient: identity.bundle, binding: { contextId: randomUUID(), messageId: randomUUID(), taskId: null, role: "user", state: null, kind: "message" }, content: { purpose: "local-key-pair-check" } });
  return identity;
 }
 inspect(peer) {
  this.ready(); const row = this.db.prepare("SELECT * FROM trust WHERE peer=?").get(peer);
  const current = row ? JSON.parse(row.record) : null;
  const proposals = this.db.prepare("SELECT digest,proposal,state FROM proposals WHERE peer=? ORDER BY rowid").all(peer).map(x => ({ digest: x.digest, proposal: JSON.parse(x.proposal), state: x.state }));
  const pending = proposals.filter(x => x.state === "pending");
  const history = this.db.prepare("SELECT version,record,digest,approved_ms FROM trust_history WHERE peer=? ORDER BY version").all(peer).map(x => ({ version: x.version, record: JSON.parse(x.record), digest: x.digest, approved_ms: x.approved_ms }));
  return { ok: true, config_identity: this.configId(), peer, current, history, live_state: pending.length ? "change-pending" : current?.state || "unpinned", pairing: "not-checked", policies: [...POLICIES], verification_choices: ["tofu", "independent"], current_digest: row ? hash("a2a-exposed sealed trust record v1", current) : "none", current_version: row?.version || 0, proposals };
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
 async approve({ peer, digest, expectedCurrent, ownerApproved = false, independentVerified = false, rePairVerified = false }) {
  if (ownerApproved !== true) fail("owner_approval_required", "The human must approve the exact proposal digest; peer messages and hosted mirrors do not authorize it.");
  return this.locked(async () => {
   const row = this.db.prepare("SELECT * FROM proposals WHERE digest=? AND peer=? AND state='pending'").get(digest, peer), current = this.inspect(peer);
   if (!row || expectedCurrent !== current.current_digest || row.expected_digest !== current.current_digest || row.expected_version !== current.current_version) fail("approval_stale", "Run peer keys inspect --to ALIAS --json and approve the current exact proposal.");
   const proposal = JSON.parse(row.proposal);
   if (hash("a2a-exposed sealed trust proposal v1", proposal) !== digest || hash("a2a-exposed sealed bundle v1", JSON.parse(this.row(proposal.localId).bundle)) !== proposal.localBundleDigest) fail("approval_stale");
   if (proposal.verificationDecision === "independent" && independentVerified !== true) fail("independent_verification_required", "Compare the locally computed safety code through another trusted channel; a hosted comparison is not independent verification.");
   if (current.current && (current.current.bundle.identityKey !== proposal.newBundle.identityKey || current.current.pairingIdentity !== proposal.pairingIdentity || current.current.localId !== proposal.localId) && rePairVerified !== true) fail("re_pair_required", "Complete a separately human-approved pairing and re-verify the identity before approving this proposal.");
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
 safetyCode(localId, peer) {
  const local = JSON.parse(this.row(localId).bundle), current = this.inspect(peer).current;
  if (!current || current.localId !== localId) fail("key_unknown", "Select a locally approved peer from peer keys inspect --to ALIAS --json.");
  const other = current.bundle; if (local.identityKey === other.identityKey) fail("same_identity");
  const tuples = [local, other].map(x => ({ cardUrl: x.cardUrl, identityKey: x.identityKey, keyId: x.keyId })).sort((a, b) => Buffer.compare(Buffer.from(a.identityKey, "base64url"), Buffer.from(b.identityKey, "base64url")) || a.cardUrl.localeCompare(b.cardUrl));
  const bytes = createHash("sha256").update("a2a-exposed sealed safety v1\n" + canonicalJSON(tuples)).digest("hex");
  const digits = (BigInt("0x" + bytes) % (10n ** 60n)).toString().padStart(60, "0");
  return { ok: true, peer, code: digits.match(/.{5}/g).join(" "), verification: current.verification, next: "Compare every group through another trusted channel. The server did not compute this code." };
 }
}
