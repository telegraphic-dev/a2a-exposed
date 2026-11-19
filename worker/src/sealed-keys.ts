import { safetyEmojiFromHex } from "./safety-emoji.ts";
// Public-key verification only: deliberately no HPKE or private-key dependency.
import { b64urlDecode, b64urlEncode, canonicalCardUrl } from "./address.ts";
export const SEALED_URI = "https://a2a.exposed/ext/sealed/v1";
export const SEALED_KEY_SETTING = "sealed_public_bundle";
export function canonical(value: any): string {
 if (value === null || typeof value !== "object") return JSON.stringify(value);
 if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
 return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}
/** The safety code the local CLI prints for a key pairing (encryption/local-state.mjs localSafetyCode): 12 groups
 *  of 5 digits over the public card URL, identity key and key ID of both bundles. Order of the arguments does not matter. */
async function safetyFingerprint(a: any, b: any): Promise<string> {
 const cmp = (x: Uint8Array, y: Uint8Array) => { for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]; return x.length - y.length; };
 const tuples = [a, b].map(x => ({ cardUrl: x.cardUrl, identityKey: x.identityKey, keyId: x.keyId }))
  .sort((p, q) => cmp(b64urlDecode(p.identityKey) || new Uint8Array(), b64urlDecode(q.identityKey) || new Uint8Array()) || p.cardUrl.localeCompare(q.cardUrl));
 const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("a2a-exposed sealed safety v1\n" + canonical(tuples))));
 const hex = Array.from(digest, v => v.toString(16).padStart(2, "0")).join("");
 return hex;
}
export async function safetyEmoji(a: any, b: any) { return safetyEmojiFromHex(await safetyFingerprint(a, b)); }
export async function safetyCode(a: any, b: any): Promise<string> {
 const hex = await safetyFingerprint(a, b);
 return (BigInt("0x" + hex) % 10n ** 60n).toString().padStart(60, "0").match(/.{5}/g)!.join(" ");
}
/** Safety code for a stored pairing request, or null when it is not a key pairing or its stored bundles do not parse. */
export async function requestSafetyCode(r: { sealed_requester?: unknown; sealed_responder?: unknown }): Promise<string | null> {
 if (!r.sealed_requester || !r.sealed_responder) return null;
 try { return await safetyCode(JSON.parse(String(r.sealed_requester)), JSON.parse(String(r.sealed_responder))); } catch { return null; }
}
export async function verifyPublicBundle(value: any, cardUrl?: string): Promise<any> {
 const bad = () => { throw Error("invalid sealed public bundle"); };
 if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "cardUrl,encryptionKey,identityKey,keyId,notBefore,signature,suite,v") bad();
 if (value.v !== 1 || value.suite !== "HPKE-X25519-SHA256-ChaCha20Poly1305" || canonicalCardUrl(value.cardUrl) !== value.cardUrl || cardUrl && value.cardUrl !== cardUrl) bad();
 for (const k of ["identityKey", "encryptionKey", "keyId", "signature"]) {
  const bytes = b64urlDecode(value[k]);
  if (!bytes || bytes.length !== (k === "signature" ? 64 : 32) || b64urlEncode(bytes) !== value[k]) bad();
 }
 if (typeof value.notBefore !== "string" || !Number.isFinite(Date.parse(value.notBefore)) || new Date(value.notBefore).toISOString() !== value.notBefore || Date.parse(value.notBefore) > Date.now() + 300000) bad();
 const encryption = b64urlDecode(value.encryptionKey)!;
 if (b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", encryption as BufferSource))) !== value.keyId) bad();
 const { signature, ...body } = value;
 const key = await crypto.subtle.importKey("raw", b64urlDecode(value.identityKey)! as BufferSource, "Ed25519", false, ["verify"]);
 if (!await crypto.subtle.verify("Ed25519", key, b64urlDecode(signature)! as BufferSource, new TextEncoder().encode("a2a-exposed sealed key v1\n" + canonical(body)))) bad();
 return JSON.parse(canonical(value));
}

// No HPKE/private-key code runs on the server. Verify signed public routing,
// the approved bundles and the exact ciphertext-only carrier before persistence.
const exact = (v: any, keys: string[]) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === [...keys].sort().join(",");
export function envelopeOf(message: any): any | null {
 return message?.extensions?.includes(SEALED_URI) ? message.parts?.[0]?.data : null;
}
export async function verifyMessage(message: any, requester: any, responder: any): Promise<any> {
 const bad = () => { throw Error("invalid sealed message"); };
 if (!exact(message, ["kind", "role", "messageId", "contextId", "parts", "extensions", ...(message.taskId === undefined ? [] : ["taskId"])]) || message.kind !== "message" || message.role !== "user" || canonical(message.extensions) !== canonical([SEALED_URI]) || message.parts?.length !== 1) bad();
 const part = message.parts[0];
 if (!exact(part, ["kind", "data", "metadata"]) || part.kind !== "data" || canonical(part.metadata) !== canonical({ [SEALED_URI]: { v: 1 } })) bad();
 const e = part.data;
 if (!exact(e, ["v", "suite", "header", "recipient", "sender", "signature"]) || e.v !== 1 || e.suite !== "HPKE-X25519-SHA256-ChaCha20Poly1305") bad();
 const h = e.header;
 if (!exact(h, ["from", "to", "contextId", "messageId", "taskId", "role", "state", "kind", "sentAt", "commitment"])) bad();
 const identity = (b: any) => ({ cardUrl: b.cardUrl, identityKey: b.identityKey, keyId: b.keyId });
 if (canonical(h.from) !== canonical(identity(requester)) || canonical(h.to) !== canonical(identity(responder)) || h.role !== "user" || h.kind !== "message" || h.state !== null || h.contextId !== message.contextId || h.messageId !== message.messageId || h.taskId !== (message.taskId ?? null)) bad();
 for (const id of [h.contextId, h.messageId, ...(h.taskId === null ? [] : [h.taskId])]) if (typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(id)) bad();
 if (typeof h.sentAt !== "string" || !Number.isFinite(Date.parse(h.sentAt)) || new Date(h.sentAt).toISOString() !== h.sentAt || Date.parse(h.sentAt) > Date.now() + 300000 || Date.parse(h.sentAt) < Date.now() - 30 * 86400000) bad();
 const bytes = (v: any, size?: number) => {
  const max = Math.ceil((size ?? (300 * 1024 + 16)) * 4 / 3);
  if (typeof v !== "string" || v.length > max || !/^[A-Za-z0-9_-]+$/.test(v)) bad();
  let b: Uint8Array;
  try { const raw = atob(v.replace(/-/g,"+").replace(/_/g,"/") + "=".repeat((4-v.length%4)%4)); b = Uint8Array.from(raw, c => c.charCodeAt(0)); } catch { bad(); }
  if ((size !== undefined && b!.length !== size) || b64urlEncode(b!) !== v) bad();
  return b!;
 };
 bytes(h.commitment, 32);
 for (const copy of [e.recipient, e.sender]) {
  if (!exact(copy, ["enc", "ct"])) bad();
  bytes(copy.enc, 32); const ct = bytes(copy.ct); if (ct.length < 16 || ct.length > 300 * 1024 + 16) bad();
 }
 const key = await crypto.subtle.importKey("raw", bytes(requester.identityKey, 32) as BufferSource, "Ed25519", false, ["verify"]);
 const { signature, ...body } = e;
 if (!await crypto.subtle.verify("Ed25519", key, bytes(signature, 64) as BufferSource, new TextEncoder().encode("a2a-exposed sealed envelope v1\n" + canonical(body)))) bad();
 return e;
}

export async function requestSafetyEmoji(r: { sealed_requester?: unknown; sealed_responder?: unknown }) {
 if (!r.sealed_requester || !r.sealed_responder) return null;
 try { return await safetyEmoji(JSON.parse(String(r.sealed_requester)), JSON.parse(String(r.sealed_responder))); } catch { return null; }
}
