// Pairing events: signature, retry, payload, and the hosted tenant path.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { dispatch } from "../src/index.ts";
import { hostedTenantContext, type WorkerBindings } from "../src/tenancy.ts";
import { postPairingEvent, type PairingEvent } from "../src/pairing-events.ts";
import { EVENT_REPLAY_WINDOW_S, verifyEventSignature } from "../../control/src/tenants/events.ts";
import { d1 } from "./d1.ts";

const BASE = "https://agent.example.com";
const EVENT_URL = "https://example.com/api/agent-events";
const SECRET = "event-secret";

function sample(over: Partial<PairingEvent> = {}): PairingEvent {
	return {
		type: "pairing_requested", agent: "agent.example.com", requestId: "abc", code: "WDJB-4827",
		name: "Barry Bot", alias: "barry", ip: "198.51.100.7", country: "DE",
		createdAt: "2026-10-16T14:00:00.000Z", expiresAt: "2026-10-16T15:00:00.000Z", pending: 1, ...over,
	};
}

test("verifyEventSignature accepts the posted bytes and rejects a replay, a tampered body, and a wrong secret", async () => {
	const now = Date.UTC(2026, 9, 16, 14, 0, 0);
	const seen: { body: string; headers: Headers }[] = [];
	await postPairingEvent({ url: EVENT_URL, secret: SECRET }, sample(), {
		now,
		fetchImpl: (async (url: string, init: RequestInit) => {
			seen.push({ body: String(init.body), headers: new Headers(init.headers) });
			assert.equal(url, EVENT_URL);
			assert.equal(init.redirect, "manual");
			return new Response("ok");
		}) as typeof fetch,
	});
	assert.equal(seen.length, 1);
	const { body, headers } = seen[0];
	const parsed = JSON.parse(body);
	assert.equal(parsed.type, "pairing_requested");
	assert.equal(parsed.pending, 1);
	assert.equal("decision" in parsed, false);
	assert.equal(await verifyEventSignature(body, headers, SECRET, now), true);
	assert.equal(await verifyEventSignature(body, headers, SECRET, now + EVENT_REPLAY_WINDOW_S * 1000), true);
	assert.equal(await verifyEventSignature(body, headers, SECRET, now + (EVENT_REPLAY_WINDOW_S + 1) * 1000), false);
	assert.equal(await verifyEventSignature(body + " ", headers, SECRET, now), false);
	assert.equal(await verifyEventSignature(body, headers, "other-secret", now), false);
	const shifted = new Headers(headers);
	shifted.set("x-a2a-timestamp", String(Math.floor(now / 1000) + 1));
	assert.equal(await verifyEventSignature(body, shifted, SECRET, now), false);

	const decided = sample({ type: "pairing_decided", decision: "approved", pending: 0 });
	let decidedBody = "";
	await postPairingEvent({ url: EVENT_URL, secret: SECRET }, decided, {
		now,
		fetchImpl: (async (_url: string, init: RequestInit) => {
			decidedBody = String(init.body);
			return new Response("ok");
		}) as typeof fetch,
	});
	assert.equal(JSON.parse(decidedBody).decision, "approved");
});

test("a timeout is retried once and a failed post stays inside the function", async () => {
	let calls = 0;
	await postPairingEvent({ url: EVENT_URL, secret: SECRET }, sample(), {
		timeoutMs: 30,
		fetchImpl: (async (_url: string, init: RequestInit) => {
			calls++;
			if (calls === 1) {
				await new Promise((_resolve, reject) => {
					const timer = setTimeout(() => reject(new Error("the attempt was not aborted")), 1000);
					init.signal?.addEventListener("abort", () => {
						clearTimeout(timer);
						reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
					});
				});
			}
			return new Response("ok");
		}) as typeof fetch,
	});
	assert.equal(calls, 2);

	let failed = 0;
	await postPairingEvent({ url: EVENT_URL, secret: SECRET }, sample(), {
		timeoutMs: 30,
		fetchImpl: (async () => {
			failed++;
			return new Response("no", { status: 503 });
		}) as typeof fetch,
	});
	assert.equal(failed, 2);

	await assert.doesNotReject(postPairingEvent({ url: EVENT_URL, secret: SECRET }, sample(), {
		timeoutMs: 30,
		fetchImpl: (async () => { throw new Error("network down"); }) as typeof fetch,
	}));
});

function env(over: Record<string, string> = {}) {
	const DB = d1(new URL("../migrations/", import.meta.url));
	return { DB, PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", AGENT_NAME: "Test Inbox", ...over };
}

async function start(bindings: Record<string, string>, fetchImpl: typeof fetch) {
	const pending: Promise<unknown>[] = [];
	const previous = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	const req = new Request(BASE + "/oauth/device_authorization", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.7" },
		body: new URLSearchParams({ client_name: "Barry Bot", client_id: "barry", agent_card_url: "https://barry.example.org/card" }).toString(),
	});
	(req as { cf?: unknown }).cf = { country: "DE" };
	const response = worker.fetch(req, env(bindings) as WorkerBindings, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as ExecutionContext);
	return {
		response, pending, restore: () => { globalThis.fetch = previous; },
	};
}

test("the response returns before the event post, and the payload carries the open count", async (t) => {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let body = "";
	let headers = new Headers();
	let started = false;
	const run = await start({ EVENT_URL, EVENT_SECRET: SECRET }, (async (url: string, init: RequestInit) => {
		if (String(url) !== EVENT_URL) return new Response("ok");
		started = true;
		body = String(init?.body);
		headers = new Headers(init?.headers);
		await gate;
		return new Response("ok");
	}) as typeof fetch);
	t.after(() => { release(); run.restore(); });
	const res = await Promise.race([
		run.response,
		new Promise<Response>((_resolve, reject) => setTimeout(() => reject(new Error("the pairing response waited for the event post")), 500)),
	]);
	assert.equal(res.status, 200);
	const data = await res.json() as { user_code: string };
	const deadline = Date.now() + 500;
	while (!started && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(started, true);
	release();
	await Promise.all(run.pending);
	const event = JSON.parse(body);
	assert.equal(event.type, "pairing_requested");
	assert.equal(event.agent, "agent.example.com");
	assert.equal(event.code, data.user_code);
	assert.equal(event.name, "Barry Bot");
	assert.equal(event.alias, "barry");
	assert.equal(event.ip, "198.51.100.7");
	assert.equal(event.country, "DE");
	assert.equal(event.pending, 1);
	assert.match(event.requestId, /^[0-9a-f]{64}$/);
	assert.equal(await verifyEventSignature(body, headers, SECRET), true);

	const quiet: string[] = [];
	const off = await start({}, (async (url: string) => {
		quiet.push(String(url));
		return new Response("ok");
	}) as typeof fetch);
	assert.equal((await off.response).status, 200);
	await Promise.all(off.pending);
	off.restore();
	assert.equal(quiet.some((url) => url === EVENT_URL), false);
});

test("a hosted tenant posts with the control plane's EVENT_URL and EVENT_SECRET", async () => {
	const DB = d1(new URL("../migrations/", import.meta.url));
	const ctx = hostedTenantContext({ DB, TENANCY: "host", EVENT_URL: "https://platform.example/other", EVENT_SECRET: "platform" } as WorkerBindings, {
		id: "ten_north", db: DB, publicUrl: "https://northwind.example.com",
		config: { EVENT_URL, EVENT_SECRET: SECRET },
	});
	assert.equal(ctx.mode, "host");
	assert.equal(ctx.EVENT_URL, EVENT_URL);
	assert.equal(ctx.EVENT_SECRET, SECRET);
	const posts: { body: string; headers: Headers }[] = [];
	const previous = globalThis.fetch;
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		if (String(url) === EVENT_URL) posts.push({ body: String(init.body), headers: new Headers(init.headers) });
		return new Response("ok");
	}) as typeof fetch;
	const pending: Promise<unknown>[] = [];
	const req = new Request("https://northwind.example.com/oauth/device_authorization", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.9" },
		body: new URLSearchParams({ client_name: "Claude", client_id: "claude" }).toString(),
	});
	(req as { cf?: unknown }).cf = { country: "US" };
	const res = await dispatch(req, ctx, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as ExecutionContext);
	await Promise.all(pending);
	globalThis.fetch = previous;
	assert.equal(res.status, 200);
	assert.equal(posts.length, 1);
	const event = JSON.parse(posts[0].body);
	assert.equal(event.agent, "northwind.example.com");
	assert.equal(event.name, "Claude");
	assert.equal(event.alias, "claude");
	assert.equal(event.country, "US");
	assert.equal(event.pending, 1);
	assert.equal(await verifyEventSignature(posts[0].body, posts[0].headers, SECRET), true);

	const plain = hostedTenantContext({ DB, TENANCY: "host", EVENT_URL, EVENT_SECRET: SECRET } as WorkerBindings, {
		id: "ten_plain", db: DB, publicUrl: "https://plain.example.com",
	});
	assert.equal(plain.EVENT_URL, undefined);
	assert.equal(plain.EVENT_SECRET, undefined);
});

test("approve posts pairing_decided with the remaining open count", async () => {
	const bindings = env({ EVENT_URL, EVENT_SECRET: SECRET });
	const posts: { body: string }[] = [];
	const previous = globalThis.fetch;
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		if (String(url) === EVENT_URL) posts.push({ body: String(init.body) });
		return new Response("ok");
	}) as typeof fetch;
	const pending: Promise<unknown>[] = [];
	const ectx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as ExecutionContext;
	const call = async (method: string, path: string, body?: string, headers: Record<string, string> = {}) => {
		const res = await worker.fetch(new Request(BASE + path, { method, headers, body }), bindings as WorkerBindings, ectx);
		await Promise.all(pending.splice(0));
		return res;
	};
	const started = await call("POST", "/oauth/device_authorization", new URLSearchParams({ client_name: "Barry Bot", client_id: "barry" }).toString(), {
		"content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.7",
	});
	const first = await started.json() as { user_code: string };
	const secondRes = await call("POST", "/oauth/device_authorization", new URLSearchParams({ client_name: "Other", client_id: "other" }).toString(), {
		"content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.8",
	});
	assert.equal(secondRes.status, 200);
	const denied = await call("POST", `/owner/pairing/${first.user_code}/deny`, "{}", { authorization: "Bearer owner-secret", "content-type": "application/json" });
	globalThis.fetch = previous;
	assert.equal(denied.status, 200);
	const decided = posts.map((post) => JSON.parse(post.body)).filter((event) => event.type === "pairing_decided");
	assert.equal(decided.length, 1);
	assert.equal(decided[0].decision, "denied");
	assert.equal(decided[0].code, first.user_code);
	assert.equal(decided[0].pending, 1);
	assert.equal(decided[0].name, "Barry Bot");
});
