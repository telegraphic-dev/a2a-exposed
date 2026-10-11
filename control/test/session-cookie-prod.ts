import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { openDb } from "./sql.ts";

const origin = "https://control.example.com";
const db = openDb();
const original = globalThis.fetch;

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

globalThis.fetch = async (input, init) => {
	const url = requestUrl(input);
	if (url.startsWith("https://github.com/login/oauth/access_token")) {
		return Response.json({ access_token: "gho_test", token_type: "bearer", scope: "read:user,user:email" });
	}
	if (url === "https://api.github.com/user") {
		return Response.json({
			id: 1,
			login: "octocat",
			name: "Mona Lisa",
			email: "mona@example.com",
			avatar_url: "https://avatars.githubusercontent.com/u/1",
		});
	}
	if (url === "https://api.github.com/user/emails") {
		return Response.json([{ email: "mona@example.com", primary: true, verified: true, visibility: "public" }]);
	}
	return original(input, init);
};

const app = createApp({
	AUTH_SECRET: "test-secret-test-secret-test-secret",
	DB: db,
	GITHUB_CLIENT_ID: "gh-id",
	GITHUB_CLIENT_SECRET: "gh-secret",
	ISSUER: origin,
}, { database: db });

const posted = await app.request(`${origin}/app/sign-in`, {
	method: "POST",
	headers: { origin, "content-type": "application/x-www-form-urlencoded" },
	body: "provider=github",
});
assert.equal(posted.status, 303);
const authorize = new URL(posted.headers.get("location") ?? "");
assert.equal(authorize.origin, "https://github.com");
const state = authorize.searchParams.get("state") ?? "";
assert.ok(state);
const jar = posted.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
const callback = await app.request(`${origin}/api/auth/callback/github?code=abc&state=${encodeURIComponent(state)}`, {
	headers: { cookie: jar },
});
assert.equal(callback.status, 302, await callback.text());
const setCookies = callback.headers.getSetCookie();
const names = setCookies.map((value) => value.split("=", 1)[0]);
assert.ok(names.includes("__Host-a2a_session"), names.join(","));
assert.equal(names.some((name) => name.startsWith("__Secure-")), false);
assert.equal(setCookies.some((value) => value.includes("__Secure-__Host-")), false);
const session = setCookies.find((value) => value.startsWith("__Host-a2a_session="))!;
assert.match(session, /Secure/);
assert.equal(/domain=/i.test(session), false);
const cookie = session.split(";")[0];
const loaded = await app.request(`${origin}/api/auth/get-session`, { headers: { cookie } });
const body = await loaded.json() as { user?: { email?: string; name?: string } };
assert.equal(body.user?.email, "mona@example.com");
assert.equal(body.user?.name, "Mona Lisa");
const page = await app.request(`${origin}/app`, { headers: { cookie } });
const html = await page.text();
assert.match(html, /Mona Lisa/);
assert.match(html, /mona@example.com/);
assert.equal(html.includes("action=\"/app/sign-in\""), false);
assert.match(page.headers.get("content-security-policy") ?? "", /form-action 'self'/);
