import type { Sql } from "../core/sql.ts";
import { newOwnerToken } from "./create.ts";
import { pushFromRow, type DataPlane, type OutboxRow } from "./push.ts";
import { tenantForAccount } from "./wake.ts";

export type RotateResult =
	| { ok: true; token: string }
	| { ok: false; error: "missing" | "gone" | "conflict" | "failed" | "replaced" };

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Replace the hosted owner-token hash and push that hash before returning the new token.
 * The outbox row is not written first: a flush could deliver the new hash after a push that
 * reported an older version and before the row was rolled back, and the page would then hide
 * the only token that works. A returned version equal to or newer than this one is not enough:
 * the stored hash has to still be this token, because a later rotation may already have moved
 * the version. A lower version is checked once more. Only then, and only while this hash is
 * still the stored one, that next version is reserved and then the previous hash is pushed there.
 * Reserving first keeps another rotation from committing a different hash at the same version.
 * A push that throws is sent once more. Self-host never calls this.
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
	const liveHash = async (): Promise<string | null> => {
		const current = await db.prepare(
			"SELECT owner_token_hash FROM tenants WHERE id = ? AND owner_account_id = ?",
		).bind(row.id, input.accountId).first<{ owner_token_hash: string }>();
		return current?.owner_token_hash ?? null;
	};
	const hashStillOurs = async () => (await liveHash()) === hash;
	const reveal = async (confirmed: boolean): Promise<RotateResult> => {
		// A later rotation can advance the version with a different hash. Do not show this token then.
		if (!(await hashStillOurs())) return { ok: false, error: "replaced" };
		const live = await db.prepare(
			"SELECT config_version FROM tenants WHERE id = ? AND owner_account_id = ?",
		).bind(row.id, input.accountId).first<{ config_version: number }>();
		const liveVersion = live?.config_version;
		const flushVersion = typeof liveVersion === "number" && Number.isSafeInteger(liveVersion) ? liveVersion : version;
		try {
			await plane.putDirectory(row.name, { id: row.id, status: row.status, region: row.region, version: confirmed ? version : flushVersion });
			if (confirmed) {
				await db.prepare("DELETE FROM config_outbox WHERE tenant_id = ? AND version <= ?").bind(row.id, version).run();
			} else {
				// Queue the live version. An older one is ignored once a restore has already been stored, and the flush then drops it.
				await db.prepare(
					`INSERT INTO config_outbox (tenant_id, version, created_at) VALUES (?, ?, ?)
					 ON CONFLICT (tenant_id, version) DO NOTHING`,
				).bind(row.id, flushVersion, now).run();
			}
		} catch (error) {
			console.log(JSON.stringify({ ts: now, event: "outbox_push_failed", tenant: row.id, error: String(error).slice(0, 200) }));
		}
		if (!(await hashStillOurs())) {
			try {
				await db.prepare("DELETE FROM config_outbox WHERE tenant_id = ? AND version = ?").bind(row.id, flushVersion).run();
			} catch { /* the token is still not shown */ }
			return { ok: false, error: "replaced" };
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
	// The previous hash at the next version. That version is reserved before the push, so another
	// rotation cannot commit a different hash at the same number and then treat a rejected push as stored.
	const restorePrevious = async (): Promise<boolean> => {
		// A later rotation already replaced this hash. Leave that row alone.
		if (!(await hashStillOurs())) return false;
		const next = version + 1;
		const reserved = await db.prepare(
			`UPDATE tenants SET config_version = ?, updated_at = ?
			 WHERE id = ? AND owner_account_id = ? AND config_version = ? AND owner_token_hash = ?`,
		).bind(next, now, row.id, input.accountId, version, hash).run();
		if (reserved.meta?.changes !== 1) return false;
		const previous: OutboxRow = { ...outbox, owner_token_hash: row.owner_token_hash, version: next };
		let result: { version: number; applied: boolean };
		try {
			result = await plane.pushConfig(pushFromRow(previous), row.region);
		} catch (error) {
			console.log(JSON.stringify({ ts: now, event: "outbox_push_failed", tenant: row.id, error: String(error).slice(0, 200) }));
			try {
				result = await plane.pushConfig(pushFromRow(previous), row.region);
			} catch (again) {
				console.log(JSON.stringify({ ts: now, event: "outbox_push_failed", tenant: row.id, error: String(again).slice(0, 200) }));
				// The old hash may already be stored at `next`. Put this hash at the following version,
				// which that tenant will accept. Do not queue the original version: it is ignored and then dropped.
				const repair = next + 1;
				const moved = await db.prepare(
					`UPDATE tenants SET config_version = ?, updated_at = ?
					 WHERE id = ? AND owner_account_id = ? AND config_version = ? AND owner_token_hash = ?`,
				).bind(repair, now, row.id, input.accountId, next, hash).run();
				if (moved.meta?.changes !== 1) return false;
				try {
					const repaired = await plane.pushConfig(pushFromRow({ ...outbox, version: repair }), row.region);
					if (Number.isSafeInteger(repaired.version) && repaired.version >= repair && (await hashStillOurs())) return false;
				} catch (error) {
					console.log(JSON.stringify({ ts: now, event: "outbox_push_failed", tenant: row.id, error: String(error).slice(0, 200) }));
				}
				await db.prepare(
					`INSERT INTO config_outbox (tenant_id, version, created_at) VALUES (?, ?, ?)
					 ON CONFLICT (tenant_id, version) DO NOTHING`,
				).bind(row.id, repair, now).run();
				return false;
			}
		}
		// An equal version is this reserved push, or a repeat of it. A higher version belongs to a later write.
		if (!Number.isSafeInteger(result.version) || result.version < next) return false;
		if (!result.applied && result.version !== next) return false;
		const restored = await db.prepare(
			`UPDATE tenants SET owner_token_hash = ?, updated_at = ?
			 WHERE id = ? AND owner_account_id = ? AND config_version = ? AND owner_token_hash = ?`,
		).bind(row.owner_token_hash, now, row.id, input.accountId, next, hash).run();
		if (restored.meta?.changes !== 1) return false;
		await db.prepare("DELETE FROM config_outbox WHERE tenant_id = ? AND version <= ?").bind(row.id, next).run();
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
