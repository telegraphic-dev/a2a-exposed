import { test } from "node:test";
import assert from "node:assert/strict";
import { mapCloudflareUser } from "../src/auth/cloudflare-user.ts";
import { TRUSTED_PROVIDERS } from "../src/auth/create-auth.ts";
import { SESSION_COOKIE, hostCookie, readCookie } from "../src/auth/cookies.ts";
import { consumeInvite, insertInvite, newInviteCode } from "../src/auth/invites.ts";
import { authBlockers, resolveAuth } from "../src/auth/options.ts";
import { createApp } from "../src/app.ts";
import { openDb } from "./sql.ts";

const secret = "test-secret-test-secret-test-secret";

test("nothing configured leaves login off", () => {
	assert.deepEqual(authBlockers({}), []);
	assert.equal(resolveAuth({}, new Request("https://control.example.com/app")), null);
	assert.deepEqual(TRUSTED_PROVIDERS, []);
});

test("a provider id without its secret is not enabled", () => {
	const blockers = authBlockers({ GITHUB_CLIENT_ID: "id", AUTH_SECRET: secret, DB: openDb() });
	assert.ok(blockers.some((line) => line.includes("GitHub")));
	assert.equal(resolveAuth({ GITHUB_CLIENT_ID: "id", AUTH_SECRET: secret, DB: openDb() }, new Request("https://control.example.com/app")), null);
});

test("Cloudflare profiles are never treated as verified", () => {
	const user = mapCloudflareUser({ id: "u1", email: "person@example.com", first_name: "Pat", last_name: "Lee", email_verified: true } as { id: string; email: string; first_name: string; last_name: string });
	assert.equal(user?.emailVerified, false);
	assert.equal(user?.name, "Pat Lee");
	assert.equal(mapCloudflareUser({ id: "", email: "person@example.com" }), null);
});

test("host cookie has no Domain attribute", () => {
	const cookie = hostCookie(SESSION_COOKIE, "value", 60);
	assert.match(cookie, /^__Host-a2a_session=/);
	assert.match(cookie, /Secure/);
	assert.match(cookie, /HttpOnly/);
	assert.match(cookie, /SameSite=Lax/);
	assert.equal(cookie.includes("Domain"), false);
	assert.equal(readCookie(cookie.split(";")[0], SESSION_COOKIE), "value");
});

test("an invite code works once", async () => {
	const db = openDb();
	const code = await insertInvite(db, { email: "person@example.com" });
	assert.match(code, /^invite_[0-9a-f]{32}$/);
	assert.equal(await consumeInvite(db, code, "other@example.com"), false);
	assert.equal(await consumeInvite(db, code, "person@example.com"), true);
	assert.equal(await consumeInvite(db, code, "person@example.com"), false);
	assert.match(newInviteCode(), /^invite_[0-9a-f]{32}$/);
});

test("magic link sets the host session cookie and an invite is required only the first time", async () => {
	const db = openDb();
	const sent: { url: string }[] = [];
	const env = {
		AUTH_SECRET: secret,
		INVITES_REQUIRED: "1",
		DB: db,
	};
	const app = createApp(env, { database: db, mailer: { async send(message) { sent.push({ url: message.text }); } } });
	const page = await app.request("https://control.example.com/app");
	const html = await page.text();
	assert.match(html, /Invite code/);
	assert.match(html, /name="provider" value="email"/);
	assert.doesNotMatch(html, /value="github"/);

	const missing = await app.request("https://control.example.com/app/sign-in", {
		method: "POST",
		headers: { origin: "https://control.example.com", "content-type": "application/x-www-form-urlencoded" },
		body: "provider=email&email=person@example.com",
	});
	assert.equal(missing.status, 303);
	assert.match(missing.headers.get("location") ?? "", /error=invite/);

	const code = await insertInvite(db);
	const posted = await app.request("https://control.example.com/app/sign-in", {
		method: "POST",
		headers: { origin: "https://control.example.com", "content-type": "application/x-www-form-urlencoded" },
		body: `provider=email&email=person@example.com&invite=${code}`,
	});
	assert.equal(posted.status, 303);
	assert.match(posted.headers.get("location") ?? "", /sent=1/);
	const inviteCookie = posted.headers.getSetCookie().find((value) => value.startsWith("__Host-a2a_invite="));
	assert.ok(inviteCookie);
	assert.equal(inviteCookie.includes("Domain"), false);
	assert.equal(sent.length, 1);
	const link = sent[0].url.match(/https:\/\/control\.example\.com\/api\/auth\/magic-link\/verify\?[^\s]+/);
	assert.ok(link);

	assert.equal(link[0].includes("invite_"), false);
	const verified = await app.request(link[0]);
	assert.equal(verified.status, 302);
	const session = verified.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`));
	assert.ok(session);
	assert.match(session, /Secure/);
	assert.match(session, /HttpOnly/);
	assert.equal(session.includes("Domain"), false);

	const again = await app.request("https://control.example.com/app/sign-in", {
		method: "POST",
		headers: { origin: "https://control.example.com", "content-type": "application/x-www-form-urlencoded" },
		body: "provider=email&email=person@example.com",
	});
	assert.match(again.headers.get("location") ?? "", /sent=1/);
	const second = sent[1].url.match(/https:\/\/control\.example\.com\/api\/auth\/magic-link\/verify\?[^\s]+/);
	assert.ok(second);
	const returning = await app.request(second[0]);
	assert.equal(returning.status, 302);
	assert.ok(returning.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_COOKIE}=`)));
});

test("unconfigured auth routes stay closed", async () => {
	const app = createApp();
	const response = await app.request("https://control.example.com/api/auth/get-session");
	assert.equal(response.status, 404);
	const post = await app.request("https://control.example.com/app/sign-in", { method: "POST" });
	assert.equal(post.status, 404);
});

test("sign-in rejects a cross-origin post", async () => {
	const db = openDb();
	const app = createApp({ AUTH_SECRET: secret, DB: db }, { database: db, mailer: { async send() {} } });
	const response = await app.request("https://control.example.com/app/sign-in", {
		method: "POST",
		headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
		body: "provider=email&email=person@example.com",
	});
	assert.equal(response.status, 303);
	assert.match(response.headers.get("location") ?? "", /error=auth/);
});
