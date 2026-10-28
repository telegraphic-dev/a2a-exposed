import type { Sql } from "../core/sql.ts";
import { TENANT_NAME } from "./reserved.ts";
import { deliverOutbox, type DataPlane, type OutboxRow } from "./push.ts";
import { WAKE_SECRET_KEYS, openWakeSecrets, sealWakeSecrets, type WakeSecrets } from "./wake-secrets.ts";

/** The same list the Worker renders. Claude Code is one of them. */
export const WAKE_PRESETS = ["grok-bot", "claude-code", "openclaw-wake", "openclaw-agent", "hermes", "openbot", "generic"] as const;

/** Headers a wake preview shows in full. A key header must not be one of these. */
const PLAIN_HEADERS = new Set([
	"content-type", "user-agent", "x-request-id", "idempotency-key", "anthropic-version", "x-webhook-timestamp", "x-openbot-timestamp", "x-openbot-delivery-id",
]);

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

export interface WakeSettings {
	url: string;
	preset: string;
	keyHeader: string;
}

/** Blank credentials retain a saved value only for the same URL and authentication mode.
 * Callers validate public DNS before saving; the Worker enforces its delivery policy separately. */
export interface WakeSaveInput {
	accountId: string;
	name: string;
	url: string;
	preset: string;
	keyHeader: string;
	key: string;
	hmacSecret?: string;
	/** Version of the settings the caller tested. A stale version makes no write. */
	expectedVersion?: number;
}

export type WakeSave =
	| { ok: true }
	| { ok: false; error: "url" | "preset" | "header" | "key" | "unavailable" | "unreadable" | "conflict" };

interface TenantRow {
	id: string;
	name: string;
	status: string;
	region: string;
	config_json: string;
	limits_json: string;
	approval_json: string;
	owner_token_hash: string;
	secrets_enc: string | null;
	config_version: number;
}

export function configFields(text: string): Record<string, string> {
	try {
		const value = JSON.parse(text) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		const out: Record<string, string> = {};
		for (const [key, item] of Object.entries(value)) if (typeof item === "string") out[key] = item;
		return out;
	} catch {
		return {};
	}
}

/** https URL with no userinfo, or a problem code. An empty URL clears the wake. */
export function wakeUrlProblem(value: string): string {
	if (!value) return "";
	if (value.length > 2000) return "url";
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password) return "url";
		return "";
	} catch {
		return "url";
	}
}

export function wakeHeaderProblem(value: string): string {
	if (!value) return "";
	if (!HEADER_NAME.test(value) || PLAIN_HEADERS.has(value.toLowerCase())) return "header";
	return "";
}

export function wakeSettingsOf(config: Record<string, string>): WakeSettings {
	const preset = WAKE_PRESETS.includes(config.WAKE_PRESET as (typeof WAKE_PRESETS)[number]) ? config.WAKE_PRESET : "generic";
	return {
		url: config.WAKE_WEBHOOK_URL ?? "",
		preset,
		keyHeader: config.WAKE_KEY_HEADER ?? "",
	};
}

/** The signed-in account's agent, or null. Another account's agent is the same result. */
export async function tenantForAccount(db: Sql, accountId: string, name: string): Promise<TenantRow | null> {
	if (!TENANT_NAME.test(name)) return null;
	return db.prepare(
		`SELECT id, name, status, region, config_json, limits_json, approval_json, owner_token_hash, secrets_enc, config_version
		 FROM tenants WHERE name = ? AND owner_account_id = ?`,
	).bind(name, accountId).first<TenantRow>();
}

export async function saveWakeSettings(
	db: Sql,
	plane: DataPlane,
	secretsKey: string,
	input: WakeSaveInput,
): Promise<WakeSave> {
	const row = await tenantForAccount(db, input.accountId, input.name);
	if (!row || (input.expectedVersion !== undefined && input.expectedVersion !== row.config_version)) return { ok: false, error: "conflict" };
	const url = input.url.trim();
	const preset = input.preset.trim();
	const keyHeader = input.keyHeader.trim();
	const key = input.key.trim();
	const hmacSecret = (input.hmacSecret ?? "").trim();
	if (wakeUrlProblem(url)) return { ok: false, error: "url" };
	if (!WAKE_PRESETS.includes(preset as (typeof WAKE_PRESETS)[number])) return { ok: false, error: "preset" };
	if (wakeHeaderProblem(keyHeader)) return { ok: false, error: "header" };
	if ([key, hmacSecret].some((value) => value.length > 4096 || /[\u0000-\u001f]/.test(value))) return { ok: false, error: "key" };
	if (url && preset === "openbot" && (key || keyHeader)) return { ok: false, error: keyHeader ? "header" : "key" };

	const config = configFields(row.config_json);
	const plaintext: WakeSecrets = {};
	for (const secret of WAKE_SECRET_KEYS) {
		const value = config[secret];
		if (value) plaintext[secret] = value;
		delete config[secret];
	}
	// Read credentials before editing the public config. Ciphertext wins over legacy plaintext.
	const same = config.WAKE_WEBHOOK_URL === url && config.WAKE_PRESET === preset;
	const sameKey = same && (config.WAKE_KEY_HEADER ?? "") === keyHeader;
	let secretsEnc = row.secrets_enc;
	const hasSecrets = !!secretsEnc || Object.keys(plaintext).length > 0;
	if (hasSecrets || key || hmacSecret || (url && preset === "openbot")) {
		const ikm = secretsKey.trim();
		if (!ikm) return { ok: false, error: "unavailable" };
		const current = secretsEnc ? await openWakeSecrets(ikm, row.id, secretsEnc) : { ...plaintext };
		if (!current) return { ok: false, error: "unreadable" };
		const before = JSON.stringify(current);
		if (!url || !sameKey || preset === "openbot") delete current.WAKE_WEBHOOK_KEY;
		if (!url || !same) delete current.WAKE_HMAC_SECRET;
		if (url && key && preset !== "openbot") current.WAKE_WEBHOOK_KEY = key;
		if (url && hmacSecret) current.WAKE_HMAC_SECRET = hmacSecret;
		if (url && preset === "openbot" && !current.WAKE_HMAC_SECRET) return { ok: false, error: "key" };
		// Preserve ciphertext on an unchanged edit and fail closed on every decrypt/seal error.
		if (!secretsEnc || JSON.stringify(current) !== before) {
			const sealed = await sealWakeSecrets(ikm, row.id, current);
			if (!sealed) return { ok: false, error: "unavailable" };
			secretsEnc = sealed;
		}
	}
	if (url) config.WAKE_WEBHOOK_URL = url;
	else delete config.WAKE_WEBHOOK_URL;
	config.WAKE_PRESET = preset;
	if (keyHeader && url) config.WAKE_KEY_HEADER = keyHeader;
	else delete config.WAKE_KEY_HEADER;

	const version = row.config_version + 1;
	const now = new Date().toISOString();
	const configJson = JSON.stringify(config);
	const updated = await db.batch([
		db.prepare(
			`UPDATE tenants SET config_json = ?, secrets_enc = ?, config_version = ?, updated_at = ?
			 WHERE id = ? AND owner_account_id = ? AND config_version = ?`,
		).bind(configJson, secretsEnc, version, now, row.id, input.accountId, row.config_version),
		db.prepare(
			`INSERT INTO config_outbox (tenant_id, version, created_at)
			 SELECT id, ?, ? FROM tenants WHERE id = ? AND owner_account_id = ? AND config_version = ?`,
		).bind(version, now, row.id, input.accountId, version),
	]) as { meta?: { changes?: number } }[];
	if (updated[0]?.meta?.changes !== 1) return { ok: false, error: "conflict" };

	const outbox: OutboxRow = {
		id: row.id, name: row.name, status: row.status, region: row.region,
		config_json: configJson, limits_json: row.limits_json, approval_json: row.approval_json,
		owner_token_hash: row.owner_token_hash, secrets_enc: secretsEnc, version, created_at: now,
	};
	console.log(JSON.stringify({ ts: now, event: "wake_settings", tenant: row.id, accountId: input.accountId, preset }));
	try { await deliverOutbox(db, plane, outbox); }
	catch {
		console.log(JSON.stringify({ ts: now, event: "outbox_push_failed", tenant: row.id, error: "wake_delivery_failed" }));
	}
	return { ok: true };
}
