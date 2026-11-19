// #461: Worker MCP request_pairing, pairing_requests safety code, and read-only wake_status.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { sha256 } from "../src/a2a.ts";
import { wakeNet, DOH_URL } from "../src/wake-target.ts";
import { d1 } from "./d1.ts";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const BOB = "https://bob.example.net";
const ALICE = "https://alice.example.net";

/** Two self-hosted Workers. Bob's pinned peer fetches are routed to Alice's Worker in-process; DNS answers a public address. */
function setup(t: TestContext) {
	const make = (base: string, owner: string, name: string) => ({ base, owner, env: { DB: d1(MIGRATIONS), PUBLIC_URL: base, OWNER_TOKEN: owner, AGENT_NAME: name } as any });
	const bob = make(BOB, "owner-bob", "Bob");
	const alice = make(ALICE, "owner-alice", "Alice");
	const byOrigin: Record<string, typeof bob> = { [BOB]: bob, [ALICE]: alice };
	// Background work (dispatch's opportunistic wake flush) is collected so a call can wait for it.
	const background: Promise<unknown>[] = [];
	const ectx = { waitUntil(p: Promise<unknown>) { background.push(p.catch(() => {})); }, passThroughOnException() {} } as any;
	const peerRequests: { url: string; method: string; body: string }[] = [];
	const origFetch = globalThis.fetch;
	const origDeliver = wakeNet.deliver;
	globalThis.fetch = (async (input: any, init?: RequestInit) => {
		const u = new URL(String(input instanceof Request ? input.url : input));
		if (u.origin === new URL(DOH_URL).origin) return Response.json({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] });
		// MCP send and poll use the runtime fetch for the card and JSON-RPC; route them to the peer Worker too.
		if (u.host === "hook.example.org") { peerRequests.push({ url: u.href, method: "POST", body: "" }); return new Response("ok"); }
		const target = byOrigin[u.origin];
		if (target) return worker.fetch((input instanceof Request ? input : new Request(u.href, init)) as any, target.env, ectx);
		throw new Error(`unexpected fetch ${u.href}`);
	}) as typeof fetch;
	wakeNet.deliver = async (url: string, init: RequestInit) => {
		const target = byOrigin[new URL(url).origin];
		const body = typeof init.body === "string" ? init.body : "";
		peerRequests.push({ url, method: String(init.method || "GET"), body });
		if (!target) return new Response("no such host", { status: 404 });
		return worker.fetch(new Request(url, { method: init.method, headers: init.headers, body: init.body as any }) as any, target.env, ectx);
	};
	t.after(() => { globalThis.fetch = origFetch; wakeNet.deliver = origDeliver; });
	const call = async (who: typeof bob, method: string, path: string, json?: unknown, headers: Record<string, string> = {}) => {
		const res = await worker.fetch(new Request(who.base + path, { method, headers: { "content-type": "application/json", ...headers }, ...(json === undefined ? {} : { body: JSON.stringify(json) }) }) as any, who.env, ectx);
		await Promise.all(background.splice(0));
		const text = await res.text();
		let data: any = text;
		try { data = JSON.parse(text); } catch { /* text */ }
		return { status: res.status, data, text };
	};
	const owner = (who: typeof bob, method: string, path: string, json?: unknown) => call(who, method, path, json, { authorization: `Bearer ${who.owner}` });
	/** An approved MCP connector on Bob, without the browser consent flow. */
	const grant = async () => {
		const access = "a2amcp_test_" + "x".repeat(40);
		await bob.env.DB.prepare("INSERT INTO mcp_grants (label, client_id, client_name, scope, access_hash, access_expires_ms, created_at) VALUES ('mcp-test', 'client-test', 'Test', 'inbox', ?, ?, ?)")
			.bind(await sha256(access), Date.now() + 3600_000, new Date().toISOString()).run();
		return access;
	};
	let rid = 0;
	const tool = async (access: string, name: string, args: unknown = {}) => {
		const r = await call(bob, "POST", "/mcp", { jsonrpc: "2.0", id: ++rid, method: "tools/call", params: { name, arguments: args } },
			{ authorization: `Bearer ${access}`, accept: "application/json, text/event-stream" });
		assert.equal(r.status, 200, r.text);
		return r.data.result as { isError: boolean; content: { text: string }[]; structuredContent?: any };
	};
	return { bob, alice, call, owner, grant, tool, peerRequests };
}

test("list_peers preserves encrypted comparisons from owner API without changing plain rows", async (t) => {
	const s = setup(t);
	const access = await s.grant();
	const bundle = (cardUrl: string, byte: number) => JSON.stringify({ cardUrl,
		identityKey: Buffer.alloc(32, byte).toString("base64url"), keyId: Buffer.alloc(32, byte + 1).toString("base64url") });
	const responder = bundle(BOB + "/.well-known/agent-card.json", 3);
	for (const [label, requester, revoked] of [
		["sealed", bundle(ALICE + "/.well-known/agent-card.json", 1), null],
		["unavailable", "not-json", null], ["plain", null, null],
		["revoked", bundle(ALICE + "/.well-known/agent-card.json", 1), new Date().toISOString()],
	] as const) {
		await s.bob.env.DB.prepare("INSERT INTO peers (label, token_hash, created_at, source, revoked_at, sealed_requester, sealed_responder) VALUES (?, ?, ?, 'pairing', ?, ?, ?)")
			.bind(label, "test-" + label, new Date().toISOString(), revoked, requester, requester ? responder : null).run();
	}
	const owner = await s.owner(s.bob, "GET", "/owner/peers");
	assert.equal(owner.status, 200);
	const expected = Object.fromEntries(owner.data.map((row: any) => [row.label, row]));
	const listed = await s.tool(access, "list_peers");
	assert.equal(listed.isError, false);
	const text = listed.content[0].text;
	const data = JSON.parse(text.slice(text.indexOf("\n") + 1));
	const by = Object.fromEntries(data.inbound.map((row: any) => [row.label, row]));
	assert.equal(by.revoked, undefined);
	for (const label of ["sealed", "unavailable"]) {
		assert.equal(by[label].sealed, true);
		assert.equal(by[label].safety_code, expected[label].safety_code);
		assert.deepEqual(by[label].safety_emoji, expected[label].safety_emoji);
	}
	assert.equal(by.unavailable.safety_code, null);
	assert.equal(by.unavailable.safety_emoji, null);
	assert.deepEqual(Object.keys(by.plain).sort(), ["cardUrl", "clientName", "continuation", "label", "since", "source"]);
	assert.equal(text.includes("sealed_requester") || text.includes("identityKey"), false);
});

test("request_pairing: pending until the other owner approves, then the first send redeems and stores the peer", async (t) => {
	const s = setup(t);
	const access = await s.grant();
	const started = await s.tool(access, "request_pairing", { url: ALICE });
	assert.equal(started.isError, false, started.content[0].text);
	const d = started.structuredContent;
	assert.equal(d.sendTo, "alice.example.net");
	assert.match(d.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
	assert.equal(d.verificationUriComplete.startsWith(`${ALICE}/device`), true);
	assert.equal(d.serverReadable, true);
	assert.match(started.content[0].text, /you never approve it yourself/);
	const text = JSON.stringify(started);
	assert.equal(/device_code|deviceCode/.test(text), false, "the device code is never shown");
	const stored = await s.bob.env.DB.prepare("SELECT device_enc FROM outbound_pairings WHERE alias = 'alice.example.net'").first() as { device_enc: string };
	assert.match(stored.device_enc, /^v1\./, "the device code is sealed at rest");

	// Alice sees the request with Bob's claimed card and identity.
	const pending = await s.owner(s.alice, "GET", "/owner/pairing");
	const req = pending.data.pending.find((r: any) => r.userCode === d.userCode);
	assert.equal(req.clientName, "Bob");
	assert.equal(req.agentCardUrl, `${BOB}/.well-known/agent-card.json`);
	assert.ok(req.identityFingerprint);

	const listed = await s.tool(access, "list_peers");
	assert.equal(JSON.parse(listed.content[0].text.slice(listed.content[0].text.indexOf("\n") + 1)).pendingOutbound[0].alias, "alice.example.net");

	const early = await s.tool(access, "send", { to: "alice.example.net", text: "hello", intent: "question" });
	assert.equal(early.isError, true);
	assert.match(early.content[0].text, /has not approved .* yet\. Nothing was sent/);

	assert.equal((await s.owner(s.alice, "POST", `/owner/pairing/${d.userCode.replace("-", "")}/approve`)).status, 200);
	// The poll interval is respected; move it to now for the test.
	await s.bob.env.DB.prepare("UPDATE outbound_pairings SET poll_after_ms = 0").run();
	const sent = await s.tool(access, "send", { to: "alice.example.net", text: "hello after approval", intent: "question" });
	assert.equal(sent.isError, false, sent.content[0].text);
	assert.equal((await s.bob.env.DB.prepare("SELECT COUNT(*) AS n FROM outbound_pairings").first() as any).n, 0);
	const peer = await s.bob.env.DB.prepare("SELECT url, token_enc FROM outbound_peers WHERE alias = 'alice.example.net'").first() as any;
	assert.equal(peer.url, ALICE);
	assert.match(peer.token_enc, /^v1\./);
	const inbox = await s.owner(s.alice, "GET", "/owner/inbox");
	assert.ok(inbox.data.some((x: any) => x.text === "hello after approval"));
	const exported = await s.owner(s.bob, "GET", "/owner/export");
	assert.deepEqual(exported.data.tables.outbound_pairings, []);
});

test("request_pairing: denial and expiry clear the request; bad addresses are refused before any request", async (t) => {
	const s = setup(t);
	const access = await s.grant();
	for (const url of ["http://alice.example.net", "https://10.0.0.1", "https://user:pw@alice.example.net", BOB]) {
		const r = await s.tool(access, "request_pairing", { url });
		assert.equal(r.isError, true, url);
	}
	assert.equal(s.peerRequests.length, 0, "nothing is fetched for a refused address");

	const started = (await s.tool(access, "request_pairing", { url: ALICE })).structuredContent;
	assert.equal((await s.owner(s.alice, "POST", `/owner/pairing/${started.userCode.replace("-", "")}/deny`)).status, 200);
	await s.bob.env.DB.prepare("UPDATE outbound_pairings SET poll_after_ms = 0").run();
	const denied = await s.tool(access, "send", { to: "alice.example.net", text: "x", intent: "question" });
	assert.match(denied.content[0].text, /denied the pairing\. Nothing was sent/);
	assert.equal((await s.bob.env.DB.prepare("SELECT COUNT(*) AS n FROM outbound_pairings").first() as any).n, 0);

	await s.tool(access, "request_pairing", { url: ALICE });
	await s.bob.env.DB.prepare("UPDATE outbound_pairings SET expires_ms = 1").run();
	const expired = await s.tool(access, "send", { to: "alice.example.net", text: "x", intent: "question" });
	assert.match(expired.content[0].text, /expired before it was approved\. Call request_pairing again/);
	assert.equal((await s.bob.env.DB.prepare("SELECT COUNT(*) AS n FROM outbound_pairings").first() as any).n, 0);
});

test("pairing_requests passes through sealed and safetyCode and no key material", async (t) => {
	const s = setup(t);
	const access = await s.grant();
	await s.call(s.bob, "POST", "/oauth/device_authorization", { client_name: "Carol", client_id: "carol" });
	// A key pairing as the owner route lists it: flagged with its safety code. The bundles stay server-side.
	await s.bob.env.DB.prepare("UPDATE device_requests SET sealed_requester = ?, sealed_responder = ?").bind('{"k":"requester-bundle"}', '{"k":"responder-bundle"}').run();
	const route = await s.owner(s.bob, "GET", "/owner/pairing");
	const sealedRow = route.data.pending[0];
	const r = await s.tool(access, "pairing_requests");
	assert.equal(r.isError, false, r.content[0].text);
	const rows = JSON.parse(r.content[0].text.slice(r.content[0].text.indexOf("\n") + 1));
	assert.equal(sealedRow.sealed, true);
	assert.equal(rows[0].sealed, true);
	assert.equal(rows[0].safetyCode, sealedRow.safetyCode);
	assert.equal(/requester-bundle|responder-bundle/.test(r.content[0].text), false, "no key material");
	const tools = (await s.call(s.bob, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: `Bearer ${access}`, accept: "application/json, text/event-stream" })).data.result.tools;
	assert.match(tools.find((x: any) => x.name === "pairing_requests").description, /compare that safety code/);
});

test("wake_status is read-only through dispatch: a due wake is not sent or consumed, and no secret is shown", async (t) => {
	const s = setup(t);
	s.bob.env.WAKE_PRESET = "generic";
	s.bob.env.WAKE_WEBHOOK_URL = "https://hook.example.org/secret-path";
	s.bob.env.WAKE_WEBHOOK_KEY = "wake-key-value";
	const access = await s.grant();
	// Due now: debounce passed long ago, so any other request's opportunistic flush would send it.
	const due = () => s.bob.env.DB.prepare("INSERT OR REPLACE INTO wakes (context_id, peer, pending_since_ms, last_sent_ms, pending_json) VALUES ('ctx-1', 'carol', 1, 0, ?)").bind(JSON.stringify({ contextId: "ctx-1", taskId: "task-1", taskIds: ["task-1"], from: "carol", preview: "private preview", kind: "inbound", attempts: 2 })).run();
	const pending = async () => (await s.bob.env.DB.prepare("SELECT pending_json FROM wakes WHERE context_id = 'ctx-1'").first() as any)?.pending_json ?? null;
	const hookCalls = () => s.peerRequests.filter((x) => new URL(x.url).host === "hook.example.org").length;
	await due();
	const before = await pending();
	const r = await s.tool(access, "wake_status");
	assert.equal(r.isError, false, r.content[0].text);
	assert.equal(r.structuredContent.configured, true);
	assert.equal(r.structuredContent.pendingCount, 1);
	assert.equal(r.structuredContent.pending[0].reason, "retry");
	assert.equal(r.structuredContent.pending[0].attempts, 2);
	assert.match(r.content[0].text, /Read-only: nothing was sent or flushed/);
	const all = JSON.stringify(r);
	for (const secret of ["hook.example.org", "secret-path", "wake-key-value", "private preview"]) assert.equal(all.includes(secret), false, secret);
	assert.equal(await pending(), before, "the due wake is still pending, unchanged");
	assert.equal(hookCalls(), 0, "no wake notification was sent");
	// Control: any other MCP call through dispatch does flush the same due wake, so the check above can see a flush.
	await s.tool(access, "list_peers");
	assert.equal(await pending(), null, "a non-diagnostic request flushed the due wake");
	assert.equal(hookCalls(), 1);
});
