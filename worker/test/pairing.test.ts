// Device-flow pairing (RFC 8628) end to end against the real Worker fetch handler, with D1 on node:sqlite and the
// wake webhook captured. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import * as P from "../src/pairing.ts";
import { wakeSummary, renderWake, type WakeEvent } from "../src/wake.ts";
import { d1 } from "./d1.ts";

const BASE = "https://agent.example.com";
const GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const PASSWORD = "correct horse battery staple";

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const advance = (s: number) => { offset += s * 1000; };

async function passwordRecord(pw = PASSWORD) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hash = await P.pbkdf2(pw, salt, 100000);
	const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
	return { alg: "pbkdf2-sha256", iterations: 100000, salt: b64(salt), hash: b64(hash) };
}

function setup(over: Record<string, string> = {}) {
	const DB = d1(new URL("../migrations/", import.meta.url));
	const env: any = { DB, PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", AGENT_NAME: "Test Inbox", WAKE_PRESET: "grok-bot",
		WAKE_WEBHOOK_URL: "https://hook.example.net/wake", WAKE_WEBHOOK_KEY: "hook-key", ...over };
	const wakes: any[] = [];
	const origFetch = globalThis.fetch;
	globalThis.fetch = (async (url: any, init: any) => {
		wakes.push({ url: String(url), body: JSON.parse(init.body) });
		return new Response("ok");
	}) as any;
	const call = async (method: string, path: string, o: { form?: Record<string, string>; json?: any; headers?: Record<string, string>; ip?: string; cookie?: string } = {}) => {
		const headers: Record<string, string> = { "cf-connecting-ip": o.ip || "198.51.100.7", ...(o.headers || {}) };
		let body: string | undefined;
		if (o.form) { headers["content-type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(o.form).toString(); }
		if (o.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(o.json); }
		if (o.cookie) headers.cookie = o.cookie;
		const pending: Promise<unknown>[] = [];
		const res = await worker.fetch(new Request(BASE + path, { method, headers, body }) as any, env, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as any);
		await Promise.allSettled(pending);
		const text = await res.text();
		let data: any = text;
		try { data = JSON.parse(text); } catch { /* html */ }
		return { status: res.status, headers: res.headers, data, text };
	};
	const owner = (method: string, path: string, json?: any) => call(method, path, { json, headers: { authorization: "Bearer owner-secret" } });
	const start = (form: Record<string, string> = { client_name: "Barry Bot", client_id: "barry", agent_card_url: "https://barry.example.org/.well-known/agent-card.json" }, ip?: string) =>
		call("POST", "/oauth/device_authorization", { form, ip });
	const poll = (device_code: string) => call("POST", "/oauth/token", { form: { grant_type: GRANT, device_code } });
	/** GET the page (sets the CSRF cookie), then POST the decision with it. */
	const decidePage = async (userCode: string, password: string, decision: "approve" | "deny", ip?: string) => {
		const g = await call("GET", `/device?user_code=${userCode}`, { ip });
		const cookie = (g.headers.get("set-cookie") || "").split(";")[0];
		const csrf = /name="csrf" value="([^"]+)"/.exec(g.text)?.[1] || cookie.split("=")[1];
		return call("POST", "/device", { form: { csrf, user_code: userCode, password, decision }, cookie, ip, headers: { origin: BASE } });
	};
	return { env, DB, wakes, call, owner, start, poll, decidePage, restore: () => { globalThis.fetch = origFetch; } };
}

test("pairing helpers: user codes, labels, requester text, params, password hashing", async () => {
	for (let i = 0; i < 200; i++) assert.match(P.newUserCode(), /^[BCDFGHJKLMNPQRSTVWXZ]{4}[2-9]{4}$/);
	assert.equal(P.formatUserCode("WDJB4827"), "WDJB-4827");
	assert.equal(P.normUserCode(" wdjb-4827 "), "WDJB4827");
	assert.equal(P.normUserCode("WDJB 4827"), "WDJB4827");
	for (const bad of ["WDJB-4801", "WXYZ-4827", "AEIO-2345", "WDJ-2345", "", 7]) assert.equal(P.normUserCode(bad), null, String(bad));
	assert.match(P.newDeviceCode(), /^[A-Za-z0-9_-]{43}$/);
	assert.equal(P.labelBase("Barry Bot (Hermes)", "x"), "Barry-Bot-Hermes");
	assert.equal(P.labelBase("  ***  ", "hermes.local"), "hermes-local");
	assert.equal(P.labelBase("", ""), "paired-agent");
	assert.equal(P.dedupeLabel("barry", new Set(["barry", "barry-2"])), "barry-3");
	assert.equal(P.cleanText("a\u202eb\nc\u0000d " + "x".repeat(100)).length, 64);
	assert.equal(P.cleanText("Barry\u202e\nBot"), "Barry Bot");
	assert.equal(P.cleanCardUrl("https://a.example/.well-known/agent-card.json"), "https://a.example/.well-known/agent-card.json");
	for (const bad of ["http://a.example/", "https://u:p@a.example/", "javascript:alert(1)", "https://a.example/" + "x".repeat(300)]) assert.equal(P.cleanCardUrl(bad), "");
	assert.deepEqual(P.parseParams("client_name=A+B&client_id=x&client_id=y", "application/x-www-form-urlencoded"), { client_name: "A B", client_id: "x" });
	assert.deepEqual(P.parseParams('{"client_name":"A","n":1}', "application/json"), { client_name: "A" });
	assert.throws(() => P.parseParams("[1]", "application/json"));
	assert.equal(P.pairingMode(undefined), "human");
	assert.equal(P.pairingMode("AGENT"), "agent");
	assert.equal(P.pairingMode("off"), "off");
	assert.equal(P.pairingMode("yolo"), "human", "unknown values fall back to the safe mode");
	const rec = await passwordRecord();
	assert.equal(P.checkPasswordRecord(rec), "");
	assert.match(P.checkPasswordRecord({ ...rec, iterations: 1000 }), /iterations/);
	assert.match(P.checkPasswordRecord({ ...rec, hash: "AAAA" }), /32 bytes/);
	assert.equal(await P.verifyPassword(PASSWORD, rec as any), true);
	assert.equal(await P.verifyPassword(PASSWORD + "!", rec as any), false);
	assert.equal(await P.verifyPassword("", rec as any), false);
});

test("agent card, RFC 8414 metadata and the 401 hint advertise the device flow; bearer stays", async (t) => {
	const s = setup(); t.after(s.restore);
	const card = (await s.call("GET", "/.well-known/agent-card.json")).data;
	assert.deepEqual(card.securitySchemes.bearer.httpAuthSecurityScheme.scheme, "Bearer");
	const o = card.securitySchemes.pairing.oauth2SecurityScheme;
	assert.deepEqual(o.flows.deviceCode.deviceAuthorizationUrl, `${BASE}/oauth/device_authorization`);
	assert.deepEqual(o.flows.deviceCode.tokenUrl, `${BASE}/oauth/token`);
	assert.equal(typeof o.flows.deviceCode.scopes, "object");
	assert.equal(o.oauth2MetadataUrl, `${BASE}/.well-known/oauth-authorization-server`);
	assert.match(o.description, /RFC 8628[\s\S]*user_code[\s\S]*owner approves/);
	assert.deepEqual(card.securityRequirements, [{ schemes: { bearer: { list: [] } } }, { schemes: { pairing: { list: [] } } }]);
	assert.deepEqual(card.supportedInterfaces.map((i: any) => i.protocolVersion), ["1.0", "0.3"], "both bindings unchanged");

	const meta = await s.call("GET", "/.well-known/oauth-authorization-server");
	assert.equal(meta.status, 200);
	assert.deepEqual([meta.data.issuer, meta.data.device_authorization_endpoint, meta.data.token_endpoint], [BASE, `${BASE}/oauth/device_authorization`, `${BASE}/oauth/token`]);
	assert.deepEqual(meta.data.grant_types_supported, [GRANT]);
	assert.deepEqual(meta.data.token_endpoint_auth_methods_supported, ["none"]);

	for (const [method, v] of [["message/send", "0.3"], ["SendMessage", "1.0"]]) {
		const r = await s.call("POST", "/", { json: { jsonrpc: "2.0", id: 1, method, params: { message: {} } }, headers: { "a2a-version": v } });
		assert.equal(r.status, 401);
		assert.equal(r.headers.get("www-authenticate"), `Bearer realm="a2a", resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);
		assert.equal(r.data.id, 1, "the JSON-RPC id is echoed");
		assert.equal(r.data.error.code, -32000);
		assert.match(r.data.error.message, /device flow \(RFC 8628\): POST client_name and agent_card_url to https:\/\/agent\.example\.com\/oauth\/device_authorization/);
		assert.equal(r.data.error.data.pairing.device_authorization_endpoint, `${BASE}/oauth/device_authorization`);
		assert.equal(r.data.error.data.pairing.token_endpoint, `${BASE}/oauth/token`);
		assert.equal(r.data.error.data.pairing.grant_type, GRANT);
	}
	const bad = await s.call("POST", "/", { json: { jsonrpc: "2.0", id: "req-7", method: "SendMessage", params: {} }, headers: { authorization: "Bearer nope" } });
	assert.equal(bad.headers.get("www-authenticate"), `Bearer realm="a2a", resource_metadata="${BASE}/.well-known/oauth-protected-resource", error="invalid_token", error_description="the bearer token is not valid (revoked, rotated or mistyped)"`);
	assert.equal(bad.data.id, "req-7");
	assert.match(bad.data.error.message, /^Unauthorized: the bearer token is not valid \(revoked, rotated or mistyped\)\. Get a new one with the OAuth 2\.0 device flow/);
	const garbage = await s.call("POST", "/", { headers: { "content-type": "application/json" } });
	assert.equal(garbage.data.id, null, "no parseable body: id null");
	// RFC 9728 metadata names the authorization server
	const prm = await s.call("GET", "/.well-known/oauth-protected-resource");
	assert.equal(prm.status, 200);
	assert.deepEqual([prm.data.resource, prm.data.authorization_servers, prm.data.bearer_methods_supported], [`${BASE}/`, [BASE], ["header"]]);
});

test("/.well-known/agent.json serves an A2A 0.3 card (url, preferredTransport, protocolVersion); agent-card.json stays 1.0", async (t) => {
	const s = setup({ AGENT_SKILLS: JSON.stringify([{ id: "s1", name: "S1", description: "d" }]) }); t.after(s.restore);
	const old = (await s.call("GET", "/.well-known/agent.json")).data;
	assert.equal(old.protocolVersion, "0.3.0");
	assert.equal(old.url, `${BASE}/`);
	assert.equal(old.preferredTransport, "JSONRPC");
	assert.deepEqual(old.additionalInterfaces, [{ url: `${BASE}/`, transport: "JSONRPC" }]);
	assert.deepEqual([old.name, old.version], ["Test Inbox", "1.0.0"]);
	assert.deepEqual(old.capabilities, { streaming: false, pushNotifications: true, stateTransitionHistory: false });
	assert.deepEqual(old.securitySchemes.bearer, { type: "http", scheme: "bearer", description: old.securitySchemes.bearer.description });
	assert.equal(old.securitySchemes.pairing.type, "oauth2");
	assert.equal(old.securitySchemes.pairing.oauth2MetadataUrl, `${BASE}/.well-known/oauth-authorization-server`);
	assert.deepEqual(old.security, [{ bearer: [] }]);
	assert.deepEqual(old.skills, [{ id: "s1", name: "S1", description: "d", tags: [] }], "0.3 requires tags");
	assert.equal(old.supportedInterfaces, undefined, "no 1.0-only fields");
	const card = (await s.call("GET", "/.well-known/agent-card.json")).data;
	assert.equal(card.url, undefined);
	assert.deepEqual(card.supportedInterfaces.map((i: any) => i.protocolVersion), ["1.0", "0.3"]);
	const off = setup({ PAIRING_APPROVAL: "off" }); t.after(off.restore);
	assert.deepEqual(Object.keys((await off.call("GET", "/.well-known/agent.json")).data.securitySchemes), ["bearer"]);
});

test("PAIRING_APPROVAL=off: no pairing scheme, endpoints 404, plain 401", async (t) => {
	const s = setup({ PAIRING_APPROVAL: "off" }); t.after(s.restore);
	const card = (await s.call("GET", "/.well-known/agent-card.json")).data;
	assert.deepEqual(Object.keys(card.securitySchemes), ["bearer"]);
	assert.deepEqual(card.securityRequirements, [{ schemes: { bearer: { list: [] } } }]);
	for (const [m, p] of [["GET", "/.well-known/oauth-authorization-server"], ["POST", "/oauth/device_authorization"], ["POST", "/oauth/token"], ["GET", "/device"]]) {
		const r = await s.call(m, p, m === "POST" ? { form: {} } : {});
		assert.equal(r.status, 404, p);
		assert.match(r.data.error_description, /disabled/);
	}
	const r = await s.call("POST", "/", { json: { jsonrpc: "2.0", id: 1, method: "SendMessage", params: {} } });
	assert.equal(r.status, 401);
	assert.equal(r.data.error.data, undefined);
	assert.equal(s.wakes.length, 0);
	const a = await s.owner("POST", "/owner/pairing/WDJB-2345/approve");
	assert.equal(a.status, 404);
});

test("human approval: pending, slow_down, page approve with the password, single-use token, owner approve refused", async (t) => {
	const s = setup(); t.after(s.restore);
	const st = await s.start({ client_name: 'Barry <script>alert(1)</script>', client_id: "barry", agent_card_url: "https://barry.example.org/.well-known/agent-card.json" });
	assert.equal(st.status, 200);
	assert.equal(st.headers.get("cache-control"), "no-store");
	const d = st.data;
	assert.match(d.device_code, /^[A-Za-z0-9_-]{43}$/);
	assert.match(d.user_code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[2-9]{4}$/);
	assert.equal(d.verification_uri, `${BASE}/device`);
	assert.equal(d.verification_uri_complete, `${BASE}/device?user_code=${d.user_code}`);
	assert.deepEqual([d.expires_in, d.interval], [600, 5]);
	// the device code is stored hashed only
	const row: any = s.DB.db.prepare("SELECT * FROM device_requests").get();
	assert.notEqual(row.device_hash, d.device_code);
	assert.ok(!JSON.stringify(row).includes(d.device_code));

	// the wake: kind pairing_request with the code and the link; the agent is told to ask its human
	assert.equal(s.wakes.length, 1);
	const w = s.wakes[0].body;
	assert.equal(w.kind, "pairing_request");
	assert.equal(w.hint, "npx a2a-over-webhook pair list");
	assert.deepEqual([w.pairing.userCode, w.pairing.verificationUriComplete, w.pairing.approval, w.pairing.clientId], [d.user_code, d.verification_uri_complete, "human", "barry"]);
	assert.equal(w.pairing.agentCardUrl, "https://barry.example.org/.well-known/agent-card.json");
	assert.match(w.pairing.instructions, /never approve on your own[\s\S]*give them this link/);

	let p = await s.poll(d.device_code);
	assert.deepEqual([p.status, p.data.error], [400, "authorization_pending"]);
	p = await s.poll(d.device_code);
	assert.deepEqual([p.status, p.data.error], [400, "slow_down"], "polled again at once");
	assert.match(p.data.error_description, /at least 10 seconds/);
	advance(6);
	p = await s.poll(d.device_code);
	assert.equal(p.data.error, "slow_down", "the interval grew to 10 s");
	assert.match(p.data.error_description, /at least 15 seconds/, "and grows by 5 s on every slow_down (RFC 8628 §3.5)");
	advance(16);
	assert.equal((await s.poll(d.device_code)).data.error, "authorization_pending");

	// human mode: the owner API (the agent) cannot approve
	const oa = await s.owner("POST", `/owner/pairing/${d.user_code}/approve`);
	assert.equal(oa.status, 403);
	assert.match(oa.data.error, /approval mode is human: the owner approves on https:\/\/agent\.example\.com\/device\?user_code=/);
	const list = await s.owner("GET", "/owner/pairing");
	assert.deepEqual([list.data.mode, list.data.passwordSet, list.data.pending.length, list.data.pending[0].userCode], ["human", false, 1, d.user_code]);

	// the page: escaped requester text, strict CSP, no caching; no password yet -> how to set one
	let g = await s.call("GET", `/device?user_code=${d.user_code.toLowerCase()}`);
	assert.equal(g.status, 200);
	assert.ok(!g.text.includes("<script>") && g.text.includes("Barry &lt;script&gt;"));
	assert.ok(g.text.includes("https://barry.example.org/.well-known/agent-card.json") && g.text.includes("198.51.100.7"));
	assert.match(g.headers.get("content-security-policy")!, /^default-src 'none'; style-src 'nonce-[A-Za-z0-9_-]+'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'$/);
	assert.equal(g.headers.get("cache-control"), "no-store");
	assert.equal(g.headers.get("x-frame-options"), "DENY");
	assert.match(g.headers.get("set-cookie")!, /^a2a_device_csrf=[A-Za-z0-9_-]{24}; Path=\/device; Secure; HttpOnly; SameSite=Strict/);
	assert.ok(!/<script|src=|href=/i.test(g.text), "no scripts or external assets");
	assert.match(g.text, /No approval password is set yet[\s\S]*npx a2a-over-webhook pair set-password/);
	assert.ok(!g.text.includes('name="password"'));
	assert.equal((await s.decidePage(d.user_code, PASSWORD, "approve")).status, 409);

	assert.equal((await s.owner("PUT", "/owner/pairing/password", { ...(await passwordRecord()), iterations: 1000 })).status, 400);
	assert.equal((await s.owner("PUT", "/owner/pairing/password", await passwordRecord())).status, 200);
	g = await s.call("GET", `/device?user_code=${d.user_code}`);
	assert.ok(g.text.includes('name="password"') && g.text.includes('value="approve"') && g.text.includes('value="deny"'));

	// CSRF: no cookie, or another site's Origin -> refused without checking the password
	const csrf = /name="csrf" value="([^"]+)"/.exec(g.text)![1];
	let r = await s.call("POST", "/device", { form: { csrf, user_code: d.user_code, password: PASSWORD, decision: "approve" } });
	assert.equal(r.status, 403);
	assert.match(r.text, /expired or came from another site/);
	r = await s.call("POST", "/device", { form: { csrf, user_code: d.user_code, password: PASSWORD, decision: "approve" }, cookie: `a2a_device_csrf=${csrf}`, headers: { origin: "https://evil.example" } });
	assert.equal(r.status, 403);

	r = await s.decidePage(d.user_code, "wrong password", "approve");
	assert.equal(r.status, 403);
	assert.match(r.text, /Wrong password\. 4 attempts left for this code\./);
	r = await s.decidePage(d.user_code, PASSWORD, "approve");
	assert.equal(r.status, 200, r.text);
	assert.match(r.text, /Approved\. Barry &lt;script&gt;alert\(1\)&lt;\/script&gt; can now collect its token \(label &quot;Barry-script-alert-1-scr&quot;\)/);

	advance(11);
	p = await s.poll(d.device_code);
	assert.equal(p.status, 200);
	assert.equal(p.headers.get("cache-control"), "no-store");
	assert.deepEqual(Object.keys(p.data).sort(), ["access_token", "peer_label", "token_type"]);
	assert.equal(p.data.peer_label, "Barry-script-alert-1-scr");
	assert.equal(p.data.token_type, "Bearer");
	assert.match(p.data.access_token, /^a2aow_[A-Za-z0-9_-]{43}$/);
	// single use: the device code is gone
	advance(11);
	assert.deepEqual([(await s.poll(d.device_code)).data.error], ["invalid_grant"]);
	assert.equal(s.DB.db.prepare("SELECT COUNT(*) AS n FROM device_requests").get()!.n, 0);

	// the token is a normal peer token
	const rpc = await s.call("POST", "/", { json: { jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "nope" } }, headers: { authorization: `Bearer ${p.data.access_token}`, "a2a-version": "1.0" } });
	assert.equal(rpc.status, 200);
	assert.equal(rpc.data.error.code, -32001, "authenticated: task not found");
	const peers = (await s.owner("GET", "/owner/peers")).data;
	assert.equal(peers.length, 1);
	assert.deepEqual([peers[0].label, peers[0].source, peers[0].user_code, peers[0].client_name], ["Barry-script-alert-1-scr", "pairing", d.user_code, "Barry <script>alert(1)</script>"]);
	assert.ok(!JSON.stringify(s.DB.db.prepare("SELECT * FROM peers").all()).includes(p.data.access_token), "stored hashed");
	// revocation works as for any token
	await s.owner("DELETE", `/owner/peers/${peers[0].label}`);
	assert.equal((await s.call("POST", "/", { json: { jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "x" } }, headers: { authorization: `Bearer ${p.data.access_token}` } })).status, 401);
});

test("labels are deduplicated; denied and expired requests; JSON bodies; bad requests", async (t) => {
	const s = setup({ PAIRING_APPROVAL: "agent" }); t.after(s.restore);
	await s.owner("POST", "/owner/peers", { label: "barry" });
	const a = (await s.start({ client_id: "barry" }, "203.0.113.1", )).data;
	const ok = await s.owner("POST", `/owner/pairing/${a.user_code}/approve`);
	assert.equal(ok.status, 200);
	assert.deepEqual([ok.data.decision, ok.data.label], ["approved", "barry-2"]);
	const b = (await s.call("POST", "/oauth/device_authorization", { json: { client_id: "barry" }, ip: "203.0.113.2" })).data;
	assert.equal((await s.owner("POST", `/owner/pairing/${b.user_code}/approve`)).data.label, "barry-3", "barry-2 is reserved by the approved request");
	assert.equal((await s.poll(a.device_code)).data.token_type, "Bearer");
	assert.equal((await s.owner("POST", `/owner/pairing/${a.user_code}/approve`)).status, 409, "already decided (and redeemed)");

	const c = (await s.start(undefined, "203.0.113.3")).data;
	const dn = await s.owner("POST", `/owner/pairing/${c.user_code}/deny`);
	assert.equal(dn.data.decision, "denied");
	assert.equal((await s.poll(c.device_code)).data.error, "access_denied");
	advance(6);
	assert.equal((await s.poll(c.device_code)).data.error, "invalid_grant", "reported once, then gone");

	const e = (await s.start(undefined, "203.0.113.4")).data;
	advance(601);
	assert.equal((await s.poll(e.device_code)).data.error, "expired_token");
	assert.equal((await s.owner("POST", `/owner/pairing/${e.user_code}/approve`)).status, 409);
	advance(3600);
	assert.equal((await s.poll(e.device_code)).data.error, "expired_token", "still expired_token an hour later (RFC 8628), not invalid_grant");
	advance(86400);
	await s.start(undefined, "203.0.113.5"); // cleanup runs on new requests
	assert.equal((await s.poll(e.device_code)).data.error, "invalid_grant", "forgotten a day after expiry");

	assert.equal((await s.call("POST", "/oauth/token", { form: { grant_type: "password", device_code: "x" } })).data.error, "unsupported_grant_type");
	assert.equal((await s.call("POST", "/oauth/token", { form: { grant_type: GRANT } })).data.error, "invalid_request");
	assert.equal((await s.poll("not-a-real-code")).data.error, "invalid_grant");
	const badCard = await s.start({ client_name: "x", agent_card_url: "http://insecure.example/card" }, "203.0.113.6");
	assert.deepEqual([badCard.status, badCard.data.error], [400, "invalid_request"]);
	assert.equal((await s.owner("POST", "/owner/pairing/AEIO-0000/approve")).status, 400);
});

test("wrong-password lockout: per code (request denied) and per IP (locked even with the right password)", async (t) => {
	const s = setup(); t.after(s.restore);
	await s.owner("PUT", "/owner/pairing/password", await passwordRecord());
	const a = (await s.start(undefined, "203.0.113.10")).data;
	for (let i = 4; i >= 1; i--) assert.match((await s.decidePage(a.user_code, `guess-${i}`, "approve", "192.0.2.1")).text, new RegExp(`${i} attempts? left`));
	const last = await s.decidePage(a.user_code, "guess-0", "approve", "192.0.2.1");
	assert.match(last.text, /Too many wrong attempts for this code: the request was denied/);
	assert.equal((await s.poll(a.device_code)).data.error, "access_denied");

	// per IP: 10 wrong passwords an hour (across codes), then even the right one is refused
	const b = (await s.start(undefined, "203.0.113.11")).data;
	const c = (await s.start(undefined, "203.0.113.12")).data;
	for (let i = 0; i < 4; i++) await s.decidePage(b.user_code, "nope", "approve", "192.0.2.1");
	for (let i = 0; i < 1; i++) await s.decidePage(c.user_code, "nope", "approve", "192.0.2.1");
	const locked = await s.decidePage(c.user_code, PASSWORD, "approve", "192.0.2.1");
	assert.equal(locked.status, 429);
	assert.match(locked.text, /Too many wrong passwords/);
	// another address still works; after the hour the first one does too
	assert.equal((await s.decidePage(c.user_code, PASSWORD, "deny", "192.0.2.2")).status, 200);
	advance(3600);
	const d2 = (await s.start(undefined, "203.0.113.13")).data;
	assert.equal((await s.decidePage(d2.user_code, PASSWORD, "approve", "192.0.2.1")).status, 200);
});

test("flood control: requests per IP and outstanding requests are capped (no flood of approval prompts)", async (t) => {
	const s = setup(); t.after(s.restore);
	for (let i = 0; i < 5; i++) assert.equal((await s.start(undefined, "198.51.100.50")).status, 200);
	const sixth = await s.start(undefined, "198.51.100.50");
	assert.deepEqual([sixth.status, sixth.data.error], [429, "slow_down"]);
	assert.equal(sixth.headers.get("retry-after"), "600");
	assert.equal(s.wakes.length, 5, "no wake for refused requests");
	for (let i = 0; i < 5; i++) assert.equal((await s.start(undefined, `198.51.100.${60 + i}`)).status, 200);
	const over = await s.start(undefined, "198.51.100.99");
	assert.equal(over.status, 429);
	assert.match(over.data.error_description, /too many pairing requests waiting/);
	// expiry frees the slots
	advance(601);
	assert.equal((await s.start(undefined, "198.51.100.99")).status, 200);
	// the page: code lookups per IP are capped (no enumerating pending requests)
	for (let i = 0; i < 30; i++) assert.doesNotMatch((await s.call("GET", "/device?user_code=BCDF-2345", { ip: "192.0.2.77" })).text, /Too many code lookups/);
	assert.match((await s.call("GET", "/device?user_code=BCDF-2345", { ip: "192.0.2.77" })).text, /Too many code lookups from this address/);
	assert.doesNotMatch((await s.call("GET", "/device?user_code=BCDF-2345", { ip: "192.0.2.78" })).text, /Too many code lookups/);
});

test("pairing wakes: summary for each preset; requester text only where previews are allowed", async () => {
	const ev: WakeEvent = { contextId: "pairing", taskId: "none", taskIds: [], from: "Barry", preview: "", kind: "pairing_request", publicUrl: BASE,
		pairing: { userCode: "WDJB-2345", verificationUriComplete: `${BASE}/device?user_code=WDJB-2345`, approval: "human", clientName: "Barry", clientId: "barry", agentCardUrl: "https://barry.example.org/card", expiresIn: 600 } };
	const sum = wakeSummary(ev, "npx a2a-over-webhook");
	assert.match(sum, /^A2A pairing request: an agent calling itself "Barry" \(claimed card: "https:\/\/barry\.example\.org\/card"\) asks to connect to your inbox \(code WDJB-2345, expires in 10 minutes\)\./);
	assert.match(sum, /never approve on your own\. Show them the code WDJB-2345 and give them this link: https:\/\/agent\.example\.com\/device\?user_code=WDJB-2345/);
	const agentSum = wakeSummary({ ...ev, pairing: { ...ev.pairing!, approval: "agent" } }, "a2a");
	assert.match(agentSum, /Only if they say yes, run `a2a pair approve WDJB-2345`; if they say no \(or don't answer\), `a2a pair deny WDJB-2345`/);
	const oc = (await renderWake({ preset: "openclaw-wake", url: "https://gw.example/hooks/wake", key: "k" }, ev))!;
	const text = JSON.parse(oc.body).text;
	assert.ok(!text.includes("Barry") && !text.includes("barry.example.org"), "trusted system event: no requester text");
	assert.match(text, /WDJB-2345/);
});

test("/device deny needs no password and runs no PBKDF2; an empty password on approve costs no attempt", async (t) => {
	const s = setup(); t.after(s.restore);
	await s.owner("PUT", "/owner/pairing/password", await passwordRecord());
	const a = (await s.start(undefined, "203.0.113.20")).data;
	const g = await s.call("GET", `/device?user_code=${a.user_code}`);
	assert.match(g.text, /<button name="decision" value="deny" type="submit" class="d" formnovalidate>Deny<\/button>/, "the browser skips the required password for Deny");
	// empty password on approve: refused without hashing or counting
	let r = await s.decidePage(a.user_code, "", "approve");
	assert.equal(r.status, 400);
	assert.match(r.text, /Enter the approval password to approve/);
	assert.equal((s.DB.db.prepare("SELECT failed_attempts FROM device_requests").get() as any).failed_attempts, 0);
	assert.equal(s.DB.db.prepare("SELECT COUNT(*) AS n FROM pairing_rate WHERE key LIKE 'pw:%'").get()!.n, 0, "no wrong-password counter touched");
	// deny with no password at all
	const realPbkdf2 = crypto.subtle.deriveBits;
	let derived = 0;
	(crypto.subtle as any).deriveBits = (...x: any[]) => { derived++; return (realPbkdf2 as any).apply(crypto.subtle, x); };
	try { r = await s.decidePage(a.user_code, "", "deny"); } finally { (crypto.subtle as any).deriveBits = realPbkdf2; }
	assert.equal(r.status, 200, r.text);
	assert.match(r.text, /Denied\. Barry Bot gets no token\./);
	assert.equal(derived, 0, "no PBKDF2 for a deny");
	assert.equal((await s.poll(a.device_code)).data.error, "access_denied");
	// CSRF still applies to deny
	const b = (await s.start(undefined, "203.0.113.21")).data;
	r = await s.call("POST", "/device", { form: { csrf: "x".repeat(24), user_code: b.user_code, decision: "deny" }, cookie: `a2a_device_csrf=${"y".repeat(24)}` });
	assert.equal(r.status, 403);
	// denies count against the per-IP lookup limit (no enumerating codes through deny)
	for (let i = 0; i < 30; i++) await s.decidePage("BCDF-2345", "", "deny", "192.0.2.90");
	r = await s.decidePage(b.user_code, "", "deny", "192.0.2.90");
	assert.equal(r.status, 429);
	// without an approval password the page still offers Deny
	const s2 = setup(); t.after(s2.restore);
	const c = (await s2.start(undefined, "203.0.113.22")).data;
	const g2 = await s2.call("GET", `/device?user_code=${c.user_code}`);
	assert.match(g2.text, /pair set-password --web<\/code> and send you the one-time link/);
	assert.ok(!g2.text.includes('name="password"') && g2.text.includes('value="deny"'));
	assert.equal((await s2.decidePage(c.user_code, "", "deny")).status, 200);
});

test("re-pairing with the current token replaces it under the same label (no orphan token, no -2 label)", async (t) => {
	const s = setup({ PAIRING_APPROVAL: "agent" }); t.after(s.restore);
	const a = (await s.start(undefined, "203.0.113.30")).data;
	await s.owner("POST", `/owner/pairing/${a.user_code}/approve`);
	const first = (await s.poll(a.device_code)).data;
	assert.equal(first.peer_label, "Barry-Bot");
	// the requester sends its current token: the request is marked as a replacement
	const b = await s.call("POST", "/oauth/device_authorization", { form: { client_name: "Barry Bot", client_id: "barry" }, ip: "203.0.113.31", headers: { authorization: `Bearer ${first.access_token}` } });
	assert.equal(b.data.replaces_label, "Barry-Bot");
	assert.equal(s.wakes.at(-1).body.pairing.replacesLabel, "Barry-Bot");
	assert.equal((await s.owner("GET", "/owner/pairing")).data.pending[0].replacesLabel, "Barry-Bot");
	const g = await s.call("GET", `/device?user_code=${b.data.user_code}`);
	assert.match(g.text, /Replaces<\/th><td>the active token &quot;Barry-Bot&quot;/);
	const ok = await s.owner("POST", `/owner/pairing/${b.data.user_code}/approve`);
	assert.deepEqual([ok.data.label, ok.data.replaced], ["Barry-Bot", true]);
	const second = (await s.poll(b.data.device_code)).data;
	assert.deepEqual([second.peer_label, second.replaced], ["Barry-Bot", true]);
	const peers = (await s.owner("GET", "/owner/peers")).data;
	assert.deepEqual(peers.map((p: any) => [p.label, p.revoked_at, p.user_code]), [["Barry-Bot", null, b.data.user_code]], "one label, new code");
	const rpc = (tok: string) => s.call("POST", "/", { json: { jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "x" } }, headers: { authorization: `Bearer ${tok}` } });
	assert.equal((await rpc(first.access_token)).status, 401, "the old token stops working");
	assert.equal((await rpc(second.access_token)).status, 200);
	// a bogus bearer is ignored (ordinary request); a replaced token revoked meanwhile -> a new label
	const c = await s.call("POST", "/oauth/device_authorization", { form: { client_name: "Barry Bot" }, ip: "203.0.113.32", headers: { authorization: "Bearer nope" } });
	assert.equal(c.data.replaces_label, undefined);
	const d = await s.call("POST", "/oauth/device_authorization", { form: { client_name: "Barry Bot" }, ip: "203.0.113.33", headers: { authorization: `Bearer ${second.access_token}` } });
	await s.owner("POST", `/owner/pairing/${d.data.user_code}/approve`);
	await s.owner("DELETE", "/owner/peers/Barry-Bot");
	const third = (await s.poll(d.data.device_code)).data;
	assert.equal(third.replaced, undefined);
	assert.equal(third.peer_label, "Barry-Bot-2");
});

test("owner API: revoking an unknown or revoked label is a 404; rotate needs an existing label; off mode lists no stale requests", async (t) => {
	const s = setup(); t.after(s.restore);
	let r = await s.owner("DELETE", "/owner/peers/No-Such-Label");
	assert.deepEqual([r.status, r.data.revoked], [404, false]);
	assert.match(r.data.error, /no active token with label No-Such-Label/);
	await s.owner("POST", "/owner/peers", { label: "bob" });
	assert.deepEqual((await s.owner("DELETE", "/owner/peers/bob")).data, { revoked: true, label: "bob" });
	r = await s.owner("DELETE", "/owner/peers/bob");
	assert.equal(r.status, 404);
	assert.match(r.data.error, /already revoked/);
	r = await s.owner("POST", "/owner/peers", { label: "typo", rotate: true, mustExist: true });
	assert.equal(r.status, 404);
	assert.equal((await s.owner("POST", "/owner/peers", { label: "bob", rotate: true, mustExist: true })).status, 200, "a revoked label can be rotated back");
	await s.start(undefined, "203.0.113.40");
	assert.equal((await s.owner("GET", "/owner/pairing")).data.pending.length, 1);
	s.env.PAIRING_APPROVAL = "off";
	assert.deepEqual((await s.owner("GET", "/owner/pairing")).data.pending, []);
});

// ------------------------------------------------------------------ one-time password setup link (pair set-password --web)
async function setupFlow(s: ReturnType<typeof setup>, url: string, pw1: string, pw2 = pw1, o: { ip?: string; origin?: string; csrf?: string } = {}) {
	const path = new URL(url).pathname + new URL(url).search;
	const g = await s.call("GET", path, { ip: o.ip });
	const cookie = (g.headers.get("set-cookie") || "").split(";")[0];
	const csrf = o.csrf ?? /name="csrf" value="([^"]+)"/.exec(g.text)?.[1] ?? cookie.split("=")[1];
	const tok = new URL(url).searchParams.get("t")!;
	const post = await s.call("POST", "/device/setup", { form: { csrf, t: tok, password: pw1, password2: pw2 }, cookie, ip: o.ip, headers: { origin: o.origin ?? BASE } });
	return { get: g, post };
}

test("password setup link: one-time page sets the password (hashed on the Worker), then /device approves with it", async (t) => {
	const s = setup(); t.after(s.restore);
	const link = await s.owner("POST", "/owner/pairing/password-link", {});
	assert.equal(link.status, 200);
	assert.match(link.data.url, /^https:\/\/agent\.example\.com\/device\/setup\?t=[A-Za-z0-9_-]{43}$/);
	assert.equal(link.data.expiresIn, 900, "15 minutes by default");
	const stored = s.DB.db.prepare("SELECT value FROM settings WHERE key = 'password_setup'").get() as any;
	assert.ok(!stored.value.includes(new URL(link.data.url).searchParams.get("t")!), "only the token's hash is stored");
	assert.ok((await s.owner("GET", "/owner/pairing")).data.setupLinkExpiresAt);

	const { get, post } = await setupFlow(s, link.data.url, PASSWORD);
	assert.equal(get.status, 200);
	assert.match(get.headers.get("content-security-policy")!, /^default-src 'none'; style-src 'nonce-[A-Za-z0-9_-]+'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'$/);
	assert.equal(get.headers.get("cache-control"), "no-store");
	assert.ok(!/<script|src=/i.test(get.text), "no scripts or external assets");
	assert.match(get.text, /name="password" type="password" autocomplete="new-password" required minlength="12"/);
	assert.match(get.text, /name="password2"/);
	assert.match(get.text, /expires in 15 min/);
	assert.equal(post.status, 200, post.text);
	assert.match(post.text, /Approval password set \(\d{4}-\d\d-\d\dT[^)]+\)/);
	assert.match(post.text, /<a href="\/device">approval page<\/a>/);
	assert.ok(!post.text.includes(PASSWORD), "the password is never echoed");
	const rec = JSON.parse((s.DB.db.prepare("SELECT value FROM settings WHERE key = 'approval_password'").get() as any).value);
	assert.deepEqual([rec.alg, rec.iterations, rec.setVia], ["pbkdf2-sha256", 100000, "web"]);
	assert.ok(!JSON.stringify(rec).includes(PASSWORD));
	const list = (await s.owner("GET", "/owner/pairing")).data;
	assert.deepEqual([list.passwordSet, list.passwordSetVia, list.passwordSetAt, list.setupLinkExpiresAt], [true, "web", rec.setAt, null]);

	// reuse: the link is burned
	const again = await setupFlow(s, link.data.url, "another password 123");
	assert.equal(again.get.status, 404);
	assert.match(again.get.text, /invalid, expired or already used/);
	assert.equal(again.post.status, 404);
	// the new password works on /device
	const a = (await s.start(undefined, "203.0.113.50")).data;
	assert.equal((await s.decidePage(a.user_code, PASSWORD, "approve")).status, 200);
	// a change: the page says a password exists
	const link2 = (await s.owner("POST", "/owner/pairing/password-link", { ttlSeconds: 120 })).data;
	assert.equal(link2.expiresIn, 120);
	const ch = await setupFlow(s, link2.url, "a brand new passphrase");
	assert.match(ch.get.text, /already set \(since /);
	assert.match(ch.post.text, /Approval password changed/);
});

test("password setup link: expiry, mismatch, too short, CSRF, a new link invalidates the old one, burn after 5 bad tries", async (t) => {
	const s = setup(); t.after(s.restore);
	assert.equal((await s.owner("POST", "/owner/pairing/password-link", { ttlSeconds: 5 })).status, 400, "TTL bounds");
	assert.equal((await s.owner("POST", "/owner/pairing/password-link", { ttlSeconds: 7200 })).status, 400);
	// expiry
	const exp = (await s.owner("POST", "/owner/pairing/password-link", {})).data;
	advance(901);
	assert.equal((await setupFlow(s, exp.url, PASSWORD)).get.status, 404);
	// a new link invalidates the old one
	const old = (await s.owner("POST", "/owner/pairing/password-link", {})).data;
	const cur = (await s.owner("POST", "/owner/pairing/password-link", {})).data;
	const o = await setupFlow(s, old.url, PASSWORD);
	assert.deepEqual([o.get.status, o.post.status], [404, 404]);
	// CSRF: another Origin, or a wrong token, is refused and changes nothing
	let r = await setupFlow(s, cur.url, PASSWORD, PASSWORD, { origin: "https://evil.example" });
	assert.equal(r.post.status, 403);
	assert.match(r.post.text, /expired or came from another site/);
	r = await setupFlow(s, cur.url, PASSWORD, PASSWORD, { csrf: "z".repeat(24) });
	assert.equal(r.post.status, 403);
	assert.equal(s.DB.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'approval_password'").get()!.n, 0);
	// mismatch and too short: explained, nothing stored, password not echoed
	r = await setupFlow(s, cur.url, PASSWORD, PASSWORD + "!");
	assert.equal(r.post.status, 400);
	assert.match(r.post.text, /The two entries differ\. Nothing was changed\./);
	assert.ok(!r.post.text.includes(PASSWORD));
	r = await setupFlow(s, cur.url, "short", "short");
	assert.match(r.post.text, /Too short: use at least 12 characters/);
	for (let i = 0; i < 2; i++) await setupFlow(s, cur.url, "x", "y");
	r = await setupFlow(s, cur.url, "x", "y");
	assert.equal(r.post.status, 403);
	assert.match(r.post.text, /this link is now used up/, "the 5th bad submission burns the link");
	assert.equal((await setupFlow(s, cur.url, PASSWORD)).post.status, 404);
	assert.equal(s.DB.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'approval_password'").get()!.n, 0);
	// rate limit per IP (page loads and submissions)
	const l = (await s.owner("POST", "/owner/pairing/password-link", {})).data;
	for (let i = 0; i < 20; i++) await s.call("GET", "/device/setup?t=nope", { ip: "192.0.2.200" });
	const limited = await s.call("GET", new URL(l.url).pathname + new URL(l.url).search, { ip: "192.0.2.200" });
	assert.equal(limited.status, 429);
	// off mode: no link
	s.env.PAIRING_APPROVAL = "off";
	assert.equal((await s.owner("POST", "/owner/pairing/password-link", {})).status, 409);
	assert.equal((await s.call("GET", "/device/setup?t=x")).status, 404);
});

test("PBKDF2 iterations: stored per hash, tunable from 50,000 to 100,000; the web setup uses the deployment's count", async (t) => {
	assert.equal(P.pbkdf2Iterations(undefined), 100000);
	assert.equal(P.pbkdf2Iterations("60000"), 60000);
	assert.equal(P.pbkdf2Iterations("1000"), 100000, "out of range: the default");
	const rec = await passwordRecord();
	assert.equal(P.checkPasswordRecord({ ...rec, iterations: 50000 }), "");
	assert.match(P.checkPasswordRecord({ ...rec, iterations: 49999 }), /between 50000 and 100000/);
	const s = setup({ PBKDF2_ITERATIONS: "60000" }); t.after(s.restore);
	assert.equal((await s.owner("GET", "/owner/pairing")).data.pbkdf2Iterations, 60000);
	const link = (await s.owner("POST", "/owner/pairing/password-link", {})).data;
	await setupFlow(s, link.url, PASSWORD);
	const stored = JSON.parse((s.DB.db.prepare("SELECT value FROM settings WHERE key = 'approval_password'").get() as any).value);
	assert.equal(stored.iterations, 60000);
	const a = (await s.start(undefined, "203.0.113.60")).data;
	assert.equal((await s.decidePage(a.user_code, PASSWORD, "approve")).status, 200, "verification uses the stored count");
});
