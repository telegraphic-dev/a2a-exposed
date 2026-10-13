// D1-shaped stand-in over node:sqlite. prepare, batch, and exec match the D1 API the library calls.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function openDb() {
	const db = new DatabaseSync(":memory:");
	const dir = path.join(root, "migrations");
	for (const name of fs.readdirSync(dir).filter((file) => file.endsWith(".sql")).sort()) {
		db.exec(fs.readFileSync(path.join(dir, name), "utf8"));
	}
	const stmt = (sql: string, args: unknown[] = []) => ({
		__sql: sql,
		__args: args,
		bind: (...next: unknown[]) => stmt(sql, next),
		async first<T>(): Promise<T | null> {
			const row = db.prepare(sql).get(...(args as [])) as T | undefined;
			return row ? { ...row } : null;
		},
		async run() {
			const result = db.prepare(sql).run(...(args as []));
			return { meta: { changes: Number(result.changes) } };
		},
		async all() {
			const writing = !/^\s*(select|pragma|with)\b/i.test(sql) && !/\breturning\b/i.test(sql);
			if (writing) {
				const result = db.prepare(sql).run(...(args as []));
				return { results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
			}
			const results = db.prepare(sql).all(...(args as [])).map((row) => ({ ...row }));
			return { results, meta: { changes: results.length } };
		},
	});
	// One write transaction at a time, as D1 does. Overlapping batches wait instead of nesting BEGIN.
	let pending = Promise.resolve();
	return {
		prepare: (sql: string) => stmt(sql),
		async batch(statements: { all(): Promise<{ results: unknown[] }> }[]) {
			const previous = pending;
			let release = () => {};
			pending = new Promise<void>((resolve) => { release = resolve; });
			await previous;
			try {
				db.exec("BEGIN");
				try {
					const out = [];
					for (const statement of statements) out.push(await statement.all());
					db.exec("COMMIT");
					return out;
				} catch (error) {
					try { db.exec("ROLLBACK"); } catch { /* the statement failed before the write */ }
					throw error;
				}
			} finally {
				release();
			}
		},
		async exec(sql: string) {
			db.exec(sql);
			return { count: 0, duration: 0 };
		},
	};
}
