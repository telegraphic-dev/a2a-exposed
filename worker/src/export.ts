// Inbox export. Both the owner HTTP API and the hosted Durable Object use this.
// The allowlist is the application tables. `d1_migrations` and the hosted `tenant_config` row (it holds
// `secrets_enc`) are left out. The SQL text is a dump the operator already owns.

import type { SqlDb } from "./tenancy.ts";

export class ExportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExportError";
	}
}

/** Application tables, in a stable order. Schema changes add a table here in the same change as the migration. */
export const EXPORT_TABLES = [
	"peers", "tasks", "messages", "history", "outbound", "wakes",
	"rate", "wake_budget", "device_requests", "pairing_rate", "settings",
	"facade_owners", "oauth_clients", "oauth_codes", "mcp_grants",
	"outbound_peers", "oauth_client_metadata", "oidc_txns",
] as const;

export type ExportTable = (typeof EXPORT_TABLES)[number];

export interface ExportFile {
	format: "a2a-exposed-export";
	version: 1;
	exportedAt: string;
	tables: { [K in ExportTable]?: Record<string, unknown>[] };
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdent(name: string): string {
	if (!IDENT.test(name)) throw new ExportError("export: bad column");
	return `"${name}"`;
}

function cell(v: unknown): unknown {
	if (v === null || typeof v === "string" || typeof v === "boolean") return v;
	if (typeof v === "number") {
		if (!Number.isFinite(v)) throw new ExportError("export: non-finite number");
		return v;
	}
	if (typeof v === "bigint") {
		if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw new ExportError("export: integer out of range");
		return Number(v);
	}
	throw new ExportError("export: unsupported value");
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(row)) {
		if (!IDENT.test(k)) throw new ExportError("export: bad column");
		out[k] = cell(v);
	}
	return out;
}

/** A SQL string literal. SQLite rejects a script that contains a NUL byte, so U+0000 is `char(0)` instead of a raw byte. */
function sqlString(v: string): string {
	const parts = v.split("\u0000");
	if (parts.length === 1) return `'${v.replaceAll("'", "''")}'`;
	const bits: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		if (parts[i]) bits.push(`'${parts[i].replaceAll("'", "''")}'`);
		if (i < parts.length - 1) bits.push("char(0)");
	}
	return bits.length === 1 ? bits[0] : `(${bits.join(" || ")})`;
}

function sqlLit(v: unknown): string {
	if (v === null) return "NULL";
	if (typeof v === "boolean") return v ? "1" : "0";
	if (typeof v === "number") return Number.isInteger(v) ? String(v) : JSON.stringify(v);
	if (typeof v === "string") return sqlString(v);
	throw new ExportError("export: unsupported value");
}

/**
 * Every allowlisted table, including ones with no rows.
 * One `batch` is one transaction. D1 runs the batch as a single transaction, so a concurrent write cannot
 * land between tables. The Durable Object adapter runs that batch inside `transactionSync`, which blocks
 * other requests for the whole read. Do not split this back into per-table queries.
 */
export async function exportRows(db: SqlDb, now = new Date()): Promise<ExportFile> {
	const out = await db.batch(EXPORT_TABLES.map((name) => db.prepare(`SELECT * FROM ${quoteIdent(name)}`)));
	const tables: ExportFile["tables"] = {};
	EXPORT_TABLES.forEach((name, i) => {
		tables[name] = ((out[i]?.results ?? []) as Record<string, unknown>[]).map(normalizeRow);
	});
	return { format: "a2a-exposed-export", version: 1, exportedAt: now.toISOString(), tables };
}

/** DELETE then INSERT for every allowlisted table. Safe to run on a database that already has the schema. */
export function toSql(file: ExportFile): string {
	if (file.format !== "a2a-exposed-export" || file.version !== 1) throw new ExportError("export: bad file");
	if (!/^[\dTZ:.-]+$/.test(file.exportedAt)) throw new ExportError("export: bad timestamp");
	const lines = [
		`-- a2a-exposed-export ${file.version}`,
		`-- exported_at ${file.exportedAt}`,
	];
	for (const name of EXPORT_TABLES) {
		lines.push(`DELETE FROM ${quoteIdent(name)};`);
		for (const row of file.tables[name] ?? []) {
			const cols = Object.keys(row);
			if (!cols.length) continue;
			lines.push(`INSERT INTO ${quoteIdent(name)} (${cols.map(quoteIdent).join(", ")}) VALUES (${cols.map((c) => sqlLit(row[c])).join(", ")});`);
		}
	}
	return lines.join("\n") + "\n";
}

export interface BookmarkStorage {
	getBookmarkForTime?(timeMs: number): Promise<string>;
	onNextSessionRestoreBookmark?(bookmark: string): Promise<unknown> | unknown;
}

/** Admin RPC helper. The storage runtime's method is called only when it exists. */
export async function bookmarkForTime(storage: BookmarkStorage, timeMs: number): Promise<{ bookmark: string }> {
	if (typeof timeMs !== "number" || !Number.isFinite(timeMs)) throw new ExportError("bookmarkForTime: timeMs must be a finite number");
	if (typeof storage.getBookmarkForTime !== "function") throw new ExportError("bookmarkForTime: point-in-time restore is not available on this storage");
	const bookmark = await storage.getBookmarkForTime(timeMs);
	if (typeof bookmark !== "string" || !bookmark) throw new ExportError("bookmarkForTime: storage returned no bookmark");
	return { bookmark };
}

/**
 * How long the RPC result is given to leave before `ctx.abort()`.
 * The reset waits out this turn and a busy caller: aborting sooner drops the result.
 */
export const RESTORE_RESTART_DELAY_MS = 1000;

/**
 * Schedule `bookmark` for the next session and return `{ ok: true }`. Does not reset the object: `ctx.abort()` in
 * this turn would drop the RPC. The Durable Object calls `restartAfterResult` after this returns. A storage error
 * is thrown and the current database keeps running.
 */
export async function restoreBookmark(storage: BookmarkStorage, bookmark: string): Promise<{ ok: true; undo?: string }> {
	if (typeof bookmark !== "string" || bookmark.length < 1 || bookmark.length > 4096) throw new ExportError("restoreBookmark: bookmark is invalid");
	if (typeof storage.onNextSessionRestoreBookmark !== "function") throw new ExportError("restoreBookmark: point-in-time restore is not available on this storage");
	let raw: unknown;
	try {
		raw = await storage.onNextSessionRestoreBookmark(bookmark);
	} catch (e) {
		if (e instanceof ExportError) throw e;
		throw new ExportError(`restoreBookmark: ${e instanceof Error ? e.message : String(e)}`);
	}
	const undo = typeof raw === "string" && raw.length > 0 ? raw : undefined;
	return undo ? { ok: true, undo } : { ok: true };
}

/** Queue `restart` so the caller can return first. The timer is longer than this turn, so the RPC result is delivered. */
export function restartAfterResult(waitUntil: (p: Promise<unknown>) => void, restart: () => void, wait: (ms: number) => Promise<void>): void {
	waitUntil(wait(RESTORE_RESTART_DELAY_MS).then(() => { restart(); }));
}
