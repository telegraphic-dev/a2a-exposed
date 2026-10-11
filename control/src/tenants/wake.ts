import type { Sql } from "../auth/invites.ts";
import { TENANT_NAME } from "./reserved.ts";
import { deliverOutbox, type DataPlane, type OutboxRow } from "./push.ts";
import { WAKE_SECRET_KEYS, openWakeSecrets, sealWakeSecrets, type WakeSecrets } from "./wake-secrets.ts";

/** The same list the Worker renders. Claude Code is one of them. */
export const WAKE_PRESETS = ["grok-bot", "claude-code", "openclaw-wake", "openclaw-agent", "hermes", "generic"] as const;

/** Headers a wake preview shows in full. A key header must not be one of these. */
const PLAIN_HEADERS = new Set([
	"content-type", "user-agent", "x-request-id", "idempotency-key", "anthropic-version", "x-webhook-timestamp",
]);

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

export interface WakeSettings {
	url: string;
	preset: string;
	keyHeader: string;
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
	input: { accountId: string; name: string; url: string; preset: string; keyHeader: string; key: string },
): Promise<WakeSave> {
	const row = await tenantForAccount(db, input.accountId, input.name);
	if (!row) return { ok: false, error: "conflict" };
	const url = input.url.trim();
	const preset = input.preset.trim();
	const keyHeader = input.keyHeader.trim();
	const key = input.key.trim();
	if (wakeUrlProblem(url)) return { ok: false, error: "url" };
	if (!WAKE_PRESETS.includes(preset as (typeof WAKE_PRESETS)[number])) return { ok: false, error: "preset" };
	if (wakeHeaderProblem(keyHeader)) return { ok: false, error: "header" };
	if (key.length > 4096 || /[\u0000-\u001f]/.test(key)) return { ok: false, error: "key" };

	const config = configFields(row.config_json);
	for (const secret of WAKE_SECRET_KEYS) delete config[secret];
	if (url) config.WAKE_WEBHOOK_URL = url;
	else delete config.WAKE_WEBHOOK_URL;
	config.WAKE_PRESET = preset;
	if (keyHeader) config.WAKE_KEY_HEADER = keyHeader;
	else delete config.WAKE_KEY_HEADER;

	let secretsEnc = row.secrets_enc;
	if (key) {
		const ikm = secretsKey.trim();
		if (!ikm) return { ok: false, error: "unavailable" };
		const current: WakeSecrets | null = secretsEnc ? await openWakeSecrets(ikm, row.id, secretsEnc) : {};
		if (!current) return { ok: false, error: "unreadable" };
		current.WAKE_WEBHOOK_KEY = key;
		const sealed = await sealWakeSecrets(ikm, row.id, current);
		if (!sealed) return { ok: false, error: "unavailable" };
		secretsEnc = sealed;
	}

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
	catch (error) {
		console.log(JSON.stringify({ ts: now, event: "outbox_push_failed", tenant: row.id, error: String(error).slice(0, 200) }));
	}
	return { ok: true };
}
