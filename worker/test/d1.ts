// Minimal D1 stand-in over node:sqlite (in-memory), with the repo's migrations applied: lets tests drive the real
// Worker fetch handler. Covers what the Worker uses: prepare().bind().first()/all()/run(), RETURNING, and batch().
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

export function d1(migrationsDir: URL) {
	const db = new DatabaseSync(":memory:");
	for (const f of fs.readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort())
		db.exec(fs.readFileSync(new URL(f, migrationsDir), "utf8"));
	return d1On(db);
}

/** The same D1 stand-in over an existing node:sqlite database (e.g. one whose schema a test built step by step). */
export function d1On(db: DatabaseSync) {
	const stmt = (sql: string, args: unknown[] = []): any => ({
		bind: (...a: unknown[]) => stmt(sql, a),
		first: async (col?: string) => {
			const r: any = db.prepare(sql).get(...(args as any[]));
			return r ? (col ? r[col] : { ...r }) : null;
		},
		all: async () => ({ results: db.prepare(sql).all(...(args as any[])).map((r: any) => ({ ...r })), meta: {} }),
		run: async () => {
			const s = db.prepare(sql);
			if (/\breturning\b/i.test(sql)) { const rows = s.all(...(args as any[])); return { results: rows, meta: { changes: rows.length } }; }
			const r = s.run(...(args as any[]));
			return { results: [], meta: { changes: Number(r.changes) } };
		},
	});
	return {
		db,
		prepare: (sql: string) => stmt(sql),
		batch: async (stmts: any[]) => {
			db.exec("BEGIN");
			try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec("COMMIT"); return out; }
			catch (e) { db.exec("ROLLBACK"); throw e; }
		},
	};
}
