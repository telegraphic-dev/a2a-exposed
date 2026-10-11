import { test } from "node:test";
import assert from "node:assert/strict";
import { SIGNUP_CLOSED, emailAllowed, signupAllowlist } from "../src/auth/allowlist.ts";
import { mapCloudflareUser } from "../src/auth/cloudflare-user.ts";
import { SESSION_COOKIE } from "../src/auth/cookies.ts";
import { createApp } from "../src/app.ts";
import { openDb } from "./sql.ts";

const secret = "test-secret-test-secret-test-secret";
const origin = "https://control.example.com";

test("an empty allowlist is open and a wildcard does not cover a subdomain", () => {
	assert.equal(signupAllowlist(undefined), null);
	assert.equal(signupAllowlist("  "), null);
	assert.equal(emailAllowed(null, "person@example.com", false), true);
	const list = signupAllowlist(" Mona@Example.COM , *@Example.com , not-an-email , *@com ");
	assert.ok(list);
	assert.equal(list.emails.has("mona@example.com"), true);
	assert.equal(list.domains.has("example.com"), true);
	assert.equal(list.domains.has("com"), false);
	assert.equal(emailAllowed(list, "MONA@example.com", true), true);
	assert.equal(emailAllowed(list, "other@example.com", true), true);
	assert.equal(emailAllowed(list, "other@sub.example.com", true), false);
	assert.equal(emailAllowed(list, "mona@example.com", false), false);
	assert.equal(emailAllowed(signupAllowlist("nope"), "mona@example.com", true), false);
	const exact = signupAllowlist("O'Connor@Example.com, user!tag@example.com, has space@example.com");
	assert.ok(exact);
	assert.equal(exact.emails.has("o'connor@example.com"), true);
	assert.equal(exact.emails.has("user!tag@example.com"), true);
	assert.equal(exact.emails.has("has space@example.com"), false);
	assert.equal(emailAllowed(exact, "O'Connor@Example.com", true), true);
	assert.equal(emailAllowed(exact, "user!tag@example.com", true), true);
	const cloudflare = mapCloudflareUser({ id: "u1", email: "mona@example.com" });
	assert.equal(emailAllowed(list, cloudflare?.email ?? "", cloudflare?.emailVerified === true), false);
});

function mailerApp(allowlist?: string) {
	const db = openDb();
	const sent: { text: string }[] = [];
	const env: { AUTH_SECRET: string; DB: ReturnType<typeof openDb>; SIGNUP_ALLOWLIST?: string } = {
		AUTH_SECRET: secret,
		DB: db,
	};
	if (allowlist !== undefined) env.SIGNUP_ALLOWLIST = allowlist;
	const app = createApp(env, {
		database: db,
		mailer: { async send(message) { sent.push({ text: message.text }); } },
	});
	return { db, sent, env, app };
}

async function magicLink(app: ReturnType<typeof createApp>, sent: { text: string }[], email: string): Promise<Response> {
	const before = sent.length;
	const posted = await app.request(`${origin}/app/sign-in`, {
		method: "POST",
		headers: { origin, "content-type": "application/x-www-form-urlencoded" },
		body: `provider=email&email=${encodeURIComponent(email)}`,
	});
	assert.equal(posted.status, 303);
	assert.equal(sent.length, before + 1);
	const link = sent[before].text.match(/https:\/\/control\.example\.com\/api\/auth\/magic-link\/verify\?[^\s]+/);
	assert.ok(link);
	return app.request(link[0]);
}

test("a magic link admits a verified address on the list and refuses one that is not", async () => {
	const { db, sent, app } = mailerApp("person@example.com, *@other.test");
	const admitted = await magicLink(app, sent, "Person@Example.com");
	assert.equal(admitted.status, 302);
	assert.equal(new URL(admitted.headers.get("location") ?? "").pathname, "/app");
	const session = admitted.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`));
	assert.ok(session);
	const page = await app.request(`${origin}/app`, { headers: { cookie: session.split(";")[0] } });
	assert.match(await page.text(), /person@example.com/);

	const domain = await magicLink(app, sent, "owner@other.test");
	assert.equal(domain.status, 302);
	assert.ok(domain.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_COOKIE}=`)));

	const refused = await magicLink(app, sent, "person@sub.example.com");
	assert.equal(refused.status, 302);
	const location = new URL(refused.headers.get("location") ?? "");
	assert.equal(location.pathname, "/app");
	assert.equal(location.searchParams.get("error"), "invite");
	assert.equal(refused.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_COOKIE}=`)), false);
	const html = await (await app.request(location.href)).text();
	assert.match(html, new RegExp(SIGNUP_CLOSED.replace(/[.]/g, "\\.")));
	const count = await db.prepare('SELECT COUNT(*) AS n FROM "user"').first<{ n: number }>();
	assert.equal(count?.n, 2);
});

test("a returning user removed from the list cannot sign in again or approve a CLI", async () => {
	const { db, sent, env, app } = mailerApp("*@example.com");
	const started = await app.request(`${origin}/api/auth/device/code`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_id: "a2a-cli" }),
	});
	const codes = await started.json() as { device_code: string; user_code: string };
	const admitted = await magicLink(app, sent, "person@example.com");
	const session = admitted.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`))!.split(";")[0];
	env.SIGNUP_ALLOWLIST = "*@nope.test";
	const again = await magicLink(app, sent, "person@example.com");
	assert.equal(again.status, 302);
	assert.equal(new URL(again.headers.get("location") ?? "").searchParams.get("error"), "invite");
	assert.equal(again.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_COOKIE}=`)), false);

	const approved = await app.request(`${origin}/app/device`, {
		method: "POST",
		headers: { origin, "content-type": "application/x-www-form-urlencoded", cookie: session },
		body: `action=approve&user_code=${codes.user_code}&confirm=${codes.user_code}`,
	});
	assert.equal(approved.status, 303);
	const back = new URL(approved.headers.get("location") ?? "");
	assert.equal(back.pathname, "/app");
	assert.equal(back.searchParams.get("error"), "invite");
	const account = await app.request(back.href, { headers: { cookie: session } });
	assert.match(await account.text(), /invite-only for now/);
	const row = await db.prepare('SELECT status FROM "deviceCode"').first<{ status: string }>();
	assert.equal(row?.status, "pending");
	await db.prepare('UPDATE "deviceCode" SET "lastPolledAt" = null, status = \'approved\', userId = (SELECT id FROM "user")').run();
	const token = await app.request(`${origin}/api/auth/device/token`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			device_code: codes.device_code,
			client_id: "a2a-cli",
		}),
	});
	assert.equal(token.status, 403);
	assert.equal((await token.json() as { code?: string }).code, "invite");
});

test("GitHub sign-in uses the verified email and refuses an unverified one", async (t) => {
	const original = globalThis.fetch;
	let verified = true;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: "gho_test", token_type: "bearer" });
		if (url === "https://api.github.com/user") return Response.json({ id: 7, login: "mona", name: "Mona", email: "mona@example.com" });
		if (url === "https://api.github.com/user/emails") return Response.json([{ email: "mona@example.com", primary: true, verified, visibility: "public" }]);
		return original(input, init);
	}) as typeof fetch;
	t.after(() => { globalThis.fetch = original; });

	const db = openDb();
	const env = {
		AUTH_SECRET: secret,
		DB: db,
		GITHUB_CLIENT_ID: "gh-id",
		GITHUB_CLIENT_SECRET: "gh-secret",
		SIGNUP_ALLOWLIST: "Mona@Example.COM",
	};
	const app = createApp(env, { database: db });
	const callbackFor = async () => {
		const posted = await app.request(`${origin}/app/sign-in`, {
			method: "POST",
			headers: { origin, "content-type": "application/x-www-form-urlencoded" },
			body: "provider=github",
		});
		assert.equal(posted.status, 303);
		const authorize = new URL(posted.headers.get("location") ?? "", origin);
		const state = authorize.searchParams.get("state") ?? "";
		const jar = posted.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
		return app.request(`${origin}/api/auth/callback/github?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie: jar } });
	};
	const admitted = await callbackFor();
	assert.equal(admitted.status, 302, await admitted.clone().text());
	assert.equal(new URL(admitted.headers.get("location") ?? "", origin).searchParams.get("error"), null);
	assert.ok(admitted.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_COOKIE}=`)));

	env.SIGNUP_ALLOWLIST = "*@nope.test";
	const removed = await callbackFor();
	assert.equal(removed.status, 302);
	assert.equal(new URL(removed.headers.get("location") ?? "", origin).searchParams.get("error"), "invite");
	assert.equal(removed.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_COOKIE}=`)), false);

	verified = false;
	const fresh = openDb();
	const unverified = createApp({ ...env, DB: fresh, SIGNUP_ALLOWLIST: "*@example.com" }, { database: fresh });
	const posted = await unverified.request(`${origin}/app/sign-in`, {
		method: "POST",
		headers: { origin, "content-type": "application/x-www-form-urlencoded" },
		body: "provider=github",
	});
	const authorize = new URL(posted.headers.get("location") ?? "", origin);
	const state = authorize.searchParams.get("state") ?? "";
	const jar = posted.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
	const refused = await unverified.request(`${origin}/api/auth/callback/github?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie: jar } });
	assert.equal(refused.status, 302);
	assert.equal(new URL(refused.headers.get("location") ?? "", origin).searchParams.get("error"), "invite");
	const count = await fresh.prepare('SELECT COUNT(*) AS n FROM "user"').first<{ n: number }>();
	assert.equal(count?.n, 0);
});

test("a mistyped invite code is not shown as an allowlist refusal", async () => {
	const db = openDb();
	const app = createApp({
		AUTH_SECRET: secret,
		DB: db,
		INVITES_REQUIRED: "1",
		SIGNUP_ALLOWLIST: "person@example.com",
	}, { database: db, mailer: { async send() {} } });
	const posted = await app.request(`${origin}/app/sign-in`, {
		method: "POST",
		headers: { origin, "content-type": "application/x-www-form-urlencoded" },
		body: "provider=email&email=person@example.com&invite=not-a-code",
	});
	assert.equal(posted.status, 303);
	const location = new URL(posted.headers.get("location") ?? "", origin);
	assert.equal(location.searchParams.get("error"), "INVITE_REQUIRED");
	const html = await (await app.request(location.href)).text();
	assert.match(html, /That invite code is not valid/);
	assert.equal(html.includes(SIGNUP_CLOSED), false);
});
