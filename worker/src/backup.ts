// Daily SQL snapshots. The R2 binding and the `0 3 * * *` trigger exist only when the deploy sets
// A2A_BACKUP_BUCKET=1. With that unset there is no bucket and this module is not called.
// Objects are `tenants/<id>/<YYYY-MM-DD>.sql`. A dated object is removed when its date is 30 or more
// days before the run (UTC), which keeps 30 daily snapshots.

import { exportRows, toSql, ExportError } from "./export.ts";
import { parseDirectoryEntry, pinDirectoryRegion, tenantRegion, TENANT_NAME, type DirectoryEntry } from "./directory.ts";
import { namespaceForRegion, parseGates, type DoNamespace, type KvNamespace, type SqlDb, type WorkerBindings } from "./tenancy.ts";

export const DAILY_CRON = "0 3 * * *";
export const RETENTION_DAYS = 30;
/** Self-host has one inbox, so its objects live under this id. */
export const SELF_TENANT_ID = "self";

const TENANT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export type R2BucketLike = NonNullable<WorkerBindings["BACKUP_BUCKET"]>;

export interface BackupWritten {
	tenantId: string;
	key: string;
	deleted: string[];
}

export interface BackupReport {
	written: BackupWritten[];
	skipped: { tenantId: string; status: string }[];
	failed: { tenantId: string; error: string }[];
}

export function dayUtc(now: Date): string {
	return now.toISOString().slice(0, 10);
}

/** UTC midnight for a real calendar day, or null. */
export function parseDay(day: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
	if (!m) return null;
	const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
	const t = Date.UTC(y, mo - 1, d);
	const dt = new Date(t);
	if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
	return t;
}

/** True when `fileDay` is at least {@link RETENTION_DAYS} before `today`. */
export function olderThanRetention(fileDay: string, today: string): boolean {
	const file = parseDay(fileDay);
	const now = parseDay(today);
	if (file === null || now === null) return false;
	return now - file >= RETENTION_DAYS * DAY_MS;
}

export function snapshotKey(tenantId: string, day: string): string {
	if (!TENANT_ID.test(tenantId)) throw new ExportError("backup: tenant id is invalid");
	if (parseDay(day) === null) throw new ExportError("backup: day is invalid");
	return `tenants/${tenantId}/${day}.sql`;
}

/** The `YYYY-MM-DD` in `tenants/<id>/<day>.sql`, or null when the key is not one of ours. */
export function objectDay(key: string, tenantId: string): string | null {
	const prefix = `tenants/${tenantId}/`;
	if (!key.startsWith(prefix) || !key.endsWith(".sql")) return null;
	const day = key.slice(prefix.length, -".sql".length);
	return parseDay(day) === null ? null : day;
}

async function listAll(bucket: R2BucketLike, prefix: string): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;
	for (;;) {
		const res = await bucket.list({ prefix, cursor, limit: 1000 });
		for (const obj of res.objects ?? []) keys.push(obj.key);
		if (!res.truncated) return keys;
		if (!res.cursor || res.cursor === cursor) throw new ExportError("backup: snapshot listing did not finish");
		cursor = res.cursor;
	}
}

/** Delete dated objects for this tenant that are past retention. The object written today stays. */
export async function pruneSnapshots(bucket: R2BucketLike, tenantId: string, today: string): Promise<string[]> {
	if (!TENANT_ID.test(tenantId)) throw new ExportError("backup: tenant id is invalid");
	const doomed = (await listAll(bucket, `tenants/${tenantId}/`)).filter((key) => {
		const day = objectDay(key, tenantId);
		return day !== null && olderThanRetention(day, today);
	});
	for (let i = 0; i < doomed.length; i += 1000) await bucket.delete(doomed.slice(i, i + 1000));
	return doomed;
}

export async function writeSnapshot(bucket: R2BucketLike, tenantId: string, sql: string, now = new Date()): Promise<BackupWritten> {
	const day = dayUtc(now);
	const key = snapshotKey(tenantId, day);
	await bucket.put(key, sql, { httpMetadata: { contentType: "application/sql" } });
	const deleted = await pruneSnapshots(bucket, tenantId, day);
	return { tenantId, key, deleted };
}

/** One self-host inbox, under {@link SELF_TENANT_ID}. */
export async function backupDatabase(bucket: R2BucketLike, db: SqlDb, tenantId = SELF_TENANT_ID, now = new Date()): Promise<BackupWritten> {
	const file = await exportRows(db, now);
	return writeSnapshot(bucket, tenantId, toSql(file), now);
}

interface KvLister extends KvNamespace {
	list?(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
		keys: { name: string }[];
		list_complete: boolean;
		cursor?: string;
	}>;
}

async function directoryNames(kv: KvLister): Promise<string[]> {
	if (typeof kv.list !== "function") throw new ExportError("backup: directory cannot be listed");
	const names: string[] = [];
	let cursor: string | undefined;
	for (;;) {
		const res = await kv.list({ prefix: "tenant:", cursor, limit: 1000 });
		for (const k of res.keys ?? []) {
			const name = k.name.startsWith("tenant:") ? k.name.slice("tenant:".length) : "";
			if (TENANT_NAME.test(name)) names.push(name);
		}
		if (res.list_complete !== false) return names;
		if (!res.cursor || res.cursor === cursor) throw new ExportError("backup: directory listing did not finish");
		cursor = res.cursor;
	}
}

function clip(e: unknown): string {
	const msg = e instanceof Error ? e.message : String(e);
	return msg.slice(0, 200);
}

/**
 * Fan-out for a hosted deploy. Active tenants are exported; other statuses are skipped.
 * An entry with no region yet is pinned the same way a request would pin it, then read.
 * One tenant's failure is recorded and the rest still run.
 */
export async function backupDirectory(
	kv: KvLister,
	bucket: R2BucketLike,
	ns: DoNamespace,
	dataRegion: string,
	now = new Date(),
): Promise<BackupReport> {
	const report: BackupReport = { written: [], skipped: [], failed: [] };
	const names = await directoryNames(kv);
	for (const name of names) {
		let entry: DirectoryEntry | null = null;
		try {
			const raw = await kv.get(`tenant:${name}`, "json");
			entry = parseDirectoryEntry(raw);
			if (!entry) throw new ExportError("backup: directory entry is unreadable");
			const pinned = await pinDirectoryRegion(kv, name, entry, dataRegion);
			if (!pinned) throw new ExportError("backup: directory unavailable");
			entry = pinned;
			if (entry.status !== "active") {
				report.skipped.push({ tenantId: entry.id, status: entry.status });
				continue;
			}
			const sql = await exportTenantSql(ns, entry);
			report.written.push(await writeSnapshot(bucket, entry.id, sql.sql, now));
		} catch (e) {
			report.failed.push({ tenantId: entry?.id || name, error: clip(e) });
		}
	}
	return report;
}

export async function exportTenantSql(ns: DoNamespace, entry: DirectoryEntry): Promise<{ sql: string; exportedAt: string }> {
	const bound = namespaceForRegion(ns, tenantRegion(entry));
	const stub = bound.get(bound.idFromName(entry.id)) as { exportSql?: () => Promise<{ sql: string; exportedAt: string }> };
	if (typeof stub.exportSql !== "function") throw new ExportError("exportSql: not available");
	const out = await stub.exportSql();
	if (!out || typeof out.sql !== "string" || typeof out.exportedAt !== "string") throw new ExportError("exportSql: empty");
	return out;
}

/** Hosted daily job. Returns null when this invocation is not the backup cron or the bucket is unset. */
export async function hostedDailyBackup(controller: { cron?: string }, env: WorkerBindings, now = new Date()): Promise<BackupReport | null> {
	if (controller.cron !== DAILY_CRON || !env.BACKUP_BUCKET) return null;
	if (env.TENANCY !== "host" || !env.TENANT_DO) return null;
	if (!env.TENANT_DIRECTORY) throw new ExportError("backup: directory cannot be listed");
	return backupDirectory(env.TENANT_DIRECTORY, env.BACKUP_BUCKET, env.TENANT_DO, parseGates(env).gates.dataRegion, now);
}
