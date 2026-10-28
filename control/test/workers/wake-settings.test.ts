// Real workerd/D1 and Web Crypto; no remote API or wake endpoint is called.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { createTenant, saveWakeSettings, tenantForAccount, openWakeSecrets, type Sql } from "../../src/core/index.ts";
import { openWakeSecrets as openWorker } from "../../../worker/src/wake-secrets.ts";

beforeAll(async () => {
	await applyD1Migrations(env.DB as D1Database, env.TEST_MIGRATIONS as { name: string; queries: string[] }[]);
});

it("seals an OpenBot secret and atomically rejects stale tested versions in workerd", async () => {
	const db = env.DB as unknown as Sql;
	const plane = { async putDirectory() {}, async pushConfig(body: { version: number }) { return { version: body.version, applied: true }; } };
	const created = await createTenant(db, plane, { accountId: "wake-owner", name: "wake-test" });
	expect(created.ok).toBe(true);
	const input = { accountId: "wake-owner", name: "wake-test", url: "https://hooks.example.com/wake", preset: "openbot", keyHeader: "", key: "", hmacSecret: "dummy-signing-secret", expectedVersion: 1 };
	expect(await saveWakeSettings(db, plane, "dummy-platform-key", input)).toEqual({ ok: true });
	const row = (await tenantForAccount(db, input.accountId, input.name))!;
	expect(row.config_version).toBe(2);
	expect(row.config_json.includes(input.hmacSecret)).toBe(false);
	expect(await openWorker("dummy-platform-key", row.id, row.secrets_enc)).toEqual({ WAKE_HMAC_SECRET: input.hmacSecret });
	expect(await openWakeSecrets("dummy-platform-key", "another-tenant", row.secrets_enc)).toBe(null);
	expect(await saveWakeSettings(db, plane, "dummy-platform-key", { ...input, hmacSecret: "replacement" })).toEqual({ ok: false, error: "conflict" });
	expect((await tenantForAccount(db, input.accountId, input.name))?.secrets_enc).toBe(row.secrets_enc);
});
