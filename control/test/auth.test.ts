import { test } from "node:test";
import assert from "node:assert/strict";
import { mapCloudflareUser } from "../src/auth/cloudflare-user.ts";
import { TRUSTED_PROVIDERS } from "../src/auth/create-auth.ts";
import { SESSION_COOKIE, hostCookie, readCookie } from "../src/auth/cookies.ts";
import { handleSignIn } from "../src/auth/sign-in.ts";
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

const origin = "https://control.example.com";

function githubEnv(db = openDb()) {
	return {
		AUTH_SECRET: secret,
		DB: db,
		GITHUB_CLIENT_ID: "gh-id",
		GITHUB_CLIENT_SECRET: "gh-secret",
	};
}

function formRequest(body: string): Request {
	return new Request(`${origin}/app/sign-in`, {
		method: "POST",
		headers: { origin, "content-type": "application/x-www-form-urlencoded" },
		body,
	});
}

test("github sign-in redirects to GitHub and keeps the state cookie", async () => {
	const db = openDb();
	const app = createApp(githubEnv(db), { database: db });
	const posted = await app.request(formRequest("provider=github"));
	assert.equal(posted.status, 303);
	const location = new URL(posted.headers.get("location") ?? "");
	assert.equal(location.origin, "https://github.com");
	assert.equal(location.pathname, "/login/oauth/authorize");
	const cookies = posted.headers.getSetCookie();
	assert.ok(cookies.some((value) => value.includes("state=")));
	assert.equal(cookies.some((value) => /domain=/i.test(value)), false);
});

test("social sign-in reads Better Auth's JSON url when Location is absent", async () => {
	const db = openDb();
	const env = githubEnv(db);
	const app = createApp(env, { database: db });
	const direct = await app.request(`${origin}/api/auth/sign-in/social`, {
		method: "POST",
		headers: { origin, "content-type": "application/json" },
		body: JSON.stringify({ provider: "github", callbackURL: "/app", errorCallbackURL: "/app?error=auth" }),
	});
	assert.equal(direct.status, 200);
	const body = await direct.text();
	const payload = JSON.parse(body) as { url?: string; redirect?: boolean };
	assert.equal(payload.redirect, true);
	assert.equal(new URL(payload.url ?? "").origin, "https://github.com");
	const headers = new Headers({ "content-type": "application/json" });
	for (const cookie of direct.headers.getSetCookie()) headers.append("set-cookie", cookie);
	assert.equal(headers.get("location"), null);
	const options = resolveAuth(env, new Request(`${origin}/app`));
	assert.ok(options);
	const posted = await handleSignIn(formRequest("provider=github"), {
		handler: async () => new Response(body, { status: 200, headers }),
	}, options);
	assert.equal(posted.status, 303);
	assert.equal(new URL(posted.headers.get("location") ?? "").origin, "https://github.com");
	assert.ok(posted.headers.getSetCookie().some((value) => value.includes("state=")));
});

test("a social url outside the provider list is not followed", async () => {
	const db = openDb();
	const env = githubEnv(db);
	const options = resolveAuth(env, new Request(`${origin}/app`));
	assert.ok(options);
	const cases = [
		"https://evil.example/oauth",
		"https://github.com.evil.example/login/oauth/authorize",
		"https://user:pass@github.com/login/oauth/authorize",
	];
	for (const url of cases) {
		const posted = await handleSignIn(formRequest("provider=github"), {
			handler: async () => Response.json({ url, redirect: true }),
		}, options);
		assert.equal(posted.status, 303);
		assert.match(posted.headers.get("location") ?? "", /error=auth$/);
		assert.equal(posted.headers.get("location")?.includes("evil.example"), false);
	}
	const google = await handleSignIn(formRequest("provider=google"), {
		handler: async () => Response.json({ url: "https://accounts.google.com/o/oauth2/v2/auth", redirect: true }),
	}, resolveAuth({ ...env, GOOGLE_CLIENT_ID: "g-id", GOOGLE_CLIENT_SECRET: "g-secret" }, new Request(`${origin}/app`))!);
	assert.equal(new URL(google.headers.get("location") ?? "").origin, "https://accounts.google.com");
	const cloudflare = await handleSignIn(formRequest("provider=cloudflare"), {
		handler: async () => Response.json({ url: "https://dash.cloudflare.com/oauth2/auth", redirect: true }),
	}, resolveAuth({
		AUTH_SECRET: secret,
		DB: db,
		CLOUDFLARE_OAUTH_CLIENT_ID: "cf-id",
		CLOUDFLARE_OAUTH_CLIENT_SECRET: "cf-secret",
	}, new Request(`${origin}/app`))!);
	assert.equal(new URL(cloudflare.headers.get("location") ?? "").origin, "https://dash.cloudflare.com");
});

test("social Turnstile failures redirect to error=turnstile", async () => {
	const db = openDb();
	const env = {
		...githubEnv(db),
		TURNSTILE_SITE_KEY: "site-key",
		TURNSTILE_SECRET_KEY: "secret-key",
	};
	const options = resolveAuth(env, new Request(`${origin}/app`));
	assert.ok(options);
	const missing = await handleSignIn(formRequest("provider=github"), { handler: async () => { throw new Error("not called"); } }, options);
	assert.match(missing.headers.get("location") ?? "", /error=turnstile/);
	for (const code of ["MISSING_RESPONSE", "VERIFICATION_FAILED"]) {
		const posted = await handleSignIn(formRequest("provider=github&cf-turnstile-response=token"), {
			handler: async () => Response.json({ code, message: "nope" }, { status: code === "MISSING_RESPONSE" ? 400 : 403 }),
		}, options);
		assert.match(posted.headers.get("location") ?? "", /error=turnstile/);
	}
});

test("/app shows a message for each sign-in error", async () => {
	const db = openDb();
	const app = createApp(githubEnv(db), { database: db });
	const messages: Record<string, string> = {
		auth: "Sign-in did not complete.",
		turnstile: "The check failed. Try again.",
		unavailable: "Login is not available.",
		invite: "That invite code is not valid.",
		email: "Enter an email address.",
	};
	for (const [code, message] of Object.entries(messages)) {
		const html = await (await app.request(`${origin}/app?error=${code}`)).text();
		assert.match(html, new RegExp(`role="alert"[^>]*>${message}`));
	}
	const unknown = await (await app.request(`${origin}/app?error=state_mismatch`)).text();
	assert.match(unknown, /role="alert"[^>]*>Sign-in did not complete\./);
	const quiet = await (await app.request(`${origin}/app`)).text();
	assert.equal(quiet.includes("role=\"alert\""), false);
});

test("an unknown OAuth callback redirects to the sign-in error", async () => {
	const db = openDb();
	const app = createApp(githubEnv(db), { database: db });
	const started = Date.now();
	const callback = await app.request(`${origin}/api/auth/callback/github?code=x&state=y`);
	assert.ok(Date.now() - started < 1000);
	assert.equal(callback.status, 302);
	const location = callback.headers.get("location") ?? "";
	assert.match(location, /\/app\?/);
	assert.match(location, /error=auth/);
	const page = await app.request(location);
	assert.match(await page.text(), /role="alert"[^>]*>Sign-in did not complete\./);

	const errorPage = await app.request(`${origin}/api/auth/error?error=state_mismatch`);
	assert.equal(errorPage.status, 302);
	assert.match(errorPage.headers.get("location") ?? "", /\/app\?error=auth/);
});

test("an OAuth callback that does not return still redirects", async () => {
	const db = openDb();
	const stall = {
		prepare(sql: string) {
			const statement = db.prepare(sql);
			const wrap = (bound: { bind: (...args: unknown[]) => typeof bound; first: () => Promise<unknown>; run: () => Promise<unknown> }) => ({
				bind: (...args: unknown[]) => wrap(bound.bind(...args)),
				first: () => bound.first(),
				run: () => bound.run(),
				all: () => new Promise(() => {}),
			});
			return wrap(statement);
		},
		batch: db.batch.bind(db),
		exec: db.exec.bind(db),
	};
	const app = createApp({
		AUTH_SECRET: secret,
		GITHUB_CLIENT_ID: "gh-id",
		GITHUB_CLIENT_SECRET: "gh-secret",
	}, { database: stall, callbackDeadlineMs: 40 });
	const started = Date.now();
	const callback = await app.request(`${origin}/api/auth/callback/github?code=x&state=y`);
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 1000, `callback took ${elapsed}ms`);
	assert.equal(callback.status, 302);
	assert.match(callback.headers.get("location") ?? "", /\/app\?error=auth$/);
});
