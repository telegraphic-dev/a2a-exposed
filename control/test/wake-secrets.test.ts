import { test } from "node:test";
import assert from "node:assert/strict";
import { openWakeSecrets as openHere, sealWakeSecrets as sealHere } from "../src/tenants/wake-secrets.ts";
import { openWakeSecrets as openWorker, sealWakeSecrets as sealWorker } from "../../worker/src/wake-secrets.ts";

test("the control plane and the worker open each other's wake secrets", async () => {
	const secrets = { WAKE_WEBHOOK_KEY: "z9Qx-secret-value-0199" };
	const fromControl = await sealHere("platform-secret", "ten_a", secrets);
	const fromWorker = await sealWorker("platform-secret", "ten_a", secrets);
	assert.ok(fromControl && fromWorker);
	assert.deepEqual(await openWorker("platform-secret", "ten_a", fromControl), secrets);
	assert.deepEqual(await openHere("platform-secret", "ten_a", fromWorker), secrets);
});
