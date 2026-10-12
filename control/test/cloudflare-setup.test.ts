import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import {
	deleteCloudflareGrant,
	openCloudflareRefresh,
	readCloudflareGrant,
	refreshCloudflareGrant,
	saveCloudflareGrant,
	sealCloudflareRefresh,
} from "../src/auth/cloudflare-grant.ts";
import { SESSION_COOKIE } from "../src/auth/cookies.ts";
import {
	ACCESS_NOT_REQUESTED,
	D1_WRITE,
	DNS_WRITE,
	OFFLINE_ACCESS,
	SETUP_NOT_PROVISIONED,
	TUNNEL_CONNECTOR_LATER,
	TUNNEL_WRITE,
	USER_DETAILS_READ,
	WORKERS_ROUTES_WRITE,
	WORKERS_WRITE,
	ZONE_READ,
	cloudflareAuthorizeUrl,
	consentScope,
	describeSetupGrant,
	setupScopes,
	type SetupChoice,
	type SetupHost,
} from "../src/auth/cloudflare-setup.ts";
import { openDb } from "./sql.ts";

const secret = "test-secret-test-secret-test-secret";
const origin = "https://control.example.com";
const INBOX_WORKERS = [
	USER_DETAILS_READ,
	"account-settings.read",
	WORKERS_WRITE,
	D1_WRITE,
	OFFLINE_ACCESS,
];
const ZONE_SCOPES = [WORKERS_ROUTES_WRITE, DNS_WRITE, ZONE_READ];

test("each setup choice requests only the scopes that choice needs", () => {
	const ids = (choice: SetupChoice, host: SetupHost) => setupScopes(choice, host).map((scope) => scope.id);
	assert.deepEqual(ids("inbox", "workers"), INBOX_WORKERS);
	assert.deepEqual(ids("inbox", "zone"), [...INBOX_WORKERS.slice(0, 4), ...ZONE_SCOPES, OFFLINE_ACCESS]);
	assert.deepEqual(ids("facade", "workers"), [...INBOX_WORKERS.slice(0, 4), TUNNEL_WRITE, OFFLINE_ACCESS]);
	assert.deepEqual(ids("facade", "zone"), [...INBOX_WORKERS.slice(0, 4), ...ZONE_SCOPES, TUNNEL_WRITE, OFFLINE_ACCESS]);
	assert.deepEqual(ids("both", "workers"), [...INBOX_WORKERS.slice(0, 4), TUNNEL_WRITE, OFFLINE_ACCESS]);
	assert.deepEqual(ids("both", "zone"), [...INBOX_WORKERS.slice(0, 4), ...ZONE_SCOPES, TUNNEL_WRITE, OFFLINE_ACCESS]);
	for (const choice of ["inbox", "facade", "both"] as const) {
		for (const host of ["workers", "zone"] as const) {
			const list = ids(choice, host);
			assert.equal(new Set(list).size, list.length);
			assert.equal(list.includes("access-app.write"), false);
			assert.equal(list.includes("workers-platform.write"), false);
			assert.equal(list.includes("workers-scripts.write"), false);
			assert.equal(list.includes("account:read"), false);
			assert.equal(list.includes("user:read"), false);
			assert.equal(list.includes(WORKERS_WRITE), true);
			assert.equal(list.includes(ZONE_READ), host === "zone");
			assert.equal(list.includes(DNS_WRITE), host === "zone");
			assert.equal(list.includes(WORKERS_ROUTES_WRITE), host === "zone");
			assert.equal(list.includes(TUNNEL_WRITE), choice !== "inbox");
			assert.equal(consentScope(choice, host), list.join(" "));
		}
	}
});

test("the consent URL carries that scope list and PKCE", () => {
	const scope = consentScope("both", "zone");
	const url = new URL(cloudflareAuthorizeUrl({
		clientId: "cf-id",
		redirectUri: "https://control.example.com/api/auth/callback/cloudflare",
		scope,
		state: "cfl_state",
		codeChallenge: "challenge",
	}));
	assert.equal(url.origin, "https://dash.cloudflare.com");
	assert.equal(url.pathname, "/oauth2/auth");
	assert.equal(url.searchParams.get("client_id"), "cf-id");
	assert.equal(url.searchParams.get("redirect_uri"), "https://control.example.com/api/auth/callback/cloudflare");
	assert.equal(url.searchParams.get("response_type"), "code");
	assert.equal(url.searchParams.get("scope"), scope);
	assert.equal(url.searchParams.get("state"), "cfl_state");
	assert.equal(url.searchParams.get("code_challenge"), "challenge");
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.equal(scope.includes("access-app.write"), false);
});

test("a declined optional scope names the setup it blocks", () => {
	const bothZone = describeSetupGrant({
		choice: "both",
		host: "zone",
		granted_scope: `${USER_DETAILS_READ} account-settings.read ${WORKERS_WRITE}`,
		refresh_enc: null,
	});
	assert.ok(bothZone);
	assert.match(bothZone.blocked.join(" "), /Without D1 Write/);
	assert.match(bothZone.blocked.join(" "), /blocks the new inbox and the façade/);
	assert.match(bothZone.blocked.join(" "), /Without Zone Read/);
	assert.match(bothZone.blocked.join(" "), /own domain/);
	assert.match(bothZone.blocked.join(" "), /Without Cloudflare Tunnel Write/);
	assert.match(bothZone.blocked.join(" "), /blocks the façade/);
	assert.match(bothZone.blocked.join(" "), /inbox does not need a tunnel/);
	assert.match(bothZone.blocked.join(" "), /Without a refresh token/);
	assert.equal(bothZone.lines.find((line) => line.name === "Workers Edit")?.state, "granted");
	assert.equal(bothZone.lines.find((line) => line.name === "D1 Write")?.state, "declined");

	const workers = describeSetupGrant({
		choice: "inbox",
		host: "workers",
		granted_scope: consentScope("inbox", "workers"),
		refresh_enc: "v1.sealed",
	});
	assert.ok(workers);
	assert.deepEqual(workers.blocked, []);
	assert.equal(workers.lines.some((line) => line.name === "Zone Read"), false);
	assert.equal(workers.refreshSaved, true);

	const unknown = describeSetupGrant({
		choice: "inbox",
		host: "workers",
		granted_scope: null,
		refresh_enc: null,
	});
	assert.match(unknown?.blocked.join(" ") ?? "", /did not say which permissions/);
	assert.equal(unknown?.lines.every((line) => line.state === "unknown"), true);
});

test("the refresh token seals for one user and the ciphertext is not the token", async () => {
	const token = "refresh-token-SECRET-value";
	const sealed = await sealCloudflareRefresh(secret, "user-1", token);
	assert.ok(sealed);
	assert.equal(sealed.includes(token), false);
	assert.equal(await openCloudflareRefresh(secret, "user-1", sealed), token);
	assert.equal(await openCloudflareRefresh(secret, "user-2", sealed), null);
	assert.equal(await openCloudflareRefresh("another-secret-another-secret-xxxx", "user-1", sealed), null);
	assert.equal(await sealCloudflareRefresh("short", "user-1", token), null);
});

function githubFetch(scope: string, refresh = "cf_refresh_SECRET") {
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: "gho_test", token_type: "bearer" });
		if (url === "https://api.github.com/user") return Response.json({ id: 7, login: "mona", name: "Mona", email: "mona@example.com" });
		if (url === "https://api.github.com/user/emails") return Response.json([{ email: "mona@example.com", primary: true, verified: true, visibility: "public" }]);
		if (url.startsWith("https://dash.cloudflare.com/oauth2/token")) {
			return Response.json({
				access_token: "cf_access_SECRET",
				refresh_token: refresh,
				token_type: "bearer",
				expires_in: 3600,
				scope,
			});
		}
		if (url === "https://api.cloudflare.com/client/v4/user") {
			return Response.json({ success: true, result: { id: "cf-user", email: "pat@cloud.test", first_name: "Pat", last_name: "Lee" } });
		}
		return original(input);
	}) as typeof fetch;
	return () => { globalThis.fetch = original; };
}

async function signIn(app: ReturnType<typeof createApp>) {
	const posted = await app.request(`${origin}/app/sign-in`, {
		method: "POST",
		headers: { origin, "content-type": "application/x-www-form-urlencoded" },
		body: "provider=github",
	});
	const authorize = new URL(posted.headers.get("location") ?? "", origin);
	const state = authorize.searchParams.get("state") ?? "";
	const jar = posted.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
	const done = await app.request(`${origin}/api/auth/callback/github?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie: jar } });
	return done.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`))!.split(";")[0];
}

test("the choice page explains a workers.dev inbox, then asks Cloudflare only for those scopes", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = createApp({
		AUTH_SECRET: secret,
		DB: db,
		GITHUB_CLIENT_ID: "gh-id",
		GITHUB_CLIENT_SECRET: "gh-secret",
		CLOUDFLARE_OAUTH_CLIENT_ID: "cf-id",
		CLOUDFLARE_OAUTH_CLIENT_SECRET: "cf-secret",
	}, { database: db });
	const signedOut = await app.request(`${origin}/app/cloudflare`);
	assert.equal(signedOut.status, 303);
	assert.equal(new URL(signedOut.headers.get("location") ?? "", origin).pathname, "/app");

	const off = createApp({ AUTH_SECRET: secret, DB: db, GITHUB_CLIENT_ID: "gh-id", GITHUB_CLIENT_SECRET: "gh-secret" }, { database: db });
	assert.equal((await off.request(`${origin}/app/cloudflare`)).status, 404);

	const cookie = await signIn(app);
	const page = await app.request(`${origin}/app/cloudflare`, { headers: { cookie } });
	const html = await page.text();
	assert.match(html, /Set me up on Cloudflare/);
	assert.match(html, /available on every plan/);
	assert.match(html, /What do you want\?/);
	assert.match(html, /Give my agent a public A2A address/);
	assert.match(html, /It receives messages, and we wake it by webhook/);
	assert.match(html, /Make an agent I already run reachable by other agents/);
	assert.match(html, /We connect it securely/);
	assert.match(html, /Which web address\?/);
	assert.match(html, /A free address from Cloudflare/);
	assert.match(html, /https:\/\/my-agent\.yourname\.workers\.dev/);
	assert.match(html, /https:\/\/agent\.example\.com/);
	assert.match(html, /class="choice"/);
	assert.match(html, /does not ask to list your domains or edit DNS/);
	assert.equal(html.includes("older than 10 minutes"), false);
	assert.match(html, /asks for permission only/);
	assert.match(html, /comes later/);
	assert.equal(html.includes("Nothing has been created"), false);
	assert.match(page.headers.get("content-security-policy") ?? "", /form-action 'self' https:\/\/dash\.cloudflare\.com/);

	const review = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=review&choice=inbox&host=workers",
	});
	const reviewHtml = await review.text();
	assert.equal(review.status, 200);
	assert.match(reviewHtml, /give your agent a public A2A address/);
	assert.match(reviewHtml, /my-agent\.yourname\.workers\.dev/);
	assert.match(reviewHtml, /D1 Write/);
	assert.match(reviewHtml, /Workers Edit/);
	assert.match(reviewHtml, /Continue to Cloudflare/);
	assert.equal(reviewHtml.includes("Zone Read"), false);
	assert.equal(reviewHtml.includes("DNS Write"), false);
	assert.equal(reviewHtml.includes("Cloudflare Tunnel Write"), false);
	assert.equal(reviewHtml.includes(ACCESS_NOT_REQUESTED), false);
	assert.match(review.headers.get("content-security-policy") ?? "", /https:\/\/dash\.cloudflare\.com/);

	const missing = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=consent&choice=nope&host=workers",
	});
	assert.equal(new URL(missing.headers.get("location") ?? "", origin).searchParams.get("error"), "choice");
	assert.match(await (await app.request(missing.headers.get("location") ?? "", { headers: { cookie } })).text(), /Choose what to set up/);

	const consent = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=consent&choice=inbox&host=workers",
	});
	const authorize = new URL(consent.headers.get("location") ?? "");
	assert.equal(authorize.searchParams.get("scope"), INBOX_WORKERS.join(" "));
	assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
	assert.match(authorize.searchParams.get("redirect_uri") ?? "", /\/api\/auth\/callback\/cloudflare$/);
	const state = authorize.searchParams.get("state") ?? "";
	const linked = await app.request(`${origin}/api/auth/callback/cloudflare?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie } });
	const landed = new URL(linked.headers.get("location") ?? "", origin);
	assert.equal(landed.pathname, "/app/cloudflare");
	assert.equal(landed.searchParams.get("connected"), "1");
	const done = await app.request(landed, { headers: { cookie } });
	const doneHtml = await done.text();
	assert.match(doneHtml, /Nothing has been created in your Cloudflare account yet/);
	assert.match(doneHtml, /A refresh token is saved encrypted/);
	assert.match(doneHtml, /single-use/);
	assert.match(doneHtml, /does not use it yet/);
	assert.equal(doneHtml.includes("Not granted."), false);
	assert.equal(doneHtml.includes("cf_refresh_SECRET"), false);
	assert.equal(doneHtml.includes("cf_access_SECRET"), false);
	const account = await db.prepare(
		`SELECT "accessToken" AS access_token, "refreshToken" AS refresh_token FROM "account" WHERE "providerId" = 'cloudflare'`,
	).first<{ access_token: string | null; refresh_token: string | null }>();
	assert.equal(account?.access_token, null);
	assert.equal(account?.refresh_token, null);
	const grant = await readCloudflareGrant(db, (await db.prepare('SELECT id FROM "user"').first<{ id: string }>())?.id ?? "");
	assert.equal(grant?.choice, "inbox");
	assert.equal(grant?.host, "workers");
	assert.equal(grant?.requested_scope, INBOX_WORKERS.join(" "));
	assert.ok(grant?.refresh_enc);
	assert.equal(grant.refresh_enc.includes("cf_refresh_SECRET"), false);
	assert.equal(JSON.stringify(grant).includes("cf_access_SECRET"), false);
	const userId = grant.userId;
	assert.equal(await openCloudflareRefresh(secret, userId, grant.refresh_enc), "cf_refresh_SECRET");

	const old = await app.request(`${origin}/app/account/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=connect",
	});
	assert.equal(new URL(old.headers.get("location") ?? "", origin).pathname, "/app/cloudflare");
	assert.equal(old.headers.get("location")?.includes("dash.cloudflare.com"), false);
});

test("a façade on your own domain asks for the tunnel and the zone, and a declined scope is named", async (t) => {
	const granted = consentScope("facade", "zone").split(" ").filter((scope) => scope !== D1_WRITE && scope !== TUNNEL_WRITE).join(" ");
	t.after(githubFetch(granted, ""));
	const db = openDb();
	const app = createApp({
		AUTH_SECRET: secret,
		DB: db,
		GITHUB_CLIENT_ID: "gh-id",
		GITHUB_CLIENT_SECRET: "gh-secret",
		CLOUDFLARE_OAUTH_CLIENT_ID: "cf-id",
		CLOUDFLARE_OAUTH_CLIENT_SECRET: "cf-secret",
	}, { database: db });
	const cookie = await signIn(app);
	const review = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=review&choice=facade&host=zone",
	});
	const reviewHtml = await review.text();
	assert.match(reviewHtml, /agent you already run reachable/);
	assert.match(reviewHtml, /agent\.example\.com/);
	assert.match(reviewHtml, /Cloudflare Tunnel Write/);
	assert.match(reviewHtml, /Zone Read/);
	assert.match(reviewHtml, /DNS Write/);
	assert.match(reviewHtml, new RegExp(TUNNEL_CONNECTOR_LATER.replace(/[.]/g, "\\.")));
	assert.match(reviewHtml, /does not ask for Cloudflare Access/);
	assert.equal(reviewHtml.includes("access-app.write"), false);
	const consent = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=consent&choice=facade&host=zone",
	});
	const authorize = new URL(consent.headers.get("location") ?? "");
	assert.equal(authorize.searchParams.get("scope"), consentScope("facade", "zone"));
	const state = authorize.searchParams.get("state") ?? "";
	const linked = await app.request(`${origin}/api/auth/callback/cloudflare?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie } });
	const doneHtml = await (await app.request(linked.headers.get("location") ?? "", { headers: { cookie } })).text();
	assert.match(doneHtml, /Without D1 Write/);
	assert.match(doneHtml, /blocks the façade/);
	assert.match(doneHtml, /Without Cloudflare Tunnel Write/);
	assert.match(doneHtml, new RegExp(SETUP_NOT_PROVISIONED.replace(/[.]/g, "\\.")));
	assert.match(doneHtml, /No refresh token is saved/);
	assert.equal(doneHtml.includes("cf_access_SECRET"), false);
	const userId = (await db.prepare('SELECT id FROM "user"').first<{ id: string }>())?.id ?? "";
	const grant = await readCloudflareGrant(db, userId);
	assert.equal(grant?.refresh_enc, null);
	assert.equal(grant?.choice, "facade");
	assert.equal(grant?.host, "zone");

	const disconnect = await app.request(`${origin}/app/account/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=disconnect",
	});
	assert.equal(new URL(disconnect.headers.get("location") ?? "", origin).searchParams.get("disconnected"), "1");
	assert.equal(await readCloudflareGrant(db, userId), null);
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM "account" WHERE "providerId" = 'cloudflare'`).first<{ n: number }>())?.n, 0);
});

test("a refresh stores the new single-use token and a rejection drops the old one", async (t) => {
	const db = openDb();
	const now = new Date().toISOString();
	await db.prepare(
		`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('user-1', 'Mona', 'mona@example.com', 1, ?, ?)`,
	).bind(now, now).run();
	await saveCloudflareGrant(db, secret, {
		userId: "user-1",
		accountId: "cf-user",
		choice: "inbox",
		host: "workers",
		requestedScope: INBOX_WORKERS.join(" "),
		grantedScope: INBOX_WORKERS.join(" "),
		refreshToken: "refresh-one-SECRET",
		expiresIn: 3600,
	});
	const stored = await readCloudflareGrant(db, "user-1");
	assert.ok(stored?.refresh_enc);
	assert.equal(stored.refresh_enc.includes("refresh-one-SECRET"), false);

	const original = globalThis.fetch;
	const sent: string[] = [];
	let mode = "rotate";
	globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		const body = String(init?.body ?? "");
		sent.push(body);
		if (mode === "hang") {
			const signal = init?.signal;
			return new Promise((_resolve, reject) => {
				const fail = () => reject(new DOMException("The operation was aborted", "AbortError"));
				if (signal?.aborted) return fail();
				signal?.addEventListener("abort", fail, { once: true });
			});
		}
		if (mode === "reject") return new Response("", { status: 401 });
		if (mode === "down") return new Response("", { status: 503 });
		const refresh = new URLSearchParams(body).get("refresh_token");
		const next = refresh === "refresh-one-SECRET" ? "refresh-two-SECRET" : "refresh-three-SECRET";
		return Response.json({ access_token: "access-SECRET", refresh_token: next, expires_in: 60, scope: INBOX_WORKERS.join(" ") });
	}) as typeof fetch;
	t.after(() => { globalThis.fetch = original; });

	const client = { database: db, secret, clientId: "cf-id", clientSecret: "cf-secret", userId: "user-1" };
	const first = await refreshCloudflareGrant(client);
	assert.equal(first.ok, true);
	if (first.ok) assert.equal(first.accessToken, "access-SECRET");
	assert.match(sent[0] ?? "", /refresh-one-SECRET/);
	assert.equal(await openCloudflareRefresh(secret, "user-1", (await readCloudflareGrant(db, "user-1"))?.refresh_enc), "refresh-two-SECRET");
	const second = await refreshCloudflareGrant(client);
	assert.equal(second.ok, true);
	assert.match(sent[1] ?? "", /refresh-two-SECRET/);
	assert.equal(sent[1]?.includes("refresh-one-SECRET"), false);
	assert.equal(await openCloudflareRefresh(secret, "user-1", (await readCloudflareGrant(db, "user-1"))?.refresh_enc), "refresh-three-SECRET");
	const raw = JSON.stringify(await readCloudflareGrant(db, "user-1"));
	assert.equal(raw.includes("refresh-one-SECRET"), false);
	assert.equal(raw.includes("refresh-two-SECRET"), false);
	assert.equal(raw.includes("refresh-three-SECRET"), false);
	assert.equal(raw.includes("access-SECRET"), false);

	mode = "down";
	const kept = await refreshCloudflareGrant(client);
	assert.equal(kept.ok, false);
	if (!kept.ok) assert.equal(kept.error, "failed");
	assert.equal(await openCloudflareRefresh(secret, "user-1", (await readCloudflareGrant(db, "user-1"))?.refresh_enc), "refresh-three-SECRET");

	mode = "hang";
	const stalled = await refreshCloudflareGrant({ ...client, fetchMs: 40 });
	assert.equal(stalled.ok, false);
	if (!stalled.ok) assert.equal(stalled.error, "uncertain");
	assert.equal(await openCloudflareRefresh(secret, "user-1", (await readCloudflareGrant(db, "user-1"))?.refresh_enc), "refresh-three-SECRET");

	const until = Date.now() + 60_000;
	await db.prepare(`UPDATE control_locks SET holder = 'other-holder', expires_ms = ? WHERE name = 'cf-refresh:user-1'`).bind(until).run();
	mode = "rotate";
	const before = sent.length;
	const busy = await refreshCloudflareGrant(client);
	assert.equal(busy.ok, false);
	if (!busy.ok) assert.equal(busy.error, "busy");
	assert.equal(sent.length, before);
	await db.prepare(`UPDATE control_locks SET expires_ms = 0 WHERE name = 'cf-refresh:user-1'`).run();

	mode = "reject";
	const rejected = await refreshCloudflareGrant(client);
	assert.equal(rejected.ok, false);
	if (!rejected.ok) assert.equal(rejected.error, "invalid_grant");
	assert.equal((await readCloudflareGrant(db, "user-1"))?.refresh_enc, null);

	await deleteCloudflareGrant(db, "user-1");
	assert.equal(await readCloudflareGrant(db, "user-1"), null);
	const missing = await refreshCloudflareGrant(client);
	assert.equal(missing.ok, false);
	if (!missing.ok) assert.equal(missing.error, "no_grant");
});

test("a Cloudflare error comes back to the setup page in plain language", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = createApp({
		AUTH_SECRET: secret,
		DB: db,
		GITHUB_CLIENT_ID: "gh-id",
		GITHUB_CLIENT_SECRET: "gh-secret",
		CLOUDFLARE_OAUTH_CLIENT_ID: "cf-id",
		CLOUDFLARE_OAUTH_CLIENT_SECRET: "cf-secret",
	}, { database: db });
	const cookie = await signIn(app);
	const consent = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=consent&choice=inbox&host=workers",
	});
	const state = new URL(consent.headers.get("location") ?? "").searchParams.get("state") ?? "";
	assert.match(state, /^cfl_/);
	const logs: string[] = [];
	const previous = console.error;
	console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
	t.after(() => { console.error = previous; });
	const freshState = async () => {
		const started = await app.request(`${origin}/app/cloudflare`, {
			method: "POST",
			headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
			body: "action=consent&choice=inbox&host=workers",
		});
		const next = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
		assert.match(next, /^cfl_/);
		return next;
	};

	const outsider = await app.request(
		`${origin}/api/auth/callback/cloudflare?error=access_denied&error_description=${encodeURIComponent("The resource owner denied the request.")}&state=${encodeURIComponent(state)}`,
	);
	const outsiderUrl = new URL(outsider.headers.get("location") ?? "", origin);
	assert.equal(outsider.status, 302);
	assert.equal(outsiderUrl.pathname, "/app");
	assert.equal(outsiderUrl.searchParams.get("error"), "cloudflare_unlinked");
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM verification WHERE identifier = ?`).bind(`cf-link:${state}`).first<{ n: number }>())?.n, 1);
	assert.equal(logs.join("\n").includes("cloudflare_oauth_error"), false);

	const description = "The OAuth 2.0 Client is not allowed to request scope 'workers-scripts.write'.";
	const refused = await app.request(
		`${origin}/api/auth/callback/cloudflare?error=invalid_scope&error_description=${encodeURIComponent(description)}&code=super-secret-code&state=${encodeURIComponent(state)}`,
		{ headers: { cookie } },
	);
	const refusedUrl = new URL(refused.headers.get("location") ?? "", origin);
	assert.equal(refused.status, 302);
	assert.equal(refusedUrl.pathname, "/app/cloudflare");
	assert.equal(refusedUrl.searchParams.get("error"), "refused");
	assert.equal(refusedUrl.pathname === "/app", false);
	const refusedHtml = await (await app.request(refusedUrl, { headers: { cookie } })).text();
	assert.match(refusedHtml, /Cloudflare refused the permissions/);
	assert.match(refusedHtml, /not allowed to ask for one of them/);
	assert.equal(refusedHtml.includes("The provider did not finish sign-in"), false);
	assert.equal(refusedHtml.includes("super-secret-code"), false);
	const logged = logs.join("\n");
	assert.match(logged, /cloudflare_oauth_error/);
	assert.match(logged, /invalid_scope/);
	assert.match(logged, /workers-scripts\.write/);
	assert.equal(logged.includes("super-secret-code"), false);
	assert.equal(logged.includes(state), false);
	assert.equal(logged.includes("cf-secret"), false);
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM verification WHERE identifier = ?`).bind(`cf-link:${state}`).first<{ n: number }>())?.n, 0);

	const cancelledState = await freshState();
	const cancelled = await app.request(
		`${origin}/api/auth/callback/cloudflare?error=access_denied&error_description=${encodeURIComponent("The resource owner or authorization server denied the request.")}&state=${encodeURIComponent(cancelledState)}`,
		{ headers: { cookie } },
	);
	const cancelledUrl = new URL(cancelled.headers.get("location") ?? "", origin);
	assert.equal(cancelledUrl.pathname, "/app/cloudflare");
	assert.equal(cancelledUrl.searchParams.get("error"), "cancelled");
	assert.match(await (await app.request(cancelledUrl, { headers: { cookie } })).text(), /You cancelled the Cloudflare permissions/);

	const leaks = [
		"Bearer cf_access_SECRET failed",
		"rejected code=super-secret-code",
		"token=cfut_SECRETVALUE",
		"id_token=eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.sig",
		"saw eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturevalue",
	];
	for (const leak of leaks) {
		const leakState = await freshState();
		const secretDescription = await app.request(
			`${origin}/api/auth/callback/cloudflare?error=server_error&error_description=${encodeURIComponent(leak)}&state=${encodeURIComponent(leakState)}`,
			{ headers: { cookie } },
		);
		const secretUrl = new URL(secretDescription.headers.get("location") ?? "", origin);
		assert.equal(secretUrl.pathname, "/app/cloudflare");
		assert.equal(secretUrl.searchParams.get("error"), "provider");
		assert.match(await (await app.request(secretUrl, { headers: { cookie } })).text(), /did not finish granting permissions/);
	}
	const loggedAfterLeaks = logs.join("\n");
	assert.match(loggedAfterLeaks, /"error_description":"redacted"/);
	for (const secret of ["cf_access_SECRET", "super-secret-code", "cfut_SECRETVALUE", "eyJhbGciOiJub25lIn0", "eyJzdWIiOiIxIn0", "signaturevalue"]) {
		assert.equal(loggedAfterLeaks.includes(secret), false, secret);
	}
	assert.match(loggedAfterLeaks, /denied the request/);

	const again = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=consent&choice=inbox&host=workers",
	});
	const bareState = new URL(again.headers.get("location") ?? "").searchParams.get("state") ?? "";
	const bare = await app.request(`${origin}/api/auth/callback/cloudflare?state=${encodeURIComponent(bareState)}`, { headers: { cookie } });
	const bareUrl = new URL(bare.headers.get("location") ?? "", origin);
	assert.equal(bareUrl.pathname, "/app/cloudflare");
	assert.equal(bareUrl.searchParams.get("error"), "provider");
	assert.equal(bareUrl.searchParams.get("error") === "no_code", false);

	const stranger = await app.request(`${origin}/api/auth/callback/cloudflare?code=abc&state=not-a-connect`, { headers: { cookie } });
	assert.equal(new URL(stranger.headers.get("location") ?? "", origin).searchParams.get("error"), "cloudflare_unlinked");
	assert.equal(new URL(stranger.headers.get("location") ?? "", origin).pathname, "/app");
});
