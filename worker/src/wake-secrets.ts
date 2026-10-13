// Wake secrets sealed for one inbox record. The writer stores `secrets_enc`; the inbox
// object decrypts it when it builds the context. A single-inbox deploy does not use this.
// Keep control/src/tenants/wake-secrets.ts in step with this file.

const INFO = "tenant-wake-secrets v1";
const SALT = "a2a-exposed";

/** Secret wake fields. Anything else in the blob is ignored. */
export const WAKE_SECRET_KEYS = [
	"WAKE_WEBHOOK_KEY",
	"WAKE_HMAC_SECRET",
	"WAKE_ACCESS_CLIENT_ID",
	"WAKE_ACCESS_CLIENT_SECRET",
] as const;

export type WakeSecretKey = (typeof WAKE_SECRET_KEYS)[number];
export type WakeSecrets = Partial<Record<WakeSecretKey, string>>;

/** One secret. The form uses the same cap. */
export const MAX_WAKE_VALUE = 4096;

/**
 * Largest JSON payload `sealWakeSecrets` will write. A character can become `\u0000` (six characters),
 * and every known field may be present. `openWakeSecrets` accepts this and nothing larger.
 */
export const MAX_WAKE_PLAIN = (() => {
	let n = 2;
	for (let i = 0; i < WAKE_SECRET_KEYS.length; i++) {
		if (i) n += 1;
		n += WAKE_SECRET_KEYS[i].length + 5 + MAX_WAKE_VALUE * 6;
	}
	return n;
})();

/** `v1.` + base64(12-byte iv) + `.` + base64(utf-8 plaintext + 16-byte tag). */
export const MAX_WAKE_SEALED = 3 + 16 + 1 + Math.ceil((MAX_WAKE_PLAIN * 3 + 16) * 4 / 3);

function b64(bytes: Uint8Array): string {
	let raw = "";
	for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(raw);
}
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(ikm: string, tenantId: string): Promise<CryptoKey | null> {
	if (!ikm || !tenantId) return null;
	const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(ikm), "HKDF", false, ["deriveKey"]);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode(SALT), info: new TextEncoder().encode(`${INFO}\0${tenantId}`) },
		base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
	);
}

function payloadOf(secrets: WakeSecrets): Record<string, string> | null {
	const payload: Record<string, string> = {};
	for (const key of WAKE_SECRET_KEYS) {
		const value = secrets[key];
		if (value == null || value === "") continue;
		if (typeof value !== "string" || value.length > MAX_WAKE_VALUE) return null;
		payload[key] = value;
	}
	return payload;
}

/** `v1.<iv>.<ciphertext>`, or null when the key or a value is unusable. */
export async function sealWakeSecrets(ikm: string, tenantId: string, secrets: WakeSecrets): Promise<string | null> {
	const key = await derive(ikm, tenantId);
	const payload = payloadOf(secrets);
	if (!key || !payload) return null;
	const json = JSON.stringify(payload);
	const encoded = new TextEncoder().encode(json);
	if (json.length > MAX_WAKE_PLAIN || encoded.length > MAX_WAKE_PLAIN * 3) return null;
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(tenantId) },
		key,
		encoded,
	));
	const sealed = `v1.${b64(iv)}.${b64(ct)}`;
	return sealed.length <= MAX_WAKE_SEALED ? sealed : null;
}

/**
 * The sealed fields, `{}` when there is nothing to open, or null when the blob cannot be read.
 * A null result must not be treated as "no secrets": the caller keeps the previous ciphertext.
 */
export async function openWakeSecrets(ikm: string, tenantId: string, sealed: string | null | undefined): Promise<WakeSecrets | null> {
	if (sealed == null || sealed === "") return {};
	if (sealed.length > MAX_WAKE_SEALED) return null;
	const key = await derive(ikm, tenantId);
	if (!key) return null;
	const [version, iv, ct, extra] = sealed.split(".");
	if (version !== "v1" || !iv || !ct || extra !== undefined) return null;
	try {
		const plain = new TextDecoder().decode(await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: unb64(iv), additionalData: new TextEncoder().encode(tenantId) },
			key,
			unb64(ct),
		));
		if (plain.length > MAX_WAKE_PLAIN) return null;
		const parsed = JSON.parse(plain) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const out: WakeSecrets = {};
		for (const name of WAKE_SECRET_KEYS) {
			const value = (parsed as Record<string, unknown>)[name];
			if (typeof value !== "string" || !value || value.length > MAX_WAKE_VALUE) continue;
			out[name] = value;
		}
		return out;
	} catch {
		return null;
	}
}
