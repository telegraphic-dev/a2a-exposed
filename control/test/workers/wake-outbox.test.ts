// Real local D1 transactions in workerd; the data plane never makes HTTP calls.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import type { Sql, SqlStatement } from "../../src/core/sql.ts";
import { createTenant, flushOutbox, saveWakeSettings, tenantForAccount, type DataPlane } from "../../src/core/index.ts";

const db = env.DB as unknown as Sql;
const plane: DataPlane = {
	async putDirectory() {},
	async pushConfig(body) { return { version: body.version, applied: true }; },
};
const baseInput = { accountId: "owner", name: "northwind", url: "https://hooks.example.com/wake", preset: "generic", keyHeader: "", key: "" };

beforeAll(async () => {
	await applyD1Migrations(env.DB as D1Database, env.TEST_MIGRATIONS as { name: string; queries: string[] }[]);
});

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

// Let both calls capture N before either UPDATE. All writes still use native D1 batch.
function simultaneousReads() {
	const ready = deferred();
	let reads = 0;
	const raw = new WeakMap<SqlStatement, SqlStatement>();
	const wrap = (statement: SqlStatement, query: string): SqlStatement => {
		const wrapped: SqlStatement = {
			bind: (...values) => wrap(statement.bind(...values), query),
			async first<T>() {
				const row = await statement.first<T>();
				if (query.includes("FROM tenants WHERE name = ? AND owner_account_id = ?") && reads < 2) {
					if (++reads === 2) ready.resolve();
					await ready.promise;
				}
				return row;
			},
			run: () => statement.run(),
			all: <T>() => statement.all<T>(),
		};
		raw.set(wrapped, statement);
		return wrapped;
	};
	return {
		db: { prepare: (query: string) => wrap(db.prepare(query), query), batch: (statements: SqlStatement[]) => db.batch(statements.map((s) => raw.get(s)!)) },
		reads: () => reads,
	};
}

for (const testedVersion of [false, true]) {
	it(`returns conflict for a losing CAS while winner delivery is pending (expectedVersion=${testedVersion})`, async () => {
		const input = { ...baseInput, name: testedVersion ? "northwind-tested" : "northwind-plain" };
		expect((await createTenant(db, plane, input)).ok).toBe(true);
		const initial = (await tenantForAccount(db, input.accountId, input.name))!;
		const synchronized = simultaneousReads();
		const release = deferred();
		const pushing = deferred();
		let pushes = 0;
		const held: DataPlane = { ...plane, async pushConfig(body) {
			pushes++;
			pushing.resolve();
			await release.promise;
			return { version: body.version, applied: true };
		} };
		const edit = { ...input, ...(testedVersion ? { expectedVersion: initial.config_version } : {}) };
		const saves = [saveWakeSettings(synchronized.db, held, "", edit), saveWakeSettings(synchronized.db, held, "", edit)];
		// Attach rejection handlers immediately, including in the deliberately broken baseline.
		const first = Promise.race(saves);
		const settled = Promise.allSettled(saves);
		try {
			expect(await first).toEqual({ ok: false, error: "conflict" });
			await pushing.promise;
			expect(synchronized.reads()).toBe(2);
			expect(pushes).toBe(1);
			expect((await tenantForAccount(db, input.accountId, input.name))?.config_version).toBe(initial.config_version + 1);
			expect((await db.prepare("SELECT version FROM config_outbox WHERE tenant_id = ?").bind(initial.id).all<{ version: number }>()).results).toEqual([{ version: initial.config_version + 1 }]);
		} finally {
			release.resolve();
			await settled;
		}
		const results = await settled;
		expect(results.every((result) => result.status === "fulfilled")).toBe(true);
		expect(results.filter((result) => result.status === "fulfilled" && result.value.ok)).toHaveLength(1);
		expect((await db.prepare("SELECT version FROM config_outbox WHERE tenant_id = ?").bind(initial.id).all()).results).toEqual([]);
	});
}

it("rolls back the tenant update when enqueue fails, preserving the database error", async () => {
	const input = { ...baseInput, name: "southwind" };
	await createTenant(db, plane, input);
	const initial = await tenantForAccount(db, input.accountId, input.name);
	await db.prepare("CREATE TRIGGER reject_wake_enqueue BEFORE INSERT ON config_outbox BEGIN SELECT RAISE(ABORT, 'test_enqueue_failure'); END").run();
	let pushes = 0;
	try {
		await expect(saveWakeSettings(db, { ...plane, async pushConfig(body) { pushes++; return { version: body.version, applied: true }; } }, "dummy-platform-secret", { ...input, key: "dummy-key" })).rejects.toThrow("test_enqueue_failure");
		expect(await tenantForAccount(db, input.accountId, input.name)).toEqual(initial);
		expect(pushes).toBe(0);
		expect((await db.prepare("SELECT version FROM config_outbox").all()).results).toEqual([]);
	} finally {
		await db.prepare("DROP TRIGGER reject_wake_enqueue").run();
	}
});

it("keeps a committed enqueue after push failure and delivers it on retry", async () => {
	const input = { ...baseInput, name: "eastwind" };
	await createTenant(db, plane, input);
	const initial = (await tenantForAccount(db, input.accountId, input.name))!;
	const failing: DataPlane = { ...plane, async pushConfig() { throw new Error("dummy push failure"); } };
	await expect(saveWakeSettings(db, failing, "", input)).resolves.toEqual({ ok: true });
	const versions = () => db.prepare("SELECT version FROM config_outbox WHERE tenant_id = ?").bind(initial.id).all<{ version: number }>();
	expect((await versions()).results).toEqual([{ version: initial.config_version + 1 }]);
	expect((await tenantForAccount(db, input.accountId, input.name))?.config_version).toBe(initial.config_version + 1);
	await expect(flushOutbox(db, plane)).resolves.toEqual({ delivered: 1, pending: 0 });
	expect((await versions()).results).toEqual([]);
});
