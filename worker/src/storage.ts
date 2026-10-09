// D1-shaped database over a Durable Object's SQLite (`ctx.storage.sql`).
// Handlers keep calling prepare().bind().first()/all()/run() and batch(). Self-host keeps the real D1 binding;
// a hosted tenant uses this adapter on its own object. `migrateDo` matches `cf d1 migrations apply`: the same
// `d1_migrations` table, unrecorded files in numeric order, one transaction per file.

/** The slice of the Workers `SqlStorage` API this adapter uses. Tests can implement it over node:sqlite. */
export interface SqlStorageLike {
	exec(query: string, ...bindings: unknown[]): SqlCursor;
}

export interface SqlCursor {
	toArray(): Record<string, unknown>[];
	raw(): Iterable<unknown[]>;
	rowsRead?: number;
	rowsWritten?: number;
}

export type TxRunner = <T>(fn: () => T) => T;
export type Migration = { name: string; sql: string };

const WRITE = /^\s*(?:insert|update|delete|replace)\b/i;

/** D1 rejects undefined bindings and stores booleans as 1/0. Mirror both so the backends agree. */
function norm(v: unknown, i: number): unknown {
	if (v === undefined) throw new Error(`D1_TYPE_ERROR: Type 'undefined' not supported for value at index ${i}`);
	if (typeof v === "boolean") return v ? 1 : 0;
	return v;
}

export interface DoSql {
	prepare(query: string): DoStmt;
	batch(statements: DoStmt[]): Promise<{ results?: unknown[]; meta: { changes?: number; last_row_id?: number } }[]>;
	exec(query: string): Promise<{ count: number; duration: number }>;
}

export interface DoStmt {
	__sql: string;
	__args: unknown[];
	bind(...values: unknown[]): DoStmt;
	first<T = unknown>(colName?: string): Promise<T | null>;
	all<T = unknown>(): Promise<{ results?: T[]; meta: { changes?: number; last_row_id?: number } }>;
	run(): Promise<{ results?: unknown[]; meta: { changes?: number; last_row_id?: number } }>;
	raw<T = unknown>(options?: { columnNames?: boolean }): Promise<T[]>;
}

/** A D1-shaped database over `SqlStorage`. `batch` is one transaction; DO SQL forbids BEGIN/COMMIT, so the caller passes `transactionSync`. */
export function doSqlD1(sql: SqlStorageLike, tx: TxRunner): DoSql {
	const execRaw = (q: string, args: unknown[], raw: boolean) => {
		const cur = sql.exec(q, ...args.map(norm));
		const rows = raw ? [...cur.raw()] : cur.toArray();
		let changes = 0, last_row_id = 0;
		if (WRITE.test(q)) {
			// `rowsWritten` also counts index writes. Ask SQLite for the D1-equivalent `meta.changes`.
			const m = sql.exec("SELECT changes() AS c, last_insert_rowid() AS r").toArray()[0] as { c?: unknown; r?: unknown } | undefined;
			changes = Number(m?.c ?? 0);
			last_row_id = Number(m?.r ?? 0);
		}
		return { rows, meta: { changes, last_row_id } };
	};
	const result = (q: string, args: unknown[]) => {
		const r = execRaw(q, args, false);
		return { success: true as const, results: r.rows, meta: r.meta };
	};
	const stmt = (q: string, args: unknown[] = []): DoStmt => ({
		__sql: q,
		__args: args,
		bind: (...a: unknown[]) => stmt(q, a),
		first: async (col?: string) => {
			const r = execRaw(q, args, false).rows[0] as Record<string, unknown> | undefined;
			if (!r) return null;
			if (col === undefined) return r as never;
			if (!(col in r)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${col})`);
			return r[col] as never;
		},
		all: async () => result(q, args),
		run: async () => result(q, args),
		raw: async (_o?: { columnNames?: boolean }) => execRaw(q, args, true).rows as never,
	});
	return {
		prepare: (q: string) => stmt(q),
		batch: async (stmts) => tx(() => stmts.map((s) => result(s.__sql, s.__args))),
		exec: async (q: string) => { sql.exec(q); return { count: 1, duration: 0 }; },
	};
}

const num = (n: string) => parseInt(n.split("_")[0]!, 10);
const byNumber = (a: Migration, b: Migration) => num(a.name) - num(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * Same bookkeeping as `cf d1 migrations apply`: create `d1_migrations` if needed, apply every unrecorded file in
 * numeric order, each in its own transaction. A lower number added later still runs when a higher one is already
 * recorded. Returns the names applied (empty once the object is up to date).
 * Call this only after the tenant row exists. An unconfigured object must not create tables.
 */
export function migrateDo(sql: SqlStorageLike, tx: TxRunner, migrations: Migration[]): string[] {
	sql.exec("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
	const done = new Set(sql.exec("SELECT name FROM d1_migrations").toArray().map((r) => String(r.name)));
	const todo = [...migrations].sort(byNumber).filter((m) => !done.has(m.name));
	for (const m of todo) tx(() => { sql.exec(m.sql); sql.exec("INSERT INTO d1_migrations (name) VALUES (?)", m.name); });
	return todo.map((m) => m.name);
}
