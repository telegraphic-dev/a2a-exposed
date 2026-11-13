import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { d1 } from "./d1.ts";
import { attemptView, pendingView } from "../src/wake-status.ts";

const BASE = "https://agent.example.com";
function fixture(t: any) {
	const env: any = { DB: d1(new URL("../migrations/", import.meta.url)), PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", WAKE_PRESET: "generic", WAKE_WEBHOOK_URL: "https://hook.example.net/wake", WAKE_WEBHOOK_KEY: "secret-key", WAKE_DEBOUNCE_SECONDS: "10" };
	let posts = 0, answer = 202;
	const original = globalThis.fetch;
	globalThis.fetch = (async () => { posts++; return new Response(null, { status: answer }); }) as typeof fetch;
	t.after(() => { globalThis.fetch = original; });
	const call = async (method: string, path: string, body?: unknown, auth = "Bearer owner-secret") => {
		const pending: Promise<unknown>[] = [];
		const response = await worker.fetch(new Request(BASE + path, { method, headers: { authorization: auth, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) as any,
			env, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as any);
		await Promise.allSettled(pending);
		return { status: response.status, data: method === "HEAD" ? null : await response.json() as any };
	};
	return { env, call, get posts() { return posts; }, fail() { answer = 503; } };
}

test("wake status reads a bounded queue without flushing overdue wakes, leaking content, or claiming handler success", async t => {
	const f = fixture(t);
	const now = Date.now();
	for (let i = 0; i < 52; i++) {
		await f.env.DB.prepare("INSERT INTO wakes (context_id, peer, last_sent_ms, pending_json, pending_since_ms, busy_until_ms) VALUES (?, ?, ?, ?, ?, ?)")
			.bind(`ctx-${i}`, "ada", now - 20000, JSON.stringify({ from: "ada", preview: "PRIVATE-CONTENT", taskIds: ["secret-task"], ...(i === 0 ? { attempts: 2 } : i === 1 ? { busy: 1 } : {}) }), now - 30000, i === 1 ? now + 50000 : null).run();
	}
	const before = await f.env.DB.prepare("SELECT * FROM wakes ORDER BY context_id").all();
	assert.equal((await f.call("GET", "/owner/wake/status", undefined, "Bearer wrong")).status, 401);
	const result = await f.call("GET", "/owner/wake/status");
	assert.equal(result.status, 200);
	assert.equal(result.data.pendingCount, 52);
	assert.equal(result.data.pending.length, 50);
	assert.equal(result.data.pending.find((x: any) => x.contextId === "ctx-0").reason, "retry");
	assert.equal(result.data.lastAttempt, null);
	assert.equal(result.data.lastAccepted, null);
	assert.match(result.data.next, /handler execution and owner notification are unverified/);
	assert.doesNotMatch(JSON.stringify(result.data), /PRIVATE-CONTENT|secret-task|secret-key/);
	assert.equal((await f.call("HEAD", "/owner/wake/status")).status, 200);
	assert.equal(f.posts, 0);
	assert.deepEqual(await f.env.DB.prepare("SELECT * FROM wakes ORDER BY context_id").all(), before);
});

test("HTTP acceptance and later failure stay distinct and preserve only safe observations", async t => {
	const f = fixture(t);
	assert.equal((await f.call("POST", "/owner/wake/test", {})).status, 200);
	const first = (await f.call("GET", "/owner/wake/status")).data;
	assert.equal(first.lastAttempt.httpStatus, 202);
	assert.equal(first.lastAccepted.httpStatus, 202);
	f.fail();
	await f.call("POST", "/owner/wake/test", {});
	const second = (await f.call("GET", "/owner/wake/status")).data;
	assert.equal(second.lastAttempt.httpStatus, 503);
	assert.deepEqual(second.lastAccepted, first.lastAccepted);
	assert.doesNotMatch(JSON.stringify(second), /secret-key|hook.example.net|signatureVerified|ownerNotified/);
	assert.equal(f.posts, 2);
});

test("diagnostic views discard malformed or unexpected fields", () => {
	assert.equal(attemptView('{"at":"invalid","httpStatus":202,"transport":"webhook"}'), null);
	assert.equal(attemptView('{"at":"2026-11-13T00:00:00Z","httpStatus":999,"transport":"webhook"}'), null);
	assert.deepEqual(attemptView('{"at":"2026-11-13T00:00:00Z","httpStatus":202,"transport":"webhook","secret":"hidden"}'), { at: "2026-11-13T00:00:00Z", httpStatus: 202, transport: "webhook" });
	assert.equal(pendingView({ context_id: "ctx", peer: "ada", due_ms: 0, pending_since_ms: 0, pending_json: '{"busy":1}' }).reason, "busy");
	assert.equal(pendingView({ pending_json: "malformed" }).reason, "debounce");
});
