import { test } from "node:test";
import assert from "node:assert/strict";
import { SIGNUP_CLOSED, emailAllowed, signupAllowlist } from "../src/auth/allowlist.ts";
import { CLOUDFLARE_REAUTH, CLOUDFLARE_UNLINKED } from "../src/auth/cloudflare-link.ts";
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
	assert.equal(cloudflare?.emailVerified, false);
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

function cloudflareFetch(email: string) {
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: "gho_test", token_type: "bearer" });
		if (url === "https://api.github.com/user") return Response.json({ id: 7, login: "mona", name: "Mona", email: "mona@example.com" });
		if (url === "https://api.github.com/user/emails") return Response.json([{ email: "mona@example.com", primary: true, verified: true, visibility: "public" }]);
		if (url.startsWith("https://dash.cloudflare.com/oauth2/token")) return Response.json({ access_token: "cf_test", token_type: "bearer" });
		if (url === "https://api.cloudflare.com/client/v4/user") {
			return Response.json({ success: true, result: { id: "cf-user", email, first_name: "Pat", last_name: "Lee" } });
		}
		return original(input, init);
	}) as typeof fetch;
	return () => { globalThis.fetch = original; };
}

async function providerCallback(app: ReturnType<typeof createApp>, provider: "github", cookie = "") {
	const posted = await app.request(`${origin}/app/sign-in`, {
		method: "POST",
		headers: { origin, "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
		body: `provider=${provider}`,
	});
	assert.equal(posted.status, 303, await posted.clone().text());
	const authorize = new URL(posted.headers.get("location") ?? "", origin);
	const state = authorize.searchParams.get("state") ?? "";
	const jar = [cookie, ...posted.headers.getSetCookie().map((value) => value.split(";")[0])].filter(Boolean).join("; ");
	return app.request(`${origin}/api/auth/callback/${provider}?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie: jar } });
}

test("a Cloudflare callback without a session is refused and creates no session", async (t) => {
	t.after(cloudflareFetch("mona@example.com"));
	const db = openDb();
	const app = createApp({
		AUTH_SECRET: secret,
		DB: db,
		GITHUB_CLIENT_ID: "gh-id",
		GITHUB_CLIENT_SECRET: "gh-secret",
		CLOUDFLARE_OAUTH_CLIENT_ID: "cf-id",
		CLOUDFLARE_OAUTH_CLIENT_SECRET: "cf-secret",
		SIGNUP_ALLOWLIST: "Mona@Example.COM",
	}, { database: db });
	const signIn = await app.request(`${origin}/app`);
	const signInHtml = await signIn.text();
	assert.equal(signInHtml.includes("Continue with Cloudflare"), false);
	assert.equal(signInHtml.includes('value="cloudflare"'), false);
	assert.equal(signIn.headers.get("content-security-policy")?.includes("dash.cloudflare.com"), false);
	const posted = await app.request(`${origin}/app/sign-in`, {
		method: "POST",
		headers: { origin, "content-type": "application/x-www-form-urlencoded" },
		body: "provider=cloudflare",
	});
	assert.equal(posted.status, 303);
	assert.equal(new URL(posted.headers.get("location") ?? "", origin).searchParams.get("error"), "unavailable");
	assert.equal(posted.headers.get("location")?.includes("dash.cloudflare.com"), false);

	const refused = await app.request(`${origin}/api/auth/callback/cloudflare?code=abc&state=not-a-connect`);
	assert.equal(refused.status, 302);
	const location = new URL(refused.headers.get("location") ?? "", origin);
	assert.equal(location.searchParams.get("error"), "cloudflare_unlinked");
	assert.equal(refused.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_COOKIE}=`) && !value.includes("Max-Age=0")), false);
	const page = await app.request(location.href);
	assert.match(await page.text(), new RegExp(CLOUDFLARE_UNLINKED.replace(/[.]/g, "\\.")));
	assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM "user"').first<{ n: number }>())?.n, 0);
	assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM "account"').first<{ n: number }>())?.n, 0);
	assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM "session"').first<{ n: number }>())?.n, 0);

	const github = await providerCallback(app, "github");
	assert.equal(github.status, 302, await github.clone().text());
	assert.equal(new URL(github.headers.get("location") ?? "", origin).searchParams.get("error"), null);
	const session = github.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`))!.split(";")[0];
	const sessions = (await db.prepare('SELECT COUNT(*) AS n FROM "session"').first<{ n: number }>())?.n;
	const again = await app.request(`${origin}/api/auth/callback/cloudflare?code=abc&state=not-a-connect`, { headers: { cookie: session } });
	assert.equal(new URL(again.headers.get("location") ?? "", origin).searchParams.get("error"), "cloudflare_unlinked");
	assert.equal(again.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_COOKIE}=`) && !value.includes("Max-Age=0")), false);
	assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM "user"').first<{ n: number }>())?.n, 1);
	assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM "session"').first<{ n: number }>())?.n, sessions);
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM "account" WHERE "providerId" = 'cloudflare'`).first<{ n: number }>())?.n, 0);
	const stored = await db.prepare('SELECT email, "emailVerified" AS email_verified FROM "user"').first<{ email: string; email_verified: number }>();
	assert.equal(stored?.email, "mona@example.com");
	assert.equal(stored?.email_verified, 1);
});

test("connecting Cloudflare records the account, and disconnect removes it", async (t) => {
	t.after(cloudflareFetch("other@cloud.test"));
	const db = openDb();
	const env = {
		AUTH_SECRET: secret,
		DB: db,
		GITHUB_CLIENT_ID: "gh-id",
		GITHUB_CLIENT_SECRET: "gh-secret",
		CLOUDFLARE_OAUTH_CLIENT_ID: "cf-id",
		CLOUDFLARE_OAUTH_CLIENT_SECRET: "cf-secret",
		SIGNUP_ALLOWLIST: "Mona@Example.COM",
	};
	const app = createApp(env, { database: db });
	const github = await providerCallback(app, "github");
	const session = github.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`))!.split(";")[0];
	const accountPage = await app.request(`${origin}/app`, { headers: { cookie: session } });
	const html = await accountPage.text();
	assert.match(html, /Connect Cloudflare/);
	assert.match(html, /Lets Inbox set things up in your Cloudflare account\. It isn&#39;t used to sign in\./);
	assert.equal(html.includes("Continue with Cloudflare"), false);
	assert.match(html, /action="\/app\/account\/cloudflare"/);
	assert.match(accountPage.headers.get("content-security-policy") ?? "", /form-action 'self' https:\/\/dash\.cloudflare\.com/);

	const staleAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
	await db.prepare('UPDATE "session" SET "createdAt" = ?').bind(staleAt).run();
	const stale = await app.request(`${origin}/app/account/cloudflare`, {
		method: "POST",
		headers: { origin, cookie: session, "content-type": "application/x-www-form-urlencoded" },
		body: "action=connect",
	});
	assert.equal(new URL(stale.headers.get("location") ?? "", origin).searchParams.get("error"), "cloudflare_reauth");
	assert.match(await (await app.request(stale.headers.get("location") ?? "")).text(), new RegExp(CLOUDFLARE_REAUTH.replace(/[.]/g, "\\.")));
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM "account" WHERE "providerId" = 'cloudflare'`).first<{ n: number }>())?.n, 0);

	const fresh = await providerCallback(app, "github");
	const freshSession = fresh.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`))!.split(";")[0];
	const cross = await app.request(`${origin}/app/account/cloudflare`, {
		method: "POST",
		headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", cookie: freshSession, "content-type": "application/x-www-form-urlencoded" },
		body: "action=connect",
	});
	assert.equal(new URL(cross.headers.get("location") ?? "", origin).searchParams.get("error"), "origin");

	const pending = await app.request(`${origin}/app/account/cloudflare`, {
		method: "POST",
		headers: { origin, cookie: freshSession, "content-type": "application/x-www-form-urlencoded" },
		body: "action=connect",
	});
	const pendingState = new URL(pending.headers.get("location") ?? "").searchParams.get("state") ?? "";
	await db.prepare('UPDATE "session" SET "createdAt" = ?').bind(staleAt).run();
	const late = await app.request(`${origin}/api/auth/callback/cloudflare?code=abc&state=${encodeURIComponent(pendingState)}`, { headers: { cookie: freshSession } });
	assert.equal(new URL(late.headers.get("location") ?? "", origin).searchParams.get("error"), "cloudflare_reauth");
	assert.equal(late.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_COOKIE}=`) && !value.includes("Max-Age=0")), false);
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM "account" WHERE "providerId" = 'cloudflare'`).first<{ n: number }>())?.n, 0);

	const live = await providerCallback(app, "github");
	const liveSession = live.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`))!.split(";")[0];
	const connect = await app.request(`${origin}/app/account/cloudflare`, {
		method: "POST",
		headers: { origin, cookie: liveSession, "content-type": "application/x-www-form-urlencoded" },
		body: "action=connect",
	});
	assert.equal(connect.status, 303);
	const authorize = new URL(connect.headers.get("location") ?? "");
	assert.equal(authorize.origin, "https://dash.cloudflare.com");
	assert.equal(authorize.searchParams.get("scope"), "user-details.read");
	assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
	assert.match(authorize.searchParams.get("redirect_uri") ?? "", /\/api\/auth\/callback\/cloudflare$/);
	const state = authorize.searchParams.get("state") ?? "";
	assert.match(state, /^cfl_/);
	const linked = await app.request(`${origin}/api/auth/callback/cloudflare?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie: liveSession } });
	assert.equal(linked.status, 302, await linked.clone().text());
	assert.equal(new URL(linked.headers.get("location") ?? "", origin).searchParams.get("connected"), "1");
	assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM "user"').first<{ n: number }>())?.n, 1);
	const account = await db.prepare(
		`SELECT "accountId", "userId", "accessToken" AS access_token, "refreshToken" AS refresh_token FROM "account" WHERE "providerId" = 'cloudflare'`,
	).first<{ accountId: string; userId: string; access_token: string | null; refresh_token: string | null }>();
	assert.equal(account?.accountId, "cf-user");
	assert.equal(account?.access_token, null);
	assert.equal(account?.refresh_token, null);
	assert.equal(linked.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_COOKIE}=`)), false);
	const user = await db.prepare('SELECT email, name, "emailVerified" AS email_verified FROM "user"').first<{ email: string; name: string; email_verified: number }>();
	assert.equal(user?.email, "mona@example.com");
	assert.equal(user?.name, "Mona");
	assert.equal(user?.email_verified, 1);
	assert.equal(account?.userId, (await db.prepare('SELECT id FROM "user"').first<{ id: string }>())?.id);
	const again = await app.request(`${origin}/app/account/cloudflare`, {
		method: "POST",
		headers: { origin, cookie: liveSession, "content-type": "application/x-www-form-urlencoded" },
		body: "action=connect",
	});
	assert.equal(new URL(again.headers.get("location") ?? "", origin).searchParams.get("connected"), "1");
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM "account" WHERE "providerId" = 'cloudflare'`).first<{ n: number }>())?.n, 1);

	const home = await app.request(`${origin}/app`, { headers: { cookie: liveSession } });
	const homeHtml = await home.text();
	assert.match(homeHtml, /mona@example.com/);
	assert.match(homeHtml, /Disconnect Cloudflare/);
	assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM "user"').first<{ n: number }>())?.n, 1);

	const signedOut = await app.request(`${origin}/app/sign-out`, {
		method: "POST",
		headers: { origin, cookie: liveSession },
	});
	assert.equal(signedOut.status, 303);
	const sessions = (await db.prepare('SELECT COUNT(*) AS n FROM "session"').first<{ n: number }>())?.n;
	const cloudflare = await app.request(`${origin}/api/auth/callback/cloudflare?code=abc&state=not-a-connect`);
	assert.equal(cloudflare.status, 302);
	assert.equal(new URL(cloudflare.headers.get("location") ?? "", origin).searchParams.get("error"), "cloudflare_unlinked");
	assert.equal(cloudflare.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_COOKIE}=`) && !value.includes("Max-Age=0")), false);
	assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM "session"').first<{ n: number }>())?.n, sessions);
	assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM "user"').first<{ n: number }>())?.n, 1);

	const againIn = await providerCallback(app, "github");
	const returnSession = againIn.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`))!.split(";")[0];
	const disconnect = await app.request(`${origin}/app/account/cloudflare`, {
		method: "POST",
		headers: { origin, cookie: returnSession, "content-type": "application/x-www-form-urlencoded" },
		body: "action=disconnect",
	});
	assert.equal(new URL(disconnect.headers.get("location") ?? "", origin).searchParams.get("disconnected"), "1");
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM "account" WHERE "providerId" = 'cloudflare'`).first<{ n: number }>())?.n, 0);
	assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM "user"').first<{ n: number }>())?.n, 1);
	const after = await app.request(`${origin}/api/auth/callback/cloudflare?code=abc&state=not-a-connect`);
	assert.equal(new URL(after.headers.get("location") ?? "", origin).searchParams.get("error"), "cloudflare_unlinked");
	assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM "user"').first<{ n: number }>())?.n, 1);
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM "account" WHERE "providerId" = 'cloudflare'`).first<{ n: number }>())?.n, 0);
});

test("one Cloudflare account stays bound to the user who claimed it", async (t) => {
	t.after(cloudflareFetch("pat@cloud.test"));
	const db = openDb();
	const sent: { text: string }[] = [];
	const app = createApp({
		AUTH_SECRET: secret,
		DB: db,
		GITHUB_CLIENT_ID: "gh-id",
		GITHUB_CLIENT_SECRET: "gh-secret",
		CLOUDFLARE_OAUTH_CLIENT_ID: "cf-id",
		CLOUDFLARE_OAUTH_CLIENT_SECRET: "cf-secret",
		SIGNUP_ALLOWLIST: "mona@example.com, other@example.com",
	}, { database: db, mailer: { async send(message) { sent.push({ text: message.text }); } } });
	const github = await providerCallback(app, "github");
	const mona = github.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`))!.split(";")[0];
	const other = await magicLink(app, sent, "other@example.com");
	const otherSession = other.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`))!.split(";")[0];

	async function connect(cookie: string): Promise<Response> {
		const posted = await app.request(`${origin}/app/account/cloudflare`, {
			method: "POST",
			headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
			body: "action=connect",
		});
		assert.equal(posted.status, 303);
		const state = new URL(posted.headers.get("location") ?? "").searchParams.get("state") ?? "";
		assert.match(state, /^cfl_/);
		return app.request(`${origin}/api/auth/callback/cloudflare?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie } });
	}

	const [first, second] = await Promise.all([connect(mona), connect(otherSession)]);
	const outcome = (response: Response) => new URL(response.headers.get("location") ?? "", origin).searchParams;
	const outcomes = [outcome(first), outcome(second)];
	assert.deepEqual(outcomes.map((params) => params.get("connected")).filter((value) => value === "1"), ["1"]);
	assert.deepEqual(outcomes.map((params) => params.get("error")).filter(Boolean), ["account_already_linked_to_different_user"]);
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM "account" WHERE "providerId" = 'cloudflare'`).first<{ n: number }>())?.n, 1);

	const now = new Date().toISOString();
	const duplicate = db.prepare(
		`INSERT INTO "account" (id, "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES (?, 'cf-user', 'cloudflare', ?, ?, ?)`,
	).bind("second-row", (await db.prepare('SELECT id FROM "user" LIMIT 1').first<{ id: string }>())?.id, now, now);
	await assert.rejects(() => duplicate.run(), /UNIQUE constraint failed/i);
});

test("a Cloudflare connect that cannot read the provider returns to /app", async (t) => {
	const original = globalThis.fetch;
	let mode = "github";
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: "gho_test", token_type: "bearer" });
		if (url === "https://api.github.com/user") return Response.json({ id: 7, login: "mona", name: "Mona", email: "mona@example.com" });
		if (url === "https://api.github.com/user/emails") return Response.json([{ email: "mona@example.com", primary: true, verified: true, visibility: "public" }]);
		if (mode === "token-throw") throw new TypeError("fetch failed");
		if (mode === "token-bad-json") return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
		if (mode === "token-hang") return new Promise(() => {});
		if (url.startsWith("https://dash.cloudflare.com/oauth2/token")) return Response.json({ access_token: "cf_test", token_type: "bearer" });
		if (mode === "profile-throw") throw new TypeError("fetch failed");
		if (mode === "profile-bad-json") return new Response("{", { status: 200, headers: { "content-type": "application/json" } });
		return original(input, init);
	}) as typeof fetch;
	t.after(() => { globalThis.fetch = original; });

	const db = openDb();
	const app = createApp({
		AUTH_SECRET: secret,
		DB: db,
		GITHUB_CLIENT_ID: "gh-id",
		GITHUB_CLIENT_SECRET: "gh-secret",
		CLOUDFLARE_OAUTH_CLIENT_ID: "cf-id",
		CLOUDFLARE_OAUTH_CLIENT_SECRET: "cf-secret",
		SIGNUP_ALLOWLIST: "mona@example.com",
	}, { database: db, cloudflareFetchMs: 40 });
	const github = await providerCallback(app, "github");
	const session = github.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`))!.split(";")[0];

	async function connect(next: string): Promise<Response> {
		mode = "github";
		const posted = await app.request(`${origin}/app/account/cloudflare`, {
			method: "POST",
			headers: { origin, cookie: session, "content-type": "application/x-www-form-urlencoded" },
			body: "action=connect",
		});
		assert.equal(posted.status, 303);
		const state = new URL(posted.headers.get("location") ?? "").searchParams.get("state") ?? "";
		mode = next;
		const started = Date.now();
		const response = await app.request(`${origin}/api/auth/callback/cloudflare?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie: session } });
		assert.equal(response.status, 302, await response.clone().text());
		if (next === "token-hang") assert.ok(Date.now() - started < 1000, `callback took ${Date.now() - started}ms`);
		return response;
	}

	async function shows(response: Response, error: string, message: RegExp) {
		const location = new URL(response.headers.get("location") ?? "", origin);
		assert.equal(location.searchParams.get("error"), error);
		const page = await app.request(location, { headers: { cookie: session } });
		assert.match(await page.text(), message);
		assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM "account" WHERE "providerId" = 'cloudflare'`).first<{ n: number }>())?.n, 0);
	}

	await shows(await connect("token-throw"), "invalid_code", /The provider rejected the sign-in\. Try again\./);
	await shows(await connect("token-bad-json"), "invalid_code", /The provider rejected the sign-in\. Try again\./);
	await shows(await connect("profile-throw"), "unable_to_get_user_info", /The provider did not return an account\./);
	await shows(await connect("profile-bad-json"), "unable_to_get_user_info", /The provider did not return an account\./);
	await shows(await connect("token-hang"), "deadline", /Sign-in took too long\. Try again\./);
});

test("a Cloudflare connect whose profile is not JSON returns to /app", async (t) => {
	const original = globalThis.fetch;
	let profile = "json";
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: "gho_test", token_type: "bearer" });
		if (url === "https://api.github.com/user") return Response.json({ id: 7, login: "mona", name: "Mona", email: "mona@example.com" });
		if (url === "https://api.github.com/user/emails") return Response.json([{ email: "mona@example.com", primary: true, verified: true, visibility: "public" }]);
		if (url.startsWith("https://dash.cloudflare.com/oauth2/token")) return Response.json({ access_token: "cf_test", token_type: "bearer" });
		if (url === "https://api.cloudflare.com/client/v4/user") {
			if (profile === "text") return new Response("not json", { status: 200, headers: { "content-type": "application/json" } });
			return Response.json({ success: true, result: { id: "cf-user", email: "pat@cloud.test", first_name: "Pat", last_name: "Lee" } });
		}
		return original(input, init);
	}) as typeof fetch;
	t.after(() => { globalThis.fetch = original; });

	const env = {
		AUTH_SECRET: secret,
		GITHUB_CLIENT_ID: "gh-id",
		GITHUB_CLIENT_SECRET: "gh-secret",
		CLOUDFLARE_OAUTH_CLIENT_ID: "cf-id",
		CLOUDFLARE_OAUTH_CLIENT_SECRET: "cf-secret",
		SIGNUP_ALLOWLIST: "mona@example.com",
	};

	const unlinkedDb = openDb();
	const unlinked = createApp({ ...env, DB: unlinkedDb }, { database: unlinkedDb });
	profile = "text";
	const refused = await unlinked.request(`${origin}/api/auth/callback/cloudflare?code=abc&state=not-a-connect`);
	assert.equal(refused.status, 302, await refused.clone().text());
	assert.equal(new URL(refused.headers.get("location") ?? "", origin).searchParams.get("error"), "cloudflare_unlinked");
	assert.equal(refused.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_COOKIE}=`) && !value.includes("Max-Age=0")), false);
	assert.equal((await unlinkedDb.prepare('SELECT COUNT(*) AS n FROM "user"').first<{ n: number }>())?.n, 0);
	assert.equal((await unlinkedDb.prepare('SELECT COUNT(*) AS n FROM "session"').first<{ n: number }>())?.n, 0);

	profile = "json";
	const linkedDb = openDb();
	const linked = createApp({ ...env, DB: linkedDb }, { database: linkedDb });
	const github = await providerCallback(linked, "github");
	const session = github.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`))!.split(";")[0];
	const posted = await linked.request(`${origin}/app/account/cloudflare`, {
		method: "POST",
		headers: { origin, cookie: session, "content-type": "application/x-www-form-urlencoded" },
		body: "action=connect",
	});
	const state = new URL(posted.headers.get("location") ?? "").searchParams.get("state") ?? "";
	const connected = await linked.request(`${origin}/api/auth/callback/cloudflare?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie: session } });
	assert.equal(new URL(connected.headers.get("location") ?? "", origin).searchParams.get("connected"), "1");

	profile = "text";
	const again = await linked.request(`${origin}/api/auth/callback/cloudflare?code=abc&state=not-a-connect`, { headers: { cookie: session } });
	assert.equal(again.status, 302, await again.clone().text());
	assert.equal(new URL(again.headers.get("location") ?? "", origin).searchParams.get("error"), "cloudflare_unlinked");
	assert.equal(again.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_COOKIE}=`) && !value.includes("Max-Age=0")), false);
	assert.equal((await linkedDb.prepare('SELECT COUNT(*) AS n FROM "user"').first<{ n: number }>())?.n, 1);
	assert.equal((await linkedDb.prepare(`SELECT COUNT(*) AS n FROM "account" WHERE "providerId" = 'cloudflare'`).first<{ n: number }>())?.n, 1);
	const sessions = (await linkedDb.prepare('SELECT COUNT(*) AS n FROM "session"').first<{ n: number }>())?.n;
	assert.equal(sessions, 1);
});

test("a Cloudflare connect token exchange stops after its bound", async (t) => {
	const original = globalThis.fetch;
	let aborted = false;
	let tokenCalls = 0;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: "gho_test", token_type: "bearer" });
		if (url === "https://api.github.com/user") return Response.json({ id: 7, login: "mona", name: "Mona", email: "mona@example.com" });
		if (url === "https://api.github.com/user/emails") return Response.json([{ email: "mona@example.com", primary: true, verified: true, visibility: "public" }]);
		if (url.startsWith("https://dash.cloudflare.com/oauth2/token")) {
			tokenCalls += 1;
			const signal = init?.signal;
			return new Promise((_resolve, reject) => {
				const fail = () => {
					aborted = true;
					reject(new DOMException("The operation was aborted", "AbortError"));
				};
				if (signal?.aborted) return fail();
				signal?.addEventListener("abort", fail, { once: true });
			});
		}
		return original(input, init);
	}) as typeof fetch;
	t.after(() => { globalThis.fetch = original; });

	const env = {
		AUTH_SECRET: secret,
		GITHUB_CLIENT_ID: "gh-id",
		GITHUB_CLIENT_SECRET: "gh-secret",
		CLOUDFLARE_OAUTH_CLIENT_ID: "cf-id",
		CLOUDFLARE_OAUTH_CLIENT_SECRET: "cf-secret",
	};

	const idleDb = openDb();
	const idle = createApp({ ...env, DB: idleDb }, { database: idleDb, cloudflareFetchMs: 30_000 });
	const started = Date.now();
	const refused = await idle.request(`${origin}/api/auth/callback/cloudflare?code=abc&state=not-a-connect`);
	assert.ok(Date.now() - started < 1000, `callback took ${Date.now() - started}ms`);
	assert.equal(new URL(refused.headers.get("location") ?? "", origin).searchParams.get("error"), "cloudflare_unlinked");
	assert.equal(tokenCalls, 0);
	assert.equal((await idleDb.prepare('SELECT COUNT(*) AS n FROM "session"').first<{ n: number }>())?.n, 0);

	const fastDb = openDb();
	const fast = createApp({ ...env, DB: fastDb }, { database: fastDb, cloudflareFetchMs: 40 });
	const github = await providerCallback(fast, "github");
	const session = github.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`))!.split(";")[0];
	const posted = await fast.request(`${origin}/app/account/cloudflare`, {
		method: "POST",
		headers: { origin, cookie: session, "content-type": "application/x-www-form-urlencoded" },
		body: "action=connect",
	});
	const state = new URL(posted.headers.get("location") ?? "").searchParams.get("state") ?? "";
	aborted = false;
	const limitedAt = Date.now();
	const limited = await fast.request(`${origin}/api/auth/callback/cloudflare?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie: session } });
	assert.ok(Date.now() - limitedAt < 1000, `token exchange took ${Date.now() - limitedAt}ms`);
	assert.equal(limited.status, 302, await limited.clone().text());
	assert.equal(new URL(limited.headers.get("location") ?? "", origin).searchParams.get("error"), "deadline");
	assert.equal(aborted, true);
	assert.equal(limited.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_COOKIE}=`) && !value.includes("Max-Age=0")), false);
	assert.equal((await fastDb.prepare(`SELECT COUNT(*) AS n FROM "account" WHERE "providerId" = 'cloudflare'`).first<{ n: number }>())?.n, 0);
	assert.equal((await fastDb.prepare('SELECT COUNT(*) AS n FROM "user"').first<{ n: number }>())?.n, 1);
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
