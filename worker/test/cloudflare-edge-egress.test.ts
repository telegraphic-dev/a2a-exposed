// EGRESS_CLOUDFLARE_EDGE=1: a checked host served only from Cloudflare addresses uses the platform fetch.
// Every other host keeps the pinned socket. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import * as M from "../src/mcp.ts";
import { parseGates } from "../src/tenancy.ts";
import { fetchCheckedPeer, fetchCheckedWake, viaEdge, wakeNet, type AddressLookup, type CheckedDeliver, type EdgeFetch } from "../src/wake-target.ts";

const lookup: AddressLookup = async (host) => {
	if (host === "worker.example") return ["104.21.0.10", "172.67.0.10", "2606:4700:3030::1"];
	if (host === "mixed.example") return ["104.21.0.10", "1.2.3.4"];
	if (host === "plain.example") return ["1.2.3.4"];
	if (host === "cf-private.example") return ["104.21.0.10", "10.0.0.1"];
	return null;
};

function edgeRecorder(answer: (url: string) => Response) {
	const calls: { url: string; redirect: string; authorization: string; signal: boolean }[] = [];
	const edge: EdgeFetch = async (url, init) => {
		calls.push({ url, redirect: init.redirect ?? "", authorization: new Headers(init.headers).get("authorization") ?? "", signal: !!init.signal });
		return answer(url);
	};
	return { edge, calls };
}

const pinned: CheckedDeliver = async () => new Response(null, { status: 299 });

test("Cloudflare ranges: published IPv4 and IPv6 blocks only", () => {
	for (const ip of ["104.16.0.1", "104.23.255.255", "172.64.0.1", "162.159.1.1", "198.41.200.1", "2606:4700::6810:1", "2a06:98c7::1"]) assert.ok(M.isCloudflareIp(ip), ip);
	for (const ip of ["1.2.3.4", "104.32.0.1", "172.72.0.1", "10.0.0.1", "127.0.0.1", "2001:db8::1", "2a06:98c8::1", "fe80::1", "not-an-ip"]) assert.ok(!M.isCloudflareIp(ip), ip);
});

test("viaEdge needs a named host whose every address is Cloudflare's", () => {
	assert.ok(viaEdge({ hostname: "worker.example", ips: ["104.21.0.10", "2606:4700:3030::1"] }));
	assert.ok(!viaEdge({ hostname: "mixed.example", ips: ["104.21.0.10", "1.2.3.4"] }));
	assert.ok(!viaEdge({ hostname: "104.21.0.10", ips: ["104.21.0.10"] }));
	assert.ok(!viaEdge({ hostname: "empty.example", ips: [] }));
});

test("the gate is exactly EGRESS_CLOUDFLARE_EDGE=1", () => {
	assert.equal(parseGates({ EGRESS_CLOUDFLARE_EDGE: "1" } as any).gates.cloudflareEdgeEgress, true);
	for (const v of [undefined, "", "0", "true", " 1"]) assert.equal(parseGates({ EGRESS_CLOUDFLARE_EDGE: v } as any).gates.cloudflareEdgeEgress, false, String(v));
});

test("wake: a Cloudflare-only host uses the edge fetch with manual redirects and a deadline", async () => {
	const rec = edgeRecorder(() => new Response("accepted", { status: 202 }));
	const result = await fetchCheckedWake("https://worker.example/wake", { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" }, { lookup, deliver: pinned, edge: rec.edge });
	assert.ok("response" in result);
	assert.equal(result.response.status, 202);
	assert.deepEqual(rec.calls, [{ url: "https://worker.example/wake", redirect: "manual", authorization: "Bearer secret", signal: true }]);
});

test("wake: mixed, non-Cloudflare, and gate-off targets keep the pinned socket", async () => {
	const rec = edgeRecorder(() => new Response(null, { status: 202 }));
	for (const url of ["https://mixed.example/wake", "https://plain.example/wake"]) {
		const r = await fetchCheckedWake(url, { method: "POST", body: "{}" }, { lookup, deliver: pinned, edge: rec.edge });
		assert.ok("response" in r && r.response.status === 299, url);
	}
	const off = await fetchCheckedWake("https://worker.example/wake", { method: "POST", body: "{}" }, { lookup, deliver: pinned });
	assert.ok("response" in off && off.response.status === 299);
	assert.equal(rec.calls.length, 0);
});

test("wake: a private address in the answer is refused before the edge is used", async () => {
	const rec = edgeRecorder(() => new Response(null, { status: 202 }));
	const r = await fetchCheckedWake("https://cf-private.example/wake", { method: "POST", body: "{}" }, { lookup, deliver: pinned, edge: rec.edge });
	assert.deepEqual(r, { refused: "resolves to a private or reserved address" });
	assert.equal(rec.calls.length, 0);
});

test("wake: an edge redirect is checked again and a cross-origin one is refused", async () => {
	const rec = edgeRecorder(() => new Response(null, { status: 307, headers: { location: "https://plain.example/elsewhere" } }));
	const r = await fetchCheckedWake("https://worker.example/wake", { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" }, { lookup, deliver: pinned, edge: rec.edge });
	assert.deepEqual(r, { refused: "cross-origin redirect" });
	assert.equal(rec.calls.length, 1);
});

test("peer: edge responses are bounded and redirects refused", async () => {
	const ok = edgeRecorder(() => new Response(JSON.stringify({ jsonrpc: "2.0", result: {} }), { status: 200 }));
	const r = await fetchCheckedPeer("https://worker.example/a2a", { method: "POST", headers: { authorization: "Bearer peer" }, body: "{}" }, { lookup, deliver: pinned, edge: ok.edge });
	assert.ok("response" in r);
	assert.equal(r.response.status, 200);
	assert.deepEqual(await r.response.json(), { jsonrpc: "2.0", result: {} });
	assert.equal(ok.calls[0]!.redirect, "manual");

	const big = edgeRecorder(() => new Response(new Uint8Array((1 << 20) + 1), { status: 200 }));
	await assert.rejects(fetchCheckedPeer("https://worker.example/a2a", { method: "POST", body: "{}" }, { lookup, deliver: pinned, edge: big.edge }), /response limit/);

	const moved = edgeRecorder(() => new Response(null, { status: 302, headers: { location: "https://worker.example/x" } }));
	assert.deepEqual(await fetchCheckedPeer("https://worker.example/a2a", { method: "POST", body: "{}" }, { lookup, deliver: pinned, edge: moved.edge }), { refused: "redirects are not allowed" });
});

test("wakeNet.edge replaces the runtime fetch for tests only", () => {
	assert.equal(wakeNet.edge, null);
});
