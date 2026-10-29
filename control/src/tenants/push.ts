import type { Sql } from "../core/sql.ts";

/** Versioned copy the data-plane Durable Object stores. Older versions are ignored there. */
export interface TenantPush {
	version: number;
	tenantId: string;
	name: string;
	status: string;
	config: Record<string, string>;
	limits: Record<string, unknown>;
	approval: Record<string, unknown>;
	ownerTokenHash: string;
	secretsEnc: string | null;
}

/** Name directory row. No secrets. `region` is `eu`, `fedramp`, or `default`. */
export interface DirectoryEntry {
	id: string;
	status: string;
	region: string;
	version: number;
}

export interface OwnerCall {
	accountId: string;
	method: string;
	path: string;
	/** Allowlisted query parameters only. */
	query?: Record<string, string>;
	/**
	 * Tool arguments for `POST /owner/mcp/send`, `POST /owner/mcp/reply`, `POST /owner/mcp/mark_working`,
	 * and `POST /owner/mcp/announce_address`. `PUT /owner/outbound-peers/:alias`, `PUT /owner/address-forward`,
	 * and `POST /owner/peers/announce` also take a body. Any other call refuses a body.
	 */
	body?: unknown;
	/** Approve or deny after a recent sign-in. */
	actor?: "human";
}

export interface DataPlane {
	putDirectory(name: string, entry: DirectoryEntry): Promise<void>;
	pushConfig(body: TenantPush, region: string): Promise<{ version: number; applied: boolean }>;
	/** Allowlisted owner call. Absent on a test double that never renders an agent page. */
	owner?(tenantId: string, region: string, input: OwnerCall): Promise<{ status: number; body: unknown }>;
	/** Remove `tenant:<name>`. A missing key is success. Absent until the data plane can delete an agent. */
	deleteDirectory?(name: string): Promise<void>;
	/** Wipe that tenant's Durable Object storage. A second call on an empty object succeeds. */
	deleteStorage?(tenantId: string, region: string): Promise<void>;
}

interface DoNamespace {
	idFromName(name: string): unknown;
	get(id: unknown): {
		pushConfig(body: TenantPush): Promise<{ version: number; applied: boolean }>;
		owner?(input: OwnerCall): Promise<{ status: number; body: unknown }>;
		deleteStorage?(): Promise<unknown>;
	};
	jurisdiction?(location: string): DoNamespace;
}

interface DirectoryKv {
	get(key: string, type: "json"): Promise<unknown>;
	put(key: string, value: string): Promise<void>;
	delete?(key: string): Promise<void>;
}

export interface PlaneEnv {
	/** Data-plane Durable Object namespace (`TenantStore`). Unset: the tenants API is off. */
	TENANT_DO?: DoNamespace;
	/** Data-plane name directory. Same namespace the inbox Worker reads. Unset: the tenants API is off. */
	TENANT_DIRECTORY?: DirectoryKv;
}

function namespaceFor(ns: DoNamespace, region: string): DoNamespace {
	if ((region === "eu" || region === "fedramp") && typeof ns.jurisdiction === "function") return ns.jurisdiction(region);
	return ns;
}

/** Bindings for the data plane's directory and Durable Object. Null when either is unset. */
export function dataPlaneFromEnv(env: PlaneEnv): DataPlane | null {
	const directory = env.TENANT_DIRECTORY;
	const objects = env.TENANT_DO;
	if (!directory || !objects) return null;
	return {
		async putDirectory(name, entry) {
			const current = await directory.get(`tenant:${name}`, "json") as { version?: unknown; id?: unknown; status?: unknown } | null;
			const other = !!current && typeof current.id === "string" && current.id !== entry.id;
			// A deleted id stays deleted. A different live tenant is not replaced. A new id may replace a tombstone.
			if (other && current?.status !== "deleted") return;
			if (!other && current?.status === "deleted" && current.id === entry.id) return;
			if (!other && current && typeof current.version === "number" && current.version > entry.version) return;
			await directory.put(`tenant:${name}`, JSON.stringify(entry));
		},
		async pushConfig(body, region) {
			const ns = namespaceFor(objects, region);
			return ns.get(ns.idFromName(body.tenantId)).pushConfig(body);
		},
		async owner(tenantId, region, input) {
			const ns = namespaceFor(objects, region);
			const stub = ns.get(ns.idFromName(tenantId));
			if (!stub.owner) throw new Error("owner rpc is not available");
			return stub.owner(input);
		},
		async deleteDirectory(name) {
			if (!directory.delete) throw new Error("directory delete is not available");
			await directory.delete(`tenant:${name}`);
		},
		async deleteStorage(tenantId, region) {
			const ns = namespaceFor(objects, region);
			const stub = ns.get(ns.idFromName(tenantId));
			if (!stub.deleteStorage) throw new Error("delete storage is not available");
			await stub.deleteStorage();
		},
	};
}

export interface OutboxRow {
	id: string;
	name: string;
	status: string;
	region: string;
	config_json: string;
	limits_json: string;
	approval_json: string;
	owner_token_hash: string;
	secrets_enc: string | null;
	version: number;
	created_at: string;
}

function parseObject(text: string): Record<string, unknown> {
	try {
		const value = JSON.parse(text) as unknown;
		if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	} catch { /* stored JSON is written by this package */ }
	return {};
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) if (typeof item === "string") out[key] = item;
	return out;
}

export function pushFromRow(row: OutboxRow): TenantPush {
	return {
		version: row.version,
		tenantId: row.id,
		name: row.name,
		status: row.status,
		config: stringRecord(parseObject(row.config_json)),
		limits: parseObject(row.limits_json),
		approval: parseObject(row.approval_json),
		ownerTokenHash: row.owner_token_hash,
		secretsEnc: row.secrets_enc,
	};
}

const OUTBOX_LOCK_MS = 60_000;

async function acquireOutboxLock(db: Sql, holder: string): Promise<void> {
	const started = Date.now();
	for (;;) {
		const now = Date.now();
		const updated = await db.prepare(
			`UPDATE control_locks SET holder = ?, expires_ms = ?
			 WHERE name = 'outbox' AND (holder = '' OR holder = ? OR expires_ms <= ?)`,
		).bind(holder, now + OUTBOX_LOCK_MS, holder, now).run();
		if ((updated.meta?.changes ?? 0) === 1) return;
		if (now - started > 10_000) throw new Error("outbox lock busy");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function releaseOutboxLock(db: Sql, holder: string): Promise<void> {
	await db.prepare(
		"UPDATE control_locks SET holder = '', expires_ms = 0 WHERE name = 'outbox' AND holder = ?",
	).bind(holder).run();
}

/** One writer at a time for delivery and delete. A crashed holder expires after a minute. */
export async function withOutboxLock<T>(db: Sql, fn: () => Promise<T>): Promise<T> {
	const holder = crypto.randomUUID();
	await acquireOutboxLock(db, holder);
	try {
		return await fn();
	} finally {
		await releaseOutboxLock(db, holder);
	}
}

interface LiveTenant {
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

async function liveTenant(db: Sql, id: string): Promise<LiveTenant | null> {
	return db.prepare(
		`SELECT id, name, status, region, config_json, limits_json, approval_json, owner_token_hash, secrets_enc, config_version
		 FROM tenants WHERE id = ?`,
	).bind(id).first<LiveTenant>();
}

/**
 * Push one outbox row, then delete it when the object reports that version or newer.
 * The row is read again under the outbox lock. A tenant that is gone or deleting is not written:
 * a flush that loaded the row earlier must not put it back after delete.
 * `beforeLock` runs after that load and before the lock, so a test can delete the agent in between.
 */
export async function deliverOutbox(db: Sql, plane: DataPlane, row: OutboxRow, beforeLock?: () => Promise<void>): Promise<boolean> {
	if (beforeLock) await beforeLock();
	return withOutboxLock(db, async () => {
		const live = await liveTenant(db, row.id);
		if (!live || live.status === "deleting" || live.status === "deleted") {
			await db.prepare("DELETE FROM config_outbox WHERE tenant_id = ?").bind(row.id).run();
			return true;
		}
		const body = pushFromRow({ ...row, status: live.status, config_json: live.config_json, limits_json: live.limits_json, approval_json: live.approval_json, owner_token_hash: live.owner_token_hash, secrets_enc: live.secrets_enc, region: live.region, name: live.name });
		await plane.putDirectory(live.name, { id: live.id, status: live.status, region: live.region, version: row.version });
		const result = await plane.pushConfig(body, live.region);
		if (result.version < row.version) return false;
		await db.prepare("DELETE FROM config_outbox WHERE tenant_id = ? AND version <= ?").bind(row.id, result.version).run();
		return true;
	});
}

/** Retry every pending push. A row older than five minutes is logged; the token is not. */
export async function flushOutbox(db: Sql, plane: DataPlane, now = Date.now()): Promise<{ delivered: number; pending: number }> {
	const listed = await db.prepare(
		`SELECT t.id, t.name, t.status, t.region, t.config_json, t.limits_json, t.approval_json,
		        t.owner_token_hash, t.secrets_enc, o.version, o.created_at
		 FROM config_outbox o JOIN tenants t ON t.id = o.tenant_id
		 ORDER BY o.created_at`,
	).all<OutboxRow>();
	let delivered = 0;
	for (const row of listed.results) {
		const age = now - Date.parse(row.created_at);
		if (Number.isFinite(age) && age > 5 * 60 * 1000) {
			console.log(JSON.stringify({ ts: new Date(now).toISOString(), event: "outbox_stale", tenant: row.id, version: row.version }));
		}
		try {
			if (await deliverOutbox(db, plane, row)) delivered += 1;
		} catch {
			console.log(JSON.stringify({ ts: new Date(now).toISOString(), event: "outbox_push_failed", tenant: row.id, error: "config_delivery_failed" }));
		}
	}
	const left = await db.prepare("SELECT COUNT(*) AS n FROM config_outbox").first<{ n: number }>();
	return { delivered, pending: Number(left?.n ?? 0) };
}
