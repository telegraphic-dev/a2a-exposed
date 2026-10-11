import type { Sql } from "../auth/invites.ts";
import { newOwnerToken } from "./create.ts";
import { pushFromRow, type DataPlane, type OutboxRow } from "./push.ts";
import { tenantForAccount } from "./wake.ts";

export type RotateResult =
	| { ok: true; token: string }
	| { ok: false; error: "missing" | "gone" | "conflict" | "failed" };

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Replace the hosted owner-token hash and push that hash before returning the new token.
 * A push that does not apply rolls the row back, so the previous token still works.
 * Self-host never calls this: its owner token stays the Worker `OWNER_TOKEN`.
 */
export async function rotateOwnerToken(
	db: Sql,
	plane: DataPlane,
	input: { accountId: string; name: string },
): Promise<RotateResult> {
	const row = await tenantForAccount(db, input.accountId, input.name);
	if (!row) return { ok: false, error: "missing" };
	if (row.status === "deleting" || row.status === "deleted") return { ok: false, error: "gone" };
	const token = newOwnerToken();
	const hash = await sha256(token);
	const version = row.config_version + 1;
	const now = new Date().toISOString();
	const updated = await db.batch([
		db.prepare(
			`UPDATE tenants SET owner_token_hash = ?, config_version = ?, updated_at = ?
			 WHERE id = ? AND owner_account_id = ? AND config_version = ?`,
		).bind(hash, version, now, row.id, input.accountId, row.config_version),
		db.prepare(
			`INSERT INTO config_outbox (tenant_id, version, created_at)
			 SELECT id, ?, ? FROM tenants WHERE id = ? AND owner_account_id = ? AND config_version = ?`,
		).bind(version, now, row.id, input.accountId, version),
	]) as { meta?: { changes?: number } }[];
	if (updated[0]?.meta?.changes !== 1) return { ok: false, error: "conflict" };

	const undo = async () => {
		await db.batch([
			db.prepare(
				`UPDATE tenants SET owner_token_hash = ?, config_version = ?, updated_at = ?
				 WHERE id = ? AND owner_account_id = ? AND config_version = ? AND owner_token_hash = ?`,
			).bind(row.owner_token_hash, row.config_version, now, row.id, input.accountId, version, hash),
			db.prepare("DELETE FROM config_outbox WHERE tenant_id = ? AND version = ?").bind(row.id, version),
		]);
	};
	const outbox: OutboxRow = {
		id: row.id, name: row.name, status: row.status, region: row.region,
		config_json: row.config_json, limits_json: row.limits_json, approval_json: row.approval_json,
		owner_token_hash: hash, secrets_enc: row.secrets_enc, version, created_at: now,
	};
	try {
		const result = await plane.pushConfig(pushFromRow(outbox), row.region);
		if (!result.applied) {
			await undo();
			return { ok: false, error: "failed" };
		}
	} catch (error) {
		console.log(JSON.stringify({ ts: now, event: "outbox_push_failed", tenant: row.id, error: String(error).slice(0, 200) }));
		try { await undo(); } catch { /* the next rotation reads whatever row is left */ }
		return { ok: false, error: "failed" };
	}
	try {
		await plane.putDirectory(row.name, { id: row.id, status: row.status, region: row.region, version });
		await db.prepare("DELETE FROM config_outbox WHERE tenant_id = ? AND version <= ?").bind(row.id, version).run();
	} catch (error) {
		console.log(JSON.stringify({ ts: now, event: "outbox_push_failed", tenant: row.id, error: String(error).slice(0, 200) }));
	}
	console.log(JSON.stringify({ ts: now, event: "owner_token_rotated", tenant: row.id, accountId: input.accountId }));
	return { ok: true, token };
}
