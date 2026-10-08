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
		assert.equal(r.headers.get("www-authenticate"), 'Bearer realm="a2a"');
		assert.equal(r.data.error.code, -32000);
		assert.match(r.data.error.message, /device flow \(RFC 8628\): POST client_name and agent_card_url to https:\/\/agent\.example\.com\/oauth\/device_authorization/);
		assert.equal(r.data.error.data.pairing.device_authorization_endpoint, `${BASE}/oauth/device_authorization`);
		assert.equal(r.data.error.data.pairing.token_endpoint, `${BASE}/oauth/token`);
		assert.equal(r.data.error.data.pairing.grant_type, GRANT);
	}
	const bad = await s.call("POST", "/", { json: { jsonrpc: "2.0", id: 1, method: "SendMessage", params: {} }, headers: { authorization: "Bearer nope" } });
	assert.equal(bad.headers.get("www-authenticate"), 'Bearer realm="a2a", error="invalid_token"');
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
	assert.deepEqual(Object.keys(p.data).sort(), ["access_token", "token_type"]);
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
	await s.start(undefined, "203.0.113.5"); // cleanup runs on new requests
	assert.equal((await s.poll(e.device_code)).data.error, "invalid_grant");

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
