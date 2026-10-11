import { test } from "node:test";
import assert from "node:assert/strict";
import { openWakeSecrets, sealWakeSecrets } from "../src/wake-secrets.ts";

const key = "platform-secret";
const tenant = "ten_a";

test("wake secrets round-trip for one tenant and stay unreadable for another", async () => {
	const secrets = { WAKE_WEBHOOK_KEY: "z9Qx-secret-value-0199", WAKE_HMAC_SECRET: "hmac-value" };
	const sealed = await sealWakeSecrets(key, tenant, secrets);
	assert.ok(sealed);
	assert.equal(sealed!.includes("z9Qx-secret-value-0199"), false);
	assert.equal(sealed!.startsWith("v1."), true);
	assert.deepEqual(await openWakeSecrets(key, tenant, sealed), secrets);
	assert.equal(await openWakeSecrets(key, "ten_b", sealed), null);
	assert.equal(await openWakeSecrets("other-key", tenant, sealed), null);
	assert.equal(await openWakeSecrets("", tenant, sealed), null);
	assert.deepEqual(await openWakeSecrets(key, tenant, null), {});
	assert.equal(await openWakeSecrets(key, tenant, sealed + ".extra"), null);
	assert.equal(await openWakeSecrets(key, tenant, "v1.not-base64.nope"), null);
});

test("a wake secret blob keeps only the known fields", async () => {
	const sealed = await sealWakeSecrets(key, tenant, {
		WAKE_WEBHOOK_KEY: "hook-key",
		WAKE_ACCESS_CLIENT_SECRET: "access-secret",
	});
	const opened = await openWakeSecrets(key, tenant, sealed);
	assert.deepEqual(opened, { WAKE_WEBHOOK_KEY: "hook-key", WAKE_ACCESS_CLIENT_SECRET: "access-secret" });
	assert.equal(await sealWakeSecrets(key, tenant, { WAKE_WEBHOOK_KEY: "x".repeat(4097) }), null);
});
