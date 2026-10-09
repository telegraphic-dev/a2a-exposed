// Inbox export/import and the gated daily R2 snapshot. Run: npm test
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
import { exportRows, importRows, toSql, bookmarkForTime, restoreBookmark, ExportError, EXPORT_TABLES } from "../src/export.ts";
import { openPeerToken, sealPeerToken } from "../src/mcp.ts";
import { backupDatabase, exportTenantSql, hostedDailyBackup, olderThanRetention, snapshotKey, DAILY_CRON, type R2BucketLike } from "../src/backup.ts";
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

test("import replaces listed tables, refuses unknown tables, and keeps a rejected file unread", async () => {
	const DB = db();
	await DB.prepare("INSERT INTO peers (label, token_hash, created_at) VALUES ('ada', 'h', 't')").run();
	await DB.prepare("INSERT INTO history (context_id, ts, dir, text) VALUES ('ctx', 't', 'local', 'keep-me')").run();
	const file = await exportRows(DB);
	await DB.prepare("INSERT INTO peers (label, token_hash, created_at) VALUES ('bea', 'h2', 't')").run();
	const replaced = await importRows(DB, file);
	assert.equal(replaced.tables, EXPORT_TABLES.length);
	const labels = ((await DB.prepare("SELECT label FROM peers ORDER BY label").all()).results as { label: string }[]).map((r) => r.label);
	assert.deepEqual(labels, ["ada"]);

	await assert.rejects(() => importRows(DB, { format: "a2a-exposed-export", version: 1, tables: { sqlite_master: [] } }), /unknown table/);
	await assert.rejects(() => importRows(DB, { format: "a2a-exposed-export", version: 2, tables: {} }), /not supported/);
	await assert.rejects(() => importRows(DB, { format: "a2a-exposed-export", version: 1, tables: { peers: [{ "label); drop": "x" }] } }), /bad column/);
	await assert.rejects(() => importRows(DB, { format: "a2a-exposed-export", version: 1, tables: { peers: [{ not_a_real_column: "x" }] } }), /peers has no column not_a_real_column/);
	const still = ((await DB.prepare("SELECT label FROM peers").all()).results as { label: string }[]).map((r) => r.label);
	assert.deepEqual(still, ["ada"]);

	const partial = await importRows(DB, { format: "a2a-exposed-export", version: 1, tables: { peers: [] } });
	assert.equal(partial.tables, 1);
	assert.equal(((await DB.prepare("SELECT label FROM peers").all()).results as unknown[]).length, 0);
	const hist = await DB.prepare("SELECT text FROM history").first<{ text: string }>();
	assert.equal(hist?.text, "keep-me");
});

test("import keeps an outbound token this owner can open and drops one sealed for another", async () => {
	const DB = db();
	const ours = await sealPeerToken("owner-secret", "ada", "a2aow_local");
	const theirs = await sealPeerToken("other-owner", "bea", "a2aow_other");
	const res = await importRows(DB, {
		format: "a2a-exposed-export", version: 1,
		tables: { outbound_peers: [
			{ alias: "ada", url: "https://ada.example.com", token_enc: ours, created_at: "t", updated_at: "t" },
			{ alias: "bea", url: "https://bea.example.com", token_enc: theirs, created_at: "t", updated_at: "t" },
		] },
	}, { openOutboundToken: (alias, enc) => openPeerToken("owner-secret", alias, enc).then((t) => !!t) });
	assert.deepEqual(res.outboundPeersNeedSync, ["bea"]);
	const ada = await DB.prepare("SELECT token_enc FROM outbound_peers WHERE alias = 'ada'").first<{ token_enc: string }>();
	assert.equal(await openPeerToken("owner-secret", "ada", ada!.token_enc), "a2aow_local");
	const bea = await DB.prepare("SELECT url, token_enc FROM outbound_peers WHERE alias = 'bea'").first<{ url: string; token_enc: string | null }>();
	assert.equal(bea?.url, "https://bea.example.com");
	assert.equal(bea?.token_enc, null);
	assert.equal(JSON.stringify(res).includes("a2aow_"), false);
});

test("owner export and import: auth, hashes, and the minute cron left in place", async () => {
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

	const bad = await call("POST", "/owner/import", { format: "nope", version: 1, tables: {} });
	assert.equal(bad.status, 400);
	const badCol = await call("POST", "/owner/import", { format: "a2a-exposed-export", version: 1, tables: { peers: [{ not_a_real_column: "x" }] } });
	assert.equal(badCol.status, 400);
	assert.match(badCol.data.error, /no column/);
	assert.equal(((await call("GET", "/owner/peers")).data as { label: string }[]).length, 1);
	const wiped = await call("POST", "/owner/import", { format: "a2a-exposed-export", version: 1, tables: { peers: [] } });
	assert.equal(wiped.status, 200);
	assert.equal(((await call("GET", "/owner/peers")).data as { label: string }[]).length, 0);
	const back = await call("POST", "/owner/import", dumped.data);
	assert.equal(back.data.rows >= 1, true);
	assert.deepEqual(back.data.outboundPeersNeedSync, []);
	const foreign = await sealPeerToken("other-owner", "bea", "a2aow_other");
	const moved = await call("POST", "/owner/import", { format: "a2a-exposed-export", version: 1, tables: { outbound_peers: [
		{ alias: "bea", url: "https://bea.example.com", token_enc: foreign, created_at: "t", updated_at: "t" },
	] } });
	assert.equal(moved.status, 200);
	assert.deepEqual(moved.data.outboundPeersNeedSync, ["bea"]);
	assert.equal(JSON.stringify(moved.data).includes("a2aow_other"), false);
	const stored = await DB.prepare("SELECT token_enc FROM outbound_peers WHERE alias = 'bea'").first<{ token_enc: string | null }>();
	assert.equal(stored?.token_enc, null);
	assert.equal(((await call("GET", "/owner/peers")).data as { label: string }[])[0].label, "ada");

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
	assert.deepEqual(await restoreBookmark(storage, "bm-10"), { ok: true });
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
});
