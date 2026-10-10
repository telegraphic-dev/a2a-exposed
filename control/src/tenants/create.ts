import type { Sql } from "../auth/invites.ts";
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

export type CreateResult =
	| { ok: true; tenant: CreatedTenant }
	| { ok: false; error: "invalid_name" | "reserved_name" | "taken" };

function regionOf(dataRegion: string | undefined): string {
	const value = (dataRegion || "").trim().toLowerCase();
	return value === "eu" || value === "fedramp" ? value : "default";
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ownerToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	let raw = "";
	for (const byte of bytes) raw += String.fromCharCode(byte);
	return `a2aot_${btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

export async function createTenant(
	db: Sql,
	plane: DataPlane,
	input: { accountId: string; name: string; domain?: string; dataRegion?: string },
): Promise<CreateResult> {
	const name = input.name.trim().toLowerCase();
	const problem = tenantNameProblem(name);
	if (problem) return { ok: false, error: problem === "reserved_name" ? "reserved_name" : "invalid_name" };
	const existing = await db.prepare("SELECT id FROM tenants WHERE name = ?").bind(name).first<{ id: string }>();
	if (existing) return { ok: false, error: "taken" };

	const id = crypto.randomUUID();
	const token = ownerToken();
	const hash = await sha256(token);
	const now = new Date().toISOString();
	const region = regionOf(input.dataRegion);
	const config = { AGENT_NAME: name };
	const version = 1;
	try {
		await db.batch([
			db.prepare(
				`INSERT INTO tenants (
				   id, name, owner_account_id, status, region, config_json, limits_json, approval_json,
				   owner_token_hash, secrets_enc, config_version, created_at, updated_at
				 ) VALUES (?, ?, ?, 'active', ?, ?, '{}', '{}', ?, NULL, ?, ?, ?)`,
			).bind(id, name, input.accountId, region, JSON.stringify(config), hash, version, now, now),
			db.prepare("INSERT INTO config_outbox (tenant_id, version, created_at) VALUES (?, ?, ?)").bind(id, version, now),
		]);
	} catch (error) {
		const message = String(error);
		if (/unique|constraint/i.test(message)) return { ok: false, error: "taken" };
		throw error;
	}
	const row: OutboxRow = {
		id, name, status: "active", region,
		config_json: JSON.stringify(config), limits_json: "{}", approval_json: "{}",
		owner_token_hash: hash, secrets_enc: null, version, created_at: now,
	};
	let pushed = false;
	try { pushed = await deliverOutbox(db, plane, row); }
	catch (error) {
		console.log(JSON.stringify({ ts: now, event: "outbox_push_failed", tenant: id, error: String(error).slice(0, 200) }));
	}
	const domain = (input.domain || "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
	return {
		ok: true,
		tenant: {
			id, name, status: "active", region, version, pushed, ownerToken: token,
			publicUrl: domain ? `https://${name}.${domain}` : null,
		},
	};
}

export async function listTenants(db: Sql, accountId: string, domain?: string): Promise<{ id: string; name: string; status: string; publicUrl: string | null; version: number }[]> {
	const listed = await db.prepare(
		"SELECT id, name, status, config_version FROM tenants WHERE owner_account_id = ? ORDER BY created_at",
	).bind(accountId).all<{ id: string; name: string; status: string; config_version: number }>();
	const host = (domain || "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
	return listed.results.map((row) => ({
		id: row.id,
		name: row.name,
		status: row.status,
		version: row.config_version,
		publicUrl: host ? `https://${row.name}.${host}` : null,
	}));
}
