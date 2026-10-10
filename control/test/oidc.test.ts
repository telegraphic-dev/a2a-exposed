import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import type { TenantPush } from "../src/tenants/push.ts";
import { openDb } from "./sql.ts";

const secret = "test-secret-test-secret-test-secret";

function b64url(data: Uint8Array): string {
	let raw = "";
	for (const byte of data) raw += String.fromCharCode(byte);
	return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
	const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

function b64urlDecode(value: string): Uint8Array {
	const pad = "=".repeat((4 - (value.length % 4)) % 4);
	const bin = atob(value.replace(/-/g, "+").replace(/_/g, "/") + pad);
	return Uint8Array.from(bin, (char) => char.charCodeAt(0));
}

test("the issuer stays closed until login is configured", async () => {
	const app = createApp();
	const response = await app.request("https://control.example.com/.well-known/openid-configuration");
	assert.equal(response.status, 404);
});

test("a signed-in owner can approve through the issuer and the client secret is not returned", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const pushes: TenantPush[] = [];
	const directory = new Map<string, unknown>();
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com", BRAND_NAME: "Northwind" },
		{
			database: db,
			mailer: { async send(message) { sent.push({ text: message.text }); } },
			dataPlane: {
				async putDirectory(name, entry) { directory.set(name, entry); },
				async pushConfig(body) { pushes.push(body); return { version: body.version, applied: true }; },
			},
		},
	);
	const posted = await app.request("https://control.example.com/app/sign-in", {
		method: "POST",
		headers: { origin: "https://control.example.com", "content-type": "application/x-www-form-urlencoded" },
		body: "provider=email&email=person@example.com",
	});
	assert.equal(posted.status, 303);
	const link = sent[0].text.match(/https:\/\/control\.example\.com\/api\/auth\/magic-link\/verify\?[^\s]+/);
	assert.ok(link);
	const verified = await app.request(link[0]);
	const cookie = verified.headers.getSetCookie().find((value) => value.startsWith("__Host-a2a_session="))!.split(";")[0];

	const created = await app.request("https://control.example.com/api/v1/tenants", {
		method: "POST",
		headers: { cookie, "content-type": "application/json", origin: "https://control.example.com" },
		body: JSON.stringify({ name: "northwind" }),
	});
	const createdBody = await created.json() as { owner_token: string };
	assert.equal(created.status, 201);
	const approval = pushes[0].approval as { issuer: string; clientId: string; clientSecret: string; allowedSubjects: string[]; methods: string[]; label: string };
	assert.equal(approval.issuer, "https://control.example.com");
	assert.equal(approval.label, "Northwind");
	assert.deepEqual(approval.methods, ["oidc"]);
	assert.match(approval.clientId, /^a2ac_/);
	assert.match(approval.clientSecret, /^a2acs_/);
	assert.equal(JSON.stringify(createdBody).includes(approval.clientSecret), false);
	assert.equal(JSON.stringify(directory.get("northwind")).includes(approval.clientSecret), false);
	assert.equal(JSON.stringify(createdBody).includes(createdBody.owner_token) , true);

	const discovery = await app.request("https://control.example.com/.well-known/openid-configuration");
	assert.equal(discovery.status, 200);
	const doc = await discovery.json() as { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; id_token_signing_alg_values_supported: string[] };
	assert.equal(doc.issuer, "https://control.example.com");
	assert.equal(doc.authorization_endpoint, "https://control.example.com/api/oidc/authorize");
	assert.equal(doc.token_endpoint, "https://control.example.com/api/oidc/token");
	assert.equal(doc.jwks_uri, "https://control.example.com/api/auth/jwks");
	assert.deepEqual(doc.id_token_signing_alg_values_supported, ["RS256"]);

	const { verifier, challenge } = await pkce();
	const state = b64url(crypto.getRandomValues(new Uint8Array(32)));
	const nonce = b64url(crypto.getRandomValues(new Uint8Array(32)));
	const redirectUri = "https://northwind.example.com/device/oidc/callback";
	const query = new URLSearchParams({
		response_type: "code", client_id: approval.clientId, redirect_uri: redirectUri,
		scope: "openid email", state, nonce, code_challenge: challenge, code_challenge_method: "S256",
	});
	const parked = await app.request(`https://control.example.com/api/oidc/authorize?${query}`);
	assert.equal(parked.status, 302);
	assert.equal(new URL(parked.headers.get("location") ?? "").pathname, "/app");
	const resume = parked.headers.get("set-cookie") ?? "";
	assert.match(resume, /__Host-a2a_oidc=/);
	assert.equal(resume.includes("Domain="), false);

	const returned = await app.request("https://control.example.com/app", { headers: { cookie: `${cookie}; ${resume.split(";")[0]}` } });
	assert.equal(returned.status, 302);
	assert.equal(new URL(returned.headers.get("location") ?? "").pathname, "/api/oidc/authorize");

	const authorized = await app.request(`https://control.example.com/api/oidc/authorize?${query}`, { headers: { cookie } });
	assert.equal(authorized.status, 302);
	const back = new URL(authorized.headers.get("location") ?? "");
	assert.equal(back.origin + back.pathname, redirectUri);
	assert.equal(back.searchParams.get("state"), state);
	const code = back.searchParams.get("code") ?? "";
	assert.ok(code);

	const token = await app.request("https://control.example.com/api/oidc/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code", code, redirect_uri: redirectUri,
			client_id: approval.clientId, client_secret: approval.clientSecret, code_verifier: verifier,
		}),
	});
	assert.equal(token.status, 200);
	const tokens = await token.json() as { id_token: string };
	const [encodedHeader, encodedPayload, encodedSignature] = tokens.id_token.split(".");
	const header = JSON.parse(new TextDecoder().decode(b64urlDecode(encodedHeader))) as { alg: string; kid: string };
	const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(encodedPayload))) as {
		iss: string; aud: string; azp: string; nonce: string; sub: string; email: string; email_verified: boolean;
	};
	assert.equal(header.alg, "RS256");
	assert.equal(claims.iss, "https://control.example.com");
	assert.equal(claims.aud, approval.clientId);
	assert.equal(claims.azp, approval.clientId);
	assert.equal(claims.nonce, nonce);
	assert.equal(claims.email, "person@example.com");
	assert.equal(claims.email_verified, true);
	assert.deepEqual(approval.allowedSubjects, [claims.sub]);
	const jwks = await (await app.request(doc.jwks_uri)).json() as { keys: { kid: string; n: string; e: string }[] };
	const jwk = jwks.keys.find((key) => key.kid === header.kid);
	assert.ok(jwk);
	const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256" }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
	const verifiedSignature = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(encodedSignature), new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`));
	assert.equal(verifiedSignature, true);

	const replay = await app.request("https://control.example.com/api/oidc/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code", code, redirect_uri: redirectUri,
			client_id: approval.clientId, client_secret: approval.clientSecret, code_verifier: verifier,
		}),
	});
	assert.equal(replay.status, 400);
});

test("ISSUER is the login origin when SITE_URL is a different host", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const pushes: TenantPush[] = [];
	const app = createApp(
		{
			AUTH_SECRET: secret,
			DB: db,
			ISSUER: "https://issuer.example",
			SITE_URL: "https://site.example",
			TENANT_DOMAIN: "example.com",
		},
		{
			database: db,
			mailer: { async send(message) { sent.push({ text: message.text }); } },
			dataPlane: {
				async putDirectory() {},
				async pushConfig(body) { pushes.push(body); return { version: body.version, applied: true }; },
			},
		},
	);

	const discovery = await app.request("https://issuer.example/.well-known/openid-configuration");
	assert.equal(discovery.status, 200);
	assert.equal((await discovery.json() as { issuer: string }).issuer, "https://issuer.example");
	const other = await app.request("https://site.example/.well-known/openid-configuration");
	assert.equal(other.status, 404);

	const posted = await app.request("https://issuer.example/app/sign-in", {
		method: "POST",
		headers: { origin: "https://issuer.example", "content-type": "application/x-www-form-urlencoded" },
		body: "provider=email&email=person@example.com",
	});
	assert.equal(posted.status, 303);
	assert.match(posted.headers.get("location") ?? "", /sent=1/);
	assert.match(sent[0].text, /https:\/\/issuer\.example\/api\/auth\/magic-link\/verify/);
	const wrong = await app.request("https://site.example/app/sign-in", {
		method: "POST",
		headers: { origin: "https://site.example", "content-type": "application/x-www-form-urlencoded" },
		body: "provider=email&email=person@example.com",
	});
	assert.equal(wrong.status, 404);

	const link = sent[0].text.match(/https:\/\/issuer\.example\/api\/auth\/magic-link\/verify\?[^\s]+/);
	assert.ok(link);
	const verified = await app.request(link[0]);
	const cookie = verified.headers.getSetCookie().find((value) => value.startsWith("__Host-a2a_session="))!.split(";")[0];
	const created = await app.request("https://issuer.example/api/v1/tenants", {
		method: "POST",
		headers: { cookie, "content-type": "application/json", origin: "https://issuer.example" },
		body: JSON.stringify({ name: "northwind" }),
	});
	assert.equal(created.status, 201);
	assert.equal((pushes[0].approval as { issuer: string }).issuer, "https://issuer.example");
	const onSite = await app.request("https://site.example/api/v1/tenants", {
		method: "POST",
		headers: { cookie, "content-type": "application/json", origin: "https://site.example" },
		body: JSON.stringify({ name: "other" }),
	});
	assert.equal(onSite.status, 404);
});

test("the token endpoint refuses a form larger than 4 KiB", async () => {
	const db = openDb();
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db },
		{ database: db, mailer: { async send() {} } },
	);
	const oversized = await app.request("https://control.example.com/api/oidc/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: "x".repeat(4097),
	});
	assert.equal(oversized.status, 413);
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("y".repeat(4097)));
			controller.close();
		},
	});
	const chunked = new Request("https://control.example.com/api/oidc/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: stream,
		duplex: "half",
	});
	assert.equal((await app.request(chunked)).status, 413);
	const small = await app.request("https://control.example.com/api/oidc/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: "grant_type=client_credentials",
	});
	assert.equal(small.status, 400);
});
