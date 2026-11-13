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
