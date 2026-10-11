// WAKE_TARGET_POLICY=public-https refuses private, metadata, and redirect-to-private wake targets.
// Unset keeps today's fetch. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { d1 } from "./d1.ts";
import * as M from "../src/mcp.ts";
import { fetchCheckedWake, publicWakeProblem, type AddressLookup, type WakeDeps } from "../src/wake-target.ts";

const publicLookup: AddressLookup = async (host) => {
	if (host === "hook.example" || host === "also.example") return ["1.2.3.4"];
	if (host === "split.example") return ["1.2.3.4", "10.0.0.1"];
	if (host === "meta.example") return ["169.254.169.254"];
	if (host === "missing.example") return [];
	return null;
};

test("public-https refuses private, metadata, and non-https URLs before any request", async () => {
	const refused = [
		"http://hook.example/wake",
		"https://user:secret@hook.example/wake",
		"https://127.0.0.1/wake",
		"https://10.1.2.3/wake",
		"https://192.168.1.1/wake",
		"https://172.16.0.1/wake",
		"https://100.64.0.1/wake",
		"https://100.100.100.200/wake",
		"https://169.254.169.254/latest/meta-data",
		"https://[::1]/wake",
		"https://[fe80::1]/wake",
		"https://localhost/wake",
		"https://metadata.google.internal/wake",
		"https://agent.ts.net/wake",
		"https://metadata/wake",
		"not a url",
	];
	for (const url of refused) {
		const why = await publicWakeProblem(url, publicLookup);
		assert.notEqual(why, "", url);
	}
	assert.equal(await publicWakeProblem("https://hook.example/wake", publicLookup), "");
	assert.equal(await publicWakeProblem("https://1.2.3.4/wake", publicLookup), "");
	assert.equal(await publicWakeProblem("https://split.example/wake", publicLookup), "resolves to a private or reserved address");
	assert.equal(await publicWakeProblem("https://meta.example/wake", publicLookup), "resolves to a private or reserved address");
	assert.equal(await publicWakeProblem("https://missing.example/wake", publicLookup), "the host has no address");
	assert.equal(await publicWakeProblem("https://unknown.example/wake", publicLookup), "its address could not be checked");
});

function recorded(answer: (call: { url: string; method: string }) => { status: number; location?: string }) {
	const calls: { url: string; method: string; authorization: string; redirect: string; body: string }[] = [];
	const fetch: NonNullable<WakeDeps["fetch"]> = async (url, init) => {
		const headers = new Headers(init.headers);
		const call = {
			url,
			method: String(init.method || "GET"),
			authorization: headers.get("authorization") ?? "",
			redirect: init.redirect ?? "",
			body: typeof init.body === "string" ? init.body : init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : "",
		};
		calls.push(call);
		const made = answer(call);
		return new Response(null, { status: made.status, headers: made.location ? { location: made.location } : {} });
	};
	return { fetch, calls };
}

test("a redirect to a private address is not requested, and the first hop uses the hostname", async () => {
	const hop = recorded(() => ({ status: 302, location: "http://169.254.169.254/latest/meta-data" }));
	const result = await fetchCheckedWake("https://hook.example/wake", { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" }, { lookup: publicLookup, fetch: hop.fetch });
	assert.deepEqual(hop.calls.map((call) => call.url), ["https://hook.example/wake"]);
	assert.equal(hop.calls[0].redirect, "manual");
	assert.equal(hop.calls[0].authorization, "Bearer secret");
	assert.equal(hop.calls.some((call) => call.url.includes("169.254.169.254") || call.url.includes("1.2.3.4")), false);
	assert.equal("refused" in result && result.refused, "must be https");
});

test("a cross-origin redirect is not followed, so credentials stay on the first host", async () => {
	const hop = recorded(() => ({ status: 307, location: "https://also.example/wake" }));
	const result = await fetchCheckedWake("https://hook.example/wake", { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" }, { lookup: publicLookup, fetch: hop.fetch });
	assert.deepEqual(hop.calls.map((call) => call.url), ["https://hook.example/wake"]);
	assert.equal("refused" in result && result.refused, "cross-origin redirect");
});

test("a same-origin redirect is checked again and keeps the wake headers", async () => {
	const hop = recorded((call) => call.url.endsWith("/wake")
		? { status: 307, location: "https://hook.example/next" }
		: { status: 200 });
	const result = await fetchCheckedWake("https://hook.example/wake", { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" }, { lookup: publicLookup, fetch: hop.fetch });
	assert.deepEqual(hop.calls.map((call) => call.url), ["https://hook.example/wake", "https://hook.example/next"]);
	assert.equal(hop.calls[1].method, "POST");
	assert.equal(hop.calls[1].authorization, "Bearer secret");
	assert.equal(hop.calls[1].body, "{}");
	assert.equal("response" in result && result.response.status, 200);
});

const BASE = "https://agent.example.com";

async function wakeTest(env: Record<string, unknown>, fetchImpl: typeof fetch) {
	const orig = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	try {
		const res = await worker.fetch(new Request(BASE + "/owner/wake/test", {
			method: "POST",
			headers: { authorization: "Bearer owner-secret" },
		}), env as any, { waitUntil() {}, passThroughOnException() {} } as any);
		return res.json() as Promise<{ status: number | null; info: string }>;
	} finally {
		globalThis.fetch = orig;
	}
}

test("the policy is off unless WAKE_TARGET_POLICY is exactly public-https", async () => {
	const env = {
		DB: d1(new URL("../migrations/", import.meta.url)),
		PUBLIC_URL: BASE,
		OWNER_TOKEN: "owner-secret",
		WAKE_PRESET: "generic",
		WAKE_WEBHOOK_URL: "http://127.0.0.1/hook",
	};
	const requested: string[] = [];
	const body = await wakeTest(env, (async (url: string) => {
		requested.push(String(url));
		return new Response("ok", { status: 200 });
	}) as typeof fetch);
	assert.equal(body.status, 200);
	assert.equal(requested.length, 1);
	assert.match(requested[0], /^http:\/\/127\.0\.0\.1\/hook/);
});

test("public-https does not request a metadata address, and does post to a checked public host", async () => {
	const db = () => d1(new URL("../migrations/", import.meta.url));
	const requested: string[] = [];
	const fetchImpl = (async (url: string | URL) => {
		const href = String(url);
		requested.push(href);
		if (href.startsWith("https://cloudflare-dns.com/dns-query")) {
			const name = new URL(href).searchParams.get("name");
			const type = new URL(href).searchParams.get("type");
			if (name === "hook.example" && type === "A") {
				return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "1.2.3.4" }] }), { status: 200 });
			}
			return new Response(JSON.stringify({ Status: 0, Answer: [] }), { status: 200 });
		}
		return new Response("ok", { status: 200 });
	}) as typeof fetch;

	const blocked = await wakeTest({
		DB: db(), PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", WAKE_PRESET: "generic",
		WAKE_WEBHOOK_URL: "https://169.254.169.254/latest/meta-data", WAKE_TARGET_POLICY: "public-https",
	}, fetchImpl);
	assert.equal(blocked.status, null);
	assert.match(blocked.info, /refused: private or internal host/);
	assert.equal(requested.some((url) => url.includes("169.254.169.254")), false);

	requested.length = 0;
	const posted: { url: string; authorization: string; redirect: string }[] = [];
	const postImpl = (async (url: string | URL, init?: RequestInit) => {
		const href = String(url);
		requested.push(href);
		if (href.startsWith("https://cloudflare-dns.com/dns-query")) return fetchImpl(url, init);
		const headers = new Headers(init?.headers);
		posted.push({ url: href, authorization: headers.get("authorization") ?? "", redirect: init?.redirect ?? "" });
		return new Response("ok", { status: 200 });
	}) as typeof fetch;
	// A socket to the resolved IP is what fails TLS on the edge (no SNI). Delivery must not open one.
	M.net.connect = () => { throw new Error("wake delivery must not pin TLS to the resolved IP"); };
	try {
		const allowed = await wakeTest({
			DB: db(), PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", WAKE_PRESET: "generic",
			WAKE_WEBHOOK_URL: "https://hook.example/wake", WAKE_WEBHOOK_KEY: "hook-key", WAKE_TARGET_POLICY: "public-https",
		}, postImpl);
		assert.equal(allowed.status, 200);
		assert.deepEqual(posted, [{ url: "https://hook.example/wake", authorization: "Bearer hook-key", redirect: "manual" }]);
		assert.equal(requested.some((url) => url.includes("1.2.3.4")), false);
		assert.equal(requested.some((url) => url.startsWith("https://cloudflare-dns.com/dns-query")), true);
	} finally {
		M.net.connect = null;
	}

	const tls = await wakeTest({
		DB: db(), PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", WAKE_PRESET: "generic",
		WAKE_WEBHOOK_URL: "https://hook.example/wake", WAKE_WEBHOOK_KEY: "hook-key", WAKE_TARGET_POLICY: "public-https",
	}, (async (url: string | URL) => {
		const href = String(url);
		if (href.startsWith("https://cloudflare-dns.com/dns-query")) return fetchImpl(url);
		throw new Error("TLS Handshake Failed.");
	}) as typeof fetch);
	assert.equal(tls.status, null);
	assert.equal(tls.info, "Error: TLS Handshake Failed.");
});
