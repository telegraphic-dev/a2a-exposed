import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
const files = fs.readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const earlier = "2026-01-01T00:00:00.000Z";
const later = "2026-01-02T00:00:00.000Z";

function apply(db: DatabaseSync, names: string[]) {
	for (const name of names) db.exec(fs.readFileSync(path.join(dir, name), "utf8"));
}

function insertUser(db: DatabaseSync, id: string, email: string) {
	db.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)`).run(id, id, email, earlier, earlier);
}

function insertAccount(db: DatabaseSync, id: string, accountId: string, providerId: string, userId: string, createdAt: string) {
	db.prepare(`INSERT INTO "account" (id, "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)`).run(id, accountId, providerId, userId, createdAt, createdAt);
}

test("0008 drops a duplicate account before it creates the unique index", () => {
	const db = new DatabaseSync(":memory:");
	apply(db, files.filter((name) => name < "0008_account_provider.sql"));
	insertUser(db, "user-a", "a@example.com");
	insertUser(db, "user-b", "b@example.com");
	insertAccount(db, "later", "cf-user", "cloudflare", "user-b", later);
	insertAccount(db, "earlier", "cf-user", "cloudflare", "user-a", earlier);
	insertAccount(db, "github", "gh-user", "github", "user-a", earlier);
	insertAccount(db, "z-tie", "tie-account", "github", "user-b", earlier);
	insertAccount(db, "a-tie", "tie-account", "github", "user-a", earlier);

	apply(db, ["0008_account_provider.sql"]);

	const rows = (sql: string) => db.prepare(sql).all().map((row) => ({ ...row }));
	assert.deepEqual(rows(`SELECT id, userId FROM "account" WHERE "providerId" = 'cloudflare' AND "accountId" = 'cf-user'`), [{ id: "earlier", userId: "user-a" }]);
	assert.deepEqual(rows(`SELECT id FROM "account" WHERE "accountId" = 'tie-account'`), [{ id: "a-tie" }]);
	assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM "account" WHERE id = 'github'`).get()?.n, 1);
	assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM "user"`).get()?.n, 2);
	assert.equal(
		db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'account_provider_account_idx'`).get()?.name,
		"account_provider_account_idx",
	);
	assert.throws(
		() => insertAccount(db, "again", "cf-user", "cloudflare", "user-b", later),
		/UNIQUE constraint failed/i,
	);

	apply(db, ["0008_account_provider.sql"]);
	assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM "account"`).get()?.n, 3);
	assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM "user"`).get()?.n, 2);
});

test("0010 adds the Cloudflare grant table on a database that already has accounts", () => {
	const db = new DatabaseSync(":memory:");
	apply(db, files.filter((name) => name < "0010_cloudflare_grant.sql"));
	insertUser(db, "user-a", "a@example.com");
	apply(db, ["0010_cloudflare_grant.sql"]);
	db.prepare(
		`INSERT INTO cloudflare_grant ("userId", "accountId", choice, host, requested_scope, created_at, updated_at) VALUES ('user-a', 'cf-user', 'inbox', 'workers', 'user-details.read', ?, ?)`,
	).run(earlier, earlier);
	assert.equal(db.prepare(`SELECT choice FROM cloudflare_grant WHERE "userId" = 'user-a'`).get()?.choice, "inbox");
	apply(db, ["0010_cloudflare_grant.sql"]);
	assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM cloudflare_grant`).get()?.n, 1);
});

test("0011 adds the Cloudflare inbox table on a database that already has a user", () => {
	const db = new DatabaseSync(":memory:");
	apply(db, files.filter((name) => name < "0011_cloudflare_inbox.sql"));
	insertUser(db, "user-a", "a@example.com");
	apply(db, ["0011_cloudflare_inbox.sql"]);
	db.prepare(
		`INSERT INTO cloudflare_inbox ("userId", cf_account_id, worker_name, d1_name, host, status, created_at, updated_at)
		 VALUES ('user-a', 'account', 'my-agent', 'my-agent', 'workers', 'ready', ?, ?)`,
	).run(earlier, earlier);
	assert.equal(db.prepare(`SELECT public_url FROM cloudflare_inbox WHERE "userId" = 'user-a'`).get()?.public_url, null);
	apply(db, ["0011_cloudflare_inbox.sql"]);
	assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM cloudflare_inbox`).get()?.n, 1);
});

test("0012 adds script_tag on an inbox row that already exists", () => {
	const db = new DatabaseSync(":memory:");
	apply(db, files.filter((name) => name < "0012_cloudflare_inbox_tag.sql"));
	insertUser(db, "user-a", "a@example.com");
	db.prepare(
		`INSERT INTO cloudflare_inbox ("userId", cf_account_id, worker_name, d1_name, host, status, created_at, updated_at)
		 VALUES ('user-a', 'account', 'my-agent', 'my-agent', 'workers', 'pending', ?, ?)`,
	).run(earlier, earlier);
	apply(db, ["0012_cloudflare_inbox_tag.sql"]);
	assert.equal(db.prepare(`SELECT script_tag FROM cloudflare_inbox WHERE "userId" = 'user-a'`).get()?.script_tag, null);
	db.prepare(`UPDATE cloudflare_inbox SET script_tag = ? WHERE "userId" = 'user-a'`).run("ab".repeat(32));
	assert.equal(db.prepare(`SELECT script_tag FROM cloudflare_inbox WHERE "userId" = 'user-a'`).get()?.script_tag, "ab".repeat(32));
});

test("0013 adds wizard columns on an inbox row that already exists", () => {
	const db = new DatabaseSync(":memory:");
	apply(db, files.filter((name) => name < "0013_cloudflare_inbox_wizard.sql"));
	insertUser(db, "user-a", "a@example.com");
	db.prepare(
		`INSERT INTO cloudflare_inbox ("userId", cf_account_id, worker_name, d1_name, host, status, created_at, updated_at)
		 VALUES ('user-a', 'account', 'my-agent', 'my-agent', 'workers', 'pending', ?, ?)`,
	).run(earlier, earlier);
	apply(db, ["0013_cloudflare_inbox_wizard.sql"]);
	const row = db.prepare(`SELECT wizard_step, workers_subdomain, step_error FROM cloudflare_inbox WHERE "userId" = 'user-a'`).get() as {
		wizard_step: string | null;
		workers_subdomain: string | null;
		step_error: string | null;
	};
	assert.equal(row.wizard_step, null);
	assert.equal(row.workers_subdomain, null);
	assert.equal(row.step_error, null);
	assert.equal(db.prepare(`SELECT worker_name FROM cloudflare_inbox WHERE "userId" = 'user-a'`).get()?.worker_name, "my-agent");
});

test("0014 keeps an existing inbox and allows a second one", () => {
	const db = new DatabaseSync(":memory:");
	apply(db, files.filter((name) => name < "0014_cloudflare_inbox_agent.sql"));
	insertUser(db, "user-a", "a@example.com");
	db.prepare(
		`INSERT INTO cloudflare_inbox ("userId", cf_account_id, worker_name, d1_name, host, hostname, status, public_url, created_at, updated_at)
		 VALUES ('user-a', 'account', 'my-agent', 'my-agent', 'zone', 'myagent.example.com', 'ready', 'https://myagent.example.com', ?, ?)`,
	).run(earlier, earlier);
	apply(db, ["0014_cloudflare_inbox_agent.sql"]);
	const kept = db.prepare(`SELECT id, zone_id, hostname FROM cloudflare_inbox WHERE "userId" = 'user-a'`).get() as {
		id: string;
		zone_id: string | null;
		hostname: string;
	};
	assert.equal(kept.id, "user-a");
	assert.equal(kept.zone_id, null);
	assert.equal(kept.hostname, "myagent.example.com");
	db.prepare(
		`INSERT INTO cloudflare_inbox (id, "userId", cf_account_id, worker_name, d1_name, host, status, created_at, updated_at)
		 VALUES (?, 'user-a', 'account', 'other', 'other', 'workers', 'pending', ?, ?)`,
	).run("b".repeat(32), later, later);
	assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM cloudflare_inbox WHERE "userId" = 'user-a'`).get()?.n, 2);
});

test("0015 adds removal_access on a grant that already exists", () => {
	const db = new DatabaseSync(":memory:");
	apply(db, files.filter((name) => name < "0015_cloudflare_grant_access.sql"));
	insertUser(db, "user-a", "a@example.com");
	db.prepare(
		`INSERT INTO cloudflare_grant ("userId", "accountId", choice, host, requested_scope, created_at, updated_at) VALUES ('user-a', 'cf-user', 'inbox', 'workers', 'user-details.read', ?, ?)`,
	).run(earlier, earlier);
	apply(db, ["0015_cloudflare_grant_access.sql"]);
	assert.equal(db.prepare(`SELECT removal_access FROM cloudflare_grant WHERE "userId" = 'user-a'`).get()?.removal_access, null);
	db.prepare(`UPDATE cloudflare_grant SET removal_access = ? WHERE "userId" = 'user-a'`).run("sealed");
	assert.equal(db.prepare(`SELECT removal_access FROM cloudflare_grant WHERE "userId" = 'user-a'`).get()?.removal_access, "sealed");
});
