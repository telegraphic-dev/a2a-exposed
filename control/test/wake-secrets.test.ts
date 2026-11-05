import { test } from "node:test";
import assert from "node:assert/strict";
import { openWakeSecrets as openHere, rewrapWakeSecrets, sealWakeSecrets as sealHere } from "../src/tenants/wake-secrets.ts";
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

test("facade credentials share the tenant-bound encrypted envelope and remain out of public config", async () => {
	const secrets = {
		EVENT_SECRET: "dummy-event-secret",
		UPSTREAM_TOKEN: "dummy-upstream-token",
		UPSTREAM_ACCESS_CLIENT_ID: "dummy-upstream-access-id",
		UPSTREAM_ACCESS_CLIENT_SECRET: "dummy-upstream-access-secret",
	};
	const sealed = await sealHere("platform-secret", "ten_a", secrets);
	assert.ok(sealed);
	assert.deepEqual(await openWorker("platform-secret", "ten_a", sealed), secrets);
	assert.equal(await openWorker("platform-secret", "ten_b", sealed), null);
	assert.equal(await openWorker("wrong-key", "ten_a", sealed), null);
	const { omitSealedSecrets } = await import("../../worker/src/wake-secrets.ts");
	assert.deepEqual(omitSealedSecrets({ AGENT_NAME: "northwind", ...secrets }, sealed), { AGENT_NAME: "northwind" });
	const { omitSealedSecrets: omitHere } = await import("../src/tenants/wake-secrets.ts");
	assert.deepEqual(omitHere({ AGENT_NAME: "northwind", ...secrets }, sealed), { AGENT_NAME: "northwind" });
	for (const value of Object.values(secrets)) assert.equal(sealed.includes(value), false);
});

const rotation = (active: string, keys: Record<string, string>) => JSON.stringify({ v: 2, active, keys });

test("v2 key ids interoperate, keep v1 readable during rotation, and retire the old key", async () => {
	const secrets = { WAKE_HMAC_SECRET: "fixture-hmac", EVENT_SECRET: "fixture-event" };
	const both = { old: "old-material", current: "new-material" };
	const oldRing = rotation("old", both);
	const newRing = rotation("current", both);
	const retired = rotation("current", { current: both.current });
	const legacy = await sealHere(both.old, "ten_a", secrets);
	const oldV2 = await sealHere(oldRing, "ten_a", secrets);
	const newV2 = await sealWorker(newRing, "ten_a", secrets);
	assert.ok(legacy && oldV2 && newV2);
	assert.ok(oldV2.startsWith("v2.old."));
	assert.ok(newV2.startsWith("v2.current."));
	for (const open of [openHere, openWorker]) {
		assert.deepEqual(await open(newRing, "ten_a", legacy), secrets);
		assert.deepEqual(await open(newRing, "ten_a", oldV2), secrets);
		assert.deepEqual(await open(oldRing, "ten_a", newV2), secrets, "both readers are staged before flipping the writer");
		assert.deepEqual(await open(retired, "ten_a", newV2), secrets);
		assert.equal(await open(retired, "ten_a", legacy), null);
		assert.equal(await open(retired, "ten_a", oldV2), null);
		assert.equal(await open(newRing, "ten_b", newV2), null);
		assert.equal(await open(both.current, "ten_a", newV2), null, "a raw-key rollback cannot silently read a v2 envelope");
	}
});

test("v2 authenticates the kid even when key material is reused and refuses malformed envelopes", async () => {
	const ring = rotation("a", { a: "fixture-material", b: "fixture-material" });
	const sealed = await sealHere(ring, "ten_a", { WAKE_WEBHOOK_KEY: "fixture-key" });
	assert.ok(sealed);
	for (const open of [openHere, openWorker]) {
		for (const blob of [sealed.replace("v2.a.", "v2.b."), sealed.replace("v2.a.", "v2.unknown."), sealed + ".extra", sealed.replace("v2.", "v3."), "v2.a.bad.bad"]) {
			assert.equal(await open(ring, "ten_a", blob), null);
		}
	}
});

test("invalid keyrings refuse writes and never fall back to treating JSON as raw material", async () => {
	for (const input of ["{", "{}", rotation("absent", { a: "key" }), rotation("a", { a: "" }), rotation("a", { a: "one", b: "two", c: "three" }), rotation("a.b", { "a.b": "key" }), JSON.stringify({v: 2, active: "a", keys: {a: "key"}, extra: true})]) {
		assert.equal(await sealHere(input, "ten_a", { WAKE_WEBHOOK_KEY: "fixture-key" }), null);
		assert.equal(await sealWorker(input, "ten_a", { WAKE_WEBHOOK_KEY: "fixture-key" }), null);
	}
});

test("unreadable blobs emit one fixed alert without secrets, tenant ids or attacker-controlled fields", async (t) => {
	const logs: unknown[][] = [];
	t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
	const ring = rotation("private-kid", { "private-kid": "fixture-private-key" });
	for (const open of [openHere, openWorker]) {
		const before = logs.length;
		assert.deepEqual(await open(ring, "private-tenant", null), {});
		assert.equal(logs.length, before);
		assert.equal(await open(ring, "private-tenant", "v2.attacker-kid.fixture-ciphertext.fixture-ciphertext"), null);
		assert.equal(logs.length, before + 1);
		assert.deepEqual(logs.at(-1), [JSON.stringify({ event: "wake_secrets_unreadable", level: "error" })]);
	}
	const legacy = await sealHere("old-key", "private-tenant", { EVENT_SECRET: "fixture-secret" });
	const both = rotation("current", { current: "new-key", previous: "old-key" });
	const before = logs.length;
	assert.deepEqual(await openWorker(both, "private-tenant", legacy), { EVENT_SECRET: "fixture-secret" });
	assert.equal(logs.length, before, "successful fallback must not raise an alert");
});

test("v2 maximum-size escaped payload opens across control and Worker", async () => {
	const ring = rotation("k".repeat(64), { ["k".repeat(64)]: "fixture-key" });
	const secrets = Object.fromEntries(WAKE_SECRET_KEYS.map((name) => [name, "\u0000".repeat(MAX_WAKE_VALUE)]));
	const sealed = await sealHere(ring, "ten_a", secrets);
	assert.ok(sealed && sealed.length <= MAX_WAKE_SEALED);
	assert.deepEqual(await openWorker(ring, "ten_a", sealed), secrets);
});


test("rewrapping preserves every sealed field and produces a blob readable after old-key retirement", async () => {
	const secrets = Object.fromEntries(WAKE_SECRET_KEYS.map((name) => [name, `fixture-${name}`]));
	const original = await sealHere("old-key", "ten_a", secrets);
	assert.ok(original);
	const ring = rotation("current", { current: "new-key", previous: "old-key" });
	const rewritten = await rewrapWakeSecrets(ring, "ten_a", original);
	assert.ok(rewritten?.startsWith("v2.current."));
	const retired = rotation("current", { current: "new-key" });
	assert.deepEqual(await openWorker(retired, "ten_a", rewritten), secrets);
	assert.equal(await rewrapWakeSecrets(retired, "ten_a", original), null);
	assert.equal(await rewrapWakeSecrets(ring, "ten_b", original), null);
	assert.equal(await rewrapWakeSecrets(ring, "ten_a", ""), null);
});
