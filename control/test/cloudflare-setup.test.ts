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
import { sessionIsFresh } from "../src/auth/cloudflare-link.ts";
import { CLOUDFLARE_RESUME_COOKIE, SESSION_COOKIE } from "../src/auth/cookies.ts";
import {
	D1_WRITE,
	DNS_WRITE,
	OFFLINE_ACCESS,
	SETUP_NOT_PROVISIONED,
	TUNNEL_CONNECTOR_LATER,
	TUNNEL_WRITE,
	USER_DETAILS_READ,
	WORKERS_ROUTES_WRITE,
	WORKERS_SCRIPTS_ADMIN,
	ZONE_READ,
	cloudflareAuthorizeUrl,
	consentScope,
	describeSetupGrant,
	inboxCanProvision,
	setupScopes,
	type SetupChoice,
	type SetupHost,
} from "../src/auth/cloudflare-setup.ts";
import { openDb } from "./sql.ts";

const secret = "test-secret-test-secret-test-secret";
const origin = "https://control.example.com";
/** Ids the staging OAuth client allows. offline_access is implicit and still requested. */
const CLIENT_SCOPES = new Set([
	"d1.write",
	"workers-scripts.admin",
	"workers-scripts.edit",
	"workers-routes.write",
	"dns.write",
	"zone.read",
	"zone-access.read",
	"zone-access.write",
	"argotunnel.read",
	"argotunnel.write",
	"account-settings.read",
	"user-details.read",
	"offline_access",
]);
const INBOX_WORKERS = [
	USER_DETAILS_READ,
	"account-settings.read",
	WORKERS_SCRIPTS_ADMIN,
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
			assert.equal(list.includes("workers-scripts.edit"), false);
			assert.equal(list.includes("workers:write"), false);
			assert.equal(list.includes("zone-access.read"), false);
			assert.equal(list.includes("zone-access.write"), false);
			assert.equal(list.includes("argotunnel.read"), false);
			assert.equal(list.includes("account:read"), false);
			assert.equal(list.includes("user:read"), false);
			assert.equal(list.includes(WORKERS_SCRIPTS_ADMIN), true);
			for (const id of list) assert.equal(CLIENT_SCOPES.has(id), true, id);
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
		granted_scope: `${USER_DETAILS_READ} account-settings.read ${WORKERS_SCRIPTS_ADMIN}`,
		refresh_enc: null,
	});
	assert.ok(bothZone);
	assert.match(bothZone.blocked.join(" "), /Without D1 Write/);
	assert.match(bothZone.blocked.join(" "), /blocks the new inbox and the façade/);
	assert.match(bothZone.blocked.join(" "), /Without Zone Read/);
	assert.match(bothZone.blocked.join(" "), /own domain/);
	assert.match(bothZone.blocked.join(" "), /Without Cloudflare Tunnel Write/);
	assert.match(bothZone.blocked.join(" "), /blocks the façade/);
	assert.match(bothZone.blocked.join(" "), /inbox can still be created/);
	assert.match(bothZone.blocked.join(" "), /Connect again and keep the refresh token/);
	assert.equal(bothZone.lines.find((line) => line.name === "Workers Admin")?.state, "granted");
	assert.equal(bothZone.needsReconnect, false);
	assert.equal(bothZone.lines.find((line) => line.name === "D1 Write")?.state, "declined");

	const workers = describeSetupGrant({
		choice: "inbox",
		host: "workers",
		granted_scope: consentScope("inbox", "workers"),
		refresh_enc: "v1.sealed",
	});
	assert.ok(workers);
	assert.deepEqual(workers.blocked, []);
	assert.equal(workers.needsReconnect, false);
	assert.equal(workers.lines.some((line) => line.name === "Zone Read"), false);
	assert.equal(workers.lines.find((line) => line.name === "Workers Admin")?.state, "granted");
	assert.match(workers.lines.find((line) => line.name === "Workers Admin")?.why ?? "", /Uploads the inbox Worker into your account/);
	assert.equal(workers.refreshSaved, true);

	const staleAdmin = describeSetupGrant({
		choice: "inbox",
		host: "workers",
		granted_scope: `${USER_DETAILS_READ} account-settings.read workers-scripts.edit ${D1_WRITE} ${OFFLINE_ACCESS}`,
		refresh_enc: "v1.sealed",
	});
	assert.ok(staleAdmin);
	assert.equal(staleAdmin.needsReconnect, true);
	assert.equal(staleAdmin.lines.find((line) => line.name === "Workers Admin")?.state, "declined");
	assert.match(staleAdmin.blocked.join(" "), /Without Workers Admin/);
	assert.match(staleAdmin.blocked.join(" "), /Connect again to grant it/);
	assert.equal(inboxCanProvision({
		choice: "inbox",
		host: "workers",
		granted_scope: `${USER_DETAILS_READ} account-settings.read workers-scripts.edit ${D1_WRITE} ${OFFLINE_ACCESS}`,
		refresh_enc: "v1.sealed",
	}), false);

	const unknown = describeSetupGrant({
		choice: "inbox",
		host: "workers",
		granted_scope: null,
		refresh_enc: null,
	});
	assert.match(unknown?.blocked.join(" ") ?? "", /did not say which permissions/);
	assert.equal(unknown?.needsReconnect, true);
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

function applyCookies(jar: Map<string, string>, response: Response) {
	for (const raw of response.headers.getSetCookie()) {
		const parts = raw.split(";").map((part) => part.trim());
		const pair = parts[0] ?? "";
		const eq = pair.indexOf("=");
		if (eq <= 0) continue;
		const name = pair.slice(0, eq);
		const cleared = parts.some((part) => /^max-age=0$/i.test(part));
		if (cleared) jar.delete(name);
		else jar.set(name, pair.slice(eq + 1));
	}
}

function cookieHeader(jar: Map<string, string>): string {
	return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function githubRoundTrip(app: ReturnType<typeof createApp>, jar: Map<string, string>, next = "") {
	const posted = await app.request(`${origin}/app/sign-in`, {
		method: "POST",
		headers: { origin, cookie: cookieHeader(jar), "content-type": "application/x-www-form-urlencoded" },
		body: next ? `provider=github&next=${encodeURIComponent(next)}` : "provider=github",
	});
	applyCookies(jar, posted);
	const authorize = new URL(posted.headers.get("location") ?? "", origin);
	const state = authorize.searchParams.get("state") ?? "";
	const done = await app.request(`${origin}/api/auth/callback/github?code=abc&state=${encodeURIComponent(state)}`, {
		headers: { cookie: cookieHeader(jar) },
	});
	applyCookies(jar, done);
	return done;
}

async function ageSession(db: ReturnType<typeof openDb>) {
	const session = await db.prepare("SELECT id, createdAt FROM session").first<{ id: string; createdAt: string | number }>();
	const staleAt = new Date(new Date(session!.createdAt).getTime() - 11 * 60 * 1000);
	const stored = typeof session!.createdAt === "number" ? staleAt.getTime() : staleAt.toISOString();
	await db.prepare("UPDATE session SET createdAt = ? WHERE id = ?").bind(stored, session!.id).run();
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
	assert.match(html, /one step at a time/);
	assert.match(html, /available on every plan/);
	assert.equal(html.includes("not a way to sign in"), false);
	assert.match(html, /What do you want\?/);
	assert.match(html, /Give my agent a public A2A address/);
	assert.match(html, /It receives messages, and we wake it by webhook/);
	assert.match(html, /Make an agent I already run reachable by other agents/);
	assert.match(html, /We connect it securely/);
	assert.match(html, /Which web address\?/);
	assert.match(html, /A free workers\.dev address/);
	assert.match(html, /My own domain/);
	assert.match(html, /https:\/\/my-agent\.yourname\.workers\.dev/);
	assert.match(html, /https:\/\/agent\.example\.com/);
	assert.match(html, /class="choice"/);
	assert.match(html, /Cloudflare provides this address/);
	assert.match(html, /Use a domain already on this Cloudflare account/);
	assert.equal(html.includes("older than 10 minutes"), false);
	assert.match(html, /creates a public address for your agent/);
	assert.equal(html.includes("not created here"), false);
	assert.equal(html.includes("Start a different setup"), false);
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
	assert.match(reviewHtml, /Workers Admin/);
	assert.match(reviewHtml, /Uploads the inbox Worker into your account/);
	assert.equal(reviewHtml.includes("Workers Scripts Edit"), false);
	assert.equal(reviewHtml.includes("workers-scripts.edit"), false);
	assert.match(reviewHtml, /Continue to Cloudflare/);
	assert.equal(reviewHtml.includes("Zone Read"), false);
	assert.equal(reviewHtml.includes("DNS Write"), false);
	assert.equal(reviewHtml.includes("Cloudflare Tunnel Write"), false);
	assert.equal(reviewHtml.includes("Cloudflare Access"), false);
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
	const started = await app.request(landed, { headers: { cookie } });
	assert.equal(started.status, 303);
	assert.match(started.headers.get("location") ?? "", /\/app\/cloudflare\/[0-9a-f]{32}$/);
	const done = await app.request(started.headers.get("location") ?? "", { headers: { cookie } });
	const doneHtml = await done.text();
	assert.match(doneHtml, /Check the Cloudflare account/);
	assert.match(doneHtml, /<details class="restart">/);
	assert.match(doneHtml, /Start a different setup/);
	assert.equal(doneHtml.includes('details class="restart" open'), false);
	const heldAt = doneHtml.indexOf('<details class="restart">');
	const held = doneHtml.slice(heldAt, doneHtml.indexOf("</details>", heldAt));
	assert.match(held, /What do you want\?/);
	assert.match(held, /Which web address\?/);
	assert.match(held, /Create this agent/);
	assert.equal(doneHtml.slice(0, heldAt).includes("What do you want?"), false);
	assert.ok(doneHtml.indexOf("Check the Cloudflare account") < heldAt);
	assert.match(doneHtml, /Cloudflare is connected, and the permissions this inbox needs are granted/);
	assert.match(doneHtml, /A refresh token is saved encrypted/);
	assert.match(doneHtml, /single-use/);
	assert.match(doneHtml, /can continue/);
	assert.equal(doneHtml.includes("Nothing has been created"), false);
	assert.equal(doneHtml.includes("does not use it yet"), false);
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

test("a saved grant without Workers Admin asks to connect again and does not run the steps", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = createApp({
		AUTH_SECRET: secret,
		DB: db,
		GITHUB_CLIENT_ID: "gh-id",
		GITHUB_CLIENT_SECRET: "gh-secret",
		CLOUDFLARE_OAUTH_CLIENT_ID: "cf-id",
		CLOUDFLARE_OAUTH_CLIENT_SECRET: "cf-secret",
	}, { database: db, inboxScript: "export default {}", inboxMigrations: [] });
	const cookie = await signIn(app);
	const userId = (await db.prepare('SELECT id FROM "user"').first<{ id: string }>())?.id ?? "";
	const oldScope = `${USER_DETAILS_READ} account-settings.read workers-scripts.edit ${D1_WRITE} ${OFFLINE_ACCESS}`;
	await saveCloudflareGrant(db, secret, {
		userId,
		accountId: "cf-user",
		choice: "inbox",
		host: "workers",
		requestedScope: oldScope,
		grantedScope: oldScope,
		refreshToken: "old-refresh-SECRET",
		expiresIn: 3600,
	});
	const html = await (await app.request(`${origin}/app/cloudflare`, { headers: { cookie } })).text();
	assert.match(html, /Without Workers Admin/);
	assert.match(html, /Connect again to grant it/);
	assert.match(html, />Connect again</);
	const connectAt = html.indexOf(">Connect again<");
	const connectForm = html.slice(html.lastIndexOf("<form", connectAt), html.indexOf("</form>", connectAt));
	assert.match(connectForm, /name="action" value="consent"/);
	assert.match(connectForm, /name="choice" value="inbox"/);
	assert.match(connectForm, /name="host" value="workers"/);
	assert.equal(connectForm.includes('value="review"'), false);
	assert.equal(html.includes('class="steps"'), false);
	assert.equal(html.includes("Check the Cloudflare account"), false);
	assert.equal(html.includes("old-refresh-SECRET"), false);
	const heldAt = html.indexOf('<details class="restart">');
	assert.ok(heldAt > html.indexOf("Connect again"));
	const held = html.slice(heldAt, html.indexOf("</details>", heldAt));
	assert.match(held, /What do you want\?/);
	assert.match(held, /Review permissions/);
	assert.equal(html.slice(0, heldAt).includes("What do you want?"), false);

	const stepped = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=step&step=upload&name=my-agent",
	});
	const steppedHtml = await stepped.text();
	assert.match(steppedHtml, />Connect again</);
	assert.equal(steppedHtml.includes('class="steps"'), false);
	assert.equal(await readCloudflareInboxSafe(db, userId), null);

	const review = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=review&choice=inbox&host=workers",
	});
	const reviewHtml = await review.text();
	assert.match(reviewHtml, /Workers Admin/);
	assert.match(reviewHtml, /Uploads the inbox Worker into your account/);
	assert.equal(reviewHtml.includes(">Connect again<"), false);
	const consent = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=consent&choice=inbox&host=workers",
	});
	const scope = new URL(consent.headers.get("location") ?? "").searchParams.get("scope") ?? "";
	assert.match(scope, /workers-scripts\.admin/);
	assert.equal(scope.includes("workers-scripts.edit"), false);
});

async function readCloudflareInboxSafe(db: ReturnType<typeof openDb>, userId: string): Promise<unknown> {
	const row = await db.prepare(`SELECT "userId" FROM cloudflare_inbox WHERE "userId" = ?`).bind(userId).first();
	return row;
}

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
	assert.match(reviewHtml, /Workers Admin/);
	assert.match(reviewHtml, /Uploads the façade Worker into your account/);
	assert.match(reviewHtml, /Cloudflare Tunnel Write/);
	assert.match(reviewHtml, /Zone Read/);
	assert.match(reviewHtml, /DNS Write/);
	assert.match(reviewHtml, new RegExp(TUNNEL_CONNECTOR_LATER.replace(/[.]/g, "\\.")));
	assert.equal(reviewHtml.includes("Cloudflare Access"), false);
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
	assert.match(refusedHtml, /Turn those permissions on for this Cloudflare app, then connect again/);
	assert.equal(refusedHtml.includes("Try the setup again"), false);
	assert.equal(refusedHtml.includes("not allowed to ask"), false);
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

async function consentAfterReauth(app: ReturnType<typeof createApp>, jar: Map<string, string>, body: string) {
	const stale = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie: cookieHeader(jar), "content-type": "application/x-www-form-urlencoded" },
		body,
	});
	applyCookies(jar, stale);
	const signInUrl = new URL(stale.headers.get("location") ?? "", origin);
	assert.equal(signInUrl.pathname, "/app/sign-in");
	assert.equal(signInUrl.searchParams.get("reauth"), "cloudflare");
	assert.equal(signInUrl.searchParams.get("return"), "/app/cloudflare");
	const signedIn = await githubRoundTrip(app, jar, "/app/cloudflare");
	const back = new URL(signedIn.headers.get("location") ?? "", origin);
	assert.equal(back.pathname, "/app/cloudflare");
	const continued = await app.request(back, { headers: { cookie: cookieHeader(jar) } });
	assert.equal(continued.status, 303);
	return new URL(continued.headers.get("location") ?? "");
}

test("Connect again continues to Cloudflare's consent screen after a fresh sign-in", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = createApp({
		AUTH_SECRET: secret,
		DB: db,
		GITHUB_CLIENT_ID: "gh-id",
		GITHUB_CLIENT_SECRET: "gh-secret",
		CLOUDFLARE_OAUTH_CLIENT_ID: "cf-id",
		CLOUDFLARE_OAUTH_CLIENT_SECRET: "cf-secret",
	}, { database: db, inboxScript: "export default {}", inboxMigrations: [] });
	const jar = new Map<string, string>();
	const first = await githubRoundTrip(app, jar);
	assert.equal(new URL(first.headers.get("location") ?? "", origin).pathname, "/app");
	const userId = (await db.prepare('SELECT id FROM "user"').first<{ id: string }>())?.id ?? "";
	const oldScope = `${USER_DETAILS_READ} account-settings.read workers-scripts.edit ${D1_WRITE} ${OFFLINE_ACCESS}`;
	await saveCloudflareGrant(db, secret, {
		userId,
		accountId: "cf-user",
		choice: "inbox",
		host: "workers",
		requestedScope: oldScope,
		grantedScope: oldScope,
		refreshToken: "old-refresh-SECRET",
		expiresIn: 3600,
	});
	await ageSession(db);
	const authorize = await consentAfterReauth(app, jar, "action=consent&choice=inbox&host=workers");
	assert.equal(authorize.origin, "https://dash.cloudflare.com");
	assert.equal(authorize.pathname, "/oauth2/auth");
	const scope = authorize.searchParams.get("scope") ?? "";
	assert.equal(scope, consentScope("inbox", "workers"));
	assert.match(scope, /workers-scripts\.admin/);
	assert.equal(scope.includes("zone.read"), false);
	assert.equal(scope.includes("dns.write"), false);
	assert.equal(scope.includes("workers-routes.write"), false);
	assert.equal(scope.includes("argotunnel.write"), false);
	assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
});

test("consent continues when the fresh sign-in does not send the resume cookie", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = createApp({
		AUTH_SECRET: secret,
		DB: db,
		GITHUB_CLIENT_ID: "gh-id",
		GITHUB_CLIENT_SECRET: "gh-secret",
		CLOUDFLARE_OAUTH_CLIENT_ID: "cf-id",
		CLOUDFLARE_OAUTH_CLIENT_SECRET: "cf-secret",
	}, { database: db, inboxScript: "export default {}", inboxMigrations: [] });
	const jar = new Map<string, string>();
	await githubRoundTrip(app, jar);
	await ageSession(db);
	const stale = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie: cookieHeader(jar), "content-type": "application/x-www-form-urlencoded" },
		body: "action=consent&choice=inbox&host=workers",
	});
	applyCookies(jar, stale);
	assert.equal(jar.has(CLOUDFLARE_RESUME_COOKIE), true);
	jar.delete(CLOUDFLARE_RESUME_COOKIE);
	const signedIn = await githubRoundTrip(app, jar, "/app/cloudflare");
	const back = new URL(signedIn.headers.get("location") ?? "", origin);
	assert.equal(back.pathname, "/app/cloudflare");
	const continued = await app.request(back, { headers: { cookie: cookieHeader(jar) } });
	assert.equal(continued.status, 303);
	const authorize = new URL(continued.headers.get("location") ?? "");
	assert.equal(authorize.origin, "https://dash.cloudflare.com");
	assert.equal(authorize.pathname, "/oauth2/auth");
	assert.equal(authorize.searchParams.get("scope"), consentScope("inbox", "workers"));
});

test("a newer session for the same account does not refresh an older one", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = createApp({
		AUTH_SECRET: secret,
		DB: db,
		GITHUB_CLIENT_ID: "gh-id",
		GITHUB_CLIENT_SECRET: "gh-secret",
		CLOUDFLARE_OAUTH_CLIENT_ID: "cf-id",
		CLOUDFLARE_OAUTH_CLIENT_SECRET: "cf-secret",
	}, { database: db, inboxScript: "export default {}", inboxMigrations: [] });
	const jar = new Map<string, string>();
	await githubRoundTrip(app, jar);
	const current = await db.prepare('SELECT id, "userId" AS userId, createdAt FROM session').first<{ id: string; userId: string; createdAt: string }>();
	assert.ok(current);
	await ageSession(db);
	const now = new Date().toISOString();
	const later = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
	await db.prepare(
		`INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, "userId") VALUES (?, ?, ?, ?, ?, ?)`,
	).bind("b".repeat(32), later, "c".repeat(32), now, now, current.userId).run();
	const stale = await sessionIsFresh(db, { session: { id: current.id, createdAt: new Date(Date.now() - 11 * 60 * 1000).toISOString() } }, current.userId);
	assert.equal(stale, false);
	const missing = await sessionIsFresh(db, { session: { id: current.id } }, current.userId);
	assert.equal(missing, false);
	const other = await sessionIsFresh(db, { session: { id: "b".repeat(32) } }, current.userId);
	assert.equal(other, true);
	const posted = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie: cookieHeader(jar), "content-type": "application/x-www-form-urlencoded" },
		body: "action=consent&choice=inbox&host=workers",
	});
	const location = new URL(posted.headers.get("location") ?? "", origin);
	assert.equal(location.pathname, "/app/sign-in");
	assert.equal(location.searchParams.get("reauth"), "cloudflare");
	assert.equal(location.origin, origin);
});

test("Continue to Cloudflare keeps the same choices after a fresh sign-in", async (t) => {
	t.after(githubFetch(consentScope("both", "zone")));
	const db = openDb();
	const app = createApp({
		AUTH_SECRET: secret,
		DB: db,
		GITHUB_CLIENT_ID: "gh-id",
		GITHUB_CLIENT_SECRET: "gh-secret",
		CLOUDFLARE_OAUTH_CLIENT_ID: "cf-id",
		CLOUDFLARE_OAUTH_CLIENT_SECRET: "cf-secret",
	}, { database: db });
	const jar = new Map<string, string>();
	await githubRoundTrip(app, jar);
	await ageSession(db);
	const authorize = await consentAfterReauth(app, jar, "action=consent&choice=both&host=zone");
	assert.equal(authorize.origin, "https://dash.cloudflare.com");
	assert.equal(authorize.pathname, "/oauth2/auth");
	assert.equal(authorize.searchParams.get("scope"), consentScope("both", "zone"));
	const scope = authorize.searchParams.get("scope") ?? "";
	assert.match(scope, /workers-scripts\.admin/);
	assert.match(scope, /workers-routes\.write/);
	assert.match(scope, /dns\.write/);
	assert.match(scope, /zone\.read/);
	assert.match(scope, /argotunnel\.write/);
});
