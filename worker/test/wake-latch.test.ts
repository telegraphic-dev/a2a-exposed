// A sent message wake stays busy. Later events wait for one catch-up. An inbox read does not end that window.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { nextCronAt } from "../src/index.ts";
import { d1 } from "./d1.ts";
import { resolveTenant } from "../src/tenancy.ts";

const BASE = "https://agent.example.com";
const realNow = Date.now;

function envFor(over: Record<string, string> = {}) {
	const env: Record<string, unknown> = {
		DB: d1(new URL("../migrations/", import.meta.url)), PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret",
		WAKE_PRESET: "generic", WAKE_WEBHOOK_URL: "https://hook.example.net/wake", WAKE_WEBHOOK_KEY: "k",
		WAKE_DEBOUNCE_SECONDS: "10", WAKE_BUSY_SECONDS: "120", ...over,
	};
	return env;
}

test("busy cool-down, debounce, preset defaults, and an explicit 0", async (t) => {
	let offset = 0;
	Date.now = () => realNow() + offset;
	const events: string[] = [];
	const origLog = console.log;
	console.log = (...args: unknown[]) => { events.push(String(args[0])); origLog(...args); };
	const sent: any[] = [];
	const origFetch = globalThis.fetch;
	globalThis.fetch = (async (_url: unknown, init: any) => {
		if (init?.body) sent.push(JSON.parse(String(init.body)));
		return new Response("ok", { status: 200 });
	}) as typeof fetch;
	t.after(() => { globalThis.fetch = origFetch; Date.now = realNow; console.log = origLog; });

	const call = async (env: any, method: string, path: string, json?: unknown, auth = "Bearer owner-secret") => {
		const pending: Promise<unknown>[] = [];
		const res = await worker.fetch(new Request(BASE + path, {
			method,
			headers: { "content-type": "application/json", authorization: auth },
			body: json === undefined ? undefined : JSON.stringify(json),
		}) as any, env, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as any);
		await Promise.allSettled(pending);
		const text = await res.text();
		let data: any = text;
		try { data = text ? JSON.parse(text) : null; } catch { /* plain */ }
		return data;
	};

	// Inbox read does not end the busy window. The next task is one catch-up, then a later task wakes.
	const busy = envFor();
	const token = (await call(busy, "POST", "/owner/peers", { label: "ada" })).token as string;
	const taskIdOf = (data: any) => data?.result?.id || data?.result?.task?.id;
	const msg = async (env: any, peer: string, contextId: string, text: string) => {
		const data = await call(env, "POST", "/", {
			jsonrpc: "2.0", id: 1, method: "message/send",
			params: { message: { kind: "message", role: "user", messageId: crypto.randomUUID(), contextId, parts: [{ kind: "text", text }] } },
		}, `Bearer ${peer}`);
		const id = taskIdOf(data);
		assert.equal(typeof id, "string", JSON.stringify(data));
		return id as string;
	};
	const bodies = (contextId: string) => sent.filter((b) => b.contextId === contextId && b.from === "ada");
	const row = () => busy.DB.db.prepare(
		"SELECT pending_json, busy_until_ms, last_sent_ms FROM wakes WHERE context_id = 'ctx-busy' AND peer = 'ada'",
	).get() as { pending_json: string | null; busy_until_ms: number | null; last_sent_ms: number };

	const first = await msg(busy, token, "ctx-busy", "one");
	assert.deepEqual(bodies("ctx-busy").map((b) => b.taskIds), [[first]]);
	const busyUntil = row().busy_until_ms as number;
	assert.ok(Math.abs(busyUntil - (row().last_sent_ms + 120_000)) < 1000, "busy starts at the send");
	const inbox = await call(busy, "GET", "/owner/inbox?context=ctx-busy&from=ada");
	assert.deepEqual(inbox.map((r: { taskId: string }) => r.taskId), [first]);
	assert.equal(row().pending_json, null);
	assert.equal(row().busy_until_ms, busyUntil, "the inbox read leaves the busy deadline in place");

	offset += 11_000;
	const second = await msg(busy, token, "ctx-busy", "two");
	assert.equal(bodies("ctx-busy").length, 1, "a task during the busy window does not send");
	const held = JSON.parse(row().pending_json!);
	assert.equal(held.busy, 1);
	assert.equal(held.taskId, second);
	assert.deepEqual(held.taskIds, [second]);
	assert.equal(row().busy_until_ms, busyUntil, "an absorbed event does not move the deadline");

	offset = (busyUntil as number) - realNow() - 1000;
	await call(busy, "GET", "/health");
	assert.equal(bodies("ctx-busy").length, 1, "the catch-up waits for the busy deadline");
	offset = (busyUntil as number) - realNow() + 1000;
	await call(busy, "GET", "/health");
	const after = bodies("ctx-busy");
	assert.equal(after.length, 2);
	assert.equal(after[1].taskId, second);
	assert.deepEqual(after[1].taskIds, [second]);
	assert.equal("busy" in after[1], false);
	assert.equal(row().pending_json, null);
	const nextBusy = row().busy_until_ms as number;
	assert.ok(nextBusy > (busyUntil as number), "the catch-up starts a new busy window");
	offset = nextBusy - realNow() + 1000;
	await call(busy, "GET", "/health");
	assert.equal(bodies("ctx-busy").length, 2, "an empty busy window does not send");
	const third = await msg(busy, token, "ctx-busy", "three");
	const done = bodies("ctx-busy");
	assert.equal(done.length, 3);
	assert.equal(done[2].taskId, third);
	assert.deepEqual(done[2].taskIds, [third]);

	// A burst inside the short debounce flushes then, not at the busy deadline.
	const burst = envFor({ WAKE_DEBOUNCE_SECONDS: "30", WAKE_BUSY_SECONDS: "300" });
	const burstToken = (await call(burst, "POST", "/owner/peers", { label: "ada" })).token as string;
	const before = sent.length;
	await msg(burst, burstToken, "ctx-burst", "one");
	await msg(burst, burstToken, "ctx-burst", "two");
	assert.equal(sent.length, before + 1);
	const burstPending = JSON.parse(burst.DB.db.prepare("SELECT pending_json FROM wakes WHERE context_id = 'ctx-burst'").get().pending_json);
	assert.equal(burstPending.busy, undefined);
	const due = await nextCronAt(resolveTenant(burst as never), Date.now());
	assert.ok(due != null && due <= Date.now() + 31_000 && due > Date.now() + 20_000, `debounce due ${due}`);
	offset += 31_000;
	await call(burst, "GET", "/health");
	assert.equal(sent.length, before + 2, "the burst flushes at the debounce");

	// Explicit 0 disables the cool-down. Unset uses the preset default, shown on wake preview.
	const off = envFor({ WAKE_PRESET: "claude-code", WAKE_BUSY_SECONDS: "0", WAKE_DEBOUNCE_SECONDS: "20" });
	const offPreview = await call(off, "GET", "/owner/wake/preview");
	assert.equal(offPreview.preset, "claude-code");
	assert.equal(offPreview.debounceSeconds, 20);
	assert.equal(offPreview.busySeconds, 0);
	const grok = envFor({ WAKE_PRESET: "grok-bot", WAKE_DEBOUNCE_SECONDS: "" });
	delete grok.WAKE_BUSY_SECONDS;
	const grokPreview = await call(grok, "GET", "/owner/wake/preview");
	assert.equal(grokPreview.debounceSeconds, 10);
	assert.equal(grokPreview.busySeconds, 180);
	const offToken = (await call(off, "POST", "/owner/peers", { label: "ada" })).token as string;
	const offBefore = sent.length;
	await msg(off, offToken, "ctx-off", "one");
	offset += 21_000;
	await msg(off, offToken, "ctx-off", "two");
	assert.equal(sent.length, offBefore + 2, "busy 0 sends again once the debounce has passed");
	const offRow = off.DB.db.prepare("SELECT busy_until_ms FROM wakes WHERE context_id = 'ctx-off'").get() as { busy_until_ms: number | null };
	assert.equal(offRow.busy_until_ms, null);

	const parsed = events.flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
	assert.equal(parsed.filter((e) => e.event === "wake_absorbed" && e.contextId === "ctx-busy").length, 1);
	assert.equal(parsed.some((e) => e.event === "wake_sent" && e.catchUp === true && e.contextId === "ctx-busy"), true);
	assert.equal(parsed.some((e) => e.event === "wake_absorbed" && e.preview !== undefined), false);
});

test("a busy pending wake is due at busy_until_ms, not the debounce", async () => {
	const now = 1_700_000_000_000;
	const DB = d1(new URL("../migrations/", import.meta.url));
	const tenant = resolveTenant({
		DB, PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", WAKE_PRESET: "generic",
		WAKE_DEBOUNCE_SECONDS: "10", WAKE_BUSY_SECONDS: "120", WAKE_MAX_PER_HOUR: "0",
	} as never);
	const until = now + 120_000;
	const pending = JSON.stringify({ contextId: "ctx-lat", from: "ada", taskId: "t-2", taskIds: ["t-2"], kind: "inbound", busy: 1 });
	await DB.prepare(
		"INSERT INTO wakes (context_id, peer, last_sent_ms, pending_json, pending_since_ms, busy_until_ms) VALUES ('ctx-lat', 'ada', ?, ?, ?, ?)",
	).bind(now - 60_000, pending, now - 60_000, until).run();
	await DB.prepare(
		"INSERT INTO wakes (context_id, peer, last_sent_ms, pending_json, pending_since_ms) VALUES ('ctx-soon', 'ada', ?, ?, ?)",
	).bind(now - 5_000, "{}", now).run();
	assert.equal(await nextCronAt(tenant, now), now - 5_000 + 10_000);
	await DB.prepare("DELETE FROM wakes WHERE context_id = 'ctx-soon'").run();
	assert.equal(await nextCronAt(tenant, now), until);
});
