// Local encrypted-backup byte format. This module does not import or restore live state.
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { canonicalJSON, parseJSON } from "./index.mjs";
export const MAX_BACKUP_FILE = 32 * 1024 * 1024;
export const MAX_BACKUP_PLAINTEXT = 16 * 1024 * 1024;
export class BackupError extends Error {
 constructor(code) { super(code); this.code = code; }
}
const fail = (code = "backup_unreadable") => { throw new BackupError(code); };
function passphraseBytes(input) {
 if (!(input instanceof Uint8Array) || input.length > 4098) fail("passphrase_input");
 let value = Buffer.from(input);
 try { new TextDecoder("utf-8", { fatal: true }).decode(value); } catch { value.fill(0); fail("passphrase_input"); }
 if (value.at(-1) === 10) { const end = value.at(-2) === 13 ? value.length - 2 : value.length - 1; value = value.subarray(0, end); }
 if (value.length < 12) { value.fill(0); fail("passphrase_input"); }
 return value;
}
export function validateBackupPassphrase(input) { const value = passphraseBytes(input); value.fill(0); return true; }
const b64 = value => Buffer.from(value).toString("base64url");
function raw(value, size, max) {
 if (typeof value !== "string" || value.length > Math.ceil((size || max) * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
 const bytes = Buffer.from(value, "base64url");
 if (b64(bytes) !== value || (size && bytes.length !== size) || (max && bytes.length > max)) fail();
 return bytes;
}
function keyFor(passphrase, salt) { return scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }); }
export function sealBackup(snapshot, passphrase) {
 let password, key, plaintext;
 try {
  plaintext = Buffer.from(canonicalJSON(snapshot));
  if (plaintext.length > MAX_BACKUP_PLAINTEXT) fail("backup_too_large");
  password = passphraseBytes(passphrase);
  const salt = randomBytes(32), nonce = randomBytes(12);
  const header = { format: "a2a-exposed local backup", v: 1, kdf: "scrypt", N: 32768, r: 8, p: 1, salt: b64(salt), nonce: b64(nonce) };
  key = keyFor(password, salt);
  const cipher = createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(Buffer.from(canonicalJSON(header)));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]); plaintext.fill(0);
  const text = canonicalJSON({ ...header, ct: b64(ciphertext) });
  if (Buffer.byteLength(text) > MAX_BACKUP_FILE) fail("backup_too_large");
  return text + "\n";
 } catch (error) { if (error instanceof BackupError) throw error; fail(); }
 finally { password?.fill(0); key?.fill(0); plaintext?.fill(0); }
}
export function openBackup(text, passphrase) {
 let password, key, plaintext;
 try {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BACKUP_FILE) fail("backup_too_large");
  const envelope = parseJSON(text, MAX_BACKUP_FILE);
  if (!envelope || typeof envelope !== "object" || Object.keys(envelope).sort().join() !== ["format","v","kdf","N","r","p","salt","nonce","ct"].sort().join()) fail();
  if (envelope.format !== "a2a-exposed local backup" || envelope.v !== 1 || envelope.kdf !== "scrypt" || envelope.N !== 32768 || envelope.r !== 8 || envelope.p !== 1) fail();
  const salt = raw(envelope.salt, 32), nonce = raw(envelope.nonce, 12), ct = raw(envelope.ct, 0, MAX_BACKUP_PLAINTEXT + 16);
  if (ct.length < 16) fail();
  const { ct: ignored, ...header } = envelope;
  password = passphraseBytes(passphrase); key = keyFor(password, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce); decipher.setAAD(Buffer.from(canonicalJSON(header))); decipher.setAuthTag(ct.subarray(-16));
  plaintext = Buffer.concat([decipher.update(ct.subarray(0, -16)), decipher.final()]);
  if (plaintext.length > MAX_BACKUP_PLAINTEXT) fail("backup_too_large");
  const value = parseJSON(new TextDecoder("utf-8", { fatal: true }).decode(plaintext), MAX_BACKUP_PLAINTEXT);
  if (canonicalJSON(value) !== plaintext.toString("utf8")) fail();
  return value;
 } catch (error) { if (error instanceof BackupError) throw error; fail(); }
 finally { password?.fill(0); key?.fill(0); plaintext?.fill(0); }
}
