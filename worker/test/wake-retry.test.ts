// A wake endpoint that answers 429 / 503 (e.g. a Claude Code routine over its fire limit): the wake is kept pending and
// re-sent after Retry-After, at most 3 times. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { d1 } from "./d1.ts";

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
