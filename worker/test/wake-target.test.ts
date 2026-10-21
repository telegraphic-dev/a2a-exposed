// WAKE_TARGET_POLICY=public-https refuses private, metadata, and redirect-to-private wake targets.
// Unset keeps today's fetch. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { Duplex } from "node:stream";
import worker from "../src/index.ts";
import { d1 } from "./d1.ts";
import * as M from "../src/mcp.ts";
import { dialChecked, fetchCheckedPush, fetchCheckedWake, publicWakeProblem, wakeNet, type AddressLookup, type CheckedDeliver, type WakeConnect } from "../src/wake-target.ts";

const publicLookup: AddressLookup = async (host) => {
	if (host === "hook.example" || host === "also.example") return ["1.2.3.4"];
	if (host === "round.example") return ["1.2.3.4", "1.2.3.5"];
	if (host === "v6.example") return ["2606:4700:4700::1111"];
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

function recorded(answer: (call: { url: string }) => { status: number; location?: string }) {
	const calls: { url: string; ip: string; hostname: string; authorization: string; body: string; redirect: string }[] = [];
	const deliver: CheckedDeliver = async (url, init, target) => {
		const headers = new Headers(init.headers);
		const call = {
			url,
			ip: target.ip,
			hostname: target.hostname,
			authorization: headers.get("authorization") ?? "",
			body: typeof init.body === "string" ? init.body : init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : "",
			redirect: init.redirect ?? "",
		};
		calls.push(call);
		const made = answer(call);
		return new Response(null, { status: made.status, headers: made.location ? { location: made.location } : {} });
	};
	return { deliver, calls };
}

test("the dial uses the checked address and leaves TLS to name the host", () => {
	const seen: { hostname: string; secure?: string }[] = [];
	const base: WakeConnect = (addr, options) => {
		seen.push({ hostname: addr.hostname, secure: options?.secureTransport });
		return { readable: new ReadableStream(), writable: new WritableStream(), async close() {} };
	};
	dialChecked("1.2.3.4", base)({ hostname: "hook.example", port: 443 }, { secureTransport: "on" });
	assert.deepEqual(seen, [{ hostname: "1.2.3.4", secure: "off" }]);
});

/** Server names from a TLS ClientHello. Empty when the bytes are not one. */
function clientHelloNames(buf: Buffer): string[] {
	if (buf.length < 5 || buf[0] !== 0x16) return [];
	const recordLen = buf.readUInt16BE(3);
	if (buf.length < 5 + recordLen) return [];
	const hs = buf.subarray(5, 5 + recordLen);
	if (hs.length < 4 || hs[0] !== 1) return [];
	let i = 4 + 2 + 32;
	if (i >= hs.length) return [];
	const sidLen = hs[i]!;
	i += 1 + sidLen;
	if (i + 2 > hs.length) return [];
	const csLen = hs.readUInt16BE(i);
	i += 2 + csLen;
	if (i >= hs.length) return [];
	const compLen = hs[i]!;
	i += 1 + compLen;
	if (i + 2 > hs.length) return [];
	const extEnd = i + 2 + hs.readUInt16BE(i);
	i += 2;
	const names: string[] = [];
	while (i + 4 <= extEnd && i + 4 <= hs.length) {
		const type = hs.readUInt16BE(i);
		const len = hs.readUInt16BE(i + 2);
		i += 4;
		if (i + len > hs.length) break;
		if (type === 0 && len >= 2) {
			const list = hs.subarray(i, i + len);
			let j = 2;
			while (j + 3 <= list.length) {
				const nameType = list[j]!;
				const nlen = list.readUInt16BE(j + 1);
				j += 3;
				if (j + nlen > list.length) break;
				if (nameType === 0) names.push(list.subarray(j, j + nlen).toString());
				j += nlen;
			}
		}
		i += len;
	}
	return names;
}

for (const checkedFetch of [fetchCheckedWake, fetchCheckedPush]) test(`${checkedFetch.name} sends the hostname in the ClientHello on a socket to the checked address`, async () => {
	const chunks: Buffer[] = [];
	const server = net.createServer((socket) => {
		socket.on("data", (data) => {
			chunks.push(data);
			const hello = Buffer.concat(chunks);
			if (hello.length >= 5 && hello[0] === 0x16 && hello.length >= 5 + hello.readUInt16BE(3)) socket.destroy();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	const dialed: { hostname: string; secure?: string }[] = [];
	const connect: WakeConnect = (addr, options) => {
		dialed.push({ hostname: addr.hostname, secure: options?.secureTransport });
		const socket = net.connect({ host: "127.0.0.1", port: address.port });
		const web = Duplex.toWeb(socket);
		return {
			readable: web.readable,
			writable: web.writable,
			opened: new Promise((resolve, reject) => {
				socket.once("connect", () => resolve({ remoteAddress: "127.0.0.1" }));
				socket.once("error", reject);
			}),
			async close() { socket.destroy(); },
		};
	};
	try {
		await assert.rejects(
			() => checkedFetch("https://hook.example/wake", {
				method: "POST",
				headers: { authorization: "Bearer secret" },
				body: "{}",
			}, { lookup: publicLookup, connect }),
			(err: unknown) => err instanceof Error && err.message === "TLS Handshake Failed.",
		);
	} finally {
		server.close();
	}
	const wire = Buffer.concat(chunks);
	assert.deepEqual(dialed, [{ hostname: "1.2.3.4", secure: "off" }]);
	assert.deepEqual(clientHelloNames(wire), ["hook.example"]);
	assert.equal(wire.includes(Buffer.from("POST /wake")), false);
	assert.equal(wire.includes(Buffer.from("secret")), false);
});

test("a redirect to a private address is not requested, and the first hop is pinned to the checked address", async () => {
	const hop = recorded(() => ({ status: 302, location: "http://169.254.169.254/latest/meta-data" }));
	const result = await fetchCheckedWake("https://hook.example/wake", { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" }, { lookup: publicLookup, deliver: hop.deliver });
	assert.equal(hop.calls.length, 1);
	assert.equal(hop.calls[0].url, "https://hook.example/wake");
	assert.equal(hop.calls[0].ip, "1.2.3.4");
	assert.equal(hop.calls[0].hostname, "hook.example");
	assert.equal(hop.calls[0].redirect, "manual");
	assert.equal(hop.calls[0].authorization, "Bearer secret");
	assert.equal("refused" in result && result.refused, "must be https");
});

test("a cross-origin redirect is not followed, so credentials stay on the first host", async () => {
	const hop = recorded(() => ({ status: 307, location: "https://also.example/wake" }));
	const result = await fetchCheckedWake("https://hook.example/wake", { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" }, { lookup: publicLookup, deliver: hop.deliver });
	assert.equal(hop.calls.length, 1);
	assert.equal(hop.calls[0].ip, "1.2.3.4");
	assert.equal("refused" in result && result.refused, "cross-origin redirect");
});

test("a same-origin redirect is checked again and keeps the wake headers", async () => {
	const hop = recorded((call) => call.url.endsWith("/wake")
		? { status: 307, location: "https://hook.example/next" }
		: { status: 200 });
	const result = await fetchCheckedWake("https://hook.example/wake", { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" }, { lookup: publicLookup, deliver: hop.deliver });
	assert.deepEqual(hop.calls.map((call) => [call.url, call.ip]), [
		["https://hook.example/wake", "1.2.3.4"],
		["https://hook.example/next", "1.2.3.4"],
	]);
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
	const hop = recorded(() => ({ status: 200 }));
	// The runtime startTls pin sends no SNI. Delivery must dial the checked IP and name the host itself.
	M.net.connect = () => { throw new Error("wake delivery must not use startTls on the resolved IP"); };
	wakeNet.deliver = hop.deliver;
	try {
		const allowed = await wakeTest({
			DB: db(), PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", WAKE_PRESET: "generic",
			WAKE_WEBHOOK_URL: "https://hook.example/wake", WAKE_WEBHOOK_KEY: "hook-key", WAKE_TARGET_POLICY: "public-https",
		}, fetchImpl);
		assert.equal(allowed.status, 200);
		assert.equal(hop.calls.length, 1);
		assert.equal(hop.calls[0].ip, "1.2.3.4");
		assert.equal(hop.calls[0].hostname, "hook.example");
		assert.equal(hop.calls[0].authorization, "Bearer hook-key");
		assert.equal(requested.some((url) => new URL(url).hostname === "hook.example"), false);
		assert.equal(requested.some((url) => url.startsWith("https://cloudflare-dns.com/dns-query")), true);
	} finally {
		M.net.connect = null;
		wakeNet.deliver = null;
	}

	wakeNet.deliver = async () => { throw new Error("TLS Handshake Failed."); };
	const tls = await wakeTest({
		DB: db(), PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", WAKE_PRESET: "generic",
		WAKE_WEBHOOK_URL: "https://hook.example/wake", WAKE_WEBHOOK_KEY: "hook-key", WAKE_TARGET_POLICY: "public-https",
	}, fetchImpl);
	wakeNet.deliver = null;
	assert.equal(tls.status, null);
	assert.equal(tls.info, "Error: TLS Handshake Failed.");
});
