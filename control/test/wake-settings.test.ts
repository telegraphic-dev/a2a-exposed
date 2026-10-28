import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenant, saveWakeSettings, openWakeSecrets, sealWakeSecrets, tenantForAccount, flushOutbox, type DataPlane, type TenantPush, type WakeSaveInput } from "../src/core/index.ts";
import { openWakeSecrets as openWorker } from "../../worker/src/wake-secrets.ts";
import { openDb } from "./sql.ts";

const platform = "dummy-platform-secret";
const input: WakeSaveInput = { accountId: "owner", name: "northwind", url: "https://hooks.example.com/wake", preset: "openbot", keyHeader: "", key: "", hmacSecret: "dummy-signing-secret" };
async function setup() {
	const db = openDb();
	const pushes: TenantPush[] = [];
	const plane: DataPlane = { async putDirectory() {}, async pushConfig(body) { pushes.push(body); return { version: body.version, applied: true }; } };
	const created = await createTenant(db, plane, { accountId: "owner", name: "northwind" });
	assert.equal(created.ok, true);
	const row = () => tenantForAccount(db, "owner", "northwind");
	const secrets = async () => { const r = (await row())!; return openWakeSecrets(platform, r.id, r.secrets_enc); };
	const save = (edit: Partial<WakeSaveInput> = {}, key = platform) => saveWakeSettings(db, plane, key, { ...input, ...edit });
	return { db, plane, pushes, row, secrets, save };
}

test("explicit signing secret is sealed and pushed; old Worker reader opens the same v1 blob", async () => {
	const s = await setup();
	assert.deepEqual(await s.save(), { ok: true });
	const row = (await s.row())!;
	assert.equal(row.config_json.includes(input.hmacSecret!), false);
	assert.equal(row.secrets_enc?.includes(input.hmacSecret!), false);
	assert.match(row.secrets_enc!, /^v1\./);
	assert.deepEqual(await openWorker(platform, row.id, row.secrets_enc), { WAKE_HMAC_SECRET: input.hmacSecret });
	assert.equal(s.pushes.at(-1)?.secretsEnc, row.secrets_enc);
	assert.equal(s.pushes.at(-1)?.config.WAKE_HMAC_SECRET, undefined);
	assert.deepEqual(await s.save({ hmacSecret: "" }), { ok: true });
	assert.equal((await s.row())?.secrets_enc, row.secrets_enc, "blank same-mode edit keeps ciphertext");
	assert.deepEqual(await s.save({ hmacSecret: "replacement" }), { ok: true });
	assert.equal((await s.secrets())?.WAKE_HMAC_SECRET, "replacement");
});

test("OpenBot fails closed without a signing secret or on destination/authentication changes", async () => {
	const s = await setup();
	const before = await s.row();
	assert.deepEqual(await s.save({ hmacSecret: "" }), { ok: false, error: "key" });
	assert.deepEqual(await s.row(), before);
	await s.save();
	const saved = await s.row();
	assert.deepEqual(await s.save({ hmacSecret: "", url: "https://other.example.com/wake" }), { ok: false, error: "key" });
	assert.deepEqual(await s.row(), saved);
	assert.deepEqual(await s.save({ key: "unused" }), { ok: false, error: "key" });
	assert.deepEqual(await s.save({ keyHeader: "Authorization" }), { ok: false, error: "header" });
	await s.save({ preset: "generic", hmacSecret: "", key: "webhook-key" });
	assert.deepEqual(await s.secrets(), { WAKE_WEBHOOK_KEY: "webhook-key" });
	assert.deepEqual(await s.save({ hmacSecret: "" }), { ok: false, error: "key" });
});

test("webhook key reuse requires identical URL, preset and key header; disable clears both wake credentials", async () => {
	const s = await setup();
	const edit = { preset: "generic", hmacSecret: "", key: "first", keyHeader: "X-Key" };
	await s.save(edit);
	await s.save({ ...edit, key: "" });
	assert.equal((await s.secrets())?.WAKE_WEBHOOK_KEY, "first");
	for (const changed of [{ url: "https://other.example.com/wake" }, { preset: "grok-bot" }, { keyHeader: "X-Other" }]) {
		await s.save(edit);
		await s.save({ ...edit, key: "", ...changed });
		assert.equal((await s.secrets())?.WAKE_WEBHOOK_KEY, undefined);
	}
	await s.save();
	await s.save({ url: "", hmacSecret: "ignored", key: "ignored", keyHeader: "X-Key" });
	assert.deepEqual(await s.secrets(), {});
	const config = JSON.parse((await s.row())!.config_json);
	assert.equal(config.WAKE_WEBHOOK_URL, undefined);
	assert.equal(config.WAKE_KEY_HEADER, undefined);
});

test("legacy plaintext migrates, ciphertext wins, unrelated sealed event/Access credentials survive", async () => {
	const s = await setup();
	const row = (await s.row())!;
	const config = { ...JSON.parse(row.config_json), WAKE_WEBHOOK_URL: input.url, WAKE_PRESET: "openbot", WAKE_HMAC_SECRET: "legacy", EVENT_SECRET: "event", WAKE_ACCESS_CLIENT_ID: "access-id", WAKE_ACCESS_CLIENT_SECRET: "access-secret" };
	await s.db.prepare("UPDATE tenants SET config_json = ? WHERE id = ?").bind(JSON.stringify(config), row.id).run();
	assert.deepEqual(await s.save({ hmacSecret: "" }), { ok: true });
	assert.equal((await s.secrets())?.WAKE_HMAC_SECRET, "legacy");
	const sealed = await sealWakeSecrets(platform, row.id, { WAKE_HMAC_SECRET: "sealed", EVENT_SECRET: "sealed-event", WAKE_ACCESS_CLIENT_ID: "id", WAKE_ACCESS_CLIENT_SECRET: "secret" });
	await s.db.prepare("UPDATE tenants SET config_json = ?, secrets_enc = ? WHERE id = ?").bind(JSON.stringify(config), sealed, row.id).run();
	await s.save({ hmacSecret: "" });
	assert.equal((await s.secrets())?.WAKE_HMAC_SECRET, "sealed");
	await s.save({ url: "", hmacSecret: "" });
	assert.deepEqual(await s.secrets(), { EVENT_SECRET: "sealed-event", WAKE_ACCESS_CLIENT_ID: "id", WAKE_ACCESS_CLIENT_SECRET: "secret" });
	const raw = JSON.parse((await s.row())!.config_json);
	for (const name of ["WAKE_HMAC_SECRET", "EVENT_SECRET", "WAKE_ACCESS_CLIENT_ID", "WAKE_ACCESS_CLIENT_SECRET"]) assert.equal(raw[name], undefined);
});

test("unreadable/missing encryption, invalid input, other accounts and stale tested versions make no write", async () => {
	const s = await setup();
	await s.save();
	const before = await s.row();
	for (const [edit, expected, key] of [
		[{ expectedVersion: -1 }, "conflict", platform],
		[{ accountId: "other" }, "conflict", platform],
		[{ name: "missing" }, "conflict", platform],
		[{ hmacSecret: "x".repeat(4097) }, "key", platform],
		[{ hmacSecret: "bad\nvalue" }, "key", platform],
		[{ url: "http://hooks.example.com/wake" }, "url", platform],
		[{}, "unreadable", "wrong"],
		[{}, "unavailable", ""],
	] as const) {
		assert.deepEqual(await s.save(edit, key), { ok: false, error: expected });
		assert.deepEqual(await s.row(), before);
	}
	await s.db.prepare("UPDATE tenants SET secrets_enc = ? WHERE name = ?").bind("v1.broken.blob", "northwind").run();
	assert.deepEqual(await s.save(), { ok: false, error: "unreadable" });
});

test("optimistic version check permits one of two concurrent tested saves", async () => {
	const s = await setup();
	const expectedVersion = (await s.row())!.config_version;
	const results = await Promise.all([s.save({ expectedVersion }), s.save({ expectedVersion, hmacSecret: "second" })]);
	assert.equal(results.filter((r) => r.ok).length, 1);
	assert.equal(results.filter((r) => !r.ok && r.error === "conflict").length, 1);
	assert.equal((await s.row())!.config_version, expectedVersion + 1);
});

test("failed push preserves encrypted outbox for retry and does not log provider text", async (t) => {
	const s = await setup();
	const logs: string[] = [];
	t.mock.method(console, "log", (text: string) => logs.push(text));
	s.plane.pushConfig = async () => { throw new Error("dummy-provider-private-value"); };
	assert.deepEqual(await s.save(), { ok: true });
	assert.equal(logs.join("").includes("dummy-provider-private-value"), false);
	assert.equal(logs.join("").includes(input.hmacSecret!), false);
	assert.equal((await s.db.prepare("SELECT COUNT(*) AS n FROM config_outbox").first<{ n: number }>())?.n, 1);
	assert.deepEqual(await flushOutbox(s.db, s.plane), { delivered: 0, pending: 1 });
	assert.equal(logs.join("").includes("dummy-provider-private-value"), false, "retry logs are sanitized too");
	s.plane.pushConfig = async (body) => ({ version: body.version, applied: true });
	assert.deepEqual(await flushOutbox(s.db, s.plane), { delivered: 1, pending: 0 });
});
