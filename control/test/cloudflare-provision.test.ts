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
import { PROVISION_TAG_NAME, cfCall, permissionNotReady } from "../src/provision/cloudflare-api.ts";
import { PERMISSION_DELAYS_MS, PERMISSION_TRIES, PERMISSION_WAIT, hashOwnerToken, readCloudflareInbox } from "../src/provision/inbox.ts";
import { zoneForHostname } from "../src/provision/names.ts";
import { sqlStatements } from "../src/provision/statements.ts";
import { openDb } from "./sql.ts";

const secret = "test-secret-test-secret-test-secret";
const origin = "https://control.example.com";
const accountId = "a".repeat(32);
const d1Id = "b".repeat(32);
const stubScript = "export default { fetch() { return new Response('inbox-stub') } }";

function assertChoicesHeld(html: string, actionOutside: string) {
	const start = html.indexOf('<details class="restart">');
	const end = html.indexOf("</details>", start);
	assert.ok(start > 0 && end > start);
	const held = html.slice(start, end);
	assert.equal(held.includes(" open"), false);
	assert.match(held, /Start a different setup/);
	assert.match(held, /What do you want\?/);
	assert.match(held, /Which web address\?/);
	assert.match(held, /Create this agent/);
	assert.equal(html.slice(0, start).includes("What do you want?"), false);
	assert.ok(html.indexOf(actionOutside) < start, actionOutside);
}

function assertChoicesOpen(html: string) {
	assert.equal(html.includes("Start a different setup"), false);
	assert.equal(html.includes("What do you want?"), false);
	assert.match(html, /In my Cloudflare account/);
	assert.match(html, /Remove from my Cloudflare/);
	assert.match(html, />Worker</);
	assert.match(html, />Database</);
}

function refreshSeconds(html: string): number {
	const match = html.match(/data-refresh-seconds="(\d+)"/);
	return match ? Number(match[1]) : 0;
}

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

interface ApiOptions {
	subdomain?: string;
	subdomainStatus?: number;
	subdomainErrors?: { code: number; message: string }[];
	scriptExists?: boolean;
	scriptTag?: string;
	uploadStatus?: number;
	zones?: { id: string; name: string; status: string }[];
	accounts?: { id: string; name: string }[];
	accountsThrow?: boolean;
	d1Status?: number;
	d1Errors?: { code: number; message: string }[];
	d1Existing?: { uuid: string; name: string }[];
	queryStatus?: number;
	verifyStatus?: number;
	/** Remaining permission failures before that call succeeds. */
	permissionLeft?: { d1?: number; query?: number; upload?: number; account?: number };
	domains?: { id: string; hostname: string; service: string }[];
	d1Name?: string;
	workerNames?: string[];
}

function cloudflareApi(options: ApiOptions) {
	const calls: Call[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = (init?.method ?? "GET").toUpperCase();
		const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
		const authorization = new Headers(init?.headers).get("authorization") ?? "";
		if (url.includes("/.well-known/agent-card.json")) {
			calls.push({ method, url, body, authorization });
			if (options.verifyStatus === 0) throw new TypeError("network down");
			return new Response("", { status: options.verifyStatus ?? 200 });
		}
		if (!url.includes("cloudflare.com")) return original(input as RequestInfo, init);
		calls.push({ method, url, body, authorization });
		const json = (payload: unknown, status = 200) => Response.json(payload, { status });
		const permission = (kind: "d1" | "query" | "upload" | "account", status: number, errors: { code?: number; message: string }[]) => {
			const left = options.permissionLeft?.[kind] ?? 0;
			if (left <= 0) return null;
			options.permissionLeft![kind] = left - 1;
			return json({ success: false, errors }, status);
		};
		if (url.startsWith("https://dash.cloudflare.com/oauth2/token")) {
			const refresh = new URLSearchParams(body).get("refresh_token");
			return json({ access_token: "cf_access_SECRET", refresh_token: `next-${refresh}`, expires_in: 3600 });
		}
		if (url.endsWith("/accounts?per_page=50")) {
			if (options.accountsThrow) throw new TypeError("Invalid header value.");
			const denied = permission("account", 403, [{ code: 10000, message: "Authentication error" }]);
			if (denied) return denied;
			return json({ success: true, result: options.accounts ?? [{ id: accountId, name: "Example account" }] });
		}
		if (url.endsWith("/workers/subdomain") && method === "GET") {
			if (options.subdomainStatus) return json({ success: false, errors: options.subdomainErrors ?? [] }, options.subdomainStatus);
			return json({ success: true, result: { subdomain: options.subdomain ?? "example" } });
		}
		if (url.endsWith("/workers/subdomain") && method === "PUT") return json({ success: true, result: { subdomain: "picked" } });
		if (/\/workers\/scripts(?:\?|$)/.test(url) && !url.includes("/workers/scripts/") && method === "GET") {
			const names = options.workerNames ?? [];
			return json({ success: true, result: names.map((id) => ({ id })), result_info: { total_count: names.length } });
		}
		if (url.includes("/workers/scripts/") && url.endsWith("/settings")) {
			if (!options.scriptExists) return new Response("", { status: 404 });
			const bindings = options.scriptTag ? [{ type: "plain_text", name: PROVISION_TAG_NAME, text: options.scriptTag }] : [];
			return json({ success: true, result: { bindings } });
		}
		if (url.includes("/workers/scripts/") && method === "GET") {
			if (!options.scriptExists) return new Response("", { status: 404 });
			return new Response("/* a2a-exposed inbox */\nexport default { fetch() { return new Response('user-worker') } }", { status: 200, headers: { "content-type": "application/javascript" } });
		}
		if (url.includes("/d1/database?") && method === "GET") return json({ success: true, result: options.d1Existing ?? [] });
		if (url.endsWith("/d1/database") && method === "POST") {
			const denied = permission("d1", 403, [{ code: 10000, message: "Authentication error" }]);
			if (denied) return denied;
			if (options.d1Status) return json({ success: false, errors: options.d1Errors ?? [{ code: 7500, message: "database name is invalid" }] }, options.d1Status);
			return json({ success: true, result: { uuid: d1Id, name: "my-agent" } });
		}
		if (url.endsWith("/query") && method === "POST") {
			const denied = permission("query", 403, [{ code: 7403, message: "Unauthorized" }]);
			if (denied) return denied;
			if (options.queryStatus) return json({ success: false, errors: [{ code: 7500, message: "query failed" }] }, options.queryStatus);
			return json({ success: true, result: [{ results: [], success: true }] });
		}
		if (url.includes("/workers/scripts/") && method === "PUT") {
			const denied = permission("upload", 403, [{ message: "No access to the specified resource" }]);
			if (denied) return denied;
			return options.uploadStatus ? new Response("", { status: options.uploadStatus }) : json({ success: true, result: {} });
		}
		if (url.endsWith("/subdomain") && method === "POST") return json({ success: true, result: { enabled: true } });
		if (url.includes("/zones?")) return json({ success: true, result: options.zones ?? [] });
		if (url.endsWith("/workers/domains") && method === "PUT") return json({ success: true, result: { hostname: "agent.example.com" } });
		if (url.endsWith("/workers/domains") && method === "GET") return json({ success: true, result: options.domains ?? [] });
		if (url.includes("/workers/domains/") && method === "DELETE") return json({ success: true, result: {} });
		if (url.includes("/d1/database/") && method === "GET") return json({ success: true, result: { uuid: d1Id, name: options.d1Name ?? "my-agent" } });
		if (url.includes("/d1/database/") && method === "DELETE") return json({ success: true, result: {} });
		if (method === "DELETE" && /\/workers\/scripts\/[^/]+$/.test(url)) return json({ success: true, result: {} });
		return new Response(`unexpected ${method} ${url}`, { status: 500 });
	}) as typeof fetch;
	return { calls, restore: () => { globalThis.fetch = original; } };
}

function appFor(db: ReturnType<typeof openDb>, permissionDelaysMs?: number[]) {
	return createApp({
		AUTH_SECRET: secret,
		DB: db,
		GITHUB_CLIENT_ID: "gh-id",
		GITHUB_CLIENT_SECRET: "gh-secret",
		CLOUDFLARE_OAUTH_CLIENT_ID: "cf-id",
		CLOUDFLARE_OAUTH_CLIENT_SECRET: "cf-secret",
	}, { database: db, inboxScript: stubScript, inboxMigrations: INBOX_MIGRATIONS, ...(permissionDelaysMs ? { permissionDelaysMs } : {}) });
}

async function finishPermissionWaits(app: ReturnType<typeof createApp>, cookie: string, first: Response) {
	let response = first;
	let html = await response.text();
	let hops = 0;
	while (html.includes(PERMISSION_WAIT)) {
		assert.ok(hops < 6, html);
		assert.match(html, /class="choice-hint" role="status">Waiting for Cloudflare to apply the new permission…</);
		assert.equal(html.includes(">Try again<"), false);
		assert.equal(html.includes("code 10000"), false);
		assert.equal(html.includes("code 7403"), false);
		assert.equal(html.includes("No access to the specified resource"), false);
		assert.equal(html.includes("Copy this owner token now."), false);
		assert.ok(refreshSeconds(html) >= 1);
		response = await app.request(`${origin}/app/cloudflare`, { headers: { cookie } });
		assert.equal(response.status, 200);
		html = await response.text();
		hops++;
	}
	return { html, response, hops };
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

const WORKER_STEPS = ["account", "address", "name", "database", "migrations", "upload", "verify"] as const;

async function postStep(app: ReturnType<typeof createApp>, cookie: string, body: string) {
	const response = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body,
	});
	assert.equal(response.status, 200, await response.clone().text());
	return response;
}

async function walkWorkers(app: ReturnType<typeof createApp>, cookie: string, through: (typeof WORKER_STEPS)[number], extra = "") {
	let last: Response | null = null;
	for (const step of WORKER_STEPS) {
		last = await postStep(app, cookie, `action=step&step=${step}&name=my-agent${extra}`);
		if (step === through) break;
	}
	return last!;
}

function apiCalls(calls: Call[]) {
	return calls.filter((call) => call.url.includes("api.cloudflare.com"));
}

function captureLogs() {
	const lines: string[] = [];
	const orig = console.log;
	console.log = (...args: unknown[]) => {
		lines.push(args.map((arg) => String(arg)).join(" "));
	};
	return { lines, restore: () => { console.log = orig; } };
}

test("cfCall strips a newline from the bearer token and omits a GET body", async () => {
	let method = "";
	let auth = "";
	let redirect = "";
	let sawBody = false;
	const fetchImpl = (async (_url: string, init?: RequestInit) => {
		method = init?.method ?? "";
		redirect = init?.redirect ?? "";
		sawBody = init?.body !== undefined;
		auth = new Headers(init?.headers).get("authorization") ?? "";
		return Response.json({ success: true, result: [] });
	}) as typeof fetch;
	const result = await cfCall({ fetchImpl, token: "cf_access\r\nSECRET\0", method: "GET", path: "/accounts?per_page=50", fetchMs: 1000 });
	assert.equal(result.ok, true);
	assert.equal(method, "GET");
	assert.equal(redirect, "manual");
	assert.equal(sawBody, false);
	assert.equal(auth, "Bearer cf_accessSECRET");
});

test("a workers.dev inbox walks one step at a time and the owner token is shown once", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const api = cloudflareApi({});
	t.after(api.restore);
	const started = await app.request(`${origin}/app/cloudflare?connected=1`, { headers: { cookie } });
	assert.equal(started.status, 303);
	const page = await (await app.request(started.headers.get("location") ?? "", { headers: { cookie } })).text();
	assert.match(page, /Cloudflare is connected, and the permissions this inbox needs are granted/);
	assert.match(page, /Check the Cloudflare account/);
	assertChoicesHeld(page, "Check the Cloudflare account");
	assert.match(page, /Not checked yet/);
	assert.equal(api.calls.length, 0);

	const account = await postStep(app, cookie, "action=step&step=account&name=my-agent");
	const accountHtml = await account.text();
	assert.match(accountHtml, /This Cloudflare account is selected/);
	assert.match(accountHtml, /Check the workers\.dev name/);
	assert.deepEqual(apiCalls(api.calls).map((call) => new URL(call.url).pathname), ["/client/v4/accounts"]);
	assert.equal(accountHtml.includes("https://my-agent.example.workers.dev"), false);

	const address = await postStep(app, cookie, "action=step&step=address&name=my-agent");
	assert.match(await address.text(), /Address name example\.workers\.dev/);
	assert.equal(apiCalls(api.calls).some((call) => call.url.includes("/d1/database")), false);
	assert.ok(apiCalls(api.calls).some((call) => call.url.endsWith("/workers/subdomain")));

	const named = await postStep(app, cookie, "action=step&step=name&name=my-agent");
	assert.match(await named.text(), /Inbox name my-agent: free/);
	assert.equal(apiCalls(api.calls).some((call) => call.method === "POST" && call.url.endsWith("/d1/database")), false);
	assert.equal(apiCalls(api.calls).some((call) => call.method === "GET" && call.url.includes("/workers/scripts/") && !call.url.endsWith("/settings")), false);

	const database = await postStep(app, cookie, "action=step&step=database&name=my-agent");
	assert.match(await database.text(), /Database my-agent is created/);
	assert.equal(apiCalls(api.calls).filter((call) => call.method === "POST" && call.url.endsWith("/d1/database")).length, 1);
	assert.equal(apiCalls(api.calls).some((call) => call.url.endsWith("/query")), false);

	const migrated = await postStep(app, cookie, "action=step&step=migrations&name=my-agent");
	assert.match(await migrated.text(), /The database setup is applied/);
	assert.ok(apiCalls(api.calls).some((call) => call.url.endsWith("/query") && call.body.includes("CREATE TABLE")));
	assert.equal(apiCalls(api.calls).some((call) => call.method === "PUT" && call.url.includes("/workers/scripts/")), false);

	const uploaded = await postStep(app, cookie, "action=step&step=upload&name=my-agent");
	const uploadHtml = await uploaded.text();
	assert.match(uploadHtml, /The inbox is uploaded/);
	assert.match(uploadHtml, /Copy this owner token now/);
	assert.match(uploadHtml, /a2aot_/);
	assert.match(uploadHtml, /Check that the inbox answers/);
	assert.equal(uploadHtml.includes("https://my-agent.example.workers.dev"), false);
	assert.equal(uploadHtml.includes("cf_access_SECRET"), false);
	assert.equal(uploadHtml.includes("cf_refresh_SECRET"), false);
	const userId = (await db.prepare('SELECT id FROM "user"').first<{ id: string }>())?.id ?? "";
	const pending = await readCloudflareInbox(db, userId);
	assert.equal(pending?.status, "pending");
	assert.equal(pending?.public_url, null);
	assert.equal(pending?.d1_id, d1Id);
	assert.equal(pending?.wizard_step, "upload");
	const shown = uploadHtml.match(/a2aot_[A-Za-z0-9_-]+/)?.[0] ?? "";
	assert.equal(pending?.owner_token_hash, await hashOwnerToken(shown));
	assert.equal(JSON.stringify(pending).includes(shown), false);
	const upload = api.calls.find((call) => call.method === "PUT" && call.url.includes("/workers/scripts/"));
	assert.ok(upload);
	assert.match(upload!.body, /inbox-stub/);
	assert.match(upload!.body, new RegExp(shown));
	assert.equal(upload!.authorization, "Bearer cf_access_SECRET");
	assert.equal(api.calls.some((call) => call.url.includes("api.cloudflare.com") && (call.body.includes("cf_refresh_SECRET") || call.authorization.includes("cf_refresh"))), false);

	const beforeVerify = api.calls.filter((call) => call.url.startsWith("https://dash.cloudflare.com/")).length;
	const verified = await postStep(app, cookie, "action=step&step=verify&name=my-agent");
	const html = await verified.text();
	assert.match(html, /https:\/\/my-agent\.example\.workers\.dev/);
	assert.match(html, /The inbox answers/);
	assertChoicesOpen(html);
	assert.equal(html.includes(shown), false);
	assert.equal(html.includes(SETUP_NOT_PROVISIONED), false);
	assert.equal(api.calls.filter((call) => call.url.startsWith("https://dash.cloudflare.com/")).length, beforeVerify);
	assert.ok(api.calls.some((call) => call.url === "https://my-agent.example.workers.dev/.well-known/agent-card.json"));
	const inbox = await readCloudflareInbox(db, userId);
	assert.equal(inbox?.status, "ready");
	assert.equal(inbox?.public_url, "https://my-agent.example.workers.dev");
	assert.equal(inbox?.cf_account_id, accountId);
	const storedRefresh = (await db.prepare(`SELECT refresh_enc FROM cloudflare_grant WHERE "userId" = ?`).bind(userId).first<{ refresh_enc: string }>())?.refresh_enc;
	assert.equal(await openCloudflareRefresh(secret, userId, storedRefresh), `${"next-".repeat(6)}cf_refresh_SECRET`);

	const beforeAgain = apiCalls(api.calls).length;
	const again = await postStep(app, cookie, "action=step&step=account&name=my-agent");
	assert.equal(apiCalls(api.calls).length, beforeAgain);
	assert.match(await again.text(), /The inbox answers/);
	const accountPage = await (await app.request(`${origin}/app`, { headers: { cookie } })).text();
	assert.match(accountPage, /my-agent\.example\.workers\.dev/);
	assert.match(accountPage, /In your Cloudflare/);
	assert.match(accountPage, new RegExp(`/app/cloudflare/${inbox?.id}`));
	assert.match(accountPage, /data-copy="https:\/\/my-agent\.example\.workers\.dev"/);
	assert.equal(accountPage.includes(shown), false);
});

test("a later step does not run before the earlier ones", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const api = cloudflareApi({});
	t.after(api.restore);
	const skipped = await postStep(app, cookie, "action=step&step=upload&name=my-agent");
	assert.match(await skipped.text(), /Check the Cloudflare account/);
	assert.equal(api.calls.length, 0);
	assert.equal(await readCloudflareInbox(db, (await db.prepare('SELECT id FROM "user"').first<{ id: string }>())?.id ?? ""), null);
});

test("a stale sign-in does not call Cloudflare, and sign-in again runs only the next step", async (t) => {
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
	assert.equal(api.calls.length, 0);
	assert.equal(await readCloudflareInbox(db, (await db.prepare('SELECT id FROM "user"').first<{ id: string }>())?.id ?? ""), null);
	const resume = posted.headers.getSetCookie().find((value) => value.startsWith("__Host-a2a_cf_resume="))?.split(";")[0] ?? "";
	const fresh = await signIn(app);
	const continued = await app.request(`${origin}/app/cloudflare`, { headers: { cookie: `${fresh}; ${resume}` } });
	assert.equal(continued.status, 200);
	const html = await continued.text();
	assert.match(html, /This Cloudflare account is selected/);
	assert.match(html, /value="my-agent"/);
	assert.equal(html.includes("https://my-agent.example.workers.dev"), false);
	assert.equal(continued.headers.getSetCookie().some((value) => value.startsWith("__Host-a2a_cf_owner=")), false);
	assert.equal(apiCalls(api.calls).some((call) => call.url.includes("/workers/subdomain")), false);
	assert.equal(apiCalls(api.calls).some((call) => call.method === "PUT" && call.url.includes("/workers/scripts/")), false);
});

test("a stale sign-in still shows the Cloudflare account list after sign-in", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const session = await db.prepare("SELECT id, createdAt FROM session").first<{ id: string; createdAt: string | number }>();
	const staleAt = new Date(new Date(session!.createdAt).getTime() - 11 * 60 * 1000);
	const stored = typeof session!.createdAt === "number" ? staleAt.getTime() : staleAt.toISOString();
	await db.prepare("UPDATE session SET createdAt = ? WHERE id = ?").bind(stored, session!.id).run();
	const otherId = "c".repeat(32);
	const api = cloudflareApi({ accounts: [{ id: accountId, name: "Example account" }, { id: otherId, name: "Other account" }] });
	t.after(api.restore);
	const posted = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=provision&name=my-agent",
	});
	assert.equal(posted.status, 303);
	assert.equal(api.calls.length, 0);
	const resume = posted.headers.getSetCookie().find((value) => value.startsWith("__Host-a2a_cf_resume="))?.split(";")[0] ?? "";
	const fresh = await signIn(app);
	const accountPage = await app.request(`${origin}/app`, { headers: { cookie: `${fresh}; ${resume}` } });
	assert.equal(accountPage.status, 303);
	assert.equal(new URL(accountPage.headers.get("location") ?? "", origin).pathname, "/app/cloudflare");
	assert.equal(accountPage.headers.getSetCookie().some((value) => value.startsWith("__Host-a2a_cf_resume=") && value.includes("Max-Age=0")), false);
	assert.equal(api.calls.length, 0);
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM verification WHERE identifier LIKE 'cf-resume:%'`).first<{ n: number }>())?.n, 1);
	const continued = await app.request(`${origin}/app/cloudflare`, { headers: { cookie: `${fresh}; ${resume}` } });
	assert.equal(continued.status, 200);
	const html = await continued.text();
	assert.match(html, /Which Cloudflare account\?/);
	assert.match(html, /Choose the Cloudflare account to use/);
	assert.match(html, /Example account/);
	assert.match(html, /Other account/);
	assert.match(html, new RegExp(`value="${accountId}"`));
	assert.match(html, new RegExp(`value="${otherId}"`));
	assert.match(html, /value="my-agent"/);
	assert.equal(html.includes("?error=account"), false);
	assert.equal(api.calls.some((call) => call.method === "POST" && call.url.endsWith("/d1/database")), false);
	assert.equal(api.calls.some((call) => call.method === "PUT" && call.url.includes("/workers/scripts/")), false);
	assert.ok(continued.headers.getSetCookie().some((value) => value.startsWith("__Host-a2a_cf_resume=") && value.includes("Max-Age=0")));

	const created = await postStep(app, fresh, `action=step&step=account&name=my-agent&account=${otherId}`);
	assert.match(await created.text(), /This Cloudflare account is selected/);
	assert.equal(api.calls.some((call) => call.method === "POST" && call.url.endsWith("/d1/database")), false);
	const userId = (await db.prepare('SELECT id FROM "user"').first<{ id: string }>())?.id ?? "";
	assert.equal((await readCloudflareInbox(db, userId))?.cf_account_id, otherId);
	assert.equal((await readCloudflareInbox(db, userId))?.d1_id, null);
});

async function staleSession(db: ReturnType<typeof openDb>) {
	const session = await db.prepare("SELECT id, createdAt FROM session").first<{ id: string; createdAt: string | number }>();
	const staleAt = new Date(new Date(session!.createdAt).getTime() - 11 * 60 * 1000);
	const stored = typeof session!.createdAt === "number" ? staleAt.getTime() : staleAt.toISOString();
	await db.prepare("UPDATE session SET createdAt = ? WHERE id = ?").bind(stored, session!.id).run();
}

test("a stale sign-in keeps a missing workers.dev name on the setup page", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const api = cloudflareApi({ subdomain: "" });
	t.after(api.restore);
	await walkWorkers(app, cookie, "account");
	await staleSession(db);
	const posted = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=step&step=address&name=my-agent",
	});
	assert.equal(posted.status, 303);
	const resume = posted.headers.getSetCookie().find((value) => value.startsWith("__Host-a2a_cf_resume="))?.split(";")[0] ?? "";
	const fresh = await signIn(app);
	const page = await app.request(`${origin}/app/cloudflare`, { headers: { cookie: `${fresh}; ${resume}` } });
	assert.equal(page.status, 200);
	const html = await page.text();
	assert.match(html, /no workers\.dev name yet/);
	assert.match(html, /value="my-agent"/);
	assert.equal(api.calls.some((call) => call.method === "POST" && call.url.endsWith("/d1/database")), false);
});

test("a stale sign-in keeps the zone list when the hostname is not on a domain", async (t) => {
	t.after(githubFetch(consentScope("inbox", "zone")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie, "zone");
	const api = cloudflareApi({ zones: [{ id: "d".repeat(32), name: "example.com", status: "active" }] });
	t.after(api.restore);
	await postStep(app, cookie, "action=step&step=account");
	await staleSession(db);
	const posted = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=step&step=address&hostname=https://other.example.net/inbox",
	});
	assert.equal(posted.status, 303);
	const resume = posted.headers.getSetCookie().find((value) => value.startsWith("__Host-a2a_cf_resume="))?.split(";")[0] ?? "";
	const fresh = await signIn(app);
	const page = await app.request(`${origin}/app/cloudflare`, { headers: { cookie: `${fresh}; ${resume}` } });
	assert.equal(page.status, 200);
	const html = await page.text();
	assert.match(html, /That address is not on a domain in this Cloudflare account\./);
	assert.match(html, /example\.com/);
	assert.match(html, /value="other\.example\.net"/);
	assert.equal(api.calls.some((call) => call.method === "POST" && call.url.endsWith("/d1/database")), false);
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
	await postStep(app, cookie, "action=step&step=account");
	await postStep(app, cookie, "action=step&step=address&hostname=https://agent.example.com/inbox");
	await postStep(app, cookie, "action=step&step=name&hostname=agent.example.com");
	await postStep(app, cookie, "action=step&step=database&hostname=agent.example.com");
	await postStep(app, cookie, "action=step&step=migrations&hostname=agent.example.com");
	const uploaded = await postStep(app, cookie, "action=step&step=upload&hostname=agent.example.com");
	assert.match(await uploaded.text(), /The inbox is uploaded/);
	const verified = await postStep(app, cookie, "action=step&step=verify&hostname=agent.example.com");
	const html = await verified.text();
	assert.match(html, /https:\/\/agent\.example\.com/);
	assert.match(html, new RegExp(TUNNEL_CONNECTOR_LATER.replace(/[.]/g, "\\.")));
	assert.equal(html.includes(SETUP_NOT_PROVISIONED), false);
	assert.ok(api.calls.some((call) => call.method === "PUT" && call.url.endsWith("/workers/domains") && call.body.includes("agent.example.com")));
	assert.ok(api.calls.some((call) => call.method === "POST" && call.url.endsWith("/subdomain") && call.body.includes("false")));
	assert.ok(api.calls.some((call) => call.url === "https://agent.example.com/.well-known/agent-card.json"));
});

test("a missing workers.dev name asks for one and does not create a database", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const api = cloudflareApi({ subdomain: "" });
	t.after(api.restore);
	await walkWorkers(app, cookie, "account");
	const posted = await postStep(app, cookie, "action=step&step=address&name=my-agent");
	const html = await posted.text();
	assert.match(html, /no workers\.dev name yet/);
	assert.match(html, /Create this workers\.dev name/);
	assert.equal(api.calls.some((call) => call.method === "POST" && call.url.endsWith("/d1/database")), false);
	const retried = await postStep(app, cookie, "action=step&step=address&name=my-agent&subdomain=picked");
	assert.match(await retried.text(), /Address name picked\.workers\.dev/);
	assert.ok(api.calls.some((call) => call.method === "PUT" && call.url.endsWith("/workers/subdomain")));
	assert.equal(api.calls.some((call) => call.method === "POST" && call.url.endsWith("/d1/database")), false);
});

test("a workers.dev error code asks for a name and does not log a failure", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const api = cloudflareApi({ subdomainStatus: 400, subdomainErrors: [{ code: 10063, message: "You need a workers.dev subdomain" }] });
	t.after(api.restore);
	const logs = captureLogs();
	t.after(logs.restore);
	await walkWorkers(app, cookie, "account");
	const posted = await postStep(app, cookie, "action=step&step=address&name=my-agent");
	const html = await posted.text();
	assert.match(html, /no workers\.dev name yet/);
	assert.match(html, /code 10063/);
	assert.equal(logs.lines.some((line) => line.includes("cloudflare_provision_failed")), false);
	assert.equal(api.calls.some((call) => call.method === "POST" && call.url.endsWith("/d1/database")), false);
});

test("a thrown accounts call names the step and the error", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const api = cloudflareApi({ accountsThrow: true });
	t.after(api.restore);
	const logs = captureLogs();
	t.after(logs.restore);
	const posted = await postStep(app, cookie, "action=step&step=account&name=my-agent");
	const html = await posted.text();
	assert.match(html, /Cloudflare stops while reading your accounts/);
	assert.match(html, /Invalid header value/);
	assert.match(html, /Try again/);
	assert.equal(html.includes("cf_access_SECRET"), false);
	const line = logs.lines.find((entry) => entry.includes("cloudflare_provision_failed"));
	assert.ok(line);
	const parsed = JSON.parse(line!) as { step: string; status: number; errors: unknown[]; name: string; message: string };
	assert.equal(parsed.step, "account");
	assert.equal(parsed.status, 0);
	assert.deepEqual(parsed.errors, []);
	assert.equal(parsed.name, "TypeError");
	assert.match(parsed.message, /Invalid header value/);
	assert.equal(api.calls.some((call) => call.url.includes("/workers/subdomain")), false);
});

test("a database failure shows Cloudflare's code and message, and hides a secret", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const options: ApiOptions = { d1Status: 400, d1Errors: [{ code: 7500, message: "database name is invalid" }] };
	const api = cloudflareApi(options);
	t.after(api.restore);
	const logs = captureLogs();
	t.after(logs.restore);
	await walkWorkers(app, cookie, "name");
	const failed = await postStep(app, cookie, "action=step&step=database&name=my-agent");
	const html = await failed.text();
	assert.match(html, /Cloudflare stops while creating the database/);
	assert.match(html, /code 7500/);
	assert.match(html, /database name is invalid/);
	assert.match(html, /Try again/);
	const line = logs.lines.find((entry) => entry.includes("cloudflare_provision_failed"));
	assert.ok(line);
	const parsed = JSON.parse(line!) as { step: string; status: number; errors: { code: number; message: string }[] };
	assert.equal(parsed.step, "d1-create");
	assert.equal(parsed.status, 400);
	assert.equal(parsed.errors[0]?.code, 7500);
	assert.equal(parsed.errors[0]?.message, "database name is invalid");
	assert.equal(api.calls.some((call) => call.method === "PUT" && call.url.includes("/workers/scripts/")), false);

	options.d1Errors = [{ code: 7500, message: "Bearer cf_access_SECRET refused" }];
	logs.lines.length = 0;
	const secret = await postStep(app, cookie, "action=step&step=database&name=my-agent");
	const secretHtml = await secret.text();
	assert.match(secretHtml, /code 7500/);
	assert.match(secretHtml, /hidden because it contains a secret/);
	assert.equal(secretHtml.includes("cf_access_SECRET"), false);
	const secretLine = logs.lines.find((entry) => entry.includes("d1-create"));
	assert.ok(secretLine);
	assert.equal(secretLine!.includes("cf_access_SECRET"), false);
	assert.match(secretLine!, /redacted/);
});

test("a failed database setup retries without creating the database again", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const options: ApiOptions = { queryStatus: 500 };
	const api = cloudflareApi(options);
	t.after(api.restore);
	await walkWorkers(app, cookie, "database");
	const creates = () => api.calls.filter((call) => call.method === "POST" && call.url.endsWith("/d1/database")).length;
	assert.equal(creates(), 1);
	const failed = await postStep(app, cookie, "action=step&step=migrations&name=my-agent");
	assert.match(await failed.text(), /Cloudflare stops while applying the database setup/);
	assert.equal(creates(), 1);
	options.queryStatus = undefined;
	const retried = await postStep(app, cookie, "action=step&step=migrations&name=my-agent");
	assert.match(await retried.text(), /The database setup is applied/);
	assert.equal(creates(), 1);
});

test("an existing Worker name is refused and a failed upload can be continued", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const taken = cloudflareApi({ scriptExists: true });
	t.after(taken.restore);
	await walkWorkers(app, cookie, "address");
	const refused = await postStep(app, cookie, "action=step&step=name&name=my-agent");
	assert.match(await refused.text(), /A Worker with that name is already in this Cloudflare account/);
	assert.equal(taken.calls.some((call) => call.method === "POST" && call.url.endsWith("/d1/database")), false);
	taken.restore();

	const upload = { uploadStatus: 500 as number | undefined };
	const failed = cloudflareApi(upload);
	t.after(failed.restore);
	await walkWorkers(app, cookie, "migrations");
	const partial = await postStep(app, cookie, "action=step&step=upload&name=my-agent");
	const partialHtml = await partial.text();
	assert.match(partialHtml, /Cloudflare stops while uploading the inbox/);
	assertChoicesHeld(partialHtml, "Try again");
	const userId = (await db.prepare('SELECT id FROM "user"').first<{ id: string }>())?.id ?? "";
	assert.equal((await readCloudflareInbox(db, userId))?.d1_id, d1Id);
	assert.equal((await readCloudflareInbox(db, userId))?.status, "pending");
	const creates = () => failed.calls.filter((call) => call.method === "POST" && call.url.endsWith("/d1/database")).length;
	assert.equal(creates(), 1);
	upload.uploadStatus = undefined;
	const continued = await postStep(app, cookie, "action=step&step=upload&name=my-agent");
	assert.match(await continued.text(), /The inbox is uploaded/);
	assert.equal(creates(), 1);
	const verified = await postStep(app, cookie, "action=step&step=verify&name=my-agent");
	assert.match(await verified.text(), /https:\/\/my-agent\.example\.workers\.dev/);
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
	await walkWorkers(app, cookie, "migrations");
	await postStep(app, cookie, "action=step&step=upload&name=my-agent");
	const userId = (await db.prepare('SELECT id FROM "user"').first<{ id: string }>())?.id ?? "";
	assert.equal((await readCloudflareInbox(db, userId))?.d1_id, d1Id);
	options.scriptExists = true;
	options.uploadStatus = undefined;
	const puts = () => api.calls.filter((call) => call.method === "PUT" && call.url.includes("/workers/scripts/")).length;
	const before = puts();
	const again = await postStep(app, cookie, "action=step&step=upload&name=my-agent");
	assert.match(await again.text(), /This page does not replace it/);
	assert.equal(puts(), before);
	assert.equal((await readCloudflareInbox(db, userId))?.status, "pending");
	assert.equal((await readCloudflareInbox(db, userId))?.d1_id, d1Id);
	assert.equal(api.calls.some((call) => call.method === "GET" && call.url.includes("/workers/scripts/") && !call.url.endsWith("/settings")), false);
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
	await walkWorkers(app, cookie, "migrations");
	await postStep(app, cookie, "action=step&step=upload&name=my-agent");
	const userId = (await db.prepare('SELECT id FROM "user"').first<{ id: string }>())?.id ?? "";
	const savedTag = (await readCloudflareInbox(db, userId))?.script_tag ?? "";
	assert.equal(savedTag.length, 64);
	assert.equal(savedTag.includes("a2a-exposed inbox"), false);
	options.scriptTag = savedTag;
	options.scriptExists = true;
	options.uploadStatus = undefined;
	const again = await postStep(app, cookie, "action=step&step=upload&name=my-agent");
	assert.match(await again.text(), /The inbox is uploaded/);
	assert.equal((await readCloudflareInbox(db, userId))?.status, "pending");
	assert.equal((await readCloudflareInbox(db, userId))?.public_url, null);
	assert.ok(api.calls.some((call) => call.method === "PUT" && call.url.includes("/workers/scripts/") && call.body.includes(PROVISION_TAG_NAME) && call.body.includes(savedTag)));
	assert.equal(api.calls.some((call) => call.method === "GET" && call.url.includes("/workers/scripts/") && !call.url.endsWith("/settings")), false);
	const verified = await postStep(app, cookie, "action=step&step=verify&name=my-agent");
	assert.equal((await readCloudflareInbox(db, userId))?.status, "ready");
	assert.match(await verified.text(), /https:\/\/my-agent\.example\.workers\.dev/);
});

test("the inbox check can be retried without uploading again", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const options: ApiOptions = { verifyStatus: 503 };
	const api = cloudflareApi(options);
	t.after(api.restore);
	await walkWorkers(app, cookie, "upload");
	const puts = () => api.calls.filter((call) => call.method === "PUT" && call.url.includes("/workers/scripts/")).length;
	const before = puts();
	const failed = await postStep(app, cookie, "action=step&step=verify&name=my-agent");
	assert.match(await failed.text(), /The inbox does not answer yet\. HTTP 503\./);
	assert.equal((await readCloudflareInbox(db, (await db.prepare('SELECT id FROM "user"').first<{ id: string }>())?.id ?? ""))?.public_url, null);
	options.verifyStatus = 200;
	const retried = await postStep(app, cookie, "action=step&step=verify&name=my-agent");
	assert.match(await retried.text(), /https:\/\/my-agent\.example\.workers\.dev/);
	assert.equal(puts(), before);
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
	assert.equal(html.includes("Check the Cloudflare account"), false);
	assert.equal(html.includes("Create it in Cloudflare"), false);
});

test("a just-granted permission is retried for about 15 seconds, and other errors are not", () => {
	assert.equal(PERMISSION_TRIES, 4);
	assert.deepEqual(PERMISSION_DELAYS_MS, [2_000, 4_000, 8_000]);
	assert.equal(PERMISSION_DELAYS_MS.reduce((sum, delay) => sum + delay, 0), 14_000);
	const failure = (code: number | null, message: string) => ({
		ok: false as const,
		status: 403,
		code,
		errors: [{ code, message }],
	});
	assert.equal(permissionNotReady(failure(10000, "Authentication error")), true);
	assert.equal(permissionNotReady(failure(7403, "Unauthorized")), true);
	assert.equal(permissionNotReady(failure(null, "No access to the specified resource")), true);
	assert.equal(permissionNotReady(failure(null, "NO ACCESS TO THE SPECIFIED RESOURCE")), true);
	assert.equal(permissionNotReady({ ok: false, status: 403, code: null, errors: [{ code: 10000, message: "Authentication error" }] }), true);
	assert.equal(permissionNotReady(failure(7500, "database name is invalid")), false);
	assert.equal(permissionNotReady({ ok: false, status: 500, code: null, errors: [] }), false);
});

test("creating the database waits through code 10000, then continues", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db, [0, 0, 0]);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const options: ApiOptions = { permissionLeft: { d1: 2 } };
	const api = cloudflareApi(options);
	t.after(api.restore);
	await walkWorkers(app, cookie, "name");
	const creates = () => api.calls.filter((call) => call.method === "POST" && call.url.endsWith("/d1/database")).length;
	const started = await postStep(app, cookie, "action=step&step=database&name=my-agent");
	const done = await finishPermissionWaits(app, cookie, started);
	assert.equal(done.hops, 2);
	assert.match(done.html, /Database my-agent is created/);
	assert.match(done.html, /Apply the database setup/);
	assert.equal(done.html.includes(PERMISSION_WAIT), false);
	assert.equal(done.response.headers.get("refresh"), null);
	assert.equal(creates(), 3);
	await app.request(`${origin}/app/cloudflare`, { headers: { cookie } });
	assert.equal(creates(), 3);
});

test("database setup shows code 7403 only after four tries", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db, [0, 0, 0]);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const options: ApiOptions = { permissionLeft: { query: 4 } };
	const api = cloudflareApi(options);
	t.after(api.restore);
	await walkWorkers(app, cookie, "database");
	const queries = () => api.calls.filter((call) => call.method === "POST" && call.url.endsWith("/query")).length;
	const started = await postStep(app, cookie, "action=step&step=migrations&name=my-agent");
	const done = await finishPermissionWaits(app, cookie, started);
	assert.equal(done.hops, 3);
	assert.match(done.html, /Cloudflare stops while applying the database setup/);
	assert.match(done.html, /code 7403/);
	assert.match(done.html, />Try again</);
	assert.equal(done.html.includes(PERMISSION_WAIT), false);
	assert.equal(done.response.headers.get("refresh"), null);
	assert.equal(queries(), 4);
	await app.request(`${origin}/app/cloudflare`, { headers: { cookie } });
	assert.equal(queries(), 4);
});

test("uploading the inbox waits through no access, then shows the owner token", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db, [0, 0, 0]);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const options: ApiOptions = { permissionLeft: { upload: 3 } };
	const api = cloudflareApi(options);
	t.after(api.restore);
	await walkWorkers(app, cookie, "migrations");
	const puts = () => api.calls.filter((call) => call.method === "PUT" && call.url.includes("/workers/scripts/")).length;
	const started = await postStep(app, cookie, "action=step&step=upload&name=my-agent");
	const done = await finishPermissionWaits(app, cookie, started);
	assert.equal(done.hops, 3);
	assert.match(done.html, /The inbox is uploaded/);
	assert.match(done.html, /Copy this owner token now/);
	assert.equal(done.html.includes("No access to the specified resource"), false);
	assert.equal(done.html.includes(PERMISSION_WAIT), false);
	assert.equal(puts(), 4);
});

test("an account permission error is shown at once and is not retried", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db, [0, 0, 0]);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const options: ApiOptions = { permissionLeft: { account: 5 } };
	const api = cloudflareApi(options);
	t.after(api.restore);
	const accounts = () => api.calls.filter((call) => call.url.endsWith("/accounts?per_page=50")).length;
	const failed = await postStep(app, cookie, "action=step&step=account&name=my-agent");
	const html = await failed.text();
	assert.match(html, /Cloudflare stops while reading your accounts/);
	assert.match(html, /code 10000/);
	assert.match(html, />Try again</);
	assert.equal(html.includes(PERMISSION_WAIT), false);
	assert.equal(failed.headers.get("refresh"), null);
	assert.equal(accounts(), 1);
	await app.request(`${origin}/app/cloudflare`, { headers: { cookie } });
	assert.equal(accounts(), 1);
});

test("a permission wait does not run again until the pause has passed", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db, [60_000, 0, 0]);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const options: ApiOptions = { permissionLeft: { d1: 5 } };
	const api = cloudflareApi(options);
	t.after(api.restore);
	await walkWorkers(app, cookie, "name");
	const creates = () => api.calls.filter((call) => call.method === "POST" && call.url.endsWith("/d1/database")).length;
	const waiting = await postStep(app, cookie, "action=step&step=database&name=my-agent");
	const html = await waiting.text();
	assert.match(html, new RegExp(PERMISSION_WAIT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	const refresh = refreshSeconds(html);
	assert.ok(refresh >= 58 && refresh <= 60, String(refresh));
	assert.equal(creates(), 1);
	const early = await app.request(`${origin}/app/cloudflare`, { headers: { cookie } });
	assert.match(await early.text(), /Waiting for Cloudflare to apply the new permission/);
	assert.equal(creates(), 1);
});

function applyCookies(jar: Map<string, string>, response: Response) {
	for (const raw of response.headers.getSetCookie()) {
		const parts = raw.split(";").map((part) => part.trim());
		const pair = parts[0] ?? "";
		const eq = pair.indexOf("=");
		if (eq <= 0) continue;
		const cleared = parts.some((part) => /^max-age=0$/i.test(part));
		if (cleared) jar.delete(pair.slice(0, eq));
		else jar.set(pair.slice(0, eq), pair.slice(eq + 1));
	}
}

function cookieHeader(jar: Map<string, string>): string {
	return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

test("a stale sign-in during a permission wait offers Try again and then continues", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db, [0, 0, 0]);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const options: ApiOptions = { permissionLeft: { d1: 5 } };
	const api = cloudflareApi(options);
	t.after(api.restore);
	await walkWorkers(app, cookie, "name");
	const creates = () => api.calls.filter((call) => call.method === "POST" && call.url.endsWith("/d1/database")).length;
	const waiting = await postStep(app, cookie, "action=step&step=database&name=my-agent");
	const waitingHtml = await waiting.text();
	assert.match(waitingHtml, /Waiting for Cloudflare to apply the new permission/);
	assert.equal(waitingHtml.includes(">Try again<"), false);
	assert.equal(creates(), 1);
	const session = await db.prepare("SELECT id, createdAt FROM session").first<{ id: string; createdAt: string | number }>();
	const staleAt = new Date(new Date(session!.createdAt).getTime() - 11 * 60 * 1000);
	const stored = typeof session!.createdAt === "number" ? staleAt.getTime() : staleAt.toISOString();
	await db.prepare("UPDATE session SET createdAt = ? WHERE id = ?").bind(stored, session!.id).run();
	const jar = new Map<string, string>([[SESSION_COOKIE, cookie.slice(cookie.indexOf("=") + 1)]]);
	const stale = await app.request(`${origin}/app/cloudflare`, { headers: { cookie: cookieHeader(jar) } });
	const html = await stale.text();
	assert.match(html, /Waiting for Cloudflare to apply the new permission/);
	assert.match(html, />Try again</);
	assert.equal(stale.headers.get("refresh"), null);
	assert.equal(creates(), 1);
	const again = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie: cookieHeader(jar), "content-type": "application/x-www-form-urlencoded" },
		body: "action=step&step=database&name=my-agent",
	});
	applyCookies(jar, again);
	const signInUrl = new URL(again.headers.get("location") ?? "", origin);
	assert.equal(signInUrl.pathname, "/app/sign-in");
	assert.equal(signInUrl.searchParams.get("reauth"), "cloudflare");
	assert.equal(signInUrl.searchParams.get("return"), "/app/cloudflare");
	const posted = await app.request(`${origin}/app/sign-in`, {
		method: "POST",
		headers: { origin, cookie: cookieHeader(jar), "content-type": "application/x-www-form-urlencoded" },
		body: "provider=github&next=%2Fapp%2Fcloudflare",
	});
	applyCookies(jar, posted);
	const state = new URL(posted.headers.get("location") ?? "", origin).searchParams.get("state") ?? "";
	const done = await app.request(`${origin}/api/auth/callback/github?code=abc&state=${encodeURIComponent(state)}`, {
		headers: { cookie: cookieHeader(jar) },
	});
	applyCookies(jar, done);
	const back = new URL(done.headers.get("location") ?? "", origin);
	assert.equal(back.pathname, "/app/cloudflare");
	const continued = await app.request(back, { headers: { cookie: cookieHeader(jar) } });
	const continuedHtml = await continued.text();
	assert.equal(continued.status, 200);
	assert.match(continuedHtml, /Waiting for Cloudflare to apply the new permission/);
	assert.ok(refreshSeconds(continuedHtml) >= 1);
	assert.equal(continuedHtml.includes(">Try again<"), false);
	assert.equal(creates(), 2);
});

test("a setup step answers with the new page instead of a reload", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const api = cloudflareApi({});
	t.after(api.restore);
	const response = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded", accept: "application/json", "x-setup-partial": "1" },
		body: "action=step&step=account&name=my-agent",
	});
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type") ?? "", /json/);
	const body = await response.json() as { html?: string; redirect?: string };
	assert.equal(body.redirect, undefined);
	assert.match(body.html ?? "", /This Cloudflare account is selected/);
	assert.match(body.html ?? "", /data-setup-root/);
	assert.equal(response.headers.get("refresh"), null);
});

test("your own domain lists the domains in the account", async (t) => {
	t.after(githubFetch(consentScope("inbox", "zone")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie, "zone");
	const zoneId = "d".repeat(32);
	const api = cloudflareApi({ zones: [{ id: zoneId, name: "example.com", status: "active" }] });
	t.after(api.restore);
	const account = await postStep(app, cookie, "action=step&step=account");
	assert.match(await account.text(), /Show my domains/);
	const listed = await postStep(app, cookie, "action=step&step=address");
	const html = await listed.text();
	assert.match(html, /Which domain\?/);
	assert.match(html, /example\.com/);
	assert.match(html, /name="zone"/);
	assert.equal(html.includes('name="hostname"'), false);
	const picked = await postStep(app, cookie, `action=step&step=address&zone=${zoneId}&name=myagent`);
	assert.match(await picked.text(), /Domain myagent\.example\.com/);
	const userId = (await db.prepare('SELECT id FROM "user"').first<{ id: string }>())?.id ?? "";
	const row = await readCloudflareInbox(db, userId);
	assert.equal(row?.hostname, "myagent.example.com");
	assert.equal(row?.zone_id, zoneId);
	assert.equal(api.calls.some((call) => call.method === "POST" && call.url.endsWith("/d1/database")), false);
});

test("the first Cloudflare agent is named from the connected account", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const options: ApiOptions = {};
	const api = cloudflareApi(options);
	t.after(api.restore);
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM cloudflare_inbox`).first<{ n: number }>())?.n, 0);
	options.permissionLeft = { account: 1 };
	const blocked = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=create&choice=inbox&host=workers&name=first-agent",
	});
	assert.equal(blocked.status, 200);
	assert.match(await blocked.text(), /this name was not used/);
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM cloudflare_inbox`).first<{ n: number }>())?.n, 0);
	options.permissionLeft = {};
	options.workerNames = ["taken-name"];
	const taken = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=create&choice=inbox&host=workers&name=taken-name",
	});
	assert.equal(taken.status, 200);
	assert.match(await taken.text(), /already in this Cloudflare account/);
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM cloudflare_inbox`).first<{ n: number }>())?.n, 0);
	const before = apiCalls(api.calls).length;
	const created = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=create&choice=inbox&host=workers&name=first-agent",
	});
	assert.equal(created.status, 303);
	const nextUrl = new URL(created.headers.get("location") ?? "", origin);
	assert.match(nextUrl.pathname, /^\/app\/cloudflare\/[0-9a-f]{32}$/);
	const added = apiCalls(api.calls).slice(before);
	assert.ok(added.some((call) => call.method === "GET" && call.url.endsWith("/accounts?per_page=50")));
	assert.ok(added.some((call) => call.method === "GET" && /\/workers\/scripts\?/.test(call.url)));
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM cloudflare_inbox`).first<{ n: number }>())?.n, 1);
	const page = await (await app.request(nextUrl, { headers: { cookie } })).text();
	assert.match(page, /value="first-agent"/);
	assert.match(page, /Check the Cloudflare account/);
});

test("a stale create keeps the typed name and checks it again after sign-in", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	await staleSession(db);
	const api = cloudflareApi({});
	t.after(api.restore);
	const posted = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=create&choice=inbox&host=workers&name=kept-name",
	});
	assert.equal(posted.status, 303);
	assert.equal(new URL(posted.headers.get("location") ?? "", origin).pathname, "/app/sign-in");
	assert.equal(api.calls.length, 0);
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM cloudflare_inbox`).first<{ n: number }>())?.n, 0);
	const resume = posted.headers.getSetCookie().find((value) => value.startsWith("__Host-a2a_cf_resume="))?.split(";")[0] ?? "";
	assert.ok(resume);
	const fresh = await signIn(app);
	const before = apiCalls(api.calls).length;
	const continued = await app.request(`${origin}/app/cloudflare`, { headers: { cookie: `${fresh}; ${resume}` } });
	assert.equal(continued.status, 303);
	const nextUrl = new URL(continued.headers.get("location") ?? "", origin);
	assert.match(nextUrl.pathname, /^\/app\/cloudflare\/[0-9a-f]{32}$/);
	const added = apiCalls(api.calls).slice(before);
	assert.ok(added.some((call) => call.method === "GET" && call.url.endsWith("/accounts?per_page=50")));
	assert.ok(added.some((call) => call.method === "GET" && /\/workers\/scripts\?/.test(call.url)));
	const page = await (await app.request(nextUrl, { headers: { cookie: fresh } })).text();
	assert.match(page, /value="kept-name"/);
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM cloudflare_inbox`).first<{ n: number }>())?.n, 1);
});

test("a stale create refuses a taken name after sign-in", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	await staleSession(db);
	const api = cloudflareApi({ workerNames: ["kept-name"] });
	t.after(api.restore);
	const posted = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=create&choice=inbox&host=workers&name=kept-name",
	});
	assert.equal(posted.status, 303);
	assert.equal(api.calls.length, 0);
	const resume = posted.headers.getSetCookie().find((value) => value.startsWith("__Host-a2a_cf_resume="))?.split(";")[0] ?? "";
	const fresh = await signIn(app);
	const continued = await app.request(`${origin}/app/cloudflare`, { headers: { cookie: `${fresh}; ${resume}` } });
	assert.equal(continued.status, 200);
	const html = await continued.text();
	assert.match(html, /already in this Cloudflare account/);
	assert.match(html, /value="kept-name"/);
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM cloudflare_inbox`).first<{ n: number }>())?.n, 0);
	assert.ok(continued.headers.getSetCookie().some((value) => value.startsWith("__Host-a2a_cf_resume=") && value.includes("Max-Age=0")));
});

test("several Cloudflare accounts defer the Worker list until one is chosen", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const otherId = "c".repeat(32);
	const api = cloudflareApi({
		accounts: [{ id: accountId, name: "Example account" }, { id: otherId, name: "Other account" }],
		workerNames: ["picked-name"],
	});
	t.after(api.restore);
	const created = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=create&choice=inbox&host=workers&name=picked-name",
	});
	assert.equal(created.status, 303);
	const added = apiCalls(api.calls);
	assert.equal(added.some((call) => /\/workers\/scripts\?/.test(call.url)), false);
	assert.ok(added.some((call) => call.method === "GET" && call.url.endsWith("/accounts?per_page=50")));
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM cloudflare_inbox`).first<{ n: number }>())?.n, 1);
});

test("a finished agent stays, and Create this agent starts another", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const api = cloudflareApi({});
	t.after(api.restore);
	await walkWorkers(app, cookie, "verify");
	const userId = (await db.prepare('SELECT id FROM "user"').first<{ id: string }>())?.id ?? "";
	const first = await readCloudflareInbox(db, userId);
	assert.equal(first?.status, "ready");
	const missing = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=create&choice=inbox&host=workers",
	});
	assert.equal(missing.status, 200);
	assert.match(await missing.text(), /Use a short name/);
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM cloudflare_inbox`).first<{ n: number }>())?.n, 1);
	const before = apiCalls(api.calls).length;
	const created = await app.request(`${origin}/app/cloudflare`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=create&choice=inbox&host=workers&name=second-agent",
	});
	assert.equal(created.status, 303);
	const nextUrl = new URL(created.headers.get("location") ?? "", origin);
	assert.match(nextUrl.pathname, /^\/app\/cloudflare\/[0-9a-f]{32}$/);
	assert.notEqual(nextUrl.pathname, `/app/cloudflare/${first?.id}`);
	const page = await (await app.request(nextUrl, { headers: { cookie } })).text();
	assert.match(page, /Check the Cloudflare account/);
	assert.match(page, /value="second-agent"/);
	assert.equal(page.includes("https://my-agent.example.workers.dev"), false);
	const added = apiCalls(api.calls).slice(before);
	assert.equal(added.length, 2);
	assert.ok(added.some((call) => call.method === "GET" && call.url.endsWith("/accounts?per_page=50")));
	assert.ok(added.some((call) => call.method === "GET" && /\/workers\/scripts\?/.test(call.url)));
	const rows = await db.prepare(`SELECT id, status, public_url FROM cloudflare_inbox WHERE "userId" = ? ORDER BY created_at`).bind(userId).all<{ id: string; status: string; public_url: string | null }>();
	assert.equal(rows.results.length, 2);
	assert.equal(rows.results[0]?.status, "ready");
	assert.equal(rows.results[0]?.public_url, "https://my-agent.example.workers.dev");
	assert.equal(rows.results[1]?.status, "pending");
	assert.equal(rows.results[1]?.id, nextUrl.pathname.slice("/app/cloudflare/".length));
});

async function readyInbox(app: ReturnType<typeof createApp>, cookie: string, db: ReturnType<typeof openDb>) {
	await walkWorkers(app, cookie, "verify");
	const userId = (await db.prepare('SELECT id FROM "user"').first<{ id: string }>())?.id ?? "";
	const row = await readCloudflareInbox(db, userId);
	assert.ok(row?.id);
	return row!;
}

test("Remove from my Cloudflare deletes the Worker and database this setup created", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const options: ApiOptions = {};
	const api = cloudflareApi(options);
	t.after(api.restore);
	const row = await readyInbox(app, cookie, db);
	options.scriptExists = true;
	options.scriptTag = row.script_tag ?? "";
	const before = api.calls.length;
	const confirm = await (await app.request(`${origin}/app/cloudflare/${row.id}?remove=1`, { headers: { cookie } })).text();
	assert.match(confirm, /Remove from my Cloudflare deletes only what this setup created/);
	assert.match(confirm, /Worker/);
	assert.match(confirm, /my-agent/);
	assert.match(confirm, /Database/);
	assert.match(confirm, /Forget only/);
	assert.equal(api.calls.length, before);
	const worker = await app.request(`${origin}/app/cloudflare/${row.id}`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=remove",
	});
	const workerHtml = await worker.text();
	assert.match(workerHtml, /my-agent is removed/);
	assert.match(workerHtml, /data-auto="1"/);
	assert.equal(api.calls.filter((call) => call.method === "DELETE" && /\/workers\/scripts\/my-agent$/.test(call.url)).length, 1);
	assert.equal(api.calls.filter((call) => call.method === "DELETE" && call.url.includes("/d1/database/")).length, 0);
	const finished = await app.request(`${origin}/app/cloudflare/${row.id}`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=remove",
	});
	assert.equal(finished.status, 303);
	assert.match(finished.headers.get("location") ?? "", /removedCloudflare=1/);
	assert.equal(api.calls.filter((call) => call.method === "DELETE" && call.url.includes("/d1/database/")).length, 1);
	const home = await (await app.request(finished.headers.get("location") ?? "", { headers: { cookie } })).text();
	assert.match(home, /That agent was removed from your Cloudflare account/);
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM cloudflare_inbox`).first<{ n: number }>())?.n, 0);
});

test("a Worker this setup did not create stays, and one already deleted counts as gone", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const options: ApiOptions = {};
	const api = cloudflareApi(options);
	t.after(api.restore);
	const row = await readyInbox(app, cookie, db);
	options.scriptExists = true;
	options.scriptTag = "not-this-setup";
	const mismatch = await app.request(`${origin}/app/cloudflare/${row.id}`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=remove",
	});
	assert.match(await mismatch.text(), /This Worker was not created by this setup, so it stays/);
	assert.equal(api.calls.some((call) => call.method === "DELETE" && call.url.includes("/workers/scripts/")), false);
	await db.prepare(`UPDATE cloudflare_inbox SET status = 'ready', step_error = NULL WHERE id = ?`).bind(row.id).run();
	options.scriptExists = false;
	const gone = await app.request(`${origin}/app/cloudflare/${row.id}`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=remove",
	});
	assert.match(await gone.text(), /Already gone/);
	assert.equal(api.calls.some((call) => call.method === "DELETE" && call.url.includes("/workers/scripts/")), false);
});

test("Forget only drops the dashboard row and does not call Cloudflare", async (t) => {
	t.after(githubFetch(consentScope("inbox", "workers")));
	const db = openDb();
	const app = appFor(db);
	const cookie = await signIn(app);
	await consentInbox(app, cookie);
	const api = cloudflareApi({});
	t.after(api.restore);
	const row = await readyInbox(app, cookie, db);
	const before = api.calls.length;
	const forgot = await app.request(`${origin}/app/cloudflare/${row.id}`, {
		method: "POST",
		headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: "action=forget",
	});
	assert.equal(forgot.status, 303);
	assert.match(forgot.headers.get("location") ?? "", /forgotCloudflare=1/);
	assert.equal(api.calls.length, before);
	const home = await (await app.request(forgot.headers.get("location") ?? "", { headers: { cookie } })).text();
	assert.match(home, /dropped from this dashboard/);
	assert.match(home, /still in your Cloudflare account/);
	assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM cloudflare_inbox`).first<{ n: number }>())?.n, 0);
});
