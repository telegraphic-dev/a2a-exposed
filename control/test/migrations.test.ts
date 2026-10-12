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
