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
 * The outbox row is not written first: a flush could deliver the new hash after a push that
 * reported an older version and before the row was rolled back, and the page would then hide
 * the only token that works. A returned version equal to or newer than this one means the hash
 * is already stored. A lower version is checked once more, and only then is the row rolled back.
 * A push that throws is sent once more; if that also throws, the previous hash is pushed at the
 * next version before the page reports failure. Self-host never calls this.
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
	const updated = await db.prepare(
		`UPDATE tenants SET owner_token_hash = ?, config_version = ?, updated_at = ?
		 WHERE id = ? AND owner_account_id = ? AND config_version = ?`,
	).bind(hash, version, now, row.id, input.accountId, row.config_version).run();
	if (updated.meta?.changes !== 1) return { ok: false, error: "conflict" };

	const outbox: OutboxRow = {
		id: row.id, name: row.name, status: row.status, region: row.region,
		config_json: row.config_json, limits_json: row.limits_json, approval_json: row.approval_json,
		owner_token_hash: hash, secrets_enc: row.secrets_enc, version, created_at: now,
	};
	const stored = (result: { version: number }) => Number.isSafeInteger(result.version) && result.version >= version;
	const reveal = async (confirmed: boolean): Promise<RotateResult> => {
		try {
			await plane.putDirectory(row.name, { id: row.id, status: row.status, region: row.region, version });
			if (confirmed) {
				await db.prepare("DELETE FROM config_outbox WHERE tenant_id = ? AND version <= ?").bind(row.id, version).run();
			} else {
				// The tenant may already have this hash, or not. Keep a flush from dropping it, and the page shows the token.
				await db.prepare(
					`INSERT INTO config_outbox (tenant_id, version, created_at) VALUES (?, ?, ?)
					 ON CONFLICT (tenant_id, version) DO NOTHING`,
				).bind(row.id, version, now).run();
			}
		} catch (error) {
			console.log(JSON.stringify({ ts: now, event: "outbox_push_failed", tenant: row.id, error: String(error).slice(0, 200) }));
		}
		console.log(JSON.stringify({ ts: now, event: "owner_token_rotated", tenant: row.id, accountId: input.accountId }));
		return { ok: true, token };
	};
	const pushNew = () => plane.pushConfig(pushFromRow(outbox), row.region);
	const decide = async (result: { version: number }): Promise<RotateResult> => {
		if (stored(result)) return reveal(true);
		// A flush can deliver this hash after the first answer and before a rollback. Look again.
		const again = await pushNew();
		if (stored(again)) return reveal(true);
		// Still older. Write the previous hash at the next version before reporting failure, so a
		// flush that then lands on this version cannot leave the tenant holding an unseen token.
		if (await restorePrevious()) return { ok: false, error: "failed" };
		return reveal(false);
	};
	// The previous hash at the next version. Only an applied push counts: a newer stored version may
	// already be this rotation's hash, and writing the old hash over the control row would hide it.
	const restorePrevious = async (): Promise<boolean> => {
		const next = version + 1;
		const previous: OutboxRow = { ...outbox, owner_token_hash: row.owner_token_hash, version: next };
		try {
			const result = await plane.pushConfig(pushFromRow(previous), row.region);
			if (!result.applied || !Number.isSafeInteger(result.version) || result.version < next) return false;
		} catch (error) {
			console.log(JSON.stringify({ ts: now, event: "outbox_push_failed", tenant: row.id, error: String(error).slice(0, 200) }));
			return false;
		}
		await db.batch([
			db.prepare(
				`UPDATE tenants SET owner_token_hash = ?, config_version = ?, updated_at = ?
				 WHERE id = ? AND owner_account_id = ? AND config_version = ? AND owner_token_hash = ?`,
			).bind(row.owner_token_hash, next, now, row.id, input.accountId, version, hash),
			db.prepare("DELETE FROM config_outbox WHERE tenant_id = ? AND version <= ?").bind(row.id, next),
		]);
		try {
			await plane.putDirectory(row.name, { id: row.id, status: row.status, region: row.region, version: next });
		} catch (error) {
			console.log(JSON.stringify({ ts: now, event: "outbox_push_failed", tenant: row.id, error: String(error).slice(0, 200) }));
		}
		return true;
	};
	try {
		return await decide(await pushNew());
	} catch (error) {
		console.log(JSON.stringify({ ts: now, event: "outbox_push_failed", tenant: row.id, error: String(error).slice(0, 200) }));
		try {
			return await decide(await pushNew());
		} catch (again) {
			console.log(JSON.stringify({ ts: now, event: "outbox_push_failed", tenant: row.id, error: String(again).slice(0, 200) }));
			if (await restorePrevious()) return { ok: false, error: "failed" };
			return reveal(false);
		}
	}
}
