import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
	assert.match(response.headers.get("location") ?? "", /error=origin$/);
});

test("a same-origin form with Origin null still reaches the provider", async () => {
	const db = openDb();
	const env = githubEnv(db);
	const options = resolveAuth(env, new Request(`${origin}/app`));
	assert.ok(options);
	let innerOrigin = "";
	const posted = await handleSignIn(new Request(`${origin}/app/sign-in`, {
		method: "POST",
		headers: {
			origin: "null",
			"sec-fetch-site": "same-origin",
			"content-type": "application/x-www-form-urlencoded",
		},
		body: "provider=github",
	}), {
		handler: async (request) => {
			innerOrigin = request.headers.get("origin") ?? "";
			return Response.json({ url: "https://github.com/login/oauth/authorize?client_id=gh-id", redirect: true });
		},
	}, options);
	assert.equal(posted.status, 303);
	assert.equal(new URL(posted.headers.get("location") ?? "").origin, "https://github.com");
	assert.equal(innerOrigin, origin);

	const app = createApp(env, { database: db });
	const browser = await app.request(`${origin}/app/sign-in`, {
		method: "POST",
		headers: {
			origin: "null",
			"sec-fetch-site": "same-origin",
			"content-type": "application/x-www-form-urlencoded",
		},
		body: "provider=github",
	});
	assert.equal(browser.status, 303);
	assert.equal(new URL(browser.headers.get("location") ?? "").origin, "https://github.com");

	const cross = await app.request(`${origin}/app/sign-in`, {
		method: "POST",
		headers: {
			origin: "null",
			"sec-fetch-site": "cross-site",
			"content-type": "application/x-www-form-urlencoded",
		},
		body: "provider=github",
	});
	assert.equal(cross.status, 303);
	assert.match(cross.headers.get("location") ?? "", /error=origin$/);
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
	assert.ok(cookies.some((value) => value.includes("better-auth.state=")));
	const stateCookie = cookies.find((value) => value.includes("better-auth.state=")) ?? "";
	assert.match(stateCookie, /HttpOnly/);
	assert.match(stateCookie, /Secure/);
	assert.match(stateCookie, /SameSite=Lax/);
	assert.equal(/SameSite=Strict/i.test(stateCookie), false);
	assert.equal(/domain=/i.test(stateCookie), false);
	assert.equal(stateCookie.startsWith("__Host-"), false);
	assert.equal(stateCookie.startsWith("__Secure-"), false);
	assert.equal(location.searchParams.get("redirect_uri"), `${origin}/api/auth/callback/github`);
	assert.match(location.searchParams.get("scope") ?? "", /user:email/);
});

test("social sign-in reads Better Auth's JSON url when Location is absent", async () => {
	const db = openDb();
	const env = githubEnv(db);
	const app = createApp(env, { database: db });
	const direct = await app.request(`${origin}/api/auth/sign-in/social`, {
		method: "POST",
		headers: { origin, "content-type": "application/json" },
		body: JSON.stringify({ provider: "github", callbackURL: "/app", errorCallbackURL: "/app" }),
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
		assert.match(posted.headers.get("location") ?? "", /error=provider_url$/);
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
	const originalFetch = globalThis.fetch;
	const originalError = console.error;
	const logged: string[] = [];
	let calls = 0;
	console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!url.startsWith("https://challenges.cloudflare.com/turnstile/v0/siteverify")) return originalFetch(input, init);
		calls += 1;
		const body = typeof init?.body === "string" ? init.body : "";
		assert.equal(body.includes("secret-key"), true);
		assert.equal(body.includes("widget-token"), true);
		if (calls === 1) return Response.json({ success: false, "error-codes": ["invalid-input-secret"] }, { status: 400 });
		return Response.json({ success: false, "error-codes": ["invalid-input-response"] });
	};
	try {
		const secret = await handleSignIn(formRequest("provider=github&cf-turnstile-response=widget-token"), {
			handler: async () => { throw new Error("not called"); },
		}, options);
		assert.match(secret.headers.get("location") ?? "", /error=invalid-input-secret$/);
		const token = await handleSignIn(formRequest("provider=github&cf-turnstile-response=widget-token"), {
			handler: async () => { throw new Error("not called"); },
		}, options);
		assert.match(token.headers.get("location") ?? "", /error=invalid-input-response$/);
		const lines = logged.filter((line) => line.includes("social_sign_in_failed"));
		assert.ok(lines.some((line) => line.includes("\"code\":\"invalid-input-secret\"")));
		assert.equal(lines.some((line) => line.includes("widget-token") || line.includes("secret-key")), false);
	} finally {
		globalThis.fetch = originalFetch;
		console.error = originalError;
	}
});

test("/app shows a message for each sign-in error", async () => {
	const db = openDb();
	const app = createApp(githubEnv(db), { database: db });
	const messages: Record<string, string> = {
		auth: "Sign-in did not complete.",
		turnstile: "Wait for the check to finish, then try again.",
		unavailable: "Login is not available.",
		invite: "That invite code is not valid.",
		email: "Enter an email address.",
		deadline: "Sign-in took too long. Try again.",
		"invalid-input-secret": "The sign-in check is not configured.",
		rate_limit: "Too many sign-in attempts. Try again in a moment.",
		provider_url: "The provider address was rejected.",
		state_mismatch: "Sign-in expired. Try again.",
		invalid_code: "The provider rejected the sign-in. Try again.",
		email_not_found: "That account has no email address.",
		unable_to_create_user: "The account could not be created.",
		access_denied: "Sign-in was cancelled.",
	};
	for (const [code, message] of Object.entries(messages)) {
		const html = await (await app.request(`${origin}/app?error=${code}`)).text();
		assert.match(html, new RegExp(`role="alert"[^>]*>${message}`));
	}
	const unknown = await (await app.request(`${origin}/app?error=not_a_code`)).text();
	assert.match(unknown, /role="alert"[^>]*>Sign-in did not complete\./);
	assert.equal(unknown.includes("not_a_code"), false);
	const quiet = await (await app.request(`${origin}/app`)).text();
	assert.equal(quiet.includes("role=\"alert\""), false);
});

test("provider buttons stay off until Turnstile finishes", async () => {
	const db = openDb();
	const app = createApp({
		...githubEnv(db),
		TURNSTILE_SITE_KEY: "site-key",
		TURNSTILE_SECRET_KEY: "secret-key",
	}, { database: db });
	const page = await app.request(`${origin}/app`);
	const html = await page.text();
	const csp = page.headers.get("content-security-policy") ?? "";
	assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
	assert.match(html, /<button[^>]*disabled[^>]*>GitHub<\/button>/);
	assert.match(html, /data-callback="a2aTurnstileReady"/);
	assert.match(html, /data-expired-callback="a2aTurnstileWait"/);
	assert.match(html, /data-error-callback="a2aTurnstileWait"/);
	assert.match(html, /src="\/turnstile\.js"/);
	assert.match(html, /src="https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js"/);
	assert.equal(/<script(?![^>]*\bsrc=)/.test(html), false);
});

test("a sign-in that does not return redirects to deadline", async () => {
	const db = openDb();
	const options = resolveAuth(githubEnv(db), new Request(`${origin}/app`));
	assert.ok(options);
	const logged: string[] = [];
	const previous = console.error;
	console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
	try {
		const started = Date.now();
		const response = await handleSignIn(formRequest("provider=github"), {
			handler: () => new Promise(() => {}),
		}, options, 40);
		assert.ok(Date.now() - started < 1000);
		assert.match(response.headers.get("location") ?? "", /error=deadline$/);
		assert.ok(logged.some((line) => line.includes("\"event\":\"social_sign_in_timeout\"")));
	} finally {
		console.error = previous;
	}
});

test("an unknown OAuth callback redirects to the sign-in error", async () => {
	const db = openDb();
	const app = createApp(githubEnv(db), { database: db });
	const logged: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		logged.push(args.map(String).join(" "));
	};
	try {
		const started = Date.now();
		const callback = await app.request(`${origin}/api/auth/callback/github?code=x&state=y`);
		assert.ok(Date.now() - started < 1000);
		assert.equal(callback.status, 302);
		const location = new URL(callback.headers.get("location") ?? "", origin);
		assert.equal(location.pathname, "/app");
		assert.deepEqual(location.searchParams.getAll("error"), ["state_mismatch"]);
		const page = await app.request(location);
		assert.match(await page.text(), /role="alert"[^>]*>Sign-in expired\. Try again\./);
		assert.ok(logged.some((line) => line.includes("\"error\":\"state_mismatch\"") && line.includes("oauth_callback_failed")));
		assert.equal(logged.some((line) => line.includes("oauth_callback_failed") && line.includes("state=y")), false);

		const errorPage = await app.request(`${origin}/api/auth/error?error=invalid_code`);
		assert.equal(errorPage.status, 302);
		const errorLocation = new URL(errorPage.headers.get("location") ?? "", origin);
		assert.equal(errorLocation.pathname, "/app");
		assert.deepEqual(errorLocation.searchParams.getAll("error"), ["invalid_code"]);
	} finally {
		console.error = original;
	}
});

test("a github callback that presents the state cookie reports invalid_code", async () => {
	const db = openDb();
	const app = createApp(githubEnv(db), { database: db });
	const posted = await app.request(formRequest("provider=github"));
	const stateCookie = posted.headers.getSetCookie().find((value) => value.includes("better-auth.state="));
	assert.ok(stateCookie);
	const authorize = new URL(posted.headers.get("location") ?? "");
	const state = authorize.searchParams.get("state");
	assert.ok(state);
	const originalFetch = globalThis.fetch;
	const logged: string[] = [];
	const originalError = console.error;
	console.error = (...args: unknown[]) => {
		logged.push(args.map(String).join(" "));
	};
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.startsWith("https://github.com/login/oauth/access_token")) {
			return Response.json({ error: "bad_verification_code", error_description: "rejected" });
		}
		return originalFetch(input, init);
	};
	try {
		const callback = await app.request(`${origin}/api/auth/callback/github?code=not-a-code&state=${encodeURIComponent(state)}`, {
			headers: { cookie: stateCookie.split(";")[0] },
		});
		assert.equal(callback.status, 302);
		const location = new URL(callback.headers.get("location") ?? "", origin);
		assert.equal(location.pathname, "/app");
		assert.deepEqual(location.searchParams.getAll("error"), ["invalid_code"]);
		const page = await app.request(location);
		assert.match(await page.text(), /role="alert"[^>]*>The provider rejected the sign-in\. Try again\./);
		const ours = logged.filter((line) => line.includes("oauth_callback_failed"));
		assert.ok(ours.some((line) => line.includes("\"error\":\"invalid_code\"")));
		assert.equal(ours.some((line) => line.includes("not-a-code") || line.includes(state)), false);
	} finally {
		globalThis.fetch = originalFetch;
		console.error = originalError;
	}
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
	assert.match(callback.headers.get("location") ?? "", /\/app\?error=deadline$/);
});

test("production sign-in keeps a Turnstile failure and a per-address limit", async () => {
	const env = { ...process.env, NODE_ENV: "production" };
	delete env.TEST;
	const child = spawn(process.execPath, ["--import", "./test/register-hooks.mjs", "./test/sign-in-prod.ts"], {
		cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
		env,
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const status = await new Promise((resolve) => child.on("close", resolve));
	assert.equal(status, 0, stderr);
});
