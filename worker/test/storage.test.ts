// Adapter and migration runner over node:sqlite. The workerd backends are STORAGE_BACKEND=d1|do. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { doSqlD1, migrateDo, type SqlStorageLike, type TxRunner } from "../src/storage.ts";
import { MIGRATIONS } from "../src/migrations.ts";

function asSql(db: DatabaseSync): SqlStorageLike {
	return {
		exec(query: string, ...bindings: unknown[]) {
			const multi = query.includes(";") && !/^\s*select\b/i.test(query);
			if (bindings.length === 0 && multi) {
				db.exec(query);
				return { toArray: () => [], raw: () => [], rowsRead: 0, rowsWritten: 0 };
			}
			const stmt = db.prepare(query);
			if (/^\s*select\b/i.test(query)) {
				const rows = stmt.all(...(bindings as [])) as Record<string, unknown>[];
				return { toArray: () => rows, raw: () => rows.map((r) => Object.values(r)), rowsRead: rows.length, rowsWritten: 0 };
			}
			const info = stmt.run(...(bindings as []));
			return { toArray: () => [], raw: () => [], rowsRead: 0, rowsWritten: Number(info.changes) };
		},
	};
}

function txOf(db: DatabaseSync): TxRunner {
	return (fn) => {
		db.exec("BEGIN");
		try { const v = fn(); db.exec("COMMIT"); return v; }
		catch (e) { db.exec("ROLLBACK"); throw e; }
	};
}

test("bundled migrations match worker/migrations", () => {
	const disk = fs.readdirSync(new URL("../migrations/", import.meta.url)).filter((n) => n.endsWith(".sql")).sort();
	assert.deepEqual(MIGRATIONS.map((m) => m.name), disk);
	for (const m of MIGRATIONS) {
		const file = fs.readFileSync(new URL(`../migrations/${m.name}`, import.meta.url), "utf8");
		assert.equal(m.sql, file, m.name);
	}
});

test("migrateDo applies in numeric order and a later lower number still runs", () => {
	const db = new DatabaseSync(":memory:");
	const sql = asSql(db);
	const tx = txOf(db);
	const early = MIGRATIONS.filter((m) => m.name === "0001_init.sql" || m.name === "0003_device_pairing.sql");
	assert.deepEqual(migrateDo(sql, tx, early), ["0001_init.sql", "0003_device_pairing.sql"]);
	const rest = migrateDo(sql, tx, MIGRATIONS);
	assert.equal(rest[0], "0002_wake_budget.sql");
	assert.deepEqual(rest, MIGRATIONS.map((m) => m.name).filter((n) => n !== "0001_init.sql" && n !== "0003_device_pairing.sql"));
	assert.deepEqual(migrateDo(sql, tx, MIGRATIONS), []);
	const names = db.prepare("SELECT name FROM d1_migrations ORDER BY id").all().map((r) => (r as { name: string }).name);
	assert.deepEqual(names, ["0001_init.sql", "0003_device_pairing.sql", ...rest]);
});

test("doSqlD1 matches D1 binding rules: booleans, undefined, missing columns, batch rollback", async () => {
	const db = new DatabaseSync(":memory:");
	const d = doSqlD1(asSql(db), txOf(db));
	await d.exec("CREATE TABLE t (n INTEGER)");
	await d.prepare("INSERT INTO t (n) VALUES (?)").bind(true).run();
	assert.equal((await d.prepare("SELECT n FROM t").first<{ n: number }>())?.n, 1);
	const wrote = await d.prepare("INSERT INTO t (n) VALUES (?)").bind(4).run();
	assert.equal(wrote.meta.changes, 1);
	await assert.rejects(() => d.prepare("SELECT n FROM t WHERE n = ?").bind(undefined).first(), /D1_TYPE_ERROR/);
	await assert.rejects(() => d.prepare("SELECT n FROM t").first("missing"), /D1_COLUMN_NOTFOUND/);
	await assert.rejects(() => d.batch([
		d.prepare("INSERT INTO t (n) VALUES (9)"),
		d.prepare("INSERT INTO missing (n) VALUES (1)"),
	]));
	assert.equal((await d.prepare("SELECT COUNT(*) AS c FROM t WHERE n = 9").first<{ c: number }>())?.c, 0);
});
