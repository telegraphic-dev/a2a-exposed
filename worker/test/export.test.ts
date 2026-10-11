// Inbox export and the gated daily R2 snapshot. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import worker from "../src/index.ts";
import { d1 } from "./d1.ts";
import { sha256 } from "../src/a2a.ts";
import { exportRows, redactExport, REDACTED_SQL_SKIP, scrubSecretText, toSql, bookmarkForTime, restoreBookmark, restartAfterResult, ExportError, EXPORT_TABLES, RESTORE_RESTART_DELAY_MS } from "../src/export.ts";
import { ownerResponseLeaks, TOKEN_PREFIXES } from "../src/owner-rpc.ts";
import { doSqlD1, type SqlStorageLike, type TxRunner } from "../src/storage.ts";
import { backupDatabase, backupDirectory, exportTenantSql, hostedDailyBackup, olderThanRetention, pruneSnapshots, snapshotKey, DAILY_CRON, type R2BucketLike } from "../src/backup.ts";
import { namespaceForRegion, type DoNamespace } from "../src/tenancy.ts";
import type { DirectoryEntry } from "../src/directory.ts";

const BASE = "https://agent.example.com";
const MIGRATIONS = new URL("../migrations/", import.meta.url);
const ectx = { waitUntil(_p: Promise<unknown>) {}, passThroughOnException() {} };

function db() {
	return d1(MIGRATIONS);
}

test("export SQL round-trips application rows and skips hosted config", async () => {
	const DB = db();
	const now = "2026-10-09T03:00:00.000Z";
	await DB.prepare("INSERT INTO peers (label, token_hash, created_at, revoked_at) VALUES (?, ?, ?, NULL)").bind("o'brien", "hash-1", now).run();
	await DB.prepare("INSERT INTO history (context_id, ts, dir, text) VALUES (?, ?, 'in', ?)").bind("ctx-1", now, "a'b\n-- drop").run();
	const file = await exportRows(DB, new Date(now));
	assert.equal(file.format, "a2a-exposed-export");
	assert.equal(file.version, 1);
	assert.equal(file.tables.peers?.[0]?.label, "o'brien");
	assert.deepEqual(Object.keys(file.tables).sort(), [...EXPORT_TABLES].sort());
	const sql = toSql(file);
	assert.match(sql, /o''brien/);
	assert.match(sql, /'a''b\n-- drop'/);
	assert.doesNotMatch(sql, /tenant_config/);
	assert.doesNotMatch(sql, /d1_migrations/);
	assert.doesNotMatch(sql, /secrets_enc/);

	const fresh = new DatabaseSync(":memory:");
	for (const name of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort())
		fresh.exec(fs.readFileSync(new URL(name, MIGRATIONS), "utf8"));
	fresh.exec(sql);
	const peer = fresh.prepare("SELECT label, token_hash FROM peers").get() as { label: string; token_hash: string };
	assert.equal(peer.label, "o'brien");
	assert.equal(peer.token_hash, "hash-1");
	const text = fresh.prepare("SELECT text FROM history").get() as { text: string };
	assert.equal(text.text, "a'b\n-- drop");
});

test("export SQL writes a NUL byte as char(0) so the script stays valid", () => {
	const raw = "a'\0b\0";
	const sql = toSql({
		format: "a2a-exposed-export",
		version: 1,
		exportedAt: "2026-10-09T03:00:00.000Z",
		tables: { history: [{ context_id: "ctx-nul", ts: "2026-10-09T03:00:00.000Z", dir: "in", text: raw }] },
	});
	assert.equal(sql.includes("\u0000"), false);
	assert.match(sql, /\('a''' \|\| char\(0\) \|\| 'b' \|\| char\(0\)\)/);
	const fresh = new DatabaseSync(":memory:");
	for (const name of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort())
		fresh.exec(fs.readFileSync(new URL(name, MIGRATIONS), "utf8"));
	fresh.exec(sql);
	const hex = fresh.prepare("SELECT hex(text) AS h FROM history").get() as { h: string };
	assert.equal(hex.h, Buffer.from(raw, "utf8").toString("hex").toUpperCase());
});

test("redactExport drops credential material and leaves the full dump unchanged", async () => {
	const DB = db();
	const now = "2026-10-11T00:00:00.000Z";
	const token = "a2aow_" + "a".repeat(20);
	const owner = "a2aot_" + "Q".repeat(43);
	const hash = "ab".repeat(32);
	const replaces = "cd".repeat(32);
	const setupHash = "ef".repeat(32);
	const setup = "c".repeat(16);
	await DB.prepare("INSERT INTO peers (label, token_hash, created_at) VALUES ('ada', ?, ?)").bind(hash, now).run();
	await DB.prepare("INSERT INTO history (context_id, ts, dir, text) VALUES ('ctx-1', ?, 'in', ?)").bind(now, `see ${token} and ${owner} at https://user:secret@hooks.example/wake?t=${setup}`).run();
	await DB.prepare("INSERT INTO history (context_id, ts, dir, text) VALUES ('ctx-owner', ?, 'in', ?)").bind(now, owner).run();
	await DB.prepare("INSERT INTO tasks (id, context_id, peer, state, protocol, created_at, updated_at, status_json, artifacts_json, push_configs_json) VALUES ('task-1', 'ctx-1', 'ada', 'submitted', '1.0', ?, ?, '{}', '[]', ?)").bind(now, now, JSON.stringify([{ token }])).run();
	await DB.prepare("INSERT INTO outbound (task_id, context_id, peer, push_token_hash, sent_at, task_json) VALUES ('task-1', 'ctx-1', 'ada', 'push-hash-secret', ?, ?)").bind(now, JSON.stringify({ token })).run();
	await DB.prepare("INSERT INTO settings (key, value) VALUES ('approval_password', ?)").bind(JSON.stringify({ hash: "x".repeat(40) })).run();
	await DB.prepare("INSERT INTO settings (key, value) VALUES ('password_setup', ?)").bind(JSON.stringify({ hash: setupHash, createdMs: 1, expiresMs: 2, failures: 0 })).run();
	await DB.prepare("INSERT INTO settings (key, value) VALUES ('theme', 'kept')").run();
	await DB.prepare("INSERT INTO device_requests (device_hash, user_code, status, created_ms, expires_ms, interval_s, replaces_label, replaces_hash, ip, country) VALUES ('device-hash-secret', 'WDJB4827', 'pending', 1, 2, 5, 'ada', ?, '203.0.113.50', 'XQ')").bind(replaces).run();
	await DB.prepare("INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scope, resource, created_ms, expires_ms) VALUES ('code-hash', 'client', 'https://client.example/cb', 'challenge-secret-value', 'mcp', 'https://agent.example/mcp', 1, 2)").run();
	await DB.prepare("INSERT INTO mcp_grants (label, client_id, scope, access_hash, refresh_hash, created_at) VALUES ('mcp-claude', 'client', 'mcp', 'access-hash-secret', 'refresh-hash-secret', ?)").bind(now).run();
	await DB.prepare("INSERT INTO outbound_peers (alias, url, token_enc, created_at, updated_at) VALUES ('ada', 'https://ada.example', 'ciphertext-secret-value', ?, ?)").bind(now, now).run();
	await DB.prepare("INSERT INTO oidc_txns (state, nonce, verifier, kind, csrf, payload_json, expires_ms) VALUES ('state-1', 'nonce-1', 'verifier-secret-value', 'device', 'csrf-secret-value', '{}', 1)").run();
	const file = await exportRows(DB, new Date(now));
	const redacted = redactExport(file);
	assert.equal(file.tables.peers?.[0]?.token_hash, hash, "the CLI dump still has the hash");
	assert.equal(file.tables.device_requests?.[0]?.replaces_hash, replaces);
	assert.equal(file.tables.device_requests?.[0]?.ip, "203.0.113.50");
	assert.equal(file.tables.device_requests?.[0]?.country, "XQ");
	assert.equal(file.tables.settings?.some((row) => row.key === "password_setup"), true);
	assert.equal(file.tables.oidc_txns?.[0]?.verifier, "verifier-secret-value");
	assert.equal(redacted.tables.peers?.[0]?.token_hash, "redacted:ada");
	assert.equal(redacted.tables.peers?.[0]?.label, "ada");
	assert.equal(redacted.tables.device_requests?.[0]?.device_hash, "redacted:WDJB4827");
	assert.equal(redacted.tables.device_requests?.[0]?.replaces_hash, undefined);
	assert.equal(Object.hasOwn(redacted.tables.device_requests?.[0] ?? {}, "ip"), false);
	assert.equal(Object.hasOwn(redacted.tables.device_requests?.[0] ?? {}, "country"), false);
	assert.equal(redacted.tables.device_requests?.[0]?.replaces_label, "ada");
	assert.equal(redacted.tables.device_requests?.[0]?.user_code, "WDJB4827");
	assert.equal(redacted.tables.tasks?.[0]?.push_configs_json, undefined);
	assert.equal(redacted.tables.outbound?.[0]?.push_token_hash, undefined);
	assert.equal(redacted.tables.outbound?.[0]?.task_json, JSON.stringify({ token: "[redacted]" }));
	assert.equal(redacted.tables.mcp_grants?.[0]?.access_hash, undefined);
	assert.equal(redacted.tables.mcp_grants?.[0]?.refresh_hash, undefined);
	assert.equal(redacted.tables.mcp_grants?.[0]?.label, "mcp-claude");
	assert.equal(redacted.tables.outbound_peers?.[0]?.token_enc, undefined);
	assert.equal(redacted.tables.outbound_peers?.[0]?.alias, "ada");
	assert.deepEqual(redacted.tables.oauth_codes, []);
	assert.deepEqual(redacted.tables.oidc_txns, []);
	assert.deepEqual(redacted.tables.settings?.map((row) => row.key), ["theme"]);
	const history = redacted.tables.history ?? [];
	assert.equal(history.find((row) => row.context_id === "ctx-1")?.text, "see [redacted] and [redacted] at https://[redacted]@hooks.example/wake?t=[redacted]");
	assert.equal(history.find((row) => row.context_id === "ctx-owner")?.text, "[redacted]");
	const dumped = JSON.stringify(redacted);
	for (const secret of [token, owner, hash, replaces, setupHash, "device-hash-secret", "ciphertext-secret-value", "verifier-secret-value", "csrf-secret-value", "challenge-secret-value", "access-hash-secret", "refresh-hash-secret", "push-hash-secret", "approval_password", "password_setup", "user:secret", `t=${setup}`]) {
		assert.equal(dumped.includes(secret), false, secret);
	}
	assert.equal(ownerResponseLeaks(owner), true);
	assert.equal(ownerResponseLeaks(redacted), false, "a pasted hosted owner token is redacted, so the dashboard export is returned");
	const sql = toSql(redacted, { skip: REDACTED_SQL_SKIP });
	assert.match(sql, /redacted:ada/);
	assert.equal(sql.includes("oauth_codes"), false);
	assert.equal(sql.includes("oidc_txns"), false);
	assert.equal(sql.includes("replaces_hash"), false);
	assert.equal(sql.includes("203.0.113.50"), false);
	assert.equal(sql.includes("XQ"), false);
	assert.equal(sql.includes("password_setup"), false);
	assert.equal(ownerResponseLeaks({ sql }), false);
	for (const secret of [token, owner, hash, replaces, setupHash]) {
		assert.equal(sql.includes(secret), false, secret);
	}
	assert.match(toSql(file), /verifier-secret-value/);
	assert.match(toSql(file), new RegExp(hash));
	assert.match(toSql(file), /replaces_hash/);
	assert.match(toSql(file), /203\.0\.113\.50/);
	assert.match(toSql(file), /'XQ'/);
});

test("scrubSecretText redacts a hosted owner token on the log and export paths", () => {
	assert.ok(TOKEN_PREFIXES.includes("a2aot_"));
	for (const prefix of TOKEN_PREFIXES) {
		const token = prefix + "Q".repeat(43);
		assert.equal(scrubSecretText(`see ${token} end`), "see [redacted] end", prefix);
		assert.equal(scrubSecretText(token), "[redacted]", prefix);
		assert.equal(ownerResponseLeaks(token), true, prefix);
	}
	const owner = "a2aot_" + "Q".repeat(43);
	const redacted = redactExport({
		format: "a2a-exposed-export",
		version: 1,
		exportedAt: "2026-10-11T00:00:00.000Z",
		tables: { history: [{ context_id: "ctx-owner", ts: "2026-10-11T00:00:00.000Z", dir: "in", text: owner }] },
	});
	assert.equal(redacted.tables.history?.[0]?.text, "[redacted]");
	assert.equal(toSql(redacted, { skip: REDACTED_SQL_SKIP }).includes(owner), false);
	assert.equal(ownerResponseLeaks(redacted), false);
});

test("redactExport removes device_requests.replaces_hash", () => {
	const replaces = "cd".repeat(32);
	const redacted = redactExport({
		format: "a2a-exposed-export",
		version: 1,
		exportedAt: "2026-10-11T00:00:00.000Z",
		tables: {
			device_requests: [{
				device_hash: "device-hash-secret",
				user_code: "WDJB4827",
				status: "pending",
				replaces_label: "ada",
				replaces_hash: replaces,
				ip: "203.0.113.50",
				country: "XQ",
			}],
		},
	});
	const row = redacted.tables.device_requests?.[0] ?? {};
	assert.equal(Object.hasOwn(row, "replaces_hash"), false);
	assert.equal(Object.hasOwn(row, "ip"), false);
	assert.equal(Object.hasOwn(row, "country"), false);
	assert.equal(row.replaces_label, "ada");
	assert.equal(row.device_hash, "redacted:WDJB4827");
	const sql = toSql(redacted, { skip: REDACTED_SQL_SKIP });
	assert.equal(sql.includes("replaces_hash"), false);
	assert.equal(sql.includes("203.0.113.50"), false);
	assert.equal(sql.includes(replaces), false);
	assert.equal(JSON.stringify(redacted).includes(replaces), false);
});

test("self-host owner HTTP has no delete route", async () => {
	const DB = db();
	const env = { DB, PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret" };
	const res = await worker.fetch(new Request(BASE + "/owner/delete", {
		method: "POST",
		headers: { authorization: "Bearer owner-secret" },
	}) as never, env as never, ectx as never);
	assert.equal(res.status, 404);
	const tables = await DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'peers'").all<{ name: string }>();
	assert.equal(tables.results.length, 1);
});

test("exportRows reads every application table in one batch", async () => {
	const DB = db();
	await DB.prepare("INSERT INTO peers (label, token_hash, created_at) VALUES ('ada', 'h', 't')").run();
	await DB.prepare("INSERT INTO history (context_id, ts, dir, text) VALUES ('c', 't', 'in', 'hi')").run();
	let batches = 0;
	const wrapped = {
		prepare(sql: string) {
			const s = DB.prepare(sql);
			const view = (stmt: { __sql: string; __args: unknown[]; bind: (...a: unknown[]) => unknown }) => ({
				__sql: stmt.__sql,
				__args: stmt.__args,
				bind(...a: unknown[]) { return view(stmt.bind(...a) as typeof stmt); },
				all: async () => { throw new Error("per-table read"); },
				first: () => { throw new Error("per-table read"); },
				run: () => { throw new Error("per-table read"); },
			});
			return view(s);
		},
		async batch(stmts: { __sql: string }[]) {
			batches++;
			assert.deepEqual(stmts.map((s) => s.__sql), EXPORT_TABLES.map((n) => `SELECT * FROM "${n}"`));
			return DB.batch(stmts);
		},
	};
	const file = await exportRows(wrapped as never);
	assert.equal(batches, 1);
	assert.equal(file.tables.peers?.[0]?.label, "ada");
	assert.equal(file.tables.history?.[0]?.text, "hi");
});

test("exportRows on a Durable Object runs inside one transactionSync", async () => {
	const raw = new DatabaseSync(":memory:");
	for (const name of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort())
		raw.exec(fs.readFileSync(new URL(name, MIGRATIONS), "utf8"));
	raw.prepare("INSERT INTO peers (label, token_hash, created_at) VALUES ('ada', 'h', 't')").run();
	raw.prepare("INSERT INTO history (context_id, ts, dir, text) VALUES ('c', 't', 'in', 'hi')").run();
	let depth = 0;
	let txCalls = 0;
	let outside = 0;
	const sql: SqlStorageLike = {
		exec(query: string, ...bindings: unknown[]) {
			if (/^\s*select\b/i.test(query) && depth === 0) outside++;
			const stmt = raw.prepare(query);
			if (/^\s*select\b/i.test(query)) {
				const rows = stmt.all(...(bindings as [])) as Record<string, unknown>[];
				return { toArray: () => rows, raw: () => rows.map((r) => Object.values(r)), rowsRead: rows.length, rowsWritten: 0 };
			}
			const info = stmt.run(...(bindings as []));
			return { toArray: () => [], raw: () => [], rowsRead: 0, rowsWritten: Number(info.changes) };
		},
	};
	const tx: TxRunner = (fn) => {
		txCalls++;
		depth++;
		raw.exec("BEGIN");
		try { const v = fn(); raw.exec("COMMIT"); return v; }
		finally { depth--; }
	};
	const file = await exportRows(doSqlD1(sql, tx));
	assert.equal(txCalls, 1);
	assert.equal(outside, 0);
	assert.equal(file.tables.peers?.[0]?.label, "ada");
	assert.equal(file.tables.history?.[0]?.text, "hi");
	assert.equal(Object.keys(file.tables).length, EXPORT_TABLES.length);
});

test("owner export: auth, hashes, and the minute cron left in place", async () => {
	const DB = db();
	const bucket = fakeBucket();
	const env: any = { DB, PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", BACKUP_BUCKET: bucket };
	const call = async (method: string, path: string, json?: unknown, auth = "Bearer owner-secret") => {
		const res = await worker.fetch(new Request(BASE + path, {
			method, headers: { authorization: auth, "content-type": "application/json" },
			body: json === undefined ? undefined : JSON.stringify(json),
		}) as any, env, ectx as any);
		const text = await res.text();
		let data: any = text;
		try { data = JSON.parse(text); } catch { /* sql */ }
		return { status: res.status, data, text };
	};
	assert.equal((await call("GET", "/owner/export", undefined, "")).status, 401);
	const issued = await call("POST", "/owner/peers", { label: "ada" });
	assert.match(issued.data.token, /^a2aow_/);
	const dumped = await call("GET", "/owner/export");
	assert.equal(dumped.status, 200);
	assert.equal(dumped.data.tables.peers[0].label, "ada");
	assert.equal(dumped.data.tables.peers[0].token_hash, await sha256(issued.data.token));
	assert.equal(JSON.stringify(dumped.data).includes(issued.data.token), false);
	assert.equal(JSON.stringify(dumped.data).includes("owner-secret"), false);
	const sql = await call("GET", "/owner/export?format=sql");
	assert.match(sql.text, /DELETE FROM "peers"/);
	assert.equal(sql.text.includes(issued.data.token), false);
	assert.equal(sql.text.includes("tenant_config"), false);
	assert.equal((await call("POST", "/owner/import", dumped.data)).status, 404);

	await DB.prepare("INSERT INTO rate (peer, minute, count) VALUES ('p', 1, 4)").run();
	await worker.scheduled({ cron: DAILY_CRON } as any, env, ectx as any);
	assert.equal((await DB.prepare("SELECT count FROM rate WHERE peer = 'p'").first<{ count: number }>())?.count, 4);
	const key = `tenants/self/${new Date().toISOString().slice(0, 10)}.sql`;
	assert.equal(bucket.puts.some((p) => p.key === key && p.contentType === "application/sql"), true);
	assert.match(bucket.objects.get(key) || "", /DELETE FROM "peers"/);

	await worker.scheduled({ cron: "* * * * *" } as any, env, ectx as any);
	assert.equal(await DB.prepare("SELECT count FROM rate WHERE peer = 'p'").first(), null);

	const bare = db();
	await bare.prepare("INSERT INTO rate (peer, minute, count) VALUES ('q', 1, 1)").run();
	await worker.scheduled({ cron: DAILY_CRON } as any, { DB: bare, PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret" } as any, ectx as any);
	assert.equal(await bare.prepare("SELECT count FROM rate WHERE peer = 'q'").first(), null);
});

test("retention drops a snapshot 30 days old and keeps the newer one", () => {
	assert.equal(olderThanRetention("2026-09-09", "2026-10-09"), true);
	assert.equal(olderThanRetention("2026-09-10", "2026-10-09"), false);
	assert.equal(olderThanRetention("2026-10-09", "2026-10-09"), false);
	assert.equal(olderThanRetention("2026-02-31", "2026-10-09"), false);
	assert.equal(snapshotKey("self", "2026-10-09"), "tenants/self/2026-10-09.sql");
	assert.throws(() => snapshotKey("a/b", "2026-10-09"), /tenant id/);
});

test("hosted backup lists the directory, pins region, skips inactive tenants, and keeps going", async () => {
	const now = new Date("2026-10-09T03:00:00.000Z");
	const bucket = fakeBucket({
		"tenants/id-alice/2026-09-09.sql": "old",
		"tenants/id-alice/2026-09-10.sql": "keep",
		"tenants/id-alice/notes.sql": "leave",
	});
	const kv = fakeKv({
		alice: { id: "id-alice", status: "active", region: "", version: 1 },
		paused: { id: "id-paused", status: "suspended", region: "default", version: 1 },
		broke: { id: "id-bad", status: "active", region: "default", version: 1 },
	});
	const seen: string[] = [];
	const ns = {
		idFromName: (id: string) => id,
		get: (id: string) => ({
			async exportSql() {
				seen.push(id);
				if (id === "id-bad") throw new Error("exportSql: boom");
				return { sql: `-- ${id}\n`, exportedAt: now.toISOString() };
			},
		}),
		jurisdiction() { throw new Error("jurisdiction"); },
	};
	const env = { TENANCY: "host", TENANT_DO: ns, TENANT_DIRECTORY: kv, DB: db(), BACKUP_BUCKET: bucket };
	assert.equal(await hostedDailyBackup({ cron: "* * * * *" }, env), null);
	assert.equal(await hostedDailyBackup({ cron: DAILY_CRON }, { ...env, BACKUP_BUCKET: undefined }), null);
	const report = await hostedDailyBackup({ cron: DAILY_CRON }, env, now);
	assert.ok(report);
	assert.deepEqual(seen.sort(), ["id-alice", "id-bad"]);
	assert.equal(report.written.length, 1);
	assert.equal(report.written[0]?.key, "tenants/id-alice/2026-10-09.sql");
	assert.deepEqual(report.written[0]?.deleted, ["tenants/id-alice/2026-09-09.sql"]);
	assert.equal(bucket.objects.get("tenants/id-alice/2026-09-10.sql"), "keep");
	assert.equal(bucket.objects.get("tenants/id-alice/notes.sql"), "leave");
	assert.equal(bucket.puts[0]?.contentType, "application/sql");
	assert.deepEqual(report.skipped, [{ tenantId: "id-paused", status: "suspended" }]);
	assert.equal(report.failed.length, 1);
	assert.match(report.failed[0]?.error || "", /boom/);
	assert.equal(JSON.parse(kv.store.get("tenant:alice") || "{}").region, "default");
});

test("hosted backup follows every directory page and refuses a stuck cursor", async () => {
	const entries: Record<string, DirectoryEntry> = {};
	for (let i = 0; i < 101; i++) {
		const name = `t${String(i).padStart(4, "0")}`;
		entries[name] = { id: `id-${name}`, status: "active", region: "default", version: 1 };
	}
	const kv = fakeKv(entries);
	const seen: string[] = [];
	const ns = {
		idFromName: (id: string) => id,
		get: (id: string) => ({
			async exportSql() {
				seen.push(id);
				return { sql: `-- ${id}\n`, exportedAt: "2026-10-09T03:00:00.000Z" };
			},
		}),
		jurisdiction() { throw new Error("jurisdiction"); },
	};
	const report = await backupDirectory(kv, fakeBucket(), ns as never, "default", new Date("2026-10-09T03:00:00.000Z"));
	assert.equal(seen.length, 101);
	assert.equal(report.written.length, 101);
	assert.equal(report.failed.length, 0);
	const stuck = {
		async get() { return null; },
		async put() {},
		async list() { return { keys: [{ name: "tenant:alice" }], list_complete: false }; },
	};
	await assert.rejects(() => backupDirectory(stuck, fakeBucket(), ns as never, "default"), /directory listing did not finish/);
});

test("snapshot prune follows every object page", async () => {
	const objects: Record<string, string> = {};
	for (let i = 0; i < 101; i++) objects[`tenants/id-alice/${new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10)}.sql`] = "old";
	const bucket = fakeBucket(objects);
	const deleted = await pruneSnapshots(bucket, "id-alice", "2026-10-09");
	assert.equal(deleted.length, 101);
	assert.equal(bucket.objects.size, 0);
});

test("a pinned eu tenant is exported through that jurisdiction", async () => {
	const eu = {
		idFromName: (id: string) => `eu:${id}`,
		get: (id: string) => ({ exportSql: async () => ({ sql: `-- ${id}\n`, exportedAt: "2026-10-09T00:00:00.000Z" }) }),
	};
	let asked = "";
	const ns = {
		idFromName: (id: string) => id,
		get: () => { throw new Error("default namespace"); },
		jurisdiction(loc: string) { asked = loc; return eu; },
	};
	const entry: DirectoryEntry = { id: "id-alice", status: "active", region: "eu", version: 1 };
	const out = await exportTenantSql(ns, entry);
	assert.equal(asked, "eu");
	assert.match(out.sql, /eu:id-alice/);
	assert.equal(namespaceForRegion(ns as DoNamespace, "eu"), eu);
});

test("point-in-time helpers require the storage methods", async () => {
	await assert.rejects(() => bookmarkForTime({}, Date.now()), (e: unknown) => e instanceof ExportError && /not available/.test(e.message));
	await assert.rejects(() => restoreBookmark({}, "bm"), (e: unknown) => e instanceof ExportError && /not available/.test(e.message));
	const storage = {
		async getBookmarkForTime(t: number) { return `bm-${t}`; },
		async onNextSessionRestoreBookmark(b: string) { return `undo-${b}`; },
	};
	assert.equal((await bookmarkForTime(storage, 10)).bookmark, "bm-10");
	assert.deepEqual(await restoreBookmark(storage, "bm-10"), { ok: true, undo: "undo-bm-10" });
	await assert.rejects(() => restoreBookmark(storage, ""), /invalid/);
});

test("restoreBookmark returns before the object restarts", async () => {
	const order: string[] = [];
	const storage = {
		async onNextSessionRestoreBookmark(b: string) {
			order.push(`schedule:${b}`);
			return `undo-${b}`;
		},
	};
	const out = await restoreBookmark(storage, "bm-1");
	order.push("returned");
	let released!: () => void;
	const gate = new Promise<void>((resolve) => { released = resolve; });
	let waited = -1;
	restartAfterResult((p) => { void p.then(() => order.push("restarted")); }, () => {}, (ms) => { waited = ms; return gate; });
	assert.equal(waited, RESTORE_RESTART_DELAY_MS);
	assert.deepEqual(out, { ok: true, undo: "undo-bm-1" });
	assert.deepEqual(order, ["schedule:bm-1", "returned"]);
	released();
	await gate;
	await Promise.resolve();
	assert.deepEqual(order, ["schedule:bm-1", "returned", "restarted"]);

	const failing = { async onNextSessionRestoreBookmark() { throw new Error("rejected bookmark"); } };
	await assert.rejects(() => restoreBookmark(failing, "bm-2"), (e: unknown) => e instanceof ExportError && /rejected bookmark/.test((e as Error).message));
	await assert.rejects(() => restoreBookmark(storage, ""), /invalid/);
});

test("backupDatabase writes the self-host snapshot", async () => {
	const DB = db();
	await DB.prepare("INSERT INTO settings (key, value) VALUES ('k', 'v')").run();
	const bucket = fakeBucket();
	const written = await backupDatabase(bucket, DB, "self", new Date("2026-10-09T03:00:00.000Z"));
	assert.equal(written.key, "tenants/self/2026-10-09.sql");
	assert.match(bucket.objects.get(written.key) || "", /INSERT INTO "settings"/);
});

function fakeBucket(initial: Record<string, string> = {}): R2BucketLike & { objects: Map<string, string>; puts: { key: string; contentType?: string }[] } {
	const objects = new Map(Object.entries(initial));
	const puts: { key: string; contentType?: string }[] = [];
	return {
		objects,
		puts,
		async put(key, value, options) {
			objects.set(key, value);
			puts.push({ key, contentType: options?.httpMetadata?.contentType });
		},
		async list({ prefix, cursor } = {}) {
			const keys = [...objects.keys()].filter((k) => !prefix || k.startsWith(prefix)).sort();
			const start = cursor ? Number(cursor) : 0;
			const slice = keys.slice(start, start + 1);
			const next = start + slice.length;
			return { objects: slice.map((key) => ({ key })), truncated: next < keys.length, cursor: next < keys.length ? String(next) : undefined };
		},
		async delete(keys) { for (const k of keys) objects.delete(k); },
	};
}

function fakeKv(entries: Record<string, DirectoryEntry>) {
	const store = new Map(Object.entries(entries).map(([name, entry]) => [`tenant:${name}`, JSON.stringify(entry)]));
	return {
		store,
		async get(key: string, type?: string) {
			const raw = store.get(key) ?? null;
			if (type === "json") return raw ? JSON.parse(raw) : null;
			return raw;
		},
		async put(key: string, value: string) { store.set(key, value); },
		async list({ prefix = "", cursor }: { prefix?: string; cursor?: string } = {}) {
			const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
			const start = cursor ? keys.indexOf(cursor) + 1 : 0;
			const slice = keys.slice(start, start + 1);
			const last = slice[slice.length - 1];
			const more = slice.length > 0 && start + slice.length < keys.length;
			return { keys: slice.map((name) => ({ name })), list_complete: !more, cursor: more ? last : undefined };
		},
	};
}

const require = createRequire(new URL("../package.json", import.meta.url));

function bundleHosted(): Promise<string> {
	const { build } = require("esbuild") as typeof import("esbuild");
	return build({
		entryPoints: [fileURLToPath(new URL("../src/hosted.ts", import.meta.url))],
		bundle: true,
		format: "esm",
		write: false,
		platform: "neutral",
		external: ["cloudflare:*"],
		target: "es2022",
		logLevel: "silent",
		plugins: [{
			name: "sql-raw",
			setup(b) {
				b.onResolve({ filter: /\.sql\?raw$/ }, (args) => ({
					path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, "")),
					namespace: "sql-raw",
				}));
				b.onLoad({ filter: /.*/, namespace: "sql-raw" }, (args) => ({
					contents: `export default ${JSON.stringify(fs.readFileSync(args.path, "utf8"))};`,
					loader: "js",
				}));
			},
		}],
	}).then((built) => {
		const file = built.outputFiles?.[0];
		if (!file) throw new Error("hosted bundle was empty");
		return file.text;
	});
}

test("TenantStore exportSql dumps a configured tenant", async (t) => {
	const mf = new Miniflare(convertV4MiniflareOptions({
		name: "a2a",
		modules: true,
		script: await bundleHosted(),
		compatibilityDate: "2026-10-06",
		d1Databases: { DB: "unused" },
		durableObjects: { TENANT_DO: { className: "TenantStore", useSQLite: true } },
		bindings: { TENANCY: "host", TENANT_DOMAIN: "example.com", TENANT_SECRETS_KEY: "platform-secret" },
	} as never));
	t.after(() => mf.dispose());
	await mf.ready;
	const ns = await mf.getDurableObjectNamespace("TENANT_DO");
	const stub = ns.get(ns.idFromName("id-alice")) as unknown as {
		storageStatus(): Promise<{ configured: boolean }>;
		pushConfig(b: Record<string, unknown>): Promise<{ applied: boolean }>;
		exportSql(): Promise<{ sql: string; exportedAt: string }>;
		bookmarkForTime(t: number): Promise<{ bookmark: string }>;
		fetch(r: Request): Promise<Response>;
	};
	assert.equal((await stub.storageStatus()).configured, false);
	const hash = await sha256("owner-alice");
	assert.equal((await stub.pushConfig({ version: 1, tenantId: "id-alice", name: "alice", status: "active", ownerTokenHash: hash, config: { AGENT_NAME: "Alice" } })).applied, true);
	const issued = await (await stub.fetch(new Request("https://alice.example.com/owner/peers", {
		method: "POST",
		headers: { authorization: "Bearer owner-alice", "content-type": "application/json" },
		body: JSON.stringify({ label: "ada" }),
	}))).json() as { token?: string };
	assert.match(issued.token || "", /^a2aow_/);
	const dumped = await stub.exportSql();
	assert.match(dumped.sql, /INSERT INTO "peers"/);
	assert.match(dumped.sql, /ada/);
	assert.equal(dumped.sql.includes(issued.token || "a2aow_"), false);
	assert.equal(dumped.sql.includes("tenant_config"), false);
	assert.equal(dumped.sql.includes("platform-secret"), false);

	const restored = stub as unknown as { restoreBookmark(b: string): Promise<{ ok: true; undo?: string }> };
	await assert.rejects(() => restored.restoreBookmark("bm-local"));
	assert.equal((await stub.storageStatus()).configured, true, "a storage error does not reset the object");
	assert.match((await stub.exportSql()).sql, /ada/);
});

test("TenantStore.restoreBookmark returns ok and the next session is a new object", async (t) => {
	// Local workerd's onNextSessionRestoreBookmark throws. The probe replaces that method, then calls the production RPC.
	const script = `${await bundleHosted()}
export class Probe extends TenantStore {
  constructor(ctx, env) { super(ctx, env); this.born = Date.now(); }
  async bornAt() { return this.born; }
  async restoreLive(bookmark) {
    this.ctx.storage.onNextSessionRestoreBookmark = async () => "undo-live";
    return await this.restoreBookmark(bookmark);
  }
}
`;
	const mf = new Miniflare(convertV4MiniflareOptions({
		name: "restore",
		modules: true,
		script,
		compatibilityDate: "2026-10-06",
		durableObjects: { TENANT_DO: { className: "Probe", useSQLite: true } },
		bindings: { TENANCY: "host", TENANT_DOMAIN: "example.com", TENANT_SECRETS_KEY: "platform-secret" },
	} as never));
	t.after(() => mf.dispose());
	await mf.ready;
	const ns = await mf.getDurableObjectNamespace("TENANT_DO");
	const id = ns.idFromName("id-alice");
	const stub = ns.get(id) as unknown as {
		bornAt(): Promise<number>;
		pushConfig(b: Record<string, unknown>): Promise<{ applied: boolean }>;
		restoreLive(bookmark: string): Promise<{ ok: boolean; undo: string }>;
	};
	const hash = await sha256("owner-alice");
	assert.equal((await stub.pushConfig({
		version: 1, tenantId: "id-alice", name: "alice", status: "active", ownerTokenHash: hash, config: { AGENT_NAME: "Alice" },
	})).applied, true);
	const born = await stub.bornAt();
	const restored = await stub.restoreLive("bm-live");
	assert.equal(await restored.ok, true);
	assert.equal(await restored.undo, "undo-live");
	const start = Date.now();
	let again = born;
	while (again === born && Date.now() - start < 4000) {
		await new Promise((r) => setTimeout(r, 50));
		try {
			again = await (ns.get(id) as typeof stub).bornAt();
		} catch {
			// The reset is in progress. The next call is a new session.
		}
	}
	assert.notEqual(again, born, "abort after the result starts a new session");
});

test("hosted daily cron writes the snapshot and leaves the self-host database alone", async (t) => {
	const mf = new Miniflare({
		...convertV4MiniflareOptions({
			name: "a2a",
			modules: true,
			script: await bundleHosted(),
			compatibilityDate: "2026-10-06",
			d1Databases: { DB: "self" },
			kvNamespaces: { TENANT_DIRECTORY: "tenants" },
			r2Buckets: { BACKUP_BUCKET: "backups" },
			durableObjects: { TENANT_DO: { className: "TenantStore", useSQLite: true } },
			bindings: { TENANCY: "host", TENANT_DOMAIN: "example.com", TENANT_SECRETS_KEY: "platform-secret", OWNER_TOKEN: "platform-owner" },
		} as never),
		unsafeTriggerHandlers: true,
	});
	t.after(() => mf.dispose());
	await mf.ready;
	const kv = await mf.getKVNamespace("TENANT_DIRECTORY");
	const ns = await mf.getDurableObjectNamespace("TENANT_DO");
	const hash = await sha256("owner-alice");
	const stub = ns.get(ns.idFromName("id-alice")) as unknown as {
		pushConfig(b: Record<string, unknown>): Promise<{ applied: boolean }>;
	};
	assert.equal((await stub.pushConfig({
		version: 1, tenantId: "id-alice", name: "alice", status: "active", ownerTokenHash: hash, config: { AGENT_NAME: "Alice" },
	})).applied, true);
	await kv.put("tenant:alice", JSON.stringify({ id: "id-alice", status: "active", region: "default", version: 1 }));
	const fire = (cron: string) => mf.dispatchFetch(`https://example.com/cdn-cgi/local/scheduled?cron=${encodeURIComponent(cron)}&format=json`);
	const daily = await fire(DAILY_CRON);
	assert.equal(daily.status, 200, await daily.text());
	const bucket = await mf.getR2Bucket("BACKUP_BUCKET");
	const listed = await bucket.list({ prefix: "tenants/id-alice/" });
	assert.equal(listed.objects.length, 1);
	assert.match(listed.objects[0]?.key || "", /^tenants\/id-alice\/\d{4}-\d{2}-\d{2}\.sql$/);
	// The minute trigger must not run the self-host flush. That database has no tables, so a flush would fail this call.
	const minute = await fire("* * * * *");
	assert.equal(minute.status, 200, await minute.text());
});
