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

function plain(v: unknown, what: string): Record<string, unknown> {
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new ExportError(`import: ${what} must be an object`);
	return v as Record<string, unknown>;
}

/**
 * D1 Free allows 50 queries per Worker invocation, and each statement inside `batch` counts as one.
 * `dispatch` then reads due wakes once, so an import keeps one query in reserve.
 */
export const IMPORT_QUERY_BUDGET = 49;

/** Bound parameters D1 accepts on one statement. */
const MAX_BIND = 100;

const STAGE_PREFIX = "_a2a_import_";
const META_TABLE = "_a2a_import_meta";
const IMPORT_ID = /^[0-9a-f]{32}$/;

function stagingTable(name: string): string {
	return STAGE_PREFIX + name;
}

function newImportId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ImportCursor {
	phase: "stage" | "commit" | "cleanup";
	/** Set on every follow-up. Matches the row in `_a2a_import_meta`. */
	id?: string;
	table?: string;
	offset?: number;
}

export interface ImportOptions {
	/** True when `tokenEnc` opens with this deployment's sealing key. Omitted: ciphertext is kept as stored. */
	openOutboundToken?(alias: string, tokenEnc: string): Promise<boolean>;
	/** Continue a staged import. Absent: start over (and replace in one batch when the file fits). */
	resume?: unknown;
}

interface TableSchema { columns: Set<string>; createSql: string }
type Row = Record<string, unknown>;

/** Columns and the CREATE statement sqlite stored, for every listed table. One query. */
async function schemas(db: SqlDb, names: string[]): Promise<Map<string, TableSchema>> {
	const known = new Map<string, TableSchema>();
	if (!names.length) return known;
	const sql = `SELECT m.name AS t, m.sql AS sql, p.name AS c FROM sqlite_master AS m JOIN pragma_table_info(m.name) AS p WHERE m.type = 'table' AND m.name IN (${names.map(sqlLit).join(", ")})`;
	const info = await db.prepare(sql).all<{ t: string; sql: string; c: string }>();
	for (const name of names) known.set(name, { columns: new Set(), createSql: "" });
	for (const row of info.results ?? []) {
		const slot = row && known.get(row.t);
		if (!slot) continue;
		if (typeof row.c === "string" && row.c) slot.columns.add(row.c);
		if (typeof row.sql === "string" && row.sql) slot.createSql = row.sql;
	}
	for (const name of names) {
		const slot = known.get(name)!;
		if (!slot.columns.size || !slot.createSql) throw new ExportError(`import: unknown table ${name}`);
	}
	return known;
}

/** Rewrite the stored CREATE TABLE so staging gets the same columns, defaults and constraints. */
function createStaging(sql: string, table: string, stage: string): string {
	const re = new RegExp(`^(\\s*CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)(?:"${table}"|${table})(?=\\s|\\()`, "i");
	if (!re.test(sql)) throw new ExportError(`import: could not stage ${table}`);
	return sql.replace(re, `$1${quoteIdent(stage)}`);
}

function sameKeys(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

function insertStatementCount(rows: Row[]): number {
	let n = 0;
	let i = 0;
	while (i < rows.length) {
		const keys = Object.keys(rows[i] ?? {});
		if (!keys.length) { i++; continue; }
		if (keys.length > MAX_BIND) throw new ExportError("import: too many columns");
		const per = Math.floor(MAX_BIND / keys.length);
		let j = i + 1;
		while (j < rows.length && j - i < per) {
			const next = Object.keys(rows[j] ?? {});
			if (!next.length || !sameKeys(keys, next)) break;
			j++;
		}
		n++;
		i = j;
	}
	return n;
}

/** Multi-row INSERT statements for `rows` from `from`, stopping after `budget` statements. */
function packInserts(db: SqlDb, table: string, rows: Row[], from: number, budget: number): { stmts: ReturnType<SqlDb["prepare"]>[]; end: number; used: number; inserted: number } {
	const stmts: ReturnType<SqlDb["prepare"]>[] = [];
	let i = from;
	let used = 0;
	let inserted = 0;
	while (i < rows.length) {
		const keys = Object.keys(rows[i] ?? {});
		if (!keys.length) { i++; continue; }
		if (used >= budget) break;
		if (keys.length > MAX_BIND) throw new ExportError("import: too many columns");
		const per = Math.floor(MAX_BIND / keys.length);
		let j = i + 1;
		while (j < rows.length && j - i < per) {
			const next = Object.keys(rows[j] ?? {});
			if (!next.length || !sameKeys(keys, next)) break;
			j++;
		}
		const slice = rows.slice(i, j);
		const placeholders = slice.map(() => `(${keys.map(() => "?").join(", ")})`).join(", ");
		const args = slice.flatMap((row) => keys.map((c) => bindable(row[c])));
		stmts.push(db.prepare(`INSERT INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(", ")}) VALUES ${placeholders}`).bind(...args));
		inserted += slice.length;
		used++;
		i = j;
	}
	return { stmts, end: i, used, inserted };
}

function filledRows(lists: Map<string, Row[]>): number {
	let n = 0;
	for (const rows of lists.values()) for (const row of rows) if (Object.keys(row).length) n++;
	return n;
}

async function runBatch(db: SqlDb, stmts: ReturnType<SqlDb["prepare"]>[]): Promise<void> {
	if (!stmts.length) return;
	try {
		await db.batch(stmts);
	} catch (e) {
		if (e instanceof ExportError) throw e;
		const msg = e instanceof Error ? e.message : String(e);
		throw new ExportError(`import: rows do not match the schema: ${msg.replace(/\s+/g, " ").slice(0, 180)}`);
	}
}

async function readMeta(db: SqlDb): Promise<{ id?: string; ready?: string } | null> {
	try {
		const info = await db.prepare(`SELECT k, v FROM ${quoteIdent(META_TABLE)} WHERE k IN ('id', 'ready')`).all<{ k: string; v: string }>();
		const out: { id?: string; ready?: string } = {};
		for (const row of info.results ?? []) {
			if (row?.k === "id" && typeof row.v === "string") out.id = row.v;
			if (row?.k === "ready" && typeof row.v === "string") out.ready = row.v;
		}
		return out;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (/no such table/i.test(msg)) return null;
		throw e;
	}
}

function parseResume(v: unknown): ImportCursor | undefined {
	if (v == null) return undefined;
	const o = plain(v, "resume");
	const phase = o.phase;
	if (phase !== "stage" && phase !== "commit" && phase !== "cleanup") throw new ExportError("import: resume phase is invalid");
	const id = o.id;
	if (phase !== "stage" || id !== undefined || o.table !== undefined) {
		if (typeof id !== "string" || !IMPORT_ID.test(id)) throw new ExportError("import: resume id is invalid");
	}
	if (phase === "stage") {
		if (typeof o.table !== "string" || !TABLE_SET.has(o.table)) throw new ExportError("import: resume table is invalid");
		if (typeof o.offset !== "number" || !Number.isInteger(o.offset) || o.offset < 0) throw new ExportError("import: resume offset is invalid");
		return { phase, id, table: o.table, offset: o.offset };
	}
	return { phase, id: id as string };
}

async function prepareTableRows(name: string, list: unknown[], allowed: Set<string>, opts: ImportOptions): Promise<{ rows: Row[]; needSync: string[] }> {
	const rows: Row[] = [];
	const needSync: string[] = [];
	for (const item of list) {
		let row = plain(item, "each row");
		for (const c of Object.keys(row)) {
			if (!IDENT.test(c)) throw new ExportError("import: bad column");
			if (!allowed.has(c)) throw new ExportError(`import: ${name} has no column ${c.slice(0, 64)}`);
		}
		if (name === "outbound_peers" && opts.openOutboundToken && typeof row.token_enc === "string" && row.token_enc) {
			const alias = typeof row.alias === "string" ? row.alias.slice(0, 128) : "";
			let opens = false;
			try { opens = await opts.openOutboundToken(alias, row.token_enc); }
			catch { opens = false; }
			if (!opens) {
				row = { ...row, token_enc: null };
				if (alias && !needSync.includes(alias)) needSync.push(alias);
			}
		}
		rows.push(row);
	}
	return { rows, needSync };
}

export interface ImportResult {
	tables: number;
	rows: number;
	outboundPeersNeedSync: string[];
	/** Set when this invocation stopped before the inbox was replaced. The same file plus this cursor continues it. */
	next?: ImportCursor;
}

/**
 * Replace rows in the tables the file lists. A table key that is absent is left as it is.
 * When `openOutboundToken` is set, an `outbound_peers.token_enc` that does not open is stored as NULL and the
 * alias is returned in `outboundPeersNeedSync`. The ciphertext is not copied into a deployment that cannot read it.
 *
 * A file that fits in {@link IMPORT_QUERY_BUDGET} is one batch: DELETE the listed tables, then INSERT. That batch
 * is one transaction. A larger file is inserted into side tables (`_a2a_import_*`) across invocations and swapped
 * into the live tables in one batch. Until that swap, the inbox is unchanged. `next` is the cursor for the next call.
 */
export async function importRows(db: SqlDb, input: unknown, opts: ImportOptions = {}): Promise<ImportResult> {
	const file = plain(input, "body");
	if (file.format !== "a2a-exposed-export" || file.version !== 1) throw new ExportError("import: format or version is not supported");
	const tables = plain(file.tables, "tables");
	for (const name of Object.keys(tables)) {
		if (!TABLE_SET.has(name)) throw new ExportError(`import: unknown table ${name.slice(0, 64)}`);
		if (!Array.isArray(tables[name])) throw new ExportError(`import: ${name} must be an array`);
	}
	const resume = parseResume(opts.resume);
	const listed = EXPORT_TABLES.filter((name) => Array.isArray(tables[name]));
	if (!listed.length) return { tables: 0, rows: 0, outboundPeersNeedSync: [] };

	let used = 0;
	const known = await schemas(db, [...listed]);
	used++;
	const prepared = new Map<string, Row[]>();
	const outboundPeersNeedSync: string[] = [];
	for (const name of listed) {
		const { rows, needSync } = await prepareTableRows(name, tables[name] as unknown[], known.get(name)!.columns, opts);
		prepared.set(name, rows);
		for (const alias of needSync) if (!outboundPeersNeedSync.includes(alias)) outboundPeersNeedSync.push(alias);
	}
	const done = (rows: number, next?: ImportCursor): ImportResult => ({ tables: listed.length, rows, outboundPeersNeedSync, ...(next ? { next } : {}) });

	if (resume?.phase === "cleanup") {
		const meta = await readMeta(db);
		used++;
		if (!meta) return done(0);
		if (meta.id !== resume.id) throw new ExportError("import: resume does not match the staged import");
		const drop = dropStaging(db, listed, IMPORT_QUERY_BUDGET - used);
		await runBatch(db, drop.stmts);
		if (drop.rest.length || !drop.meta) return done(0, { phase: "cleanup", id: resume.id });
		return done(0);
	}

	if (resume?.phase === "commit") {
		const meta = await readMeta(db);
		used++;
		if (!meta || meta.id !== resume.id || meta.ready !== resume.id) throw new ExportError("import: staging is incomplete; re-run import");
		const swap = [];
		for (const name of listed) {
			swap.push(db.prepare(`DELETE FROM ${quoteIdent(name)}`));
			swap.push(db.prepare(`INSERT INTO ${quoteIdent(name)} SELECT * FROM ${quoteIdent(stagingTable(name))}`));
		}
		await runBatch(db, swap);
		used += swap.length;
		const drop = dropStaging(db, listed, IMPORT_QUERY_BUDGET - used);
		await runBatch(db, drop.stmts);
		if (drop.rest.length || !drop.meta) return done(0, { phase: "cleanup", id: resume.id });
		return done(0);
	}

	const insertCount = listed.reduce((n, name) => n + insertStatementCount(prepared.get(name)!), 0);
	if (!resume && used + listed.length + insertCount <= IMPORT_QUERY_BUDGET) {
		const stmts = [];
		for (const name of listed) {
			stmts.push(db.prepare(`DELETE FROM ${quoteIdent(name)}`));
			stmts.push(...packInserts(db, name, prepared.get(name)!, 0, insertCount).stmts);
		}
		await runBatch(db, stmts);
		return done(filledRows(prepared));
	}

	const id = resume?.id ?? newImportId();
	const staging: ReturnType<SqlDb["prepare"]>[] = [];
	if (!resume) {
		staging.push(db.prepare(`DROP TABLE IF EXISTS ${quoteIdent(META_TABLE)}`));
		for (const name of listed) staging.push(db.prepare(`DROP TABLE IF EXISTS ${quoteIdent(stagingTable(name))}`));
		staging.push(db.prepare(`CREATE TABLE ${quoteIdent(META_TABLE)} (k TEXT PRIMARY KEY, v TEXT NOT NULL)`));
		for (const name of listed) staging.push(db.prepare(createStaging(known.get(name)!.createSql, name, stagingTable(name))));
		staging.push(db.prepare(`INSERT INTO ${quoteIdent(META_TABLE)} (k, v) VALUES ('id', ?)`).bind(id));
	} else {
		const meta = await readMeta(db);
		used++;
		if (!meta || meta.id !== id) throw new ExportError("import: resume does not match the staged import");
	}
	// One statement stays free so the chunk that finishes can mark the staging ready in the same batch.
	const insertBudget = IMPORT_QUERY_BUDGET - used - staging.length - 1;
	if (insertBudget < 1 && insertCount > 0) throw new ExportError("import: query budget cannot fit a row");
	const packed = stageRows(db, listed, prepared, resume?.phase === "stage" ? { table: resume.table!, offset: resume.offset! } : null, Math.max(0, insertBudget));
	if (resume?.phase === "stage" && packed.cursor && packed.cursor.table === resume.table && packed.cursor.offset === resume.offset) {
		throw new ExportError("import: query budget cannot fit a row");
	}
	staging.push(...packed.stmts);
	if (!packed.cursor) staging.push(db.prepare(`INSERT INTO ${quoteIdent(META_TABLE)} (k, v) VALUES ('ready', ?)`).bind(id));
	await runBatch(db, staging);
	if (packed.cursor) return done(packed.inserted, { phase: "stage", id, table: packed.cursor.table, offset: packed.cursor.offset });
	return done(packed.inserted, { phase: "commit", id });
}

function stageRows(db: SqlDb, listed: readonly string[], prepared: Map<string, Row[]>, from: { table: string; offset: number } | null, budget: number): { stmts: ReturnType<SqlDb["prepare"]>[]; inserted: number; cursor: { table: string; offset: number } | null } {
	let armed = !from;
	let inserted = 0;
	const stmts: ReturnType<SqlDb["prepare"]>[] = [];
	for (const name of listed) {
		const rows = prepared.get(name)!;
		let i = 0;
		if (!armed) {
			if (name !== from!.table) continue;
			if (from!.offset > rows.length) throw new ExportError("import: resume offset is past the end of the table");
			armed = true;
			i = from!.offset;
		}
		const part = packInserts(db, stagingTable(name), rows, i, budget);
		stmts.push(...part.stmts);
		budget -= part.used;
		inserted += part.inserted;
		if (part.end < rows.length) return { stmts, inserted, cursor: { table: name, offset: part.end } };
	}
	if (from && !armed) throw new ExportError("import: resume table is not in this file");
	return { stmts, inserted, cursor: null };
}

/** DROP staging tables, then the meta table, up to `budget` statements. */
function dropStaging(db: SqlDb, names: readonly string[], budget: number): { stmts: ReturnType<SqlDb["prepare"]>[]; rest: string[]; meta: boolean } {
	const stmts: ReturnType<SqlDb["prepare"]>[] = [];
	const rest: string[] = [];
	for (const name of names) {
		if (stmts.length < budget) stmts.push(db.prepare(`DROP TABLE IF EXISTS ${quoteIdent(stagingTable(name))}`));
		else rest.push(name);
	}
	let meta = false;
	if (!rest.length && stmts.length < budget) {
		stmts.push(db.prepare(`DROP TABLE IF EXISTS ${quoteIdent(META_TABLE)}`));
		meta = true;
	}
	return { stmts, rest, meta };
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
