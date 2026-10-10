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

function pinned(answer: (request: string) => { status: number; location?: string }) {
	const calls: { ip: string; sni: string; request: string }[] = [];
	const connect: NonNullable<WakeDeps["connect"]> = (addr) => ({
		startTls: ({ expectedServerHostname: sni }) => {
			let req = "";
			let respond!: (bytes: Uint8Array) => void;
			const ready = new Promise<Uint8Array>((resolve) => { respond = resolve; });
			const writable = new WritableStream<Uint8Array>({
				write(chunk) {
					req += new TextDecoder().decode(chunk);
					if (!req.includes("\r\n\r\n")) return;
					calls.push({ ip: addr.hostname, sni, request: req });
					const made = answer(req);
					const headers = [`HTTP/1.1 ${made.status} X`, "content-length: 0"];
					if (made.location) headers.push(`location: ${made.location}`);
					headers.push("connection: close", "", "");
					respond(new TextEncoder().encode(headers.join("\r\n")));
				},
			});
			const readable = new ReadableStream<Uint8Array>({
				async start(controller) {
					controller.enqueue(await ready);
					controller.close();
				},
			});
			return { readable, writable, close: async () => {} };
		},
	});
	return { connect, calls };
}

test("a redirect to a private address is not connected, and the first hop uses the checked IP", async () => {
	const socket = pinned(() => ({ status: 302, location: "http://169.254.169.254/latest/meta-data" }));
	const result = await fetchCheckedWake("https://hook.example/wake", { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" }, { lookup: publicLookup, connect: socket.connect });
	assert.equal(socket.calls.length, 1);
	assert.equal(socket.calls[0].ip, "1.2.3.4");
	assert.equal(socket.calls[0].sni, "hook.example");
	assert.match(socket.calls[0].request, /^POST \/wake HTTP\/1\.1/);
	assert.match(socket.calls[0].request, /authorization: Bearer secret/i);
	assert.equal("refused" in result && result.refused, "must be https");
});

test("a cross-origin redirect is not followed, so credentials stay on the first host", async () => {
	const socket = pinned(() => ({ status: 307, location: "https://also.example/wake" }));
	const result = await fetchCheckedWake("https://hook.example/wake", { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" }, { lookup: publicLookup, connect: socket.connect });
	assert.equal(socket.calls.length, 1);
	assert.equal(socket.calls[0].ip, "1.2.3.4");
	assert.equal("refused" in result && result.refused, "cross-origin redirect");
});

test("a same-origin redirect is pinned again and keeps the wake headers", async () => {
	const socket = pinned((request) => request.startsWith("POST /wake ")
		? { status: 307, location: "https://hook.example/next" }
		: { status: 200 });
	const result = await fetchCheckedWake("https://hook.example/wake", { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" }, { lookup: publicLookup, connect: socket.connect });
	assert.equal(socket.calls.length, 2);
	assert.deepEqual(socket.calls.map((call) => call.ip), ["1.2.3.4", "1.2.3.4"]);
	assert.match(socket.calls[1].request, /^POST \/next HTTP\/1\.1/);
	assert.match(socket.calls[1].request, /authorization: Bearer secret/i);
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
	const socket = pinned(() => ({ status: 200 }));
	M.net.connect = socket.connect;
	try {
		const allowed = await wakeTest({
			DB: db(), PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", WAKE_PRESET: "generic",
			WAKE_WEBHOOK_URL: "https://hook.example/wake", WAKE_WEBHOOK_KEY: "hook-key", WAKE_TARGET_POLICY: "public-https",
		}, fetchImpl);
		assert.equal(allowed.status, 200);
		assert.equal(requested.every((url) => url.startsWith("https://cloudflare-dns.com/")), true);
		assert.equal(socket.calls.length, 1);
		assert.equal(socket.calls[0].ip, "1.2.3.4");
		assert.equal(socket.calls[0].sni, "hook.example");
		assert.match(socket.calls[0].request, /authorization: Bearer hook-key/i);
	} finally {
		M.net.connect = null;
	}
});
