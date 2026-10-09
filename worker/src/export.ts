// Inbox export and import. Both the owner HTTP API and the hosted Durable Object use this.
// The allowlist is the application tables. `d1_migrations` and the hosted `tenant_config` row (it holds
// `secrets_enc`) are left out. Values are bound on import; the SQL text is produced only for a dump the
// operator already owns.

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
	"outbound_peers", "oauth_client_metadata",
] as const;

export type ExportTable = (typeof EXPORT_TABLES)[number];

export interface ExportFile {
	format: "a2a-exposed-export";
	version: 1;
	exportedAt: string;
	tables: { [K in ExportTable]?: Record<string, unknown>[] };
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TABLE_SET = new Set<string>(EXPORT_TABLES);

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

function sqlLit(v: unknown): string {
	if (v === null) return "NULL";
	if (typeof v === "boolean") return v ? "1" : "0";
	if (typeof v === "number") return Number.isInteger(v) ? String(v) : JSON.stringify(v);
	if (typeof v === "string") return `'${v.replaceAll("'", "''")}'`;
	throw new ExportError("export: unsupported value");
}

function bindable(v: unknown): unknown {
	if (v === null || typeof v === "string") return v;
	if (typeof v === "boolean") return v ? 1 : 0;
	if (typeof v === "number") {
		if (!Number.isFinite(v)) throw new ExportError("import: non-finite number");
		return v;
	}
	throw new ExportError("import: unsupported value");
}

/** Every allowlisted table, including ones with no rows. */
export async function exportRows(db: SqlDb, now = new Date()): Promise<ExportFile> {
	const tables: ExportFile["tables"] = {};
	for (const name of EXPORT_TABLES) {
		const rows = await db.prepare(`SELECT * FROM ${quoteIdent(name)}`).all<Record<string, unknown>>();
		tables[name] = (rows.results ?? []).map(normalizeRow);
	}
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

function plain(v: unknown, what: string): Record<string, unknown> {
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new ExportError(`import: ${what} must be an object`);
	return v as Record<string, unknown>;
}

/** Replace rows in the tables the file lists. A table key that is absent is left as it is. */
export async function importRows(db: SqlDb, input: unknown): Promise<{ tables: number; rows: number }> {
	const file = plain(input, "body");
	if (file.format !== "a2a-exposed-export" || file.version !== 1) throw new ExportError("import: format or version is not supported");
	const tables = plain(file.tables, "tables");
	for (const name of Object.keys(tables)) {
		if (!TABLE_SET.has(name)) throw new ExportError(`import: unknown table ${name.slice(0, 64)}`);
		if (!Array.isArray(tables[name])) throw new ExportError(`import: ${name} must be an array`);
	}
	const stmts = [];
	let rows = 0;
	let listed = 0;
	for (const name of EXPORT_TABLES) {
		const list = tables[name];
		if (!Array.isArray(list)) continue;
		listed++;
		stmts.push(db.prepare(`DELETE FROM ${quoteIdent(name)}`));
		for (const item of list) {
			const row = plain(item, "each row");
			const cols = Object.keys(row);
			for (const c of cols) if (!IDENT.test(c)) throw new ExportError("import: bad column");
			if (!cols.length) continue;
			stmts.push(db.prepare(`INSERT INTO ${quoteIdent(name)} (${cols.map(quoteIdent).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...cols.map((c) => bindable(row[c]))));
			rows++;
		}
	}
	if (stmts.length) await db.batch(stmts);
	return { tables: listed, rows };
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
 * Ask the runtime to restore `bookmark` on the next session. The isolate is left running so this RPC can answer;
 * the runtime applies the bookmark when the next session starts.
 */
export async function restoreBookmark(storage: BookmarkStorage, bookmark: string): Promise<{ ok: true }> {
	if (typeof bookmark !== "string" || bookmark.length < 1 || bookmark.length > 4096) throw new ExportError("restoreBookmark: bookmark is invalid");
	if (typeof storage.onNextSessionRestoreBookmark !== "function") throw new ExportError("restoreBookmark: point-in-time restore is not available on this storage");
	await storage.onNextSessionRestoreBookmark(bookmark);
	return { ok: true };
}
