import type { Sql } from "../auth/invites.ts";

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

export interface DataPlane {
	putDirectory(name: string, entry: DirectoryEntry): Promise<void>;
	pushConfig(body: TenantPush, region: string): Promise<{ version: number; applied: boolean }>;
}

interface DoNamespace {
	idFromName(name: string): unknown;
	get(id: unknown): { pushConfig(body: TenantPush): Promise<{ version: number; applied: boolean }> };
	jurisdiction?(location: string): DoNamespace;
}

interface DirectoryKv {
	get(key: string, type: "json"): Promise<unknown>;
	put(key: string, value: string): Promise<void>;
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
			const current = await directory.get(`tenant:${name}`, "json") as { version?: unknown } | null;
			if (current && typeof current.version === "number" && current.version > entry.version) return;
			await directory.put(`tenant:${name}`, JSON.stringify(entry));
		},
		async pushConfig(body, region) {
			const ns = namespaceFor(objects, region);
			return ns.get(ns.idFromName(body.tenantId)).pushConfig(body);
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

/** Push one outbox row, then delete it when the object reports that version or newer. */
export async function deliverOutbox(db: Sql, plane: DataPlane, row: OutboxRow): Promise<boolean> {
	const body = pushFromRow(row);
	await plane.putDirectory(row.name, { id: row.id, status: row.status, region: row.region, version: row.version });
	const result = await plane.pushConfig(body, row.region);
	if (result.version < row.version) return false;
	await db.prepare("DELETE FROM config_outbox WHERE tenant_id = ? AND version <= ?").bind(row.id, result.version).run();
	return true;
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
		} catch (error) {
			console.log(JSON.stringify({ ts: new Date(now).toISOString(), event: "outbox_push_failed", tenant: row.id, error: String(error).slice(0, 200) }));
		}
	}
	const left = await db.prepare("SELECT COUNT(*) AS n FROM config_outbox").first<{ n: number }>();
	return { delivered, pending: Number(left?.n ?? 0) };
}
