// D1 migrations: file naming and order, and what `cf d1 migrations apply` (run by init/deploy) does to databases
// created by earlier builds. cf records applied migrations by file name in `d1_migrations` and applies every file whose
// name isn't recorded, in numeric order. So 0002_wake_budget.sql, added after 0003 shipped, still runs on a database
// that already recorded 0001 and 0003. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.ts";
import { sha256 } from "../src/a2a.ts";
import { d1On } from "./d1.ts";

const DIR = new URL("../migrations/", import.meta.url);
const FILES = fs.readdirSync(DIR).filter((n) => n.endsWith(".sql"));
const sql = (f: string) => fs.readFileSync(new URL(f, DIR), "utf8");
const num = (f: string) => parseInt(f.split("_")[0], 10);
const byNumber = (a: string, b: string) => num(a) - num(b) || (a < b ? -1 : a > b ? 1 : 0);

/** What `cf d1 migrations apply` does: create the tracking table, then apply and record each file whose name isn't
 *  recorded yet, in numeric order. Returns the names it applied. */
function applyMigrations(db: DatabaseSync, files = FILES): string[] {
	db.exec("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
	const done = new Set(db.prepare("SELECT name FROM d1_migrations").all().map((r: any) => r.name));
	const todo = [...files].sort(byNumber).filter((f) => !done.has(f));
	for (const f of todo) {
		db.exec(sql(f));
		db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(f);
	}
	return todo;
}

/** A database whose migrations table already lists `recorded`, built from the given schema files. */
function existingDb(schema: string[], recorded: string[]): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
	for (const s of schema) db.exec(s);
	for (const name of recorded) db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
	return db;
}

const tables = (db: DatabaseSync) =>
	db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%' ORDER BY name").all().map((r: any) => r.name);
const columns = (db: DatabaseSync, t: string) => db.prepare(`PRAGMA table_info(${t})`).all().map((r: any) => r.name);
const recorded = (db: DatabaseSync) => db.prepare("SELECT name FROM d1_migrations ORDER BY id").all().map((r: any) => r.name);

// The current 0001 without its wake_budget table: the shape of an older build's 0001_init.sql (e.g. the s2a2a prototype).
const OLD_0001 = sql("0001_init.sql").replace(/CREATE TABLE IF NOT EXISTS wake_budget \([^;]*\);\n?/, "");

test("migration files: NNNN_name.sql, unique numbers, no gaps, 0002_wake_budget between 0001 and 0003", () => {
	for (const f of FILES) assert.match(f, /^\d{4}_[a-z0-9_]+\.sql$/, f);
	assert.equal(new Set(FILES.map(num)).size, FILES.length, "two migrations share a number");
	assert.deepEqual([...FILES].sort(byNumber).map(num), FILES.map((_, i) => i + 1), "numbered 0001, 0002, ... without gaps");
	assert.deepEqual([...FILES].sort(byNumber).slice(0, 4), ["0001_init.sql", "0002_wake_budget.sql", "0003_device_pairing.sql", "0004_pairing_replace.sql"]);
	assert.deepEqual([...FILES].sort(byNumber), [...FILES].sort(), "numeric and lexical order agree (test/d1.ts sorts lexically)");
});

test("fresh database: every migration applies in order; a second run applies nothing", () => {
	const db = new DatabaseSync(":memory:");
	assert.deepEqual(applyMigrations(db), [...FILES].sort(byNumber));
	for (const t of ["peers", "tasks", "wakes", "wake_budget", "device_requests", "pairing_rate", "settings"]) assert.ok(tables(db).includes(t), t);
	assert.ok(columns(db, "peers").includes("source"));
	assert.ok(columns(db, "device_requests").includes("replaces_label"));
	assert.deepEqual(applyMigrations(db), []);
});

test("database from the 0002 fix (0001-0003 recorded): only 0004 applies; pending requests keep working", () => {
	const db = existingDb([sql("0001_init.sql"), sql("0002_wake_budget.sql"), sql("0003_device_pairing.sql")], ["0001_init.sql", "0002_wake_budget.sql", "0003_device_pairing.sql"]);
	db.prepare("INSERT INTO device_requests (device_hash, user_code, status, created_ms, expires_ms, interval_s) VALUES ('h', 'WDJB4827', 'pending', 1, 2, 5)").run();
	assert.deepEqual(applyMigrations(db), ["0004_pairing_replace.sql"]);
	assert.equal((db.prepare("SELECT replaces_label FROM device_requests WHERE device_hash = 'h'").get() as any).replaces_label, null);
});

test("database from v0.2.0 (0001 and 0003 recorded): 0002 applies as a no-op and keeps the data", () => {
	const db = existingDb([sql("0001_init.sql"), sql("0003_device_pairing.sql")], ["0001_init.sql", "0003_device_pairing.sql"]);
	db.prepare("INSERT INTO wake_budget (hour, count) VALUES (1, 7)").run();
	assert.deepEqual(applyMigrations(db), ["0002_wake_budget.sql", "0004_pairing_replace.sql"]);
	assert.deepEqual(recorded(db), ["0001_init.sql", "0003_device_pairing.sql", "0002_wake_budget.sql", "0004_pairing_replace.sql"]);
	assert.equal((db.prepare("SELECT count FROM wake_budget WHERE hour = 1").get() as any).count, 7);
});

test("database from an earlier build without wake_budget (0001 and 0003 recorded): 0002 creates it, old tokens and wakes work", async () => {
	const db = existingDb([OLD_0001, sql("0003_device_pairing.sql")], ["0001_init.sql", "0003_device_pairing.sql"]);
	assert.ok(!tables(db).includes("wake_budget"));
	// a peer token from the earlier build: another prefix, stored as its SHA-256 like every token
	const oldToken = "s2a_" + "x".repeat(43);
	db.prepare("INSERT INTO peers (label, token_hash, created_at) VALUES (?, ?, ?)").run("old-peer", await sha256(oldToken), "2026-01-01T00:00:00.000Z");

	const wakes: any[] = [];
	const origFetch = globalThis.fetch;
	globalThis.fetch = (async (url: any, init: any) => { wakes.push({ url: String(url), body: JSON.parse(init.body) }); return new Response("ok"); }) as any;
	const env: any = { DB: d1On(db), PUBLIC_URL: "https://agent.example.com", OWNER_TOKEN: "owner-secret", AGENT_NAME: "Adopted Inbox",
		WAKE_PRESET: "grok-bot", WAKE_WEBHOOK_URL: "https://hook.example.net/wake", WAKE_WEBHOOK_KEY: "hook-key", WAKE_MAX_PER_HOUR: "10" };
	/** The old peer sends a message (its own conversation each time, so no debounce applies). */
	const send = async (messageId: string) => {
		const pending: Promise<unknown>[] = [];
		const body = { jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { role: "ROLE_USER", messageId, parts: [{ text: "hello again" }] } } };
		const res = await worker.fetch(new Request("https://agent.example.com/", { method: "POST", body: JSON.stringify(body),
			headers: { "content-type": "application/json", "a2a-version": "1.0", authorization: `Bearer ${oldToken}` } }) as any,
			env, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as any);
		await Promise.allSettled(pending);
		return { status: res.status, data: (await res.json()) as any };
	};
	try {
		// before 0002: the wake's hourly cap has no table, so the peer gets an internal error and no wake goes out
		const before = await send("m1");
		assert.equal(before.data.error?.code, -32603, JSON.stringify(before.data));
		assert.equal(wakes.length, 0);

		assert.deepEqual(applyMigrations(db), ["0002_wake_budget.sql", "0004_pairing_replace.sql"]);
		assert.deepEqual(columns(db, "wake_budget"), ["hour", "count"]);
		assert.deepEqual(applyMigrations(db), []);

		// after: the same peer token works and the wake is sent and counted
		const after = await send("m2");
		assert.equal(after.status, 200);
		assert.ok(after.data.result, JSON.stringify(after.data));
		assert.equal(wakes.length, 1);
		assert.equal(wakes[0].body.from, "old-peer");
		assert.equal((db.prepare("SELECT SUM(count) AS n FROM wake_budget").get() as any).n, 1);
	} finally {
		globalThis.fetch = origFetch;
	}
});
