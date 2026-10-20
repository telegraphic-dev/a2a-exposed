import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { pushUrlAllowed } from "../src/a2a.ts";
import { fetchCheckedPush, dialChecked, wakeNet, type AddressLookup } from "../src/wake-target.ts";
import { d1 } from "./d1.ts";

const URL_CALLBACK = "https://callback.example/push";

test("push checks all resolved A/AAAA addresses and fails closed on DNS errors", async () => {
	for (const ips of [["10.0.0.1"], ["127.0.0.1"], ["169.254.169.254"], ["100.64.0.1"], ["::1"], ["fd00::1"], ["fe80::1"], ["::ffff:7f00:1"], ["1.2.3.4", "192.168.1.1"], ["1.2.3.4", "fd00::1"], [], null]) {
		let delivered = false;
		const result = await fetchCheckedPush(URL_CALLBACK, {}, { lookup: async () => ips, deliver: async () => { delivered = true; return new Response(); } });
		assert.ok("refused" in result, JSON.stringify(ips));
		assert.equal(delivered, false);
	}
	const result = await fetchCheckedPush(URL_CALLBACK, {}, { lookup: async () => { throw new Error("DNS down"); } });
	assert.ok("refused" in result);
});

test("push rejects URL credentials, private literals and internal names before lookup or delivery", async () => {
	for (const url of ["http://callback.example", "https://user:secret@callback.example", "https://127.0.0.1", "https://[::1]", "https://localhost", "https://metadata.google.internal", "https://agent.ts.net"]) {
		assert.equal(pushUrlAllowed(url)[0], false, url);
		assert.ok("refused" in await fetchCheckedPush(url, {}, { lookup: async () => { assert.fail("lookup"); }, deliver: async () => { assert.fail("delivery"); } }));
	}
});

test("push pins the first public answer even if DNS rebinds; does not fetch the hostname", async () => {
	let lookups = 0;
	const lookup: AddressLookup = async () => ++lookups === 1 ? ["1.2.3.4"] : ["10.0.0.1"];
	const result = await fetchCheckedPush(URL_CALLBACK, { method: "POST", body: "payload", headers: { authorization: "Bearer auth-secret", "x-a2a-notification-token": "push-secret" } }, {
		lookup,
		deliver: async (url, init, target) => {
			assert.equal(url, URL_CALLBACK);
			assert.deepEqual(target, { ip: "1.2.3.4", hostname: "callback.example" });
			// The production dial adapter ignores the TLS hostname and opens only the checked IP.
			dialChecked(target.ip, (addr) => {
				assert.deepEqual(addr, { hostname: "1.2.3.4", port: 443 });
				return { readable: new ReadableStream(), writable: new WritableStream() };
			})({ hostname: target.hostname, port: 443 });
			assert.equal(init.redirect, "manual");
			assert.equal(init.body, "payload");
			assert.equal(new Headers(init.headers).get("authorization"), "Bearer auth-secret");
			assert.equal(new Headers(init.headers).get("x-a2a-notification-token"), "push-secret");
			return new Response(null, { status: 204 });
		},
	});
	assert.equal(lookups, 1);
	assert.equal("response" in result && result.response.status, 204);
	// A subsequent notification must check fresh DNS, not reuse a previously allowed host.
	assert.ok("refused" in await fetchCheckedPush(URL_CALLBACK, {}, { lookup }));
});

test("public IPv4/IPv6 callbacks use checked targets; blocked sockets never fall back to fetch", async () => {
	for (const [url, ip] of [["https://1.2.3.4/push", "1.2.3.4"], ["https://[2606:4700:4700::1111]/push", "2606:4700:4700::1111"], [URL_CALLBACK, "2606:4700:4700::1111"]]) {
		const result = await fetchCheckedPush(url, {}, { lookup: async () => [ip], deliver: async (_url, _init, target) => {
			assert.equal(target.ip, ip);
			return new Response(null, { status: 200 });
		} });
		assert.equal("response" in result && result.response.status, 200);
	}
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => { assert.fail("unpinned fallback fetch"); }) as typeof fetch;
	let dialed = false;
	try {
		await assert.rejects(() => fetchCheckedPush(URL_CALLBACK, {}, {
			lookup: async () => ["1.2.3.4"],
			connect: (addr) => {
				dialed = true;
				assert.equal(addr.hostname, "1.2.3.4");
				throw new Error("socket blocked by runtime");
			},
		}));
		assert.equal(dialed, true);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("all push redirects fail closed, including relative, private and cross-origin locations", async () => {
	for (const status of [300, 301, 302, 303, 304, 307, 308, 399]) {
		for (const location of ["/next", "https://169.254.169.254/metadata", "https://elsewhere.example/push", ""]) {
			let deliveries = 0;
			const result = await fetchCheckedPush(URL_CALLBACK, {}, { lookup: async () => ["1.2.3.4"], deliver: async (_url, init) => {
				deliveries++;
				assert.equal(init.redirect, "manual");
				return new Response(null, { status, headers: location ? { location } : {} });
			} });
			assert.deepEqual(result, { refused: "redirects are not allowed" });
			assert.equal(deliveries, 1);
		}
	}
});

// Exercise the real owner -> notifyPeer -> sendPush wiring for stored configs (not just URL registration).
test("owner push path enforces DNS checks and redirects; valid 0.3/1.0 callbacks retain auth and errors hide secrets", async () => {
	const DB = d1(new URL("../migrations/", import.meta.url));
	const env = { DB, PUBLIC_URL: "https://agent.example", OWNER_TOKEN: "owner-secret" };
	const cfg = { id: "cfg", url: URL_CALLBACK, token: "push-secret", authentication: { scheme: "Bearer", credentials: "auth-secret" }, _version: "0.3" };
	const orig = globalThis.fetch;
	let ips = ["10.0.0.1"];
	let deliveries = 0;
	let status = 204;
	let fail = false;
	let version = "0.3";
	globalThis.fetch = (async (input) => {
		const url = new URL(String(input));
		assert.equal(url.hostname, "cloudflare-dns.com", "never platform-fetch the callback");
		return Response.json({ Status: 0, Answer: url.searchParams.get("type") === "A" ? ips.map((data) => ({ type: 1, data })) : [] });
	}) as typeof fetch;
	wakeNet.deliver = async (_url, init, target) => {
		deliveries++;
		assert.equal(target.ip, "1.2.3.4");
		assert.equal(target.hostname, "callback.example");
		assert.equal(init.method, "POST");
		assert.equal(init.redirect, "manual");
		const headers = new Headers(init.headers);
		assert.equal(headers.get("authorization"), "Bearer auth-secret");
		assert.equal(headers.get("x-a2a-notification-token"), "push-secret");
		const payload = JSON.parse(String(init.body));
		assert.equal(version === "1.0" ? payload.task.status.state : payload.status.state, version === "1.0" ? "TASK_STATE_WORKING" : "working");
		assert.equal(headers.get("content-type"), version === "1.0" ? "application/a2a+json" : "application/json");
		assert.equal(headers.get("a2a-version"), version === "1.0" ? "1.0" : null);
		if (fail) throw new Error("auth-secret push-secret private transport details");
		return new Response(null, { status, headers: status === 307 ? { location: "https://169.254.169.254/" } : {} });
	};
	async function notify() {
		cfg._version = version;
		await DB.prepare("INSERT OR REPLACE INTO tasks (id, context_id, peer, state, protocol, created_at, updated_at, status_json, push_configs_json) VALUES ('t1', 'c1', 'peer', 'submitted', ?, 'now', 'now', ?, ?)").bind(version, JSON.stringify({ state: "submitted" }), JSON.stringify([cfg])).run();
		const res = await worker.fetch(new Request("https://agent.example/owner/tasks/t1/working", { method: "POST", headers: { authorization: "Bearer owner-secret" } }), env as any, { waitUntil() {}, passThroughOnException() {} } as any);
		assert.equal(res.status, 200);
		return await res.json() as any;
	}
	try {
		let body = await notify();
		assert.equal(body.push[0].ok, false);
		assert.match(body.push[0].info, /private or reserved/);
		assert.equal(deliveries, 0);
		ips = ["1.2.3.4"];
		for (version of ["0.3", "1.0"]) {
			body = await notify();
			assert.deepEqual(body.push, [{ url: URL_CALLBACK, ok: true, info: "HTTP 204" }]);
			assert.equal(JSON.stringify(body).includes("auth-secret"), false);
			assert.equal(JSON.stringify(body).includes("push-secret"), false);
		}
		status = 307;
		body = await notify();
		assert.equal(body.push[0].ok, false);
		assert.match(body.push[0].info, /redirects are not allowed/);
		assert.equal(deliveries, 3);
		fail = true;
		body = await notify();
		assert.equal(body.push[0].info, "push delivery failed");
		const history = await DB.prepare("SELECT text FROM history WHERE event = 'push'").all();
		for (const secret of ["auth-secret", "push-secret", "private transport details"]) {
			assert.equal(JSON.stringify(body).includes(secret), false);
			assert.equal(JSON.stringify(history).includes(secret), false);
		}
	} finally {
		globalThis.fetch = orig;
		wakeNet.deliver = null;
	}
});
