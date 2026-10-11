import type { Sql } from "../auth/invites.ts";
import { pushFromRow, type DataPlane, type OutboxRow } from "./push.ts";
import { tenantForAccount } from "./wake.ts";

export type DeleteResult = { ok: true } | { ok: false; error: "failed" | "unavailable" };

/**
 * Remove one agent the account owns.
 * The control row is deleted last, so the agent-limit slot stays taken until the directory entry
 * and the Durable Object storage are gone. A retry continues from `deleting` and does not put the
 * new state in the outbox, so a flush cannot write the agent back after the wipe.
 */
export async function deleteTenant(
	db: Sql,
	plane: DataPlane,
	input: { accountId: string; name: string },
): Promise<DeleteResult> {
	if (!plane.deleteDirectory || !plane.deleteStorage) return { ok: false, error: "unavailable" };
	const marked = await markDeleting(db, input.accountId, input.name);
	if (marked === "missing") return { ok: true };
	if (marked === "failed") return { ok: false, error: "failed" };
	await db.prepare("DELETE FROM config_outbox WHERE tenant_id = ?").bind(marked.id).run();
	const now = new Date().toISOString();
	const body = pushFromRow({
		id: marked.id,
		name: marked.name,
		status: "deleting",
		region: marked.region,
		config_json: marked.config_json,
		limits_json: marked.limits_json,
		approval_json: marked.approval_json,
		owner_token_hash: marked.owner_token_hash,
		secrets_enc: marked.secrets_enc,
		version: marked.config_version,
		created_at: now,
	} satisfies OutboxRow);
	try {
		await plane.putDirectory(marked.name, { id: marked.id, status: "deleting", region: marked.region, version: marked.config_version });
		await plane.pushConfig(body, marked.region);
		await plane.deleteDirectory(marked.name);
		await plane.deleteStorage(marked.id, marked.region);
	} catch (error) {
		console.log(JSON.stringify({ ts: now, event: "agent_delete_failed", tenant: marked.id, error: String(error).slice(0, 200) }));
		return { ok: false, error: "failed" };
	}
	await db.prepare("DELETE FROM config_outbox WHERE tenant_id = ?").bind(marked.id).run();
	const removed = await db.prepare("DELETE FROM tenants WHERE id = ? AND owner_account_id = ?").bind(marked.id, input.accountId).run();
	if ((removed.meta?.changes ?? 0) === 1) return { ok: true };
	const still = await tenantForAccount(db, input.accountId, input.name);
	return still ? { ok: false, error: "failed" } : { ok: true };
}

async function markDeleting(db: Sql, accountId: string, name: string) {
	const row = await tenantForAccount(db, accountId, name);
	if (!row) return "missing" as const;
	if (row.status === "deleting" || row.status === "deleted") return row;
	const version = row.config_version + 1;
	const now = new Date().toISOString();
	const updated = await db.prepare(
		`UPDATE tenants SET status = 'deleting', config_version = ?, updated_at = ?
		 WHERE id = ? AND owner_account_id = ? AND config_version = ? AND status NOT IN ('deleting', 'deleted')`,
	).bind(version, now, row.id, accountId, row.config_version).run();
	if ((updated.meta?.changes ?? 0) === 1) return { ...row, status: "deleting", config_version: version };
	const again = await tenantForAccount(db, accountId, name);
	if (!again) return "missing" as const;
	if (again.status !== "deleting" && again.status !== "deleted") return "failed" as const;
	return again;
}
