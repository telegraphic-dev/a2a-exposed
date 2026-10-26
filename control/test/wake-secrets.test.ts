import { test } from "node:test";
import assert from "node:assert/strict";
import { openWakeSecrets as openHere, sealWakeSecrets as sealHere } from "../src/tenants/wake-secrets.ts";
import { MAX_WAKE_SEALED, MAX_WAKE_VALUE, openWakeSecrets as openWorker, sealWakeSecrets as sealWorker, WAKE_SECRET_KEYS } from "../../worker/src/wake-secrets.ts";

test("the library and the worker open each other's wake secrets", async () => {
	const secrets = { WAKE_WEBHOOK_KEY: "z9Qx-secret-value-0199" };
	const fromControl = await sealHere("platform-secret", "ten_a", secrets);
	const fromWorker = await sealWorker("platform-secret", "ten_a", secrets);
	assert.ok(fromControl && fromWorker);
	assert.deepEqual(await openWorker("platform-secret", "ten_a", fromControl), secrets);
	assert.deepEqual(await openHere("platform-secret", "ten_a", fromWorker), secrets);
});

test("a maximum-size wake blob sealed on one side opens on the other", async () => {
	const value = "x".repeat(MAX_WAKE_VALUE);
	const secrets = Object.fromEntries(WAKE_SECRET_KEYS.map((name) => [name, value]));
	const fromControl = await sealHere("platform-secret", "ten_a", secrets);
	const fromWorker = await sealWorker("platform-secret", "ten_a", secrets);
	assert.ok(fromControl && fromWorker);
	assert.ok(fromControl.length > 16384 && fromControl.length <= MAX_WAKE_SEALED);
	assert.deepEqual(await openWorker("platform-secret", "ten_a", fromControl), secrets);
	assert.deepEqual(await openHere("platform-secret", "ten_a", fromWorker), secrets);
});

test("control wake presets match the Worker and protect plain preview headers", async () => {
	const { WAKE_PRESETS, wakeSettingsOf, wakeHeaderProblem } = await import("../src/tenants/wake.ts");
	const { PRESETS } = await import("../../worker/src/wake.ts");
	assert.deepEqual(WAKE_PRESETS, PRESETS);
	assert.equal(wakeSettingsOf({ WAKE_PRESET: "openbot" }).preset, "openbot");
	assert.equal(wakeHeaderProblem("x-openbot-delivery-id"), "header");
	assert.equal(wakeHeaderProblem("x-openbot-timestamp"), "header");
});
