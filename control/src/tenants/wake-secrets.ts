// Wake secrets sealed for one inbox record. The writer stores `secrets_enc`; the inbox
// object decrypts it when it builds the context. A single-inbox deploy does not use this.
// Keep worker/src/wake-secrets.ts in step with this file.

const INFO = "tenant-wake-secrets v1";
const SALT = "a2a-exposed";

/** Sealed secret fields. Anything else in the blob is ignored. */
export const WAKE_SECRET_KEYS = [
	"WAKE_WEBHOOK_KEY",
	"WAKE_HMAC_SECRET",
	"WAKE_ACCESS_CLIENT_ID",
	"WAKE_ACCESS_CLIENT_SECRET",
	"EVENT_SECRET",
	"UPSTREAM_TOKEN",
	"UPSTREAM_ACCESS_CLIENT_ID",
	"UPSTREAM_ACCESS_CLIENT_SECRET",
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

/** Longest envelope: `v2.<64-char kid>.<iv>.<ciphertext>`. */
export const MAX_WAKE_SEALED = 3 + 64 + 1 + 16 + 1 + Math.ceil((MAX_WAKE_PLAIN * 3 + 16) * 4 / 3);

/** A bounded keyring lives in the existing secret binding, never in public config. */
export interface TenantSecretsKeyring {
	active: string;
	keys: Record<string, string>;
	legacy: boolean;
}

/** Raw keys preserve v1 writes for a reader-first rollout. JSON keyrings enable v2 writes. */
export function tenantSecretsKeyring(input: string): TenantSecretsKeyring | null {
	if (!input) return null;
	if (!input.trimStart().startsWith("{")) return { active: "", keys: { "": input }, legacy: true };
	if (input.length > 65536) return null;
	try {
		const value = JSON.parse(input);
		if (!value || value.v !== 2 || typeof value.active !== "string" ||
			!value.keys || typeof value.keys !== "object" || Array.isArray(value.keys) ||
			Object.keys(value).some((name) => !["v", "active", "keys"].includes(name))) return null;
		const entries = Object.entries(value.keys);
		if (entries.length < 1 || entries.length > 2 || !Object.hasOwn(value.keys, value.active)) return null;
		for (const [kid, key] of entries) {
			if (!/^[A-Za-z0-9_-]{1,64}$/.test(kid) || typeof key !== "string" || !key.trim() || key.length > 4096) return null;
		}
		return { active: value.active, keys: value.keys, legacy: false };
	} catch { return null; }
}

/** Current material first, then the single read-only rotation key. No caller may log these values. */
export function tenantSecretsMaterials(input: string): string[] {
	const ring = tenantSecretsKeyring(input);
	if (!ring) return [];
	return [ring.keys[ring.active], ...Object.entries(ring.keys).filter(([kid]) => kid !== ring.active).map(([, key]) => key)];
}

function unreadable(): null {
	// Only a fixed event: ciphertext, key ids, credentials and tenant identifiers never enter logs.
	console.error(JSON.stringify({ event: "wake_secrets_unreadable", level: "error" }));
	return null;
}

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

/**
 * Config written next to a sealed blob. The sealed fields stay in `secrets_enc`.
 * With no ciphertext, the config is returned unchanged.
 */
export function omitSealedSecrets<T extends Record<string, unknown>>(config: T, secretsEnc: string | null | undefined): T {
	if (typeof secretsEnc !== "string" || secretsEnc === "") return config;
	const stored = { ...config };
	for (const key of WAKE_SECRET_KEYS) delete stored[key];
	return stored;
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

/** `v2.<kid>.<iv>.<ciphertext>` for keyrings; raw keys keep v1 writes until rollout completes. */
export async function sealWakeSecrets(ikm: string, tenantId: string, secrets: WakeSecrets): Promise<string | null> {
	const ring = tenantSecretsKeyring(ikm);
	const key = ring ? await derive(ring.keys[ring.active], tenantId) : null;
	const payload = payloadOf(secrets);
	if (!key || !payload) return null;
	const json = JSON.stringify(payload);
	const encoded = new TextEncoder().encode(json);
	if (json.length > MAX_WAKE_PLAIN || encoded.length > MAX_WAKE_PLAIN * 3) return null;
	const prefix = ring!.legacy ? "v1" : `v2.${ring!.active}`;
	const aad = ring!.legacy ? tenantId : `${prefix}\0${tenantId}`;
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
		key,
		encoded,
	));
	const sealed = `${prefix}.${b64(iv)}.${b64(ct)}`;
	return sealed.length <= MAX_WAKE_SEALED ? sealed : null;
}

/**
 * The sealed fields, `{}` when there is nothing to open, or null when the blob cannot be read.
 * A null result must not be treated as "no secrets": the caller keeps the previous ciphertext.
 */
export async function openWakeSecrets(ikm: string, tenantId: string, sealed: string | null | undefined): Promise<WakeSecrets | null> {
	if (sealed == null || sealed === "") return {};
	if (typeof sealed !== "string" || sealed.length > MAX_WAKE_SEALED) return unreadable();
	const ring = tenantSecretsKeyring(ikm);
	if (!ring || !tenantId) return unreadable();
	const parts = sealed.split(".");
	const version = parts[0];
	const kid = version === "v2" ? parts[1] : "";
	if (version !== "v1" && version !== "v2") return unreadable();
	if (parts.length !== (version === "v2" ? 4 : 3)) return unreadable();
	const [iv, ct] = parts.slice(version === "v2" ? 2 : 1);
	if (!iv || !ct || (version === "v2" && (ring.legacy || !Object.hasOwn(ring.keys, kid)))) return unreadable();
	const materials = version === "v2" ? [ring.keys[kid]] : tenantSecretsMaterials(ikm);
	const aad = version === "v2" ? `v2.${kid}\0${tenantId}` : tenantId;
	for (const material of materials) {
		try {
			const key = await derive(material, tenantId);
			if (!key) continue;
			const ivBytes = unb64(iv);
			if (ivBytes.length !== 12) return unreadable();
			const plain = new TextDecoder().decode(await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv: ivBytes, additionalData: new TextEncoder().encode(aad) },
				key,
				unb64(ct),
			));
			if (plain.length > MAX_WAKE_PLAIN) return unreadable();
			const parsed = JSON.parse(plain) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return unreadable();
			const out: WakeSecrets = {};
			for (const name of WAKE_SECRET_KEYS) {
				const value = (parsed as Record<string, unknown>)[name];
				if (typeof value !== "string" || !value || value.length > MAX_WAKE_VALUE) continue;
				out[name] = value;
			}
			return out;
		} catch { /* Try the previous key only for an unlabelled v1 blob. */ }
	}
	return unreadable();
}

/** Pure maintenance helper. The caller must CAS the original blob and queue the new tenant config. */
export async function rewrapWakeSecrets(ikm: string, tenantId: string, sealed: string): Promise<string | null> {
	if (!sealed) return null;
	const secrets = await openWakeSecrets(ikm, tenantId, sealed);
	return secrets ? sealWakeSecrets(ikm, tenantId, secrets) : null;
}
