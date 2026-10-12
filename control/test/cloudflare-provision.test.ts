import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.ts";
import { SESSION_COOKIE } from "../src/auth/cookies.ts";
import { openCloudflareRefresh } from "../src/auth/cloudflare-grant.ts";
import { SETUP_NOT_PROVISIONED, TUNNEL_CONNECTOR_LATER, consentScope } from "../src/auth/cloudflare-setup.ts";
import { INBOX_MIGRATIONS } from "../src/provision/inbox-migrations.ts";
import { PROVISION_TAG_NAME } from "../src/provision/cloudflare-api.ts";
import { hashOwnerToken, readCloudflareInbox } from "../src/provision/inbox.ts";
import { zoneForHostname } from "../src/provision/names.ts";
import { sqlStatements } from "../src/provision/statements.ts";
import { openDb } from "./sql.ts";

const secret = "test-secret-test-secret-test-secret";
const origin = "https://control.example.com";
const accountId = "a".repeat(32);
const d1Id = "b".repeat(32);
const stubScript = "export default { fetch() { return new Response('inbox-stub') } }";

test("migration statements keep semicolons inside strings and drop line comments", () => {
	const statements = sqlStatements("-- note\nCREATE TABLE t (note TEXT); INSERT INTO t (note) VALUES ('a;b');");
	assert.deepEqual(statements, ["CREATE TABLE t (note TEXT)", "INSERT INTO t (note) VALUES ('a;b')"]);
	const names = INBOX_MIGRATIONS.map((migration) => migration.name);
	const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../worker/migrations");
	assert.deepEqual(names, fs.readdirSync(dir).filter((name) => name.endsWith(".sql")).sort());
	assert.ok(sqlStatements(INBOX_MIGRATIONS[0]?.sql ?? "").some((statement) => statement.startsWith("CREATE TABLE")));
});

test("a hostname matches the longest active zone", () => {
	const zones = [
		{ id: "1", name: "example.com", status: "active" },
		{ id: "2", name: "agent.example.com", status: "active" },
		{ id: "3", name: "idle.example", status: "pending" },
	];
	assert.equal(zoneForHostname("agent.example.com", zones)?.id, "2");
	assert.equal(zoneForHostname("other.example.com", zones)?.id, "1");
	assert.equal(zoneForHostname("idle.example", zones), null);
});

function githubFetch(scope: string) {
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: "gho_test", token_type: "bearer" });
		if (url === "https://api.github.com/user") return Response.json({ id: 7, login: "mona", name: "Mona", email: "mona@example.com" });
		if (url === "https://api.github.com/user/emails") return Response.json([{ email: "mona@example.com", primary: true, verified: true, visibility: "public" }]);
		if (url.startsWith("https://dash.cloudflare.com/oauth2/token")) {
			return Response.json({ access_token: "cf_access_SECRET", refresh_token: "cf_refresh_SECRET", token_type: "bearer", expires_in: 3600, scope });
		}
		if (url === "https://api.cloudflare.com/client/v4/user") {
			return Response.json({ success: true, result: { id: "cf-user", email: "pat@cloud.test" } });
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

interface Call {
	method: string;
	url: string;
	body: string;
	authorization: string;
}

function cloudflareApi(options: { subdomain?: string; scriptExists?: boolean; scriptTag?: string; uploadStatus?: number; zones?: { id: string; name: string; status: string }[]; accounts?: { id: string; name: string }[] }) {
	const calls: Call[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!url.includes("cloudflare.com")) return original(input as RequestInfo, init);
		const method = (init?.method ?? "GET").toUpperCase();
		const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
		const authorization = new Headers(init?.headers).get("authorization") ?? "";
		calls.push({ method, url, body, authorization });
		const json = (payload: unknown, status = 200) => Response.json(payload, { status });
		if (url.startsWith("https://dash.cloudflare.com/oauth2/token")) {
			const refresh = new URLSearchParams(body).get("refresh_token");
			return json({ access_token: "cf_access_SECRET", refresh_token: `next-${refresh}`, expires_in: 3600 });
		}
		if (url.endsWith("/accounts?per_page=50")) {
			return json({ success: true, result: options.accounts ?? [{ id: accountId, name: "Example account" }] });
		}
		if (url.endsWith("/workers/subdomain") && method === "GET") {
			return json({ success: true, result: { subdomain: options.subdomain ?? "example" } });
		}
		if (url.endsWith("/workers/subdomain") && method === "PUT") return json({ success: true, result: { subdomain: "picked" } });
		if (url.includes("/workers/scripts/") && url.endsWith("/settings")) {
			if (!options.scriptExists) return new Response("", { status: 404 });
			const bindings = options.scriptTag ? [{ type: "plain_text", name: PROVISION_TAG_NAME, text: options.scriptTag }] : [];
			return json({ success: true, result: { bindings } });
		}
		if (url.includes("/workers/scripts/") && method === "GET") {
			if (!options.scriptExists) return new Response("", { status: 404 });
			return new Response("/* a2a-exposed inbox */\nexport default { fetch() { return new Response('user-worker') } }", { status: 200, headers: { "content-type": "application/javascript" } });
		}
		if (url.includes("/d1/database?") && method === "GET") return json({ success: true, result: [] });
		if (url.endsWith("/d1/database") && method === "POST") return json({ success: true, result: { uuid: d1Id, name: "my-agent" } });
		if (url.endsWith("/query") && method === "POST") return json({ success: true, result: [{ results: [], success: true }] });
		if (url.includes("/workers/scripts/") && method === "PUT") {
			return options.uploadStatus ? new Response("", { status: options.uploadStatus }) : json({ success: true, result: {} });
		}
		if (url.endsWith("/subdomain") && method === "POST") return json({ success: true, result: { enabled: true } });
		if (url.includes("/zones?")) return json({ success: true, result: options.zones ?? [] });
		if (url.endsWith("/workers/domains") && method === "PUT") return json({ success: true, result: { hostname: "agent.example.com" } });
		return new Response(`unexpected ${method} ${url}`, { status: 500 });
	}) as typeof fetch;
	return { calls, restore: () => { globalThis.fetch = original; } };
}

function appFor(db: ReturnType<typeof openDb>) {
	return createApp({
		AUTH_SECRET: secret,
		DB: db,
		GITHUB_CLIENT_ID: "gh-id",
		GITHUB_CLIENT_SECRET: "gh-secret",
		CLOUDFLARE_OAUTH_CLIENT_ID: "cf-id",
		CLOUDFLARE_OAUTH_CLIENT_SECRET: "cf-secret",
	}, { database: db, inboxScript: stubScript, inboxMigrations: INBOX_MIGRATIONS });
}

async function consentInbox(app: ReturnType<typeof createApp>, cookie: string, host: "workers" | "zone" = "workers") {
	const consent = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: `action=consent&choice=inbox&host=${host}`,
	});
	const state = new URL(consent.headers.get("location") ?? "").searchParams.get("state") ?? "";
	const linked = await app.request(`${origin}/api/auth/callback/cloudflare?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie } });
	assert.equal(new URL(linked.headers.get("location") ?? "", origin).pathname, "/app/cloudflare");
}

test("a workers.dev inbox is created from the saved grant and the owner token is shown once", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const api = cloudflareApi({});
	t.after(api.restore);

	const posted = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=provision&name=my-agent",
	});
	assert.equal(posted.status, 303);
	const setCookie = posted.headers.getSetCookie().find((value) => value.startsWith("__Host-a2a_cf_owner="));
	assert.ok(setCookie);
	const ownerCookie = setCookie!.split(";")[0]!;
	const page = await app.request(`${origin}/app/cloudflare`, { headers: { cookie: `${cookie}; ${ownerCookie}` } });
	const html = await page.text();
	assert.match(html, /https:\/\/my-agent\.example\.workers\.dev/);
	assert.match(html, /Copy this owner token now/);
	assert.match(html, /a2aot_/);
	assert.equal(html.includes(SETUP_NOT_PROVISIONED), false);
	assert.equal(html.includes("Nothing has been created"), false);
	assert.equal(html.includes("cf_access_SECRET"), false);
	assert.equal(html.includes("cf_refresh_SECRET"), false);
	assert.equal(html.includes("next-cf_refresh_SECRET"), false);
	const userId = (await db.prepare('SELECT id FROM "user"').first<{ id: string }>())?.id ?? "";
	const inbox = await readCloudflareInbox(db, userId);
	assert.equal(inbox?.status, "ready");
	assert.equal(inbox?.public_url, "https://my-agent.example.workers.dev");
	assert.equal(inbox?.cf_account_id, accountId);
	assert.equal(inbox?.d1_id, d1Id);
	const shown = html.match(/a2aot_[A-Za-z0-9_-]+/)?.[0] ?? "";
	assert.equal(inbox?.owner_token_hash, await hashOwnerToken(shown));
	assert.equal(JSON.stringify(inbox).includes(shown), false);
	assert.equal(await openCloudflareRefresh(secret, userId, (await db.prepare(`SELECT refresh_enc FROM cloudflare_grant WHERE "userId" = ?`).bind(userId).first<{ refresh_enc: string }>())?.refresh_enc), "next-cf_refresh_SECRET");
	const upload = api.calls.find((call) => call.method === "PUT" && call.url.includes("/workers/scripts/"));
	assert.ok(upload);
	assert.match(upload!.body, /inbox-stub/);
	assert.match(upload!.body, new RegExp(shown));
	assert.equal(upload!.authorization, "Bearer cf_access_SECRET");
	assert.ok(api.calls.some((call) => call.url.endsWith("/query") && call.body.includes("CREATE TABLE")));
	assert.equal(api.calls.some((call) => call.url.includes("api.cloudflare.com") && (call.body.includes("cf_refresh_SECRET") || call.authorization.includes("cf_refresh"))), false);

	const apiCalls = () => api.calls.filter((call) => call.url.includes("api.cloudflare.com")).length;
	const beforeAgain = apiCalls();
	const again = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=provision&name=my-agent",
	});
	assert.equal(again.status, 303);
	assert.equal(again.headers.getSetCookie().some((value) => value.startsWith("__Host-a2a_cf_owner=") && !value.includes("Max-Age=0")), false);
	assert.equal(apiCalls(), beforeAgain);

	const account = await (await app.request(`${origin}/app`, { headers: { cookie } })).text();
	assert.match(account, /Your Cloudflare inbox is at/);
	assert.match(account, /https:\/\/my-agent\.example\.workers\.dev/);
	assert.equal(account.includes(shown), false);
});

test("a stale sign-in does not call Cloudflare, and the same create continues after sign-in", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const session = await db.prepare("SELECT id, createdAt FROM session").first<{ id: string; createdAt: string | number }>();
	const staleAt = new Date(new Date(session!.createdAt).getTime() - 11 * 60 * 1000);
	const stored = typeof session!.createdAt === "number" ? staleAt.getTime() : staleAt.toISOString();
	await db.prepare("UPDATE session SET createdAt = ? WHERE id = ?").bind(stored, session!.id).run();
	const api = cloudflareApi({});
	t.after(api.restore);
	const before = api.calls.length;
	const posted = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=provision&name=my-agent",
	});
	assert.equal(posted.status, 303);
	const location = new URL(posted.headers.get("location") ?? "", origin);
	assert.equal(location.pathname, "/app/sign-in");
	assert.equal(location.searchParams.get("reauth"), "cloudflare");
	assert.equal(location.searchParams.get("return"), "/app/cloudflare");
	assert.equal(api.calls.length, before);
	assert.equal(await readCloudflareInbox(db, (await db.prepare('SELECT id FROM "user"').first<{ id: string }>())?.id ?? ""), null);
	const resume = posted.headers.getSetCookie().find((value) => value.startsWith("__Host-a2a_cf_resume="))?.split(";")[0] ?? "";
	const fresh = await signIn(app);
	const continued = await app.request(`${origin}/app/cloudflare`, { headers: { cookie: `${fresh}; ${resume}` } });
	assert.equal(continued.status, 303);
	assert.match(continued.headers.get("location") ?? "", /\/app\/cloudflare$/);
	assert.ok(continued.headers.getSetCookie().some((value) => value.startsWith("__Host-a2a_cf_owner=")));
	assert.ok(api.calls.some((call) => call.method === "PUT" && call.url.includes("/workers/scripts/")));
});

test("your own domain attaches the hostname and does not claim the tunnel is done", async (t) => {
	t.after(githubFetch(consentScope("both", "zone")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	const consent = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=consent&choice=both&host=zone",
	});
	const state = new URL(consent.headers.get("location") ?? "").searchParams.get("state") ?? "";
	await app.request(`${origin}/api/auth/callback/cloudflare?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie } });
	const api = cloudflareApi({ zones: [{ id: "c".repeat(32), name: "example.com", status: "active" }] });
	t.after(api.restore);
	const posted = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=provision&hostname=https://agent.example.com/inbox",
	});
	assert.equal(posted.status, 303);
	const html = await (await app.request(new URL(posted.headers.get("location") ?? "", origin), { headers: { cookie: `${cookie}; ${posted.headers.getSetCookie().find((value) => value.startsWith("__Host-a2a_cf_owner="))?.split(";")[0] ?? ""}` } })).text();
	assert.match(html, /https:\/\/agent\.example\.com/);
	assert.match(html, new RegExp(TUNNEL_CONNECTOR_LATER.replace(/[.]/g, "\\.")));
	assert.equal(html.includes(SETUP_NOT_PROVISIONED), false);
	assert.ok(api.calls.some((call) => call.method === "PUT" && call.url.endsWith("/workers/domains") && call.body.includes("agent.example.com")));
	assert.ok(api.calls.some((call) => call.method === "POST" && call.url.endsWith("/subdomain") && call.body.includes("false")));
});

test("a missing workers.dev name asks for one and does not create a database", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const api = cloudflareApi({ subdomain: "" });
	t.after(api.restore);
	const posted = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=provision&name=my-agent",
	});
	assert.equal(posted.status, 200);
	const html = await posted.text();
	assert.match(html, /no workers\.dev name yet/);
	assert.equal(api.calls.some((call) => call.method === "POST" && call.url.endsWith("/d1/database")), false);
	const retried = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=provision&name=my-agent&subdomain=picked",
	});
	assert.equal(retried.status, 303);
	assert.ok(api.calls.some((call) => call.method === "PUT" && call.url.endsWith("/workers/subdomain")));
});

test("an existing Worker name is refused and a failed upload can be continued", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const taken = cloudflareApi({ scriptExists: true });
	const refused = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=provision&name=my-agent",
	});
	assert.equal(refused.status, 303);
	assert.equal(new URL(refused.headers.get("location") ?? "", origin).searchParams.get("error"), "taken");
	assert.equal(taken.calls.some((call) => call.method === "POST" && call.url.endsWith("/d1/database")), false);
	taken.restore();

	const upload = { uploadStatus: 500 as number | undefined };
	const failed = cloudflareApi(upload);
	t.after(failed.restore);
	const partial = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=provision&name=my-agent",
	});
	assert.equal(new URL(partial.headers.get("location") ?? "", origin).searchParams.get("error"), "partial");
	const userId = (await db.prepare('SELECT id FROM "user"').first<{ id: string }>())?.id ?? "";
	assert.equal((await readCloudflareInbox(db, userId))?.d1_id, d1Id);
	assert.equal((await readCloudflareInbox(db, userId))?.status, "pending");
	const creates = () => failed.calls.filter((call) => call.method === "POST" && call.url.endsWith("/d1/database")).length;
	assert.equal(creates(), 1);
	upload.uploadStatus = undefined;
	failed.calls.length = 0;
	const continued = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=provision&name=my-agent",
	});
	assert.equal(continued.status, 303);
	assert.equal(creates(), 0);
	assert.equal((await readCloudflareInbox(db, userId))?.status, "ready");
	assert.equal(JSON.stringify(await readCloudflareInbox(db, userId)).includes("cf_access_SECRET"), false);
});

test("a retry does not replace a Worker that only contains the inbox comment", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const options = { scriptExists: false, uploadStatus: 500 as number | undefined, scriptTag: "" };
	const api = cloudflareApi(options);
	t.after(api.restore);
	const partial = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=provision&name=my-agent",
	});
	assert.equal(new URL(partial.headers.get("location") ?? "", origin).searchParams.get("error"), "partial");
	const userId = (await db.prepare('SELECT id FROM "user"').first<{ id: string }>())?.id ?? "";
	assert.equal((await readCloudflareInbox(db, userId))?.d1_id, d1Id);
	options.scriptExists = true;
	options.uploadStatus = undefined;
	const puts = () => api.calls.filter((call) => call.method === "PUT" && call.url.includes("/workers/scripts/")).length;
	const before = puts();
	const again = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=provision&name=my-agent",
	});
	assert.equal(new URL(again.headers.get("location") ?? "", origin).searchParams.get("error"), "taken");
	assert.equal(puts(), before);
	assert.equal((await readCloudflareInbox(db, userId))?.status, "pending");
	assert.equal((await readCloudflareInbox(db, userId))?.d1_id, d1Id);
});

test("a retry continues when the script settings carry the tag this page stored", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const options = { scriptExists: false, uploadStatus: 500 as number | undefined, scriptTag: "" };
	const api = cloudflareApi(options);
	t.after(api.restore);
	const partial = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=provision&name=my-agent",
	});
	assert.equal(new URL(partial.headers.get("location") ?? "", origin).searchParams.get("error"), "partial");
	const userId = (await db.prepare('SELECT id FROM "user"').first<{ id: string }>())?.id ?? "";
	const savedTag = (await readCloudflareInbox(db, userId))?.script_tag ?? "";
	assert.equal(savedTag.length, 64);
	assert.equal(savedTag.includes("a2a-exposed inbox"), false);
	options.scriptTag = savedTag;
	options.scriptExists = true;
	options.uploadStatus = undefined;
	const again = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=provision&name=my-agent",
	});
	assert.equal(again.status, 303);
	assert.equal(new URL(again.headers.get("location") ?? "", origin).searchParams.get("error"), null);
	assert.equal((await readCloudflareInbox(db, userId))?.status, "ready");
	assert.ok(api.calls.some((call) => call.method === "PUT" && call.url.includes("/workers/scripts/") && call.body.includes(PROVISION_TAG_NAME) && call.body.includes(savedTag)));
	assert.equal(api.calls.some((call) => call.method === "GET" && call.url.includes("/workers/scripts/") && !call.url.endsWith("/settings")), false);
});

test("a façade alone does not create Cloudflare resources", async (t) => {
	t.after(githubFetch(consentScope("facade", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	const consent = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=consent&choice=facade&host=workers",
	});
	const state = new URL(consent.headers.get("location") ?? "").searchParams.get("state") ?? "";
	const linked = await app.request(`${origin}/api/auth/callback/cloudflare?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie } });
	const html = await (await app.request(linked.headers.get("location") ?? "", { headers: { cookie } })).text();
	assert.match(html, new RegExp(SETUP_NOT_PROVISIONED.replace(/[.]/g, "\\.")));
	assert.match(html, new RegExp(TUNNEL_CONNECTOR_LATER.replace(/[.]/g, "\\.")));
	assert.match(html, /does not create the tunnel/);
	assert.equal(html.includes("Create it in Cloudflare"), false);
});
