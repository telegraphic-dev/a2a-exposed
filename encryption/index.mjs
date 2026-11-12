// Local-only primitives for a review-draft extension. No transport/key storage is enabled here.
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";

export const EXTENSION = "https://a2a.exposed/ext/sealed/v1";
export const SUITE = "HPKE-X25519-SHA256-ChaCha20Poly1305";
export const MAX_PLAINTEXT = 300 * 1024;
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() });
const encode = value => encoder.encode(value);
const b64 = bytes => Buffer.from(bytes).toString("base64url");
export class EncryptionError extends Error {
 constructor(code) { super(code); this.name = "EncryptionError"; this.code = code; }
}
const refuse = (code = "verification_failed") => { throw new EncryptionError(code); };
function raw(value, length) {
 if (typeof value !== "string" || value.length > Math.ceil((length ?? (MAX_PLAINTEXT + 16)) * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) refuse();
 const bytes = Buffer.from(value, "base64url");
 if (b64(bytes) !== value || (length !== undefined && bytes.length !== length)) refuse();
 return new Uint8Array(bytes);
}
function fields(value, names) {
 if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) refuse();
 const keys = Object.keys(value).sort();
 if (keys.join("\0") !== [...names].sort().join("\0")) refuse();
}
function validString(value) {
 if (typeof value !== "string") refuse();
 for (const char of value) { const point = char.codePointAt(0); if (point >= 0xd800 && point <= 0xdfff) refuse(); }
}
export function canonicalJSON(value, depth = 0) {
 if (depth > 32) refuse("content_unsupported");
 if (value === null || typeof value === "boolean") return JSON.stringify(value);
 if (typeof value === "string") { validString(value); return JSON.stringify(value); }
 if (typeof value === "number") { if (!Number.isFinite(value)) refuse("content_unsupported"); return JSON.stringify(value); }
 if (Array.isArray(value)) {
  if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) refuse("content_unsupported");
  const items = [];
  for (let index = 0; index < value.length; index++) {
   const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
   if (!descriptor || !("value" in descriptor)) refuse("content_unsupported");
   items.push(canonicalJSON(descriptor.value, depth + 1));
  }
  return "[" + items.join(",") + "]";
 }
 if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== Object.keys(value).length) refuse("content_unsupported");
 return "{" + Object.keys(value).sort().map(key => {
  validString(key); const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) refuse("content_unsupported");
  return JSON.stringify(key) + ":" + canonicalJSON(descriptor.value, depth + 1);
 }).join(",") + "}";
}
// JSON.parse first establishes grammar. Then a bounded token walk rejects duplicate members
// before normalisation could erase a signed/unsigned disagreement.
export function parseJSON(text) {
 if (typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024) refuse("content_too_large");
 let value; try { value = JSON.parse(text); } catch { refuse(); }
 const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) || [];
 let offset = 0;
 function walk(depth) {
  if (depth > 32) refuse("content_unsupported");
  const token = tokens[offset++];
  if (token === "{") {
   const seen = new Set();
   if (tokens[offset] === "}") { offset++; return; }
   for (;;) {
    const key = JSON.parse(tokens[offset++]); if (seen.has(key)) refuse(); seen.add(key);
    offset++; walk(depth + 1);
    if (tokens[offset++] === "}") return;
   }
  }
  if (token === "[") {
   if (tokens[offset] === "]") { offset++; return; }
   for (;;) { walk(depth + 1); if (tokens[offset++] === "]") return; }
  }
 }
 walk(0); canonicalJSON(value); return value;
}
const digest = async bytes => b64(await crypto.subtle.digest("SHA-256", bytes));
const sign = async (key, bytes) => b64(await crypto.subtle.sign("Ed25519", key, bytes));
async function verify(key, signature, bytes) {
 const publicKey = await crypto.subtle.importKey("raw", raw(key, 32), "Ed25519", false, ["verify"]);
 if (!await crypto.subtle.verify("Ed25519", publicKey, raw(signature, 64), bytes)) refuse();
}
function clock(now) {
 if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) refuse();
}
function timestamp(value) {
 if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) refuse();
}
function card(value) {
 if (typeof value !== "string" || value.length > 2048) refuse();
 let url; try { url = new URL(value); } catch { refuse(); }
 if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || url.href !== value) refuse();
 // DNS/SSRF checks are the transport's responsibility. Key bundles never cause a fetch.
}
function peer(value) { fields(value, ["cardUrl", "identityKey", "keyId"]); card(value.cardUrl); raw(value.identityKey, 32); raw(value.keyId, 32); }
const identityOf = bundle => ({ cardUrl: bundle.cardUrl, identityKey: bundle.identityKey, keyId: bundle.keyId });
function header(value, now) {
 clock(now);
 fields(value, ["from", "to", "contextId", "messageId", "taskId", "role", "state", "kind", "sentAt", "commitment"]);
 peer(value.from); peer(value.to);
 for (const id of [value.contextId, value.messageId]) if (typeof id !== "string" || !/^[\x21-\x7e]{1,200}$/.test(id)) refuse();
 if (value.taskId !== null && (typeof value.taskId !== "string" || !/^[\x21-\x7e]{1,200}$/.test(value.taskId))) refuse();
 if (!["user", "agent"].includes(value.role) || !["message", "status", "artifact"].includes(value.kind)) refuse();
 if (value.state !== null && !["submitted", "working", "input-required", "completed", "failed", "canceled", "rejected", "auth-required"].includes(value.state)) refuse();
 if (value.taskId === null && (value.role !== "user" || value.kind !== "message" || value.state !== null)) refuse();
 timestamp(value.sentAt); raw(value.commitment, 32);
 if (Date.parse(value.sentAt) < now - 30 * 86400000 || Date.parse(value.sentAt) > now + 300000) refuse("replay");
}
function bundleBody(bundle) { const { signature, ...body } = bundle; return body; }
function envelopeBody(envelope) { const { signature, ...body } = envelope; return body; }
async function verifyBundleRaw(bundle, { cardUrl, identityKey, now = Date.now() }) {
 clock(now);
 fields(bundle, ["v", "suite", "cardUrl", "identityKey", "encryptionKey", "keyId", "notBefore", "signature"]);
 if (bundle.v !== 1 || bundle.suite !== SUITE) refuse("extension_unsupported");
 card(bundle.cardUrl); timestamp(bundle.notBefore);
 if (bundle.cardUrl !== cardUrl || bundle.identityKey !== identityKey || Date.parse(bundle.notBefore) > now + 300000) refuse("key_changed");
 if (await digest(raw(bundle.encryptionKey, 32)) !== bundle.keyId) refuse();
 await verify(identityKey, bundle.signature, encode("a2a-exposed sealed key v1\n" + canonicalJSON(bundleBody(bundle))));
 return bundle;
}
async function generateIdentityRaw(cardUrl, now = Date.now()) {
 clock(now); card(cardUrl);
 const signing = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
 const encryption = await suite.kem.generateKeyPair();
 const body = { v: 1, suite: SUITE, cardUrl, identityKey: b64(await crypto.subtle.exportKey("raw", signing.publicKey)), encryptionKey: b64(await suite.kem.serializePublicKey(encryption.publicKey)), notBefore: new Date(now).toISOString() };
 body.keyId = await digest(raw(body.encryptionKey, 32));
 const bundle = { ...body, signature: await sign(signing.privateKey, encode("a2a-exposed sealed key v1\n" + canonicalJSON(body))) };
 return { signingKey: signing.privateKey, encryptionKey: encryption.privateKey, bundle };
}
async function commitment(nonce, content) {
 const bytes = encode(canonicalJSON(content)), salt = raw(nonce, 32);
 const joined = new Uint8Array(salt.length + bytes.length); joined.set(salt); joined.set(bytes, salt.length);
 return digest(joined);
}
async function sealCopy(bundle, plaintext, aad, purpose) {
 const publicKey = await suite.kem.deserializePublicKey(raw(bundle.encryptionKey, 32));
 const context = await suite.createSenderContext({ recipientPublicKey: publicKey, info: encode("a2a-exposed sealed v1 " + purpose) });
 return { enc: b64(context.enc), ct: b64(await context.seal(plaintext, aad)) };
}
// The caller must supply locally pinned bundles, and must enforce policy and replay state.
async function sealRaw({ identity, recipient, binding, content, now = Date.now() }) {
 fields(binding, ["contextId", "messageId", "taskId", "role", "state", "kind"]);
 await verifyBundle(identity.bundle, { cardUrl: identity.bundle.cardUrl, identityKey: identity.bundle.identityKey, now });
 await verifyBundle(recipient, { cardUrl: recipient.cardUrl, identityKey: recipient.identityKey, now });
 const nonce = b64(crypto.getRandomValues(new Uint8Array(32)));
 const plaintext = encode(canonicalJSON({ nonce, content }));
 if (plaintext.length > MAX_PLAINTEXT) refuse("content_too_large");
 const h = { ...binding, from: identityOf(identity.bundle), to: identityOf(recipient), sentAt: new Date(now).toISOString(), commitment: await commitment(nonce, content) };
 header(h, now); const aad = encode(canonicalJSON(h));
 const body = { v: 1, suite: SUITE, header: h, recipient: await sealCopy(recipient, plaintext, aad, "recipient"), sender: await sealCopy(identity.bundle, plaintext, aad, "sender") };
 const envelope = { ...body, signature: await sign(identity.signingKey, encode("a2a-exposed sealed envelope v1\n" + canonicalJSON(body))) };
 if (Buffer.byteLength(canonicalJSON(envelope)) > 1024 * 1024) refuse("content_too_large");
 await open({ envelope, identity, sender: identity.bundle, recipient, expected: binding, purpose: "sender", now });
 return envelope;
}
async function openRaw({ envelope, identity, sender, recipient, expected, purpose = "recipient", now = Date.now() }) {
 try {
  if (typeof envelope === "string") envelope = parseJSON(envelope);
  fields(envelope, ["v", "suite", "header", "recipient", "sender", "signature"]);
  if (envelope.v !== 1 || envelope.suite !== SUITE) refuse("extension_unsupported");
  if (!["recipient", "sender"].includes(purpose)) refuse();
  header(envelope.header, now);
  // Exact expected bindings are mandatory. An unassigned initial task must be pinned by the ledger.
  fields(expected, ["contextId", "messageId", "taskId", "role", "state", "kind"]);
  for (const key of Object.keys(expected)) if (expected[key] !== envelope.header[key]) refuse();
  if (canonicalJSON(envelope.header.from) !== canonicalJSON(identityOf(sender)) || canonicalJSON(envelope.header.to) !== canonicalJSON(identityOf(recipient))) refuse("key_changed");
  const own = purpose === "sender" ? sender : recipient;
  if (canonicalJSON(identityOf(identity.bundle)) !== canonicalJSON(identityOf(own))) refuse("key_lost");
  await verifyBundle(sender, { cardUrl: sender.cardUrl, identityKey: sender.identityKey, now });
  await verifyBundle(recipient, { cardUrl: recipient.cardUrl, identityKey: recipient.identityKey, now });
  for (const copy of [envelope.recipient, envelope.sender]) {
   fields(copy, ["enc", "ct"]); raw(copy.enc, 32); const ct = raw(copy.ct);
   if (ct.length < 16 || ct.length > MAX_PLAINTEXT + 16) refuse("content_too_large");
  }
  await verify(sender.identityKey, envelope.signature, encode("a2a-exposed sealed envelope v1\n" + canonicalJSON(envelopeBody(envelope))));
  const copy = envelope[purpose];
  const context = await suite.createRecipientContext({ recipientKey: identity.encryptionKey, enc: raw(copy.enc, 32), info: encode("a2a-exposed sealed v1 " + purpose) });
  const plaintext = await context.open(raw(copy.ct), encode(canonicalJSON(envelope.header)));
  if (plaintext.byteLength > MAX_PLAINTEXT) refuse("content_too_large");
  const payload = parseJSON(decoder.decode(plaintext)); fields(payload, ["nonce", "content"]);
  if (await commitment(payload.nonce, payload.content) !== envelope.header.commitment) refuse();
  return payload.content;
 } catch (error) {
  if (error instanceof EncryptionError) throw error;
  refuse(); // Never expose HPKE/JSON/provider exception strings or material.
 }
}

async function safeCall(action) {
 try { return await action(); } catch (error) {
  if (error instanceof EncryptionError) throw error;
  refuse();
 }
}
export const verifyBundle = (...args) => safeCall(() => verifyBundleRaw(...args));
export const generateIdentity = (...args) => safeCall(() => generateIdentityRaw(...args));
export const seal = (...args) => safeCall(() => sealRaw(...args));
export const open = (...args) => safeCall(() => openRaw(...args));
