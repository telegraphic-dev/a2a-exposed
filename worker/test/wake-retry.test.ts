// A wake endpoint that answers 429 / 503 (e.g. a Claude Code routine over its fire limit): the wake is kept pending and
// re-sent after Retry-After, at most 3 times. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { nextCronAt } from "../src/index.ts";
import { d1 } from "./d1.ts";
import { resolveTenant } from "../src/tenancy.ts";

const BASE = "https://agent.example.com";
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;

test("429 with Retry-After: the wake is re-sent after the wait, merged with newer tasks, and dropped after 3 retries", async (t) => {
	const env: any = { DB: d1(new URL("../migrations/", import.meta.url)), PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", WAKE_PRESET: "claude-code",
		WAKE_WEBHOOK_URL: "https://api.anthropic.com/v1/claude_code/routines/trig_x/fire", WAKE_WEBHOOK_KEY: "rt", WAKE_DEBOUNCE_SECONDS: "20" };
	const sent: any[] = [];
	let answer = 429;
	const orig = globalThis.fetch;
	globalThis.fetch = (async (_u: any, init: any) => { sent.push(JSON.parse(init.body)); return new Response("{}", { status: answer, headers: { "retry-after": "120" } }); }) as any;
	t.after(() => { globalThis.fetch = orig; Date.now = realNow; });
	const call = async (method: string, path: string, json?: any, auth = "Bearer owner-secret") => {
		const pending: Promise<unknown>[] = [];
		const res = await worker.fetch(new Request(BASE + path, { method, headers: { "content-type": "application/json", authorization: auth }, body: json ? JSON.stringify(json) : undefined }) as any,
			env, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as any);
		// settle the request's background work (the 20 s debounce timer is never needed here)
		await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, 200))]);
		return res.json().catch(() => null);
	};
	const tok = (await call("POST", "/owner/peers", { label: "barry" })).token;
	const msg = (text: string) => call("POST", "/", { jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { kind: "message", role: "user", messageId: crypto.randomUUID(), contextId: "ctx-r", parts: [{ kind: "text", text }] } } }, `Bearer ${tok}`);
	await msg("one");
	assert.equal(sent.length, 1);
	const row = () => env.DB.db.prepare("SELECT * FROM wakes WHERE context_id = 'ctx-r'").get() as any;
	assert.ok(row().pending_json, "kept pending after the 429");
	offset += 60_000;
	await call("GET", "/health");
	assert.equal(sent.length, 1, "not before Retry-After");
	offset += 61_000;
	await call("GET", "/health");
	assert.equal(sent.length, 2, "re-sent after Retry-After");
	assert.equal(JSON.parse(row().pending_json).attempts, 2);
	for (let i = 0; i < 3; i++) { offset += 121_000; await call("GET", "/health"); }
	assert.equal(sent.length, 4, "3 retries, then dropped");
	assert.equal(row().pending_json, null);
	// a success clears it for good
	answer = 200;
	offset += 3_600_000;
	await msg("two");
	assert.equal(sent.length, 5);
	assert.equal(row().pending_json, null);
});

test("a 429 is due at Retry-After when the debounce is longer", async (t) => {
	const env: any = { DB: d1(new URL("../migrations/", import.meta.url)), PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", WAKE_PRESET: "generic",
		WAKE_WEBHOOK_URL: "https://example.com/hook", WAKE_WEBHOOK_KEY: "k", WAKE_DEBOUNCE_SECONDS: "120" };
	const sent: any[] = [];
	const orig = globalThis.fetch;
	globalThis.fetch = (async () => { sent.push(1); return new Response("{}", { status: 429, headers: { "retry-after": "30" } }); }) as any;
	t.after(() => { globalThis.fetch = orig; });
	const pending: Promise<unknown>[] = [];
	const ectx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
	const call = async (method: string, path: string, json?: any, auth = "Bearer owner-secret") => {
		const res = await worker.fetch(new Request(BASE + path, { method, headers: { "content-type": "application/json", authorization: auth }, body: json ? JSON.stringify(json) : undefined }) as any, env, ectx as any);
		await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, 200))]);
		return res.json().catch(() => null);
	};
	const tok = (await call("POST", "/owner/peers", { label: "barry" })).token;
	const before = Date.now();
	await call("POST", "/", { jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { kind: "message", role: "user", messageId: "m1", contextId: "ctx-long", parts: [{ kind: "text", text: "one" }] } } }, `Bearer ${tok}`);
	assert.equal(sent.length, 1);
	const at = await nextCronAt(resolveTenant(env), Date.now());
	assert.ok(at != null && at >= before + 25_000 && at <= before + 35_000, `alarm ${at} is Retry-After, not the 120s debounce`);
});

test("OpenBot preview masks signing credentials and wake test accepts HTTP 202", async (t) => {
	const env: any = { DB: d1(new URL("../migrations/", import.meta.url)), PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret",
		WAKE_PRESET: "openbot", WAKE_WEBHOOK_URL: "https://hooks.example.com/a2a", WAKE_HMAC_SECRET: "dummy-openbot-secret" };
	const pending: Promise<unknown>[] = [];
	const call = (method: string, path: string) => worker.fetch(new Request(BASE + path, { method, headers: { authorization: "Bearer owner-secret" } }) as any,
		env, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as any);
	const preview = await (await call("GET", "/owner/wake/preview")).json() as any;
	assert.equal(preview.preset, "openbot");
	assert.equal(preview.signingInput, "<timestamp>.<delivery-id>.<exact-body-bytes>");
	assert.equal(preview.request.headers["x-openbot-delivery-id"], "preview");
	assert.equal(preview.request.headers["x-openbot-signature"], "••••");
	assert.ok(!JSON.stringify(preview).includes(env.WAKE_HMAC_SECRET));
	const original = globalThis.fetch;
	let sent = false;
	globalThis.fetch = (async (_url: any, init: any) => {
		sent = true;
		assert.equal(JSON.parse(init.body).type, "a2a_wake");
		assert.match(init.headers["x-openbot-signature"], /^sha256=[0-9a-f]{64}$/);
		assert.ok(init.headers["x-openbot-delivery-id"]);
		return new Response("{}", { status: 202 });
	}) as any;
	t.after(() => { globalThis.fetch = original; });
	const result = await (await call("POST", "/owner/wake/test")).json() as any;
	assert.equal(result.status, 202);
	assert.equal(sent, true);
	await Promise.allSettled(pending);
});
