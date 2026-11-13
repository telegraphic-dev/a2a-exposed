// Public-key verification only: deliberately no HPKE or private-key dependency.
import { b64urlDecode, b64urlEncode, canonicalCardUrl } from "./address.ts";
export const SEALED_URI = "https://a2a.exposed/ext/sealed/v1";
export const SEALED_KEY_SETTING = "sealed_public_bundle";
export function canonical(value: any): string {
 if (value === null || typeof value !== "object") return JSON.stringify(value);
 if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
 return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
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
 const bytes = (v: any, size?: number) => { const b = typeof v === "string" ? b64urlDecode(v) : null; if (!b || b64urlEncode(b) !== v || size !== undefined && b.length !== size) bad(); return b!; };
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
