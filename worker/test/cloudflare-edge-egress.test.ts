// EGRESS_CLOUDFLARE_EDGE=1: the pinned socket always goes first. Only when the Workers socket policy refuses a
// checked Cloudflare address for a named host, and a fresh lookup is again all Cloudflare, is the request retried
// once with the platform fetch. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import * as M from "../src/mcp.ts";
import { parseGates } from "../src/tenancy.ts";
import { edgeRetryAllowed, fetchCheckedPeer, fetchCheckedWake, getPinnedMetadata, lookupAddresses, type AddressLookup, type EdgeFetch, type SocketAttempt, type WakeConnect } from "../src/wake-target.ts";

const REFUSAL = "proxy request failed, cannot connect to the specified address";

function dns(answers: Record<string, string[]>) {
	const asked: string[] = [];
	const lookup: AddressLookup = async (host) => { asked.push(host); return answers[host] ?? null; };
	return { lookup, asked };
}

const cfAnswers = () => ({ "worker.example": ["104.21.0.10", "2606:4700:3030::1"], "plain.example": ["1.2.3.4"] });

/** Every dial is refused the way Workers refuses a Cloudflare address: synchronously, or through `opened`. */
function refusingConnect(mode: "throw" | "opened" = "throw", message = REFUSAL) {
	const dials: string[] = [];
	const connect: WakeConnect = (address) => {
		dials.push(address.hostname);
		if (mode === "throw") throw new Error(message);
		const failure = new Error(message);
		const opened = Promise.reject(failure);
		opened.catch(() => {});
		return {
			opened,
			readable: new ReadableStream({ start(c) { c.error(new Error("Network connection lost.")); } }),
			writable: new WritableStream({ write() { throw new Error("Network connection lost."); } }),
			close: async () => {},
		};
	};
	return { connect, dials };
}

function edgeRecorder(answer: (url: string) => Response) {
	const calls: { url: string; redirect: string; authorization: string; signal: boolean }[] = [];
	const edge: EdgeFetch = async (url, init) => {
		calls.push({ url, redirect: init.redirect ?? "", authorization: new Headers(init.headers).get("authorization") ?? "", signal: !!init.signal });
		return answer(url);
	};
	return { edge, calls };
}

test("Cloudflare ranges: published IPv4 and IPv6 blocks only", () => {
	for (const ip of ["104.16.0.1", "104.23.255.255", "172.64.0.1", "162.159.1.1", "198.41.200.1", "2606:4700::6810:1", "2a06:98c7::1"]) assert.ok(M.isCloudflareIp(ip), ip);
	for (const ip of ["1.2.3.4", "104.32.0.1", "172.72.0.1", "10.0.0.1", "127.0.0.1", "2001:db8::1", "2a06:98c8::1", "fe80::1", "not-an-ip"]) assert.ok(!M.isCloudflareIp(ip), ip);
});

test("the gate is exactly EGRESS_CLOUDFLARE_EDGE=1", () => {
	assert.equal(parseGates({ EGRESS_CLOUDFLARE_EDGE: "1" } as any).gates.cloudflareEdgeEgress, true);
	for (const v of [undefined, "", "0", "true", " 1"]) assert.equal(parseGates({ EGRESS_CLOUDFLARE_EDGE: v } as any).gates.cloudflareEdgeEgress, false, String(v));
});

test("edgeRetryAllowed: only a policy refusal of one checked Cloudflare address, confirmed by a fresh all-Cloudflare answer", async () => {
	const { lookup } = dns({ "worker.example": ["104.21.0.10"], "mixed.example": ["104.21.0.10", "1.2.3.4"], "private.example": ["104.21.0.10", "10.0.0.1"] });
	const refusal = new Error(REFUSAL);
	assert.equal(await edgeRetryAllowed("worker.example", [{ ip: "104.21.0.10", refused: true }], refusal, lookup), true);
	assert.equal(await edgeRetryAllowed("worker.example", [{ ip: "104.21.0.10", refused: false }], new Error("connection reset"), lookup), false, "other socket errors");
	assert.equal(await edgeRetryAllowed("worker.example", [{ ip: "1.2.3.4", refused: true }], refusal, lookup), false, "a non-Cloudflare address");
	assert.equal(await edgeRetryAllowed("104.21.0.10", [{ ip: "104.21.0.10", refused: true }], refusal, lookup), false, "an IP literal");
	assert.equal(await edgeRetryAllowed("worker.example", [], refusal, lookup), false, "no socket attempt");
	assert.equal(await edgeRetryAllowed("mixed.example", [{ ip: "104.21.0.10", refused: true }], refusal, lookup), false, "fresh answer is mixed");
	assert.equal(await edgeRetryAllowed("private.example", [{ ip: "104.21.0.10", refused: true }], refusal, lookup), false, "fresh answer has a private address");
	assert.equal(await edgeRetryAllowed("gone.example", [{ ip: "104.21.0.10", refused: true }], refusal, lookup), false, "fresh lookup failed");
});

for (const mode of ["throw", "opened"] as const) {
	test(`wake: pinned first, then one edge retry after a socket policy refusal (${mode})`, async () => {
		const d = dns(cfAnswers()), sock = refusingConnect(mode), rec = edgeRecorder(() => new Response("accepted", { status: 202 }));
		const result = await fetchCheckedWake("https://worker.example/wake", { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" }, { lookup: d.lookup, connect: sock.connect, edge: rec.edge });
		assert.ok("response" in result, JSON.stringify(result));
		assert.equal(result.response.status, 202);
		assert.equal(result.transport, "fetch_fallback");
		assert.deepEqual(sock.dials, ["104.21.0.10"], "the checked address was dialled first");
		assert.deepEqual(d.asked, ["worker.example", "worker.example"], "checked, then looked up again before the retry");
		assert.deepEqual(rec.calls, [{ url: "https://worker.example/wake", redirect: "manual", authorization: "Bearer secret", signal: true }]);
	});
}

test("wake: no retry with the gate off, for other socket errors, or for non-Cloudflare addresses", async () => {
	const rec = edgeRecorder(() => new Response(null, { status: 202 }));
	await assert.rejects(fetchCheckedWake("https://worker.example/wake", { method: "POST", body: "{}" }, { lookup: dns(cfAnswers()).lookup, connect: refusingConnect().connect }), /proxy request failed/);
	await assert.rejects(fetchCheckedWake("https://worker.example/wake", { method: "POST", body: "{}" }, { lookup: dns(cfAnswers()).lookup, connect: refusingConnect("throw", "connection reset").connect, edge: rec.edge }), /connection reset/);
	await assert.rejects(fetchCheckedWake("https://plain.example/wake", { method: "POST", body: "{}" }, { lookup: dns(cfAnswers()).lookup, connect: refusingConnect().connect, edge: rec.edge }), /proxy request failed/);
	assert.equal(rec.calls.length, 0);
});

test("wake: a fresh answer that moved off Cloudflare keeps the failure", async () => {
	let n = 0;
	const lookup: AddressLookup = async () => (n++ === 0 ? ["104.21.0.10"] : ["203.0.114.9"]);
	const rec = edgeRecorder(() => new Response(null, { status: 202 }));
	await assert.rejects(fetchCheckedWake("https://worker.example/wake", { method: "POST", body: "{}" }, { lookup, connect: refusingConnect().connect, edge: rec.edge }), /proxy request failed/);
	assert.equal(rec.calls.length, 0);
});

test("wake: a redirect from the retry is checked again and a cross-origin one is refused", async () => {
	const rec = edgeRecorder(() => new Response(null, { status: 307, headers: { location: "https://plain.example/elsewhere" } }));
	const r = await fetchCheckedWake("https://worker.example/wake", { method: "POST", body: "{}" }, { lookup: dns(cfAnswers()).lookup, connect: refusingConnect().connect, edge: rec.edge });
	assert.deepEqual(r, { refused: "cross-origin redirect" });
	assert.equal(rec.calls.length, 1);
});

test("peer: retry responses are bounded and redirects refused", async () => {
	const ok = edgeRecorder(() => new Response(JSON.stringify({ jsonrpc: "2.0", result: {} }), { status: 200 }));
	const r = await fetchCheckedPeer("https://worker.example/a2a", { method: "POST", headers: { authorization: "Bearer peer" }, body: "{}" }, { lookup: dns(cfAnswers()).lookup, connect: refusingConnect().connect, edge: ok.edge });
	assert.ok("response" in r);
	assert.equal(r.transport, "fetch_fallback");
	assert.deepEqual(await r.response.json(), { jsonrpc: "2.0", result: {} });
	assert.equal(ok.calls[0]!.redirect, "manual");
	assert.equal(ok.calls[0]!.authorization, "Bearer peer");

	const big = edgeRecorder(() => new Response(new Uint8Array((1 << 20) + 1), { status: 200 }));
	await assert.rejects(fetchCheckedPeer("https://worker.example/a2a", { method: "POST", body: "{}" }, { lookup: dns(cfAnswers()).lookup, connect: refusingConnect().connect, edge: big.edge }), /response limit/);

	const moved = edgeRecorder(() => new Response(null, { status: 302, headers: { location: "https://worker.example/x" } }));
	assert.deepEqual(await fetchCheckedPeer("https://worker.example/a2a", { method: "POST", body: "{}" }, { lookup: dns(cfAnswers()).lookup, connect: refusingConnect().connect, edge: moved.edge }), { refused: "redirects are not allowed" });

	const aborted = new AbortController(); aborted.abort();
	await assert.rejects(fetchCheckedPeer("https://worker.example/a2a", { method: "POST", body: "{}", signal: aborted.signal }, { lookup: dns(cfAnswers()).lookup, connect: refusingConnect().connect, edge: ok.edge }));
});

test("client metadata: the pinned socket client dials the checked address and records a policy refusal", async () => {
	for (const mode of ["throw", "opened"] as const) {
		const sock = refusingConnect(mode);
		const attempts: SocketAttempt[] = [];
		await assert.rejects(getPinnedMetadata("https://worker.example/m.json", { ip: "104.21.0.10", hostname: "worker.example" }, 5120, 5000, AbortSignal.timeout(5000), attempts, sock.connect));
		assert.deepEqual(sock.dials, ["104.21.0.10"], mode);
		assert.equal(attempts.length, 1);
		assert.equal(await edgeRetryAllowed("worker.example", attempts, undefined, dns(cfAnswers()).lookup), true, mode);
	}
	const generic = refusingConnect("throw", "connect ECONNREFUSED");
	const attempts: SocketAttempt[] = [];
	await assert.rejects(getPinnedMetadata("https://worker.example/m.json", { ip: "104.21.0.10", hostname: "worker.example" }, 5120, 5000, AbortSignal.timeout(5000), attempts, generic.connect), /ECONNREFUSED/);
	assert.equal(await edgeRetryAllowed("worker.example", attempts, undefined, dns(cfAnswers()).lookup), false, "a generic socket error is not a policy refusal");
});

test("the retry lookup bypasses the DNS-over-HTTPS cache", async (t) => {
	const seen: (string | undefined)[] = [];
	const real = globalThis.fetch;
	globalThis.fetch = (async (input: any, init: any = {}) => {
		seen.push(init.cache);
		const aaaa = new URL(String(input)).searchParams.get("type") === "AAAA";
		return Response.json({ Status: 0, Answer: aaaa ? [] : [{ type: 1, data: "104.21.0.10" }] });
	}) as any;
	t.after(() => { globalThis.fetch = real; });
	assert.deepEqual(await lookupAddresses("worker.example"), ["104.21.0.10"]);
	assert.deepEqual(await lookupAddresses("worker.example", undefined, true), ["104.21.0.10"]);
	assert.deepEqual(seen, [undefined, undefined, "no-store", "no-store"]);
});

test("the fresh lookup gets a signal bound to the remaining deadline, and a stalled lookup does not start the retry", async () => {
	const rec = edgeRecorder(() => new Response(null, { status: 202 }));
	const signals: (AbortSignal | undefined)[] = [];
	let n = 0;
	const stalled: AddressLookup = (host, signal) => {
		if (n++ === 0) return Promise.resolve(["104.21.0.10"]);
		signals.push(signal);
		// A ref'd timer stands in for the pending DoH request; AbortSignal.timeout alone does not keep the loop alive.
		return new Promise((resolve, reject) => {
			const pending = setTimeout(() => resolve(["104.21.0.10"]), 5000);
			signal?.addEventListener("abort", () => { clearTimeout(pending); reject(signal.reason); }, { once: true });
		});
	};
	const started = Date.now();
	await assert.rejects(fetchCheckedWake("https://worker.example/wake", { method: "POST", body: "{}" }, { lookup: stalled, connect: refusingConnect().connect, edge: rec.edge, timeoutMs: 40 }), (e: any) => e?.name === "TimeoutError");
	assert.ok(Date.now() - started < 2000, "the deadline ended the stalled lookup");
	assert.equal(signals.length, 1);
	assert.ok(signals[0] instanceof AbortSignal && signals[0].aborted, "the lookup signal was aborted by the deadline");
	assert.equal(rec.calls.length, 0, "the retry fetch never started");
});

test("a deadline that passes during the fresh lookup does not start the retry (wake and peer)", async () => {
	for (const run of [
		(deps: any) => fetchCheckedWake("https://worker.example/wake", { method: "POST", body: "{}" }, deps),
		(deps: any) => fetchCheckedPeer("https://worker.example/a2a", { method: "POST", body: "{}" }, deps),
	]) {
		const rec = edgeRecorder(() => new Response(null, { status: 202 }));
		let n = 0;
		// Ignores its signal and answers after the deadline.
		const slow: AddressLookup = async () => { if (n++ > 0) await new Promise((r) => setTimeout(r, 60)); return ["104.21.0.10"]; };
		await assert.rejects(run({ lookup: slow, connect: refusingConnect().connect, edge: rec.edge, timeoutMs: 20 }), (e: any) => e?.name === "TimeoutError");
		assert.equal(rec.calls.length, 0);
	}
});

test("peer: the fresh lookup signal follows the caller's signal as well as the deadline", async () => {
	const rec = edgeRecorder(() => new Response("{}", { status: 200 }));
	const signals: (AbortSignal | undefined)[] = [];
	let n = 0;
	const lookup: AddressLookup = async (host, signal) => { if (n++ > 0) signals.push(signal); return ["104.21.0.10"]; };
	const caller = new AbortController();
	const r = await fetchCheckedPeer("https://worker.example/a2a", { method: "POST", body: "{}", signal: caller.signal }, { lookup, connect: refusingConnect().connect, edge: rec.edge });
	assert.ok("response" in r);
	assert.ok(signals[0] instanceof AbortSignal && !signals[0].aborted);
	caller.abort();
	assert.ok(signals[0]!.aborted, "aborting the caller aborts the lookup signal");
	assert.equal(rec.calls[0]!.signal, true);
});
