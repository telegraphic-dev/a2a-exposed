// OpenID Connect approval on /device and /oauth/authorize, against a stub issuer (discovery, token, JWKS).
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import worker, { dispatch } from "../src/index.ts";
import * as M from "../src/mcp.ts";
import { approvalPolicy } from "../src/approval-oidc.ts";
import { hostedTenantContext, parseGates, type WorkerBindings } from "../src/tenancy.ts";
import { d1 } from "./d1.ts";

const BASE = "https://agent.example.com";
const ISSUER = "https://idp.example";
const CLIENT = "client-1";
const SECRET = "oidc-client-secret";
const GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string; kty: string };
Object.assign(jwk, { kid: "k1", alg: "RS256", use: "sig" });

function signJwt(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1", typ: "JWT" }): string {
	const h = Buffer.from(JSON.stringify(header)).toString("base64url");
	const b = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const data = `${h}.${b}`;
	if (header.alg === "none") return `${data}.`;
	const sig = crypto.createSign("RSA-SHA256").update(data).sign(privateKey).toString("base64url");
	return `${data}.${sig}`;
}

function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
	const now = Math.floor(Date.now() / 1000);
	return { iss: ISSUER, aud: [CLIENT, "other"], sub: "owner-1", exp: now + 300, iat: now, ...over };
}

function setup(over: Record<string, string> = {}) {
	const DB = d1(new URL("../migrations/", import.meta.url));
	const env: any = { DB, PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", AGENT_NAME: "Test Inbox", ...over };
	const tokenBodies: Record<string, string>[] = [];
	let next: () => Record<string, unknown> = () => claims();
	const logs: string[] = [];
	const origLog = console.log;
	console.log = (line: string) => { logs.push(String(line)); };
	const origFetch = globalThis.fetch;
	globalThis.fetch = (async (url: any, init: any = {}) => {
		const u = new URL(String(url));
		if (u.origin === ISSUER && u.pathname === "/.well-known/openid-configuration")
			return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` });
		if (u.origin === ISSUER && u.pathname === "/jwks") return Response.json({ keys: [jwk] });
		if (u.origin === ISSUER && u.pathname === "/token") {
			tokenBodies.push(Object.fromEntries(new URLSearchParams(String(init.body || ""))));
			return Response.json({ id_token: signJwt(next()) });
		}
		return new Response("ok");
	}) as any;
	const call = async (method: string, path: string, o: { form?: Record<string, string>; json?: any; headers?: Record<string, string>; cookie?: string } = {}) => {
		const headers: Record<string, string> = { "cf-connecting-ip": "198.51.100.7", ...(o.headers || {}) };
		let body: string | undefined;
		if (o.form) { headers["content-type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(o.form).toString(); }
		if (o.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(o.json); }
		if (o.cookie) headers.cookie = o.cookie;
		const res = await worker.fetch(new Request(BASE + path, { method, headers, body }) as any, env, { waitUntil() {}, passThroughOnException() {} } as any);
		const text = await res.text();
		let data: any = text;
		try { data = JSON.parse(text); } catch { /* html */ }
		return { status: res.status, headers: res.headers, data, text };
	};
	const csrfOf = (text: string, setCookie: string | null) => /name="csrf" value="([^"]+)"/.exec(text)?.[1] || (setCookie || "").split(";")[0].split("=")[1] || "";
	const start = () => call("POST", "/oauth/device_authorization", { form: { client_name: "Barry Bot", client_id: "barry" } });
	const page = async (userCode: string) => {
		const g = await call("GET", `/device?user_code=${userCode}`);
		const cookie = (g.headers.get("set-cookie") || "").split(";")[0];
		return { ...g, cookie, csrf: csrfOf(g.text, g.headers.get("set-cookie")) };
	};
	const postOidc = async (userCode: string) => {
		const g = await page(userCode);
		return { page: g, post: await call("POST", "/device", { form: { csrf: g.csrf, user_code: userCode, decision: "oidc" }, cookie: g.cookie, headers: { origin: BASE } }) };
	};
	return {
		env, DB, tokenBodies, logs, call, start, page, postOidc,
		setClaims(fn: () => Record<string, unknown>) { next = fn; },
		restore: () => { globalThis.fetch = origFetch; console.log = origLog; },
	};
}

const oidcEnv = {
	APPROVAL_OIDC_ISSUER: ISSUER, APPROVAL_OIDC_CLIENT_ID: CLIENT, APPROVAL_OIDC_CLIENT_SECRET: SECRET,
	APPROVAL_OIDC_ALLOWED_SUBJECTS: "owner-1",
};

test("approval policy: unset is password only; incomplete oidc does not disable the password", () => {
	const off = parseGates({ DB: {} } as WorkerBindings).gates.approvalOidc;
	assert.deepEqual(approvalPolicy(off), { oidc: false, password: true, label: "" });
	const partial = parseGates({ DB: {}, APPROVAL_OIDC_ISSUER: ISSUER, APPROVAL_OIDC_CLIENT_ID: CLIENT, APPROVAL_METHODS: "oidc" } as WorkerBindings).gates.approvalOidc;
	assert.equal(approvalPolicy(partial).oidc, false);
	assert.equal(approvalPolicy(partial).password, true, "oidc-only with a missing secret keeps the password");
	const both = parseGates({ DB: {}, ...oidcEnv } as WorkerBindings).gates.approvalOidc;
	assert.equal(approvalPolicy(both).oidc, true);
	assert.equal(approvalPolicy(both).password, true);
	assert.equal(approvalPolicy(both).label, "idp.example");
	const explicit = parseGates({ DB: {}, ...oidcEnv, APPROVAL_METHODS: "password" } as WorkerBindings).gates.approvalOidc;
	assert.equal(approvalPolicy(explicit).oidc, false);
	assert.equal(approvalPolicy(explicit).password, true);
	const only = parseGates({ DB: {}, ...oidcEnv, APPROVAL_METHODS: "oidc" } as WorkerBindings).gates.approvalOidc;
	assert.equal(approvalPolicy(only).password, false);
});

test("unset /device has no OpenID Connect button", async (t) => {
	const s = setup(); t.after(s.restore);
	const d = await s.start();
	const g = await s.page(d.data.user_code);
	assert.equal(g.status, 200);
	assert.equal(g.text.includes("Approve with"), false);
	assert.equal(g.text.includes("Continue with"), false);
	assert.match(g.text, /No approval password is set yet/);
});

test("configured /device redirects to the issuer with PKCE and approves on a valid id token", async (t) => {
	const s = setup(oidcEnv); t.after(s.restore);
	const d = await s.start();
	const code = d.data.user_code as string;
	const { page, post } = await s.postOidc(code);
	assert.match(page.text, /Approve with idp\.example/);
	assert.match(page.text, /No approval password is set yet/);
	assert.equal(post.status, 302, post.text);
	const loc = new URL(post.headers.get("location")!);
	assert.equal(loc.origin + loc.pathname, `${ISSUER}/authorize`);
	assert.equal(loc.searchParams.get("code_challenge_method"), "S256");
	assert.equal(loc.searchParams.get("redirect_uri"), `${BASE}/device/oidc/callback`);
	assert.ok(loc.searchParams.get("state"));
	assert.ok(loc.searchParams.get("nonce"));
	assert.equal(loc.search.includes(code.replace("-", "")), false);
	assert.equal(loc.search.includes(SECRET), false);
	const nonce = loc.searchParams.get("nonce")!;
	s.setClaims(() => claims({ nonce }));
	const back = await s.call("GET", `/device/oidc/callback?code=auth-code&state=${loc.searchParams.get("state")}`);
	assert.equal(back.status, 200, back.text);
	assert.match(back.text, /Approved/);
	assert.equal(s.tokenBodies.length, 1);
	assert.equal(s.tokenBodies[0].client_secret, SECRET);
	assert.equal(s.tokenBodies[0].redirect_uri, `${BASE}/device/oidc/callback`);
	assert.equal(loc.searchParams.get("code_challenge"), await M.s256(s.tokenBodies[0].code_verifier));
	const again = await s.call("GET", `/device/oidc/callback?code=auth-code&state=${loc.searchParams.get("state")}`);
	assert.equal(again.status, 400);
	assert.match(again.text, /already used/);
	const tok = await s.call("POST", "/oauth/token", { form: { grant_type: GRANT, device_code: d.data.device_code } });
	assert.equal(tok.status, 200, tok.text);
	assert.ok(String(tok.data.access_token).startsWith("a2aow_"));
	assert.equal(s.logs.join("\n").includes(SECRET), false);
	const list = await s.call("GET", "/owner/pairing", { headers: { authorization: "Bearer owner-secret" } });
	assert.deepEqual(list.data.approvalMethods, ["password", "oidc"]);
	assert.equal(list.data.oidcIssuer, "idp.example");
});

test("wrong sub, wrong nonce and expired exp do not approve", async (t) => {
	const s = setup(oidcEnv); t.after(s.restore);
	const bad = async (over: Record<string, unknown>) => {
		const d = await s.start();
		const { post } = await s.postOidc(d.data.user_code);
		const loc = new URL(post.headers.get("location")!);
		const nonce = loc.searchParams.get("nonce")!;
		s.setClaims(() => claims({ nonce, ...over }));
		const back = await s.call("GET", `/device/oidc/callback?code=auth-code&state=${loc.searchParams.get("state")}`);
		assert.equal(back.status, 400, back.text);
		const tok = await s.call("POST", "/oauth/token", { form: { grant_type: GRANT, device_code: d.data.device_code } });
		assert.equal(tok.data.error, "authorization_pending");
	};
	await bad({ sub: "someone-else" });
	await bad({ nonce: "not-the-nonce" });
	await bad({ exp: Math.floor(Date.now() / 1000) - 120 });
	s.setClaims(() => claims());
	const d = await s.start();
	const { post } = await s.postOidc(d.data.user_code);
	const loc = new URL(post.headers.get("location")!);
	const none = signJwt(claims({ nonce: loc.searchParams.get("nonce") }), { alg: "none", typ: "JWT" });
	const orig = globalThis.fetch;
	globalThis.fetch = (async (url: any, init: any = {}) => {
		const u = new URL(String(url));
		if (u.pathname === "/token") return Response.json({ id_token: none });
		return orig(url, init);
	}) as any;
	const back = await s.call("GET", `/device/oidc/callback?code=auth-code&state=${loc.searchParams.get("state")}`);
	globalThis.fetch = orig;
	assert.equal(back.status, 400, back.text);
	const tok = await s.call("POST", "/oauth/token", { form: { grant_type: GRANT, device_code: d.data.device_code } });
	assert.equal(tok.data.error, "authorization_pending");
});

test("APPROVAL_METHODS=oidc hides the password; APPROVAL_METHODS=password hides OpenID Connect", async (t) => {
	const only = setup({ ...oidcEnv, APPROVAL_METHODS: "oidc" }); t.after(only.restore);
	const d = await only.start();
	const g = await only.page(d.data.user_code);
	assert.equal(g.text.includes('name="password"'), false);
	assert.equal(g.text.includes("No approval password is set yet"), false);
	assert.match(g.text, /Approve with idp\.example/);
	assert.match(g.text, /Deny/);
	const posted = await only.call("POST", "/device", { form: { csrf: g.csrf, user_code: d.data.user_code, decision: "approve", password: "correct horse battery staple" }, cookie: g.cookie, headers: { origin: BASE } });
	assert.equal(posted.status, 400, posted.text);
	const still = await only.call("POST", "/oauth/token", { form: { grant_type: GRANT, device_code: d.data.device_code } });
	assert.equal(still.data.error, "authorization_pending");

	const pw = setup({ ...oidcEnv, APPROVAL_METHODS: "password" }); t.after(pw.restore);
	const d2 = await pw.start();
	const g2 = await pw.page(d2.data.user_code);
	assert.equal(g2.text.includes("Approve with"), false);
	assert.match(g2.text, /No approval password is set yet/);
});

test("email allowlist matches and a hosted tenant uses its own approval, not the Worker secret", async (t) => {
	const s = setup({ ...oidcEnv, APPROVAL_OIDC_ALLOWED_SUBJECTS: "human@example.com" }); t.after(s.restore);
	const d = await s.start();
	const { post } = await s.postOidc(d.data.user_code);
	const loc = new URL(post.headers.get("location")!);
	s.setClaims(() => claims({ nonce: loc.searchParams.get("nonce")!, sub: "other", email: "human@example.com" }));
	const back = await s.call("GET", `/device/oidc/callback?code=auth-code&state=${loc.searchParams.get("state")}`);
	assert.equal(back.status, 200, back.text);
	assert.match(back.text, /Approved/);

	const DB = d1(new URL("../migrations/", import.meta.url));
	const platform: any = { DB, PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", ...oidcEnv, APPROVAL_OIDC_CLIENT_SECRET: "platform-secret", APPROVAL_METHODS: "oidc" };
	const ctx = hostedTenantContext(platform, {
		id: "ten_a", db: DB, publicUrl: BASE,
		approval: { issuer: ISSUER, clientId: CLIENT, clientSecret: "tenant-secret", allowedSubjects: ["owner-1"], label: "Example IdP" },
	});
	const ectx = { waitUntil() {}, passThroughOnException() {} } as any;
	const call = async (method: string, path: string, o: { form?: Record<string, string>; headers?: Record<string, string>; cookie?: string } = {}) => {
		const headers: Record<string, string> = { "cf-connecting-ip": "198.51.100.7", ...(o.headers || {}) };
		let body: string | undefined;
		if (o.form) { headers["content-type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(o.form).toString(); }
		if (o.cookie) headers.cookie = o.cookie;
		const res = await dispatch(new Request(BASE + path, { method, headers, body }), ctx, ectx);
		const text = await res.text();
		let data: any = text;
		try { data = JSON.parse(text); } catch { /* html */ }
		return { status: res.status, headers: res.headers, text, data };
	};
	const started = await call("POST", "/oauth/device_authorization", { form: { client_name: "Barry", client_id: "barry" } });
	const g = await call("GET", `/device?user_code=${started.data.user_code}`);
	assert.match(g.text, /Approve with Example IdP/);
	assert.equal(g.text.includes("platform"), false);
	const cookie = (g.headers.get("set-cookie") || "").split(";")[0];
	const csrf = /name="csrf" value="([^"]+)"/.exec(g.text)![1];
	const startedPost = await call("POST", "/device", { form: { csrf, user_code: started.data.user_code, decision: "oidc" }, cookie, headers: { origin: BASE } });
	assert.equal(startedPost.status, 302, startedPost.text);
	const loc2 = new URL(startedPost.headers.get("location")!);
	s.setClaims(() => claims({ nonce: loc2.searchParams.get("nonce")! }));
	const done = await call("GET", `/device/oidc/callback?code=auth-code&state=${loc2.searchParams.get("state")}`);
	assert.match(done.text, /Approved/);
	assert.equal(s.tokenBodies.at(-1)!.client_secret, "tenant-secret");
});

test("MCP consent offers Continue with the issuer and the callback issues the authorization code", async (t) => {
	const s = setup(oidcEnv); t.after(s.restore);
	const reg = await s.call("POST", "/oauth/register", { json: { client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] } });
	const verifier = Buffer.from(crypto.randomBytes(32)).toString("base64url");
	const q: Record<string, string> = { response_type: "code", client_id: reg.data.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback",
		state: "st-1", code_challenge: await M.s256(verifier), code_challenge_method: "S256", scope: "inbox", resource: `${BASE}/mcp` };
	const g = await s.call("GET", `/oauth/authorize?${new URLSearchParams(q)}`);
	assert.match(g.text, /Continue with idp\.example/);
	assert.match(g.text, /No approval password is set yet/);
	const cookie = (g.headers.get("set-cookie") || "").split(";")[0];
	const csrf = /name="csrf" value="([^"]+)"/.exec(g.text)![1];
	const post = await s.call("POST", "/oauth/authorize", { form: { ...q, csrf, decision: "oidc" }, cookie, headers: { origin: BASE } });
	assert.equal(post.status, 302, post.text);
	const loc = new URL(post.headers.get("location")!);
	assert.equal(loc.search.includes("st-1"), false, "the MCP state is not the identity provider's state");
	s.setClaims(() => claims({ nonce: loc.searchParams.get("nonce")! }));
	const back = await s.call("GET", `/oauth/authorize/oidc/callback?code=auth-code&state=${loc.searchParams.get("state")}`);
	assert.equal(back.status, 302, back.text);
	const client = new URL(back.headers.get("location")!);
	assert.equal(client.origin, "https://claude.ai");
	assert.equal(client.searchParams.get("state"), "st-1");
	assert.ok(client.searchParams.get("code"));
	const tok = await s.call("POST", "/oauth/token", { form: { grant_type: "authorization_code", code: client.searchParams.get("code")!, client_id: reg.data.client_id,
		redirect_uri: q.redirect_uri, code_verifier: verifier, resource: `${BASE}/mcp` } });
	assert.equal(tok.status, 200, tok.text);
	assert.ok(String(tok.data.access_token).startsWith("a2amcp_"));
});
