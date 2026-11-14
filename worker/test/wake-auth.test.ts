// Key-based presets refuse to render, preview or test a wake without the credential their receiver checks.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { renderWake, presetAuthProblem, BEARER_KEY_PRESETS, type WakeEvent } from "../src/wake.ts";
import { d1 } from "./d1.ts";

const BASE = "https://agent.example.com";
const ev: WakeEvent = { contextId: "ctx-1", taskId: "t-1", taskIds: ["t-1"], from: "peer-a", preview: "hello", kind: "inbound", publicUrl: BASE };
const url = "https://hooks.example.com/wake";

test("Bearer presets and Hermes refuse a missing credential; a set credential renders", async () => {
	assert.deepEqual([...BEARER_KEY_PRESETS], ["grok-bot", "claude-code", "openclaw-wake", "openclaw-agent"]);
	for (const preset of BEARER_KEY_PRESETS) {
		for (const key of [undefined, "", "   "]) {
			await assert.rejects(renderWake({ preset, url, key, hmacSecret: "cannot-replace-bearer" }, ev), new RegExp(`^Error: ${preset} requires WAKE_WEBHOOK_KEY`));
			await assert.rejects(renderWake({ preset, transport: "relay", key }, ev), /requires WAKE_WEBHOOK_KEY/);
		}
		const req = (await renderWake({ preset, url, key: "dummy-key" }, ev))!;
		assert.equal(req.headers.authorization, "Bearer dummy-key");
		assert.equal(await renderWake({ preset }, ev), null, "no URL is still an unconfigured wake, not an error");
	}
	for (const hmacSecret of [undefined, "", "   "]) {
		await assert.rejects(renderWake({ preset: "hermes", url, hmacSecret, key: "cannot-replace-signing" }, ev), /^Error: hermes requires WAKE_HMAC_SECRET/);
	}
	assert.ok((await renderWake({ preset: "hermes", url, hmacSecret: "dummy-signing" }, ev))!.headers["X-Webhook-Signature-V2"]);
	// The generic preset keeps optional auth.
	assert.equal((await renderWake({ preset: "generic", url }, ev))!.headers.authorization, undefined);
	assert.equal(presetAuthProblem({ preset: "generic" }), "");
	// The message names the setting, never a value.
	assert.equal(presetAuthProblem({ preset: "claude-code", key: "" }).includes("dummy"), false);
});

test("wake preview and wake test report a missing key and send nothing", async (t) => {
	const sent: unknown[] = [];
	const origFetch = globalThis.fetch;
	globalThis.fetch = (async (_url: unknown, init: any) => { sent.push(init?.body); return new Response("ok", { status: 200 }); }) as typeof fetch;
	t.after(() => { globalThis.fetch = origFetch; });
	const call = async (env: Record<string, unknown>, method: string, path: string, json?: unknown) => {
		const pending: Promise<unknown>[] = [];
		const res = await worker.fetch(new Request(BASE + path, {
			method, headers: { "content-type": "application/json", authorization: "Bearer owner-secret" },
			body: json === undefined ? undefined : JSON.stringify(json),
		}) as any, env as any, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as any);
		await Promise.allSettled(pending);
		return { status: res.status, body: await res.json() as any };
	};
	for (const preset of [...BEARER_KEY_PRESETS, "hermes"]) {
		const env = { DB: d1(new URL("../migrations/", import.meta.url)), PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", WAKE_PRESET: preset, WAKE_WEBHOOK_URL: url };
		const preview = await call(env, "GET", "/owner/wake/preview");
		assert.equal(preview.status, 400, preset);
		assert.match(preview.body.error, new RegExp(`^${preset} requires WAKE_(WEBHOOK_KEY|HMAC_SECRET)`));
		const tested = await call(env, "POST", "/owner/wake/test", {});
		assert.equal(tested.body.status, null, `${preset} test wake is not reported as delivered`);
		assert.match(tested.body.info, /^render failed: Error: .* requires WAKE_/);
		const unhooked = await call({ ...env, WAKE_WEBHOOK_URL: "" }, "GET", "/owner/wake/preview");
		assert.equal(unhooked.status, 200, "an unconfigured wake previews without a credential error");
	}
	assert.deepEqual(sent, [], "no webhook POST without the receiver's credential");
	const keyed = { DB: d1(new URL("../migrations/", import.meta.url)), PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", WAKE_PRESET: "claude-code", WAKE_WEBHOOK_URL: url, WAKE_WEBHOOK_KEY: "dummy-key" };
	assert.equal((await call(keyed, "GET", "/owner/wake/preview")).body.hasKey, true);
	assert.equal((await call(keyed, "POST", "/owner/wake/test", {})).body.status, 200);
	assert.equal(sent.length, 1);
});
