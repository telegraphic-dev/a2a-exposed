import type { Sql } from "../auth/invites.ts";
import { newApprovalClient } from "../oidc/issuer.ts";
import { deliverOutbox, type DataPlane, type OutboxRow } from "./push.ts";
import { tenantNameProblem } from "./reserved.ts";

export interface CreatedTenant {
	id: string;
	name: string;
	status: string;
	region: string;
	publicUrl: string | null;
	ownerToken: string;
	version: number;
	pushed: boolean;
}

/** Unset or not a non-negative integer: this deployment has no default cap. */
export function configuredFreeAgentLimit(value: string | undefined): number | null {
	const trimmed = (value ?? "").trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const parsed = Number(trimmed);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

/** The account column wins. Null uses the configured default. Both empty: no cap. */
export async function accountAgentLimit(db: Sql, accountId: string, freeAgentLimit: number | null): Promise<number | null> {
	const row = await db.prepare('SELECT agent_limit AS n FROM "user" WHERE id = ?').bind(accountId).first<{ n: number | null }>();
	if (!row || row.n == null) return freeAgentLimit;
	const parsed = Number(row.n);
	return Number.isSafeInteger(parsed) ? parsed : freeAgentLimit;
}

export type CreateResult =
	| { ok: true; tenant: CreatedTenant }
	| { ok: false; error: "invalid_name" | "reserved_name" | "taken" | "limit" };

function regionOf(dataRegion: string | undefined): string {
	const value = (dataRegion || "").trim().toLowerCase();
	return value === "eu" || value === "fedramp" ? value : "default";
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `a2aot_` plus 32 random bytes, base64url. Shown once. Only the SHA-256 hash is stored. */
export function newOwnerToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	let raw = "";
	for (const byte of bytes) raw += String.fromCharCode(byte);
	return `a2aot_${btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

export async function createTenant(
	db: Sql,
	plane: DataPlane,
	input: { accountId: string; name: string; domain?: string; dataRegion?: string; issuer?: string; label?: string; freeAgentLimit?: number | null },
): Promise<CreateResult> {
	const name = input.name.trim().toLowerCase();
	const problem = tenantNameProblem(name);
	if (problem) return { ok: false, error: problem === "reserved_name" ? "reserved_name" : "invalid_name" };
	const existing = await db.prepare("SELECT id FROM tenants WHERE name = ?").bind(name).first<{ id: string }>();
	if (existing) return { ok: false, error: "taken" };

	const id = crypto.randomUUID();
	const token = newOwnerToken();
	const hash = await sha256(token);
	const now = new Date().toISOString();
	const region = regionOf(input.dataRegion);
	const config = { AGENT_NAME: name };
	const version = 1;
	const domain = (input.domain || "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
	const publicUrl = domain ? `https://${name}.${domain}` : null;
	const client = await newApprovalClient({ accountId: input.accountId, issuer: input.issuer || "", publicUrl, label: input.label });
	const approval = client?.approval ?? {};
	// Committed before the insert. A rejected insert still keeps the current default,
	// and the trigger reads it in the same database as the per-account column.
	await db.prepare(
		`INSERT INTO control_settings (id, free_agent_limit) VALUES (1, ?)
		 ON CONFLICT(id) DO UPDATE SET free_agent_limit = excluded.free_agent_limit`,
	).bind(input.freeAgentLimit ?? null).run();
	try {
		await db.batch([
			db.prepare(
				`INSERT INTO tenants (
				   id, name, owner_account_id, status, region, config_json, limits_json, approval_json,
				   owner_token_hash, secrets_enc, config_version, created_at, updated_at
				 ) VALUES (?, ?, ?, 'active', ?, ?, '{}', ?, ?, NULL, ?, ?, ?)`,
			).bind(id, name, input.accountId, region, JSON.stringify(config), JSON.stringify(approval), hash, version, now, now),
			...(client ? [db.prepare(
				"INSERT INTO oauth_client (id, secret_hash, owner_account_id, redirect_uris, created_at) VALUES (?, ?, ?, ?, ?)",
			).bind(client.clientId, client.secretHash, input.accountId, JSON.stringify(client.redirectUris), now)] : []),
			db.prepare("INSERT INTO config_outbox (tenant_id, version, created_at) VALUES (?, ?, ?)").bind(id, version, now),
		]);
	} catch (error) {
		const message = String(error);
		if (message.includes("agent_limit")) return { ok: false, error: "limit" };
		if (/unique|constraint/i.test(message)) return { ok: false, error: "taken" };
		throw error;
	}
	const row: OutboxRow = {
		id, name, status: "active", region,
		config_json: JSON.stringify(config), limits_json: "{}", approval_json: JSON.stringify(approval),
		owner_token_hash: hash, secrets_enc: null, version, created_at: now,
	};
	let pushed = false;
	try { pushed = await deliverOutbox(db, plane, row); }
	catch (error) {
		console.log(JSON.stringify({ ts: now, event: "outbox_push_failed", tenant: id, error: String(error).slice(0, 200) }));
	}
	return {
		ok: true,
		tenant: {
			id, name, status: "active", region, version, pushed, ownerToken: token,
			publicUrl,
		},
	};
}

export async function listTenants(db: Sql, accountId: string, domain?: string): Promise<{ id: string; name: string; status: string; region: string; publicUrl: string | null; version: number; createdAt: string }[]> {
	const listed = await db.prepare(
		"SELECT id, name, status, region, config_version, created_at FROM tenants WHERE owner_account_id = ? ORDER BY created_at",
	).bind(accountId).all<{ id: string; name: string; status: string; region: string; config_version: number; created_at: string }>();
	const host = (domain || "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
	return listed.results.map((row) => ({
		id: row.id,
		name: row.name,
		status: row.status,
		region: row.region,
		version: row.config_version,
		createdAt: row.created_at,
		publicUrl: host ? `https://${row.name}.${host}` : null,
	}));
}
