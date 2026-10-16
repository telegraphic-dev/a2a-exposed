import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenant, listTenants } from "../src/tenants/create.ts";
import { dataPlaneFromEnv, flushOutbox, type DataPlane, type TenantPush } from "../src/tenants/push.ts";
import { openDb } from "./sql.ts";

function plane() {
	const directory = new Map<string, { id: string; status: string; region: string; version: number }>();
	const pushes: { body: TenantPush; region: string }[] = [];
	let fail = false;
	const data: DataPlane = {
		async putDirectory(name, entry) {
			const current = directory.get(name);
			if (current && current.version > entry.version) return;
			directory.set(name, entry);
		},
		async pushConfig(body, region) {
			if (fail) throw new Error("plane down");
			pushes.push({ body, region });
			return { version: body.version, applied: true };
		},
	};
	return { directory, pushes, data, setFail(next: boolean) { fail = next; } };
}

test("create writes the directory and the object, and the token is shown once", async () => {
	const db = openDb();
	const target = plane();
	const reserved = await createTenant(db, target.data, { accountId: "acct", name: "admin", domain: "example.com", dataRegion: "eu" });
	assert.equal(reserved.ok, false);
	if (!reserved.ok) assert.equal(reserved.error, "reserved_name");
	const invalid = await createTenant(db, target.data, { accountId: "acct", name: "   ", domain: "example.com" });
	assert.equal(invalid.ok, false);
	if (!invalid.ok) assert.equal(invalid.error, "invalid_name");
	assert.equal(target.directory.size, 0);
	assert.equal(target.pushes.length, 0);

	const created = await createTenant(db, target.data, { accountId: "acct", name: "Northwind", domain: "example.com", dataRegion: "eu" });
	assert.equal(created.ok, true);
	if (!created.ok) return;
	assert.equal(created.tenant.name, "northwind");
	assert.equal(created.tenant.publicUrl, "https://northwind.example.com");
	assert.equal(created.tenant.region, "eu");
	assert.equal(created.tenant.pushed, true);
	assert.match(created.tenant.ownerToken, /^a2aot_/);
	assert.equal(target.directory.get("northwind")?.region, "eu");
	assert.equal(target.pushes.length, 1);
	assert.equal(target.pushes[0].region, "eu");
	assert.equal(target.pushes[0].body.name, "northwind");
	assert.equal(target.pushes[0].body.version, 1);
	assert.equal(target.pushes[0].body.ownerTokenHash.length, 64);
	assert.equal(JSON.stringify(target.pushes[0]).includes(created.tenant.ownerToken), false);
	assert.equal(target.pushes[0].body.config.EVENT_URL, undefined);
	assert.equal(target.pushes[0].body.config.EVENT_SECRET, undefined);

	const again = await createTenant(db, target.data, { accountId: "acct", name: "northwind", domain: "example.com" });
	assert.equal(again.ok, false);
	if (!again.ok) assert.equal(again.error, "taken");

	const listed = await listTenants(db, "acct", "example.com");
	assert.equal(listed.length, 1);
	assert.equal(listed[0].name, "northwind");
	assert.equal(listed[0].publicUrl, "https://northwind.example.com");
	assert.equal(JSON.stringify(listed).includes(created.tenant.ownerToken), false);
	assert.equal(JSON.stringify(listed).includes("ownerToken"), false);
});

test("create stores pairing event settings when the control plane passes both", async () => {
	const db = openDb();
	const target = plane();
	const url = "https://example.com/api/agent-events";
	const created = await createTenant(db, target.data, { accountId: "acct", name: "northwind", eventUrl: url, eventSecret: "event-secret" });
	assert.equal(created.ok, true);
	assert.equal(target.pushes[0].body.config.EVENT_URL, url);
	assert.equal(target.pushes[0].body.config.EVENT_SECRET, "event-secret");
	assert.equal(target.pushes[0].body.config.AGENT_NAME, "northwind");
	const partial = await createTenant(db, target.data, { accountId: "acct", name: "partial1", eventUrl: "http://example.com/api", eventSecret: "event-secret" });
	assert.equal(partial.ok, true);
	assert.equal(target.pushes[1].body.config.EVENT_URL, undefined);
	assert.equal(target.pushes[1].body.config.EVENT_SECRET, undefined);
});

test("a failed push stays in the outbox and a later flush delivers it", async () => {
	const db = openDb();
	const target = plane();
	target.setFail(true);
	const created = await createTenant(db, target.data, { accountId: "acct", name: "northwind" });
	assert.equal(created.ok, true);
	if (!created.ok) return;
	assert.equal(created.tenant.pushed, false);
	assert.match(created.tenant.ownerToken, /^a2aot_/);
	assert.equal(target.pushes.length, 0);
	target.setFail(false);
	const flushed = await flushOutbox(db, target.data, Date.parse("2099-01-01T00:00:00.000Z"));
	assert.equal(flushed.delivered, 1);
	assert.equal(flushed.pending, 0);
	assert.equal(target.pushes.length, 1);
	assert.equal(target.directory.get("northwind")?.region, "default");
});

test("eu and fedramp select a jurisdiction and default stays on the namespace", async () => {
	const seen: string[] = [];
	const stub = {
		idFromName(name: string) { return name; },
		get(id: unknown) {
			seen.push(`get:${String(id)}`);
			return { async pushConfig(body: TenantPush) { return { version: body.version, applied: true }; } };
		},
		jurisdiction(location: string) {
			seen.push(`jurisdiction:${location}`);
			return this;
		},
	};
	const kv = { async get() { return null; }, async put() {} };
	const bound = dataPlaneFromEnv({ TENANT_DIRECTORY: kv, TENANT_DO: stub });
	assert.ok(bound);
	const body: TenantPush = {
		version: 1, tenantId: "t1", name: "northwind", status: "active",
		config: {}, limits: {}, approval: {}, ownerTokenHash: "ab", secretsEnc: null,
	};
	await bound.pushConfig(body, "eu");
	await bound.pushConfig({ ...body, version: 2 }, "fedramp");
	await bound.pushConfig({ ...body, version: 3 }, "default");
	assert.deepEqual(seen, ["jurisdiction:eu", "get:t1", "jurisdiction:fedramp", "get:t1", "get:t1"]);
});

function tenantInsert(db: ReturnType<typeof openDb>, accountId: string) {
	return (name: string) => db.prepare(
		`INSERT INTO tenants (
		   id, name, owner_account_id, status, region, config_json, limits_json, approval_json,
		   owner_token_hash, secrets_enc, config_version, created_at, updated_at
		 ) VALUES (?, ?, ?, 'active', 'default', '{}', '{}', '{}', 'hash', NULL, 1, ?, ?)`,
	).bind(crypto.randomUUID(), name, accountId, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z").run();
}

test("creates are not capped when no limit is configured", async () => {
	const db = openDb();
	const plane = { async putDirectory() {}, async pushConfig() { return { version: 1, applied: true }; } };
	for (const name of ["alpha1", "bravo1", "charlie"]) {
		const created = await createTenant(db, plane, { accountId: "acct", name });
		assert.equal(created.ok, true, name);
	}
	assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM tenants").first<{ n: number }>())?.n, 3);
});

test("the free default is enforced inside the insert", async () => {
	const db = openDb();
	await db.prepare("INSERT INTO control_settings (id, free_agent_limit) VALUES (1, 2)").run();
	const insert = tenantInsert(db, "acct");
	await insert("alpha1");
	await insert("bravo1");
	await assert.rejects(insert("charlie"), /agent_limit/);
	assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM tenants WHERE owner_account_id = 'acct'").first<{ n: number }>())?.n, 2);
	const plane = { async putDirectory() {}, async pushConfig() { return { version: 1, applied: true }; } };
	const created = await createTenant(db, plane, { accountId: "acct", name: "delta1", freeAgentLimit: 2 });
	assert.deepEqual(created, { ok: false, error: "limit" });
});

test("a raised per-account limit overrides the free default", async () => {
	const db = openDb();
	const now = "2026-01-01T00:00:00.000Z";
	await db.prepare(
		`INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt, agent_limit)
		 VALUES ('acct', 'A', 'a@example.com', 1, NULL, ?, ?, 10)`,
	).bind(now, now).run();
	await db.prepare("INSERT INTO control_settings (id, free_agent_limit) VALUES (1, 2)").run();
	const insert = tenantInsert(db, "acct");
	await insert("alpha1");
	await insert("bravo1");
	await insert("charlie");
	const plane = { async putDirectory() {}, async pushConfig() { return { version: 1, applied: true }; } };
	for (let i = 3; i < 10; i++) {
		const created = await createTenant(db, plane, { accountId: "acct", name: `agent${i}x`, freeAgentLimit: 2 });
		assert.equal(created.ok, true, `agent${i}x`);
	}
	assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM tenants").first<{ n: number }>())?.n, 10);
	await assert.rejects(insert("extra1"), /agent_limit/);
	const created = await createTenant(db, plane, { accountId: "acct", name: "extra2", freeAgentLimit: 2 });
	assert.deepEqual(created, { ok: false, error: "limit" });
	assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM tenants").first<{ n: number }>())?.n, 10);
});

test("two overlapping creates cannot both pass the free-plan limit", async () => {
	const db = openDb();
	const plane = { async putDirectory() {}, async pushConfig() { return { version: 1, applied: true }; } };
	const first = await createTenant(db, plane, { accountId: "acct", name: "alpha1", freeAgentLimit: 2 });
	assert.equal(first.ok, true);
	const raced = await Promise.all([
		createTenant(db, plane, { accountId: "acct", name: "bravo1", freeAgentLimit: 2 }),
		createTenant(db, plane, { accountId: "acct", name: "charlie", freeAgentLimit: 2 }),
	]);
	const results = raced.map((result) => result.ok ? "ok" : result.error).sort();
	assert.deepEqual(results, ["limit", "ok"]);
	assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM tenants").first<{ n: number }>())?.n, 2);
});

test("a directory write does not roll a newer version backwards", async () => {
	const versions: number[] = [];
	const kv = {
		async get() { return { version: 4 }; },
		async put(_key: string, value: string) { versions.push(JSON.parse(value).version); },
	};
	const objects = {
		idFromName(name: string) { return name; },
		get() { return { async pushConfig(body: TenantPush) { return { version: body.version, applied: true }; } }; },
	};
	const bound = dataPlaneFromEnv({ TENANT_DIRECTORY: kv, TENANT_DO: objects });
	assert.ok(bound);
	await bound.putDirectory("northwind", { id: "t1", status: "active", region: "default", version: 2 });
	assert.deepEqual(versions, []);
	await bound.putDirectory("northwind", { id: "t1", status: "active", region: "default", version: 5 });
	assert.deepEqual(versions, [5]);
});

test("a deleted directory id is not overwritten and a new id can replace the tombstone", async () => {
	const store = new Map<string, string>();
	const kv = {
		async get(key: string) {
			const raw = store.get(key);
			return raw ? JSON.parse(raw) as unknown : null;
		},
		async put(key: string, value: string) { store.set(key, value); },
	};
	const objects = {
		idFromName(name: string) { return name; },
		get() { return { async pushConfig(body: TenantPush) { return { version: body.version, applied: true }; } }; },
	};
	const bound = dataPlaneFromEnv({ TENANT_DIRECTORY: kv, TENANT_DO: objects });
	assert.ok(bound);
	await bound.putDirectory("northwind", { id: "old", status: "deleted", region: "default", version: 4 });
	await bound.putDirectory("northwind", { id: "old", status: "active", region: "default", version: 9 });
	assert.equal(JSON.parse(store.get("tenant:northwind")!).status, "deleted");
	assert.equal(JSON.parse(store.get("tenant:northwind")!).id, "old");
	await bound.putDirectory("northwind", { id: "new", status: "active", region: "default", version: 1 });
	assert.equal(JSON.parse(store.get("tenant:northwind")!).id, "new");
	assert.equal(JSON.parse(store.get("tenant:northwind")!).status, "active");
	await bound.putDirectory("northwind", { id: "old", status: "active", region: "default", version: 20 });
	assert.equal(JSON.parse(store.get("tenant:northwind")!).id, "new");
});
