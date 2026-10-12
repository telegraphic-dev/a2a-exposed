// POST /api/feedback and /app/feedback. No network: GitHub and Turnstile are stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createApp } from "../src/app.ts";
import { inboxConnection, issueDocument, scrubFeedbackText } from "../src/feedback.ts";
import { feedbackPlainId } from "../src/feedback-plain.ts";
import { openDb } from "./sql.ts";

const origin = "https://control.example.com";
const repo = "example-org/example-repo";
const ghToken = "ghp_testtokenvalue1234567890";

// workerd rejects redirect modes other than follow and manual. Node's fetch accepts "error".
const WORKERD_REDIRECT = 'Invalid redirect value, must be one of "follow" or "manual" ("error" won\'t be implemented since it does not make sense at the edge; use "manual" and check the response status code).';

function assertWorkerdRedirect(init?: RequestInit) {
	const redirect = init?.redirect;
	if (redirect !== "follow" && redirect !== "manual") throw new TypeError(WORKERD_REDIRECT);
}

function env(over: Record<string, unknown> = {}) {
	return { FEEDBACK_GITHUB_TOKEN: ghToken, FEEDBACK_REPO: repo, ...over };
}

function issue(n = 7) {
	return `https://github.com/${repo}/issues/${n}`;
}

function githubFetch(body: Record<string, unknown> = { html_url: issue() }, status = 201) {
	const calls: { url: string; init: RequestInit; json: any }[] = [];
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		assertWorkerdRedirect(init);
		const json = JSON.parse(String(init?.body ?? "{}"));
		calls.push({ url: String(input), init: init ?? {}, json });
		return Response.json(body, { status });
	}) as typeof fetch;
	return { fetch, calls };
}

function post(app: ReturnType<typeof createApp>, body: Record<string, unknown>, headers: Record<string, string> = {}) {
	return app.request(`${origin}/api/feedback`, {
		method: "POST",
		headers: { "content-type": "application/json", origin, "cf-connecting-ip": "203.0.113.10", ...headers },
		body: JSON.stringify(body),
	});
}

test("deploy binds a non-numeric feedback app id and installation id", () => {
	assert.equal(feedbackPlainId("4242"), "4242");
	assert.equal(feedbackPlainId(" nope "), "nope");
	assert.equal(feedbackPlainId("not-an-id"), "not-an-id");
	assert.equal(feedbackPlainId("   "), "");
	assert.equal(feedbackPlainId(undefined), "");
	const source = readFileSync(new URL("../cloudflare.config.ts", import.meta.url), "utf8");
	assert.match(source, /FEEDBACK_GITHUB_APP_ID: feedbackPlainId\(e\.FEEDBACK_GITHUB_APP_ID\)/);
	assert.match(source, /FEEDBACK_GITHUB_APP_INSTALLATION_ID: feedbackPlainId\(e\.FEEDBACK_GITHUB_APP_INSTALLATION_ID\)/);
	assert.doesNotMatch(source, /FEEDBACK_GITHUB_APP_(?:ID|INSTALLATION_ID): \/\^\\d/);
});

test("scrubFeedbackText strips tokens, setup secrets, userinfo, and Bearer values", () => {
	const token = "a2aot_" + "AbcdEf0123456789abcd";
	const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiI0MjQyIn0.sigvalue1234567890";
	const text = scrubFeedbackText(`see ${token} Bearer supersecretvalue https://user:pass@agent.example.com/x?t=setupsecrettokenvalue ${jwt}`);
	assert.equal(text.includes(token), false);
	assert.equal(text.includes("supersecretvalue"), false);
	assert.equal(text.includes("user:pass"), false);
	assert.equal(text.includes("setupsecrettokenvalue"), false);
	assert.equal(text.includes(jwt), false);
	assert.equal(text.includes("eyJ"), false);
	assert.match(text, /\[redacted\]/);
	assert.match(text, /Bearer \[redacted\]/);
});

test("issue body is escaped and drops the configured token", () => {
	const doc = issueDocument({
		message: `hello <b>there</b> & ${ghToken}`,
		kind: "bug",
		contact: "ada@example.com",
		source: "cli",
		agent: "Ada",
		version: "0.7.0",
		steps: "1. open <b>x</b>",
		expected: "a card",
		actual: "a blank page",
		environment: "local laptop",
		os: "linux 6.12.94",
		node: "v22.20.0",
		connection: "polling",
		deployment: "self-host",
		logs: "",
	}, ghToken);
	assert.equal(doc.title, "[bug] hello <b>there</b> & [redacted]");
	assert.match(doc.body, /### What happened\n\nhello &lt;b&gt;there&lt;\/b&gt; &amp; \[redacted\]/);
	assert.match(doc.body, /### Reproduction steps\n\n1\. open &lt;b&gt;x&lt;\/b&gt;/);
	assert.match(doc.body, /### Expected\n\na card/);
	assert.match(doc.body, /### Actual\n\na blank page/);
	assert.match(doc.body, /### Agent\n\nAda/);
	assert.match(doc.body, /### Environment\n\nlocal/);
	assert.match(doc.body, /### a2a-exposed version\n\n0\.7\.0/);
	assert.match(doc.body, /### Connection type\n\npolling/);
	assert.match(doc.body, /### Deployment\n\nself-hosted/);
	assert.match(doc.body, /### OS\n\nlinux 6\.12\.94/);
	assert.match(doc.body, /### Node\n\nv22\.20\.0/);
	assert.match(doc.body, /### Contact\n\nada@example.com/);
	assert.equal(/^## [^#]/m.test(doc.body), false);
	assert.equal(doc.body.includes("Source:"), false);
	assert.equal(doc.body.includes(ghToken), false);
	assert.deepEqual(doc.labels, ["bug", "feedback", "from-agent"]);
	const empty = issueDocument({ message: "hi", kind: "idea", contact: "", source: "web", agent: "", version: "", steps: "", expected: "", actual: "", environment: "", os: "", node: "", connection: "", deployment: "", logs: "" }, ghToken);
	assert.deepEqual(empty.labels, ["enhancement", "feedback"]);
	assert.match(empty.body, /### a2a-exposed version\n\nunknown/);
	assert.match(empty.body, /### Connection type\n\nunknown/);
	assert.match(empty.body, /### Deployment\n\nunknown/);
	assert.equal(empty.body.includes("### Reproduction steps"), false);
	const both = issueDocument({ message: "hi", kind: "bug", contact: "", source: "cli", agent: "", version: "0.7.0 (worker 0.7.0)", steps: "open it", expected: "", actual: "", environment: "", os: "", node: "", connection: "webhook", deployment: "hosted", logs: "" }, ghToken);
	assert.match(both.body, /### a2a-exposed version\n\n0\.7\.0 \(worker 0\.7\.0\)/);
	assert.match(both.body, /### Connection type\n\nwebhook/);
	assert.deepEqual(both.labels, ["bug", "feedback", "from-agent"]);
});

test("unconfigured feedback is 404, including a partial config", async () => {
	const off = createApp();
	const api = await off.request(`${origin}/api/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: "{\"message\":\"hi\",\"source\":\"cli\"}" });
	assert.equal(api.status, 404);
	const unnamed = await off.request(`${origin}/api/feedback`);
	assert.equal(unnamed.status, 404);
	assert.deepEqual(await api.json(), { error: "not_found" });
	const page = await off.request(`${origin}/app/feedback`);
	assert.equal(page.status, 404);
	assert.deepEqual(await page.json(), { error: "not_found" });
	const shell = await off.request(`${origin}/app`);
	assert.equal((await shell.text()).includes("/app/feedback"), false);

	const pemHeaders = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----";
	for (const partial of [
		{ FEEDBACK_GITHUB_TOKEN: ghToken },
		{ FEEDBACK_REPO: repo },
		{ FEEDBACK_GITHUB_TOKEN: "   ", FEEDBACK_REPO: repo },
		{ FEEDBACK_GITHUB_TOKEN: ghToken, FEEDBACK_REPO: "not a repo" },
		{ FEEDBACK_GITHUB_TOKEN: ghToken, FEEDBACK_REPO: "a/b/c" },
		{ FEEDBACK_GITHUB_APP_ID: "4242" },
		{ FEEDBACK_GITHUB_APP_PRIVATE_KEY: pemHeaders },
		{ FEEDBACK_GITHUB_APP_ID: "4242", FEEDBACK_GITHUB_APP_PRIVATE_KEY: pemHeaders },
		{ FEEDBACK_GITHUB_APP_ID: "   ", FEEDBACK_GITHUB_APP_PRIVATE_KEY: pemHeaders, FEEDBACK_REPO: repo },
		{ FEEDBACK_GITHUB_APP_ID: "4242", FEEDBACK_GITHUB_APP_PRIVATE_KEY: "   ", FEEDBACK_REPO: repo },
		{ FEEDBACK_GITHUB_APP_ID: "4242", FEEDBACK_GITHUB_APP_PRIVATE_KEY: pemHeaders, FEEDBACK_REPO: "not a repo" },
	]) {
		const app = createApp(partial);
		const res = await post(app, { message: "hi", source: "cli" });
		assert.equal(res.status, 404, JSON.stringify(partial));
	}
});

test("a configured post files an issue and the page links to feedback", async () => {
	const gh = githubFetch();
	const app = createApp(env(), { fetch: gh.fetch });
	const named = await app.request(`${origin}/api/feedback`);
	assert.equal(named.status, 200);
	assert.deepEqual(await named.json(), { repo });
	assert.equal(gh.calls.length, 0);
	const res = await post(app, { message: "the form forgot a field", kind: "bug", source: "web", version: "0.7.0", steps: "1. open the form" });
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { ok: true, issue_url: issue() });
	assert.equal(gh.calls.length, 1);
	assert.equal(gh.calls[0].url, `https://api.github.com/repos/${repo}/issues`);
	assert.equal(gh.calls[0].init.redirect, "manual");
	assert.equal(new Headers(gh.calls[0].init.headers).get("user-agent"), "a2a-exposed");
	assert.equal(new Headers(gh.calls[0].init.headers).get("authorization"), `Bearer ${ghToken}`);
	assert.deepEqual(gh.calls[0].json.labels, ["bug", "feedback"]);
	assert.match(gh.calls[0].json.body, /### What happened\n\nthe form forgot a field/);
	assert.match(gh.calls[0].json.body, /### Reproduction steps\n\n1\. open the form/);
	assert.equal(gh.calls[0].json.body.includes("Source:"), false);
	assert.equal(gh.calls[0].json.body.includes(ghToken), false);

	const home = await app.request(`${origin}/app`);
	const html = await home.text();
	assert.match(html, /href="\/app\/feedback"/);
	assert.match(html, /No login provider is configured/);

	const form = await app.request(`${origin}/app/feedback`);
	assert.equal(form.status, 200);
	const page = await form.text();
	assert.match(page, /<form class="feedback"/);
	assert.match(page, /Reproduction steps help most/);
	assert.match(page, /name="steps"/);
	assert.match(page, /name="expected"/);
	assert.match(page, /name="actual"/);
	assert.match(page, /name="agent"/);
	assert.match(page, /name="environment"/);
	assert.match(page, /Required for a bug/);
	assert.match(page, /name="logs"/);
	assert.match(page, /Remove tokens, passwords, and keys before pasting/);
	assert.match(page, /value="local"/);
	assert.match(page, /value="cloud VM"/);
	assert.match(page, /value="CI"/);
	assert.match(page, /cloud agent sandbox/);
	assert.match(page, /value="other"/);
	assert.equal(page.includes("local laptop"), false);
	assert.equal(page.includes("Cloudflare Worker"), false);
	assert.match(page, /name="version"/);
	assert.match(page, /name="connection"/);
	assert.match(page, /name="deployment"/);
	assert.equal(page.includes('name="mode"'), false);
	assert.match(page, /public GitHub issue on example-org\/example-repo/);
	assert.match(page, /Do not include confidential information: secrets, tokens, owner or pairing tokens, private URLs or hostnames, message contents, or personal data/);
	assert.ok(page.indexOf("public GitHub issue") < page.indexOf("<button"));
	assert.match(form.headers.get("content-security-policy") ?? "", /script-src 'none'/);
	assert.equal(/<script/.test(page), false);
});

test("a missing GitHub label is retried once without labels", async () => {
	let n = 0;
	const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		assertWorkerdRedirect(init);
		n += 1;
		const json = JSON.parse(String(init?.body));
		if (n === 1) {
			assert.deepEqual(json.labels, ["feedback", "from-agent"]);
			return new Response(JSON.stringify({ message: "missing" }), { status: 422 });
		}
		assert.equal(json.labels, undefined);
		return Response.json({ html_url: issue(8) }, { status: 201 });
	}) as typeof fetch;
	const app = createApp(env(), { fetch });
	const res = await post(app, { message: "from the cli", source: "cli" });
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { ok: true, issue_url: issue(8) });
	assert.equal(n, 2);
});

test("a GitHub call that does not finish is 504", async () => {
	const fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
		assertWorkerdRedirect(init);
		const signal = init?.signal;
		// AbortSignal.timeout does not keep the event loop alive. Hold it until the signal fires.
		const keep = setInterval(() => {}, 1000);
		const fail = () => {
			clearInterval(keep);
			const reason = signal?.reason;
			reject(reason instanceof Error ? reason : new DOMException("The operation was aborted", "TimeoutError"));
		};
		if (!signal || signal.aborted) fail();
		else signal.addEventListener("abort", fail, { once: true });
	})) as typeof fetch;
	const app = createApp(env(), { fetch, githubTimeoutMs: 20 });
	const res = await post(app, { message: "slow", source: "cli" });
	assert.equal(res.status, 504);
	assert.deepEqual(await res.json(), { error: "timeout" });
});

test("web posts need this origin, and Turnstile when it is configured", async () => {
	const gh = githubFetch();
	const app = createApp(env(), { fetch: gh.fetch });
	const cross = await post(app, { message: "hi", source: "web" }, { origin: "https://evil.example" });
	assert.equal(cross.status, 403);
	assert.equal(gh.calls.length, 0);

	const site = "site-key";
	const secret = "turnstile-secret";
	const orig = globalThis.fetch;
	let checks = 0;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		assert.match(String(input), /siteverify/);
		checks += 1;
		return Response.json({ success: true });
	}) as typeof fetch;
	try {
		const guarded = createApp(env({ TURNSTILE_SITE_KEY: site, TURNSTILE_SECRET_KEY: secret }), { fetch: gh.fetch, now: () => 1_700_000_000_000 });
		const page = await guarded.request(`${origin}/app/feedback`);
		const html = await page.text();
		assert.match(html, /class="cf-turnstile"/);
		assert.match(html, /<button class="action" type="submit" disabled/);
		assert.match(html, /src="\/turnstile\.js"/);
		assert.equal(/<script(?![^>]*\bsrc=)/.test(html), false);
		assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
		const missing = await post(guarded, { message: "hi", source: "web" });
		assert.equal(missing.status, 400);
		assert.deepEqual(await missing.json(), { error: "turnstile" });
		assert.equal(checks, 0);
		const ok = await post(guarded, { message: "hi", source: "web", turnstile: "token" });
		assert.equal(ok.status, 200);
		assert.equal(checks, 1);
	} finally {
		globalThis.fetch = orig;
	}
});

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function rememberOwner(db: ReturnType<typeof openDb>, token: string): Promise<string> {
	const hash = /^[0-9a-f]{64}$/i.test(token) ? token.toLowerCase() : await sha256(token);
	const now = "2026-01-01T00:00:00.000Z";
	await db.prepare(
		`INSERT INTO tenants (id, name, owner_account_id, status, region, config_json, limits_json, approval_json, owner_token_hash, config_version, created_at, updated_at)
		 VALUES (?, ?, 'acct', 'active', 'default', '{}', '{}', '{}', ?, 1, ?, ?)`,
	).bind(crypto.randomUUID(), `agent-${hash.slice(0, 12)}`, hash, now, now).run();
	return hash;
}

test("unauthenticated posts are limited per address, and a known owner token has its own bucket", async () => {
	const gh = githubFetch();
	const app = createApp(env(), { fetch: gh.fetch, now: () => 1_700_000_000_000 });
	for (let i = 0; i < 5; i++) {
		const res = await post(app, { message: `web ${i}`, source: "web" });
		assert.equal(res.status, 200, String(i));
	}
	const blocked = await post(app, { message: "web again", source: "web" });
	assert.equal(blocked.status, 429);
	assert.equal(blocked.headers.get("retry-after") !== null, true);
	const otherIp = await post(app, { message: "other", source: "web" }, { "cf-connecting-ip": "203.0.113.11" });
	assert.equal(otherIp.status, 200);
	// No database, so a bearer cannot be checked and does not open a fresh bucket.
	const unknown = await post(app, { message: "cli", source: "cli" }, { authorization: "Bearer owner-token-value" });
	assert.equal(unknown.status, 429);

	const db = openDb();
	const owner = "owner-token-value";
	const hash = await rememberOwner(db, owner);
	const tokenApp = createApp(env({ DB: db }), { fetch: gh.fetch, now: () => 1_700_000_000_000 });
	const shared = { "cf-connecting-ip": "203.0.113.50" };
	for (let i = 0; i < 5; i++) {
		const res = await post(tokenApp, { message: `anon ${i}`, source: "cli" }, shared);
		assert.equal(res.status, 200, String(i));
	}
	const stranger = await post(tokenApp, { message: "other owner", source: "cli" }, { authorization: "Bearer someone-else", ...shared });
	assert.equal(stranger.status, 429);
	for (let i = 0; i < 5; i++) {
		const res = await post(tokenApp, { message: `cli ${i}`, source: "cli" }, { authorization: `Bearer ${owner}`, "cf-connecting-ip": `203.0.113.${20 + i}` });
		assert.equal(res.status, 200, String(i));
	}
	const again = await post(tokenApp, { message: "cli again", source: "mcp" }, { authorization: `Bearer ${hash}`, "cf-connecting-ip": "198.51.100.9" });
	assert.equal(again.status, 429);
	const fresh = await post(tokenApp, { message: "other owner", source: "cli" }, { authorization: "Bearer someone-else", "cf-connecting-ip": "203.0.113.80" });
	assert.equal(fresh.status, 200);
});

test("the same limit is stored in D1 when a database is bound", async () => {
	const gh = githubFetch();
	const db = openDb();
	const app = createApp(env({ DB: db }), { fetch: gh.fetch, now: () => 1_700_000_000_000 });
	for (let i = 0; i < 5; i++) assert.equal((await post(app, { message: `n ${i}`, source: "cli" })).status, 200);
	assert.equal((await post(app, { message: "over", source: "cli" })).status, 429);
	const row = await db.prepare("SELECT count AS n FROM feedback_rate").first<{ n: number }>();
	assert.equal(Number(row?.n), 5);
});

test("a database error on the rate table is 503", async () => {
	const app = createApp(env({
		DB: { prepare() { throw new Error("no such table"); } },
	} as never), { fetch: githubFetch().fetch });
	const res = await post(app, { message: "hi", source: "cli" }, { authorization: "Bearer owner-token-value" });
	assert.equal(res.status, 503);
	assert.deepEqual(await res.json(), { error: "unavailable" });
});

test("a mode that is not hosted or self-hosted is rejected", async () => {
	const gh = githubFetch();
	const app = createApp(env(), { fetch: gh.fetch });
	const res = await post(app, { message: "hi", source: "cli", mode: "both" });
	assert.equal(res.status, 400);
	assert.deepEqual(await res.json(), { error: "invalid_mode" });
	const deployment = await post(app, { message: "hi", source: "cli", deployment: "both" });
	assert.equal(deployment.status, 400);
	assert.deepEqual(await deployment.json(), { error: "invalid_deployment" });
	const connection = await post(app, { message: "hi", source: "cli", connection: "socket" });
	assert.equal(connection.status, 400);
	assert.deepEqual(await connection.json(), { error: "invalid_connection" });
	assert.equal(gh.calls.length, 0);

	const older = await post(app, { message: "hi", source: "cli", mode: "self-host", connection: "webhook", version: "0.7.0 (worker 0.7.0)" });
	assert.equal(older.status, 200);
	assert.match(gh.calls[0].json.body, /### Deployment\n\nself-hosted/);
	assert.match(gh.calls[0].json.body, /### Connection type\n\nwebhook/);
	assert.match(gh.calls[0].json.body, /### a2a-exposed version\n\n0\.7\.0 \(worker 0\.7\.0\)/);
});

test("a bug without steps is refused", async () => {
	const gh = githubFetch();
	const app = createApp(env(), { fetch: gh.fetch });
	const res = await post(app, { message: "it broke", kind: "bug", source: "cli", steps: "   " });
	assert.equal(res.status, 400);
	assert.deepEqual(await res.json(), { error: "steps_required" });
	assert.equal(gh.calls.length, 0);
	const page = await app.request(`${origin}/app/feedback`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", origin },
		body: "message=broke&kind=bug&steps=",
	});
	assert.equal(page.status, 303);
	assert.match(page.headers.get("location") ?? "", /error=steps/);
	const shown = await app.request(`${origin}/app/feedback?error=steps`);
	assert.match(await shown.text(), /A bug report needs reproduction steps/);
});

test("the form prefills connection and deployment from the query", async () => {
	const app = createApp(env());
	const form = await app.request(`${origin}/app/feedback?connection=webhook&deployment=hosted`);
	const page = await form.text();
	assert.match(page, /<option value="webhook" selected/);
	assert.match(page, /<option value="hosted" selected/);
	assert.equal(page.includes('value="proxy" selected'), false);
	const junk = await app.request(`${origin}/app/feedback?connection=webhook%22%3E&deployment=self-host`);
	const ignored = await junk.text();
	assert.equal(ignored.includes('value="webhook&quot;'), false);
	assert.equal(ignored.includes('value="webhook" selected'), false);
	assert.equal(ignored.includes('value="self-hosted" selected'), false);
});

test("the form posts and redirects to the issue", async () => {
	const gh = githubFetch();
	const app = createApp(env(), { fetch: gh.fetch });
	const res = await app.request(`${origin}/app/feedback`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", origin },
		body: "message=hello+from+the+form&kind=idea&contact=ada%40example.com",
	});
	assert.equal(res.status, 303);
	const location = res.headers.get("location") ?? "";
	assert.match(location, /\/app\/feedback\?/);
	const next = new URL(location);
	assert.equal(next.searchParams.get("sent"), "1");
	assert.equal(next.searchParams.get("issue"), issue());
	assert.equal(gh.calls[0].json.labels.includes("from-agent"), false);
	const page = await app.request(location);
	assert.match(await page.text(), /Sent/);
});

test("inboxConnection prefers an upstream, then a wake URL, and never returns the URL", () => {
	assert.equal(inboxConnection({}), "polling");
	assert.equal(inboxConnection({ UPSTREAM_URL: "none", WAKE_WEBHOOK_URL: "https://hooks.example/wake" }), "webhook");
	assert.equal(inboxConnection({ UPSTREAM_URL: "off" }), "polling");
	assert.equal(inboxConnection({ UPSTREAM_URL: "https://up.example", WAKE_WEBHOOK_URL: "https://hooks.example/wake" }), "proxy");
});

test("the agent page shows hosted and the connection, and links to the prefilled form", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const data = {
		async putDirectory() {},
		async pushConfig() { return { version: 1, applied: true }; },
		async owner() { return { status: 200, body: {} }; },
	};
	const secret = "test-secret-test-secret-test-secret";
	const app = createApp(
		{ ...env(), AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com" },
		{ database: db, mailer: { async send(message: { text: string }) { sent.push({ text: message.text }); } }, dataPlane: data },
	);
	const posted = await app.request(`${origin}/app/sign-in`, {
		method: "POST",
		headers: { origin, "content-type": "application/x-www-form-urlencoded" },
		body: "provider=email&email=person@example.com",
	});
	assert.equal(posted.status, 303);
	const link = sent[0].text.match(/https:\/\/control\.example\.com\/api\/auth\/magic-link\/verify\?[^\s]+/);
	assert.ok(link);
	const verified = await app.request(link[0]);
	const cookie = verified.headers.getSetCookie().find((value) => value.startsWith("__Host-a2a_session="))!.split(";")[0];
	const created = await app.request(`${origin}/api/v1/tenants`, {
		method: "POST",
		headers: { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
		body: "name=Northwind",
	});
	assert.equal(created.status, 303);
	await db.prepare("UPDATE tenants SET config_json = ? WHERE name = ?").bind(JSON.stringify({
		AGENT_NAME: "northwind",
		WAKE_WEBHOOK_URL: "https://hooks.example/wake",
		UPSTREAM_URL: "none",
	}), "northwind").run();
	const html = await (await app.request(`${origin}/app/agents/northwind`, { headers: { cookie } })).text();
	assert.match(html, /Deployment: hosted\. Connection: webhook wake\./);
	assert.match(html, /href="\/app\/feedback\?deployment=hosted&(?:amp;)?connection=webhook"/);
	const sentence = html.split("Deployment: hosted")[1]?.split("</p>")[0] ?? "";
	assert.equal(sentence.includes("hooks.example"), false);

	await db.prepare("UPDATE tenants SET config_json = ? WHERE name = ?").bind(JSON.stringify({
		AGENT_NAME: "northwind",
		UPSTREAM_URL: "https://up.example",
		WAKE_WEBHOOK_URL: "https://hooks.example/wake",
	}), "northwind").run();
	const proxy = await (await app.request(`${origin}/app/agents/northwind`, { headers: { cookie } })).text();
	assert.match(proxy, /Connection: proxy\./);
	assert.match(proxy, /connection=proxy"/);
	assert.equal(proxy.split("Deployment: hosted")[1]?.split("</p>")[0]?.includes("up.example"), false);

	const off = createApp(
		{ AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com" },
		{ database: db, dataPlane: data },
	);
	const quiet = await (await off.request(`${origin}/app/agents/northwind`, { headers: { cookie } })).text();
	assert.equal(quiet.includes("Send feedback"), false);
});

function appKeys() {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	return {
		pkcs1: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
		pkcs8: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		publicKey,
	};
}

function jwtPayload(jwt: string, publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"]) {
	const [header, payload, signature] = jwt.split(".");
	const verify = createVerify("RSA-SHA256");
	verify.update(`${header}.${payload}`);
	verify.end();
	assert.equal(verify.verify(publicKey, Buffer.from(signature, "base64url")), true);
	return JSON.parse(Buffer.from(payload, "base64url").toString()) as { iss: string; iat: number; exp: number };
}

function appGithub(options: { expiresAt?: string; tokenStatus?: number; installationStatus?: number } = {}) {
	const calls: { url: string; method: string; authorization: string; body: string; redirect: string }[] = [];
	let minted = 0;
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		assertWorkerdRedirect(init);
		const url = String(input);
		const headers = new Headers(init?.headers);
		calls.push({ url, method: init?.method ?? "GET", authorization: headers.get("authorization") ?? "", body: init?.body ? String(init.body) : "", redirect: init?.redirect ?? "" });
		if (url.endsWith("/installation")) {
			const status = options.installationStatus ?? 200;
			if (status !== 200) return Response.json({ message: "nope" }, { status });
			return Response.json({ id: 424242 });
		}
		if (url.includes("/access_tokens")) {
			minted += 1;
			if ((options.tokenStatus ?? 201) !== 201) return Response.json({ message: "nope", token: "ghs_shouldnotbeloggedvalue" }, { status: options.tokenStatus });
			const token = minted === 1 ? "ghs_installtokenvalue1234567890" : "ghs_refreshedtokenvalue1234567890";
			const body: Record<string, string> = { token };
			if (options.expiresAt) body.expires_at = options.expiresAt;
			return Response.json(body);
		}
		if (url.endsWith("/issues")) return Response.json({ html_url: issue() }, { status: 201 });
		return new Response("missing", { status: 500 });
	}) as typeof fetch;
	return { fetch, calls };
}

test("a GitHub App files the issue, prefers the app over the token, and reuses the installation token", async () => {
	const keys = appKeys();
	let now = 1_700_000_000_000;
	const gh = appGithub({ expiresAt: new Date(now + 120_000).toISOString() });
	const app = createApp({
		FEEDBACK_GITHUB_APP_ID: "4242",
		FEEDBACK_GITHUB_APP_PRIVATE_KEY: keys.pkcs1,
		FEEDBACK_GITHUB_TOKEN: ghToken,
		FEEDBACK_REPO: repo,
	}, { fetch: gh.fetch, now: () => now });
	const pem = "-----BEGIN RSA PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END RSA PRIVATE KEY-----";
	const res = await post(app, {
		message: `broke ${pem} AKIAIOSFODNN7EXAMPLE sk-proj-abcdefghijklmnopqrstuvwxyz ${ghToken}`,
		source: "cli",
	});
	assert.equal(res.status, 200);
	assert.equal(gh.calls.filter((call) => call.url.endsWith("/installation")).length, 1);
	assert.equal(gh.calls.filter((call) => call.url.includes("/access_tokens")).length, 1);
	assert.equal(gh.calls.filter((call) => call.url.endsWith("/issues")).length, 1);
	const install = gh.calls.find((call) => call.url.endsWith("/installation"))!;
	assert.equal(install.url, `https://api.github.com/repos/${repo}/installation`);
	assert.equal(install.redirect, "manual");
	assert.equal(gh.calls.every((call) => call.redirect === "manual"), true);
	const payload = jwtPayload(install.authorization.slice("Bearer ".length), keys.publicKey);
	assert.equal(payload.iss, "4242");
	assert.equal(payload.iat, Math.floor(now / 1000) - 60);
	assert.equal(payload.exp - payload.iat, 600);
	const filed = gh.calls.find((call) => call.url.endsWith("/issues"))!;
	assert.equal(filed.authorization, "Bearer ghs_installtokenvalue1234567890");
	assert.equal(filed.authorization.includes(ghToken), false);
	const body = JSON.parse(filed.body).body as string;
	assert.equal(body.includes("SECRETKEYMATERIAL"), false);
	assert.equal(body.includes("AKIAIOSFODNN7EXAMPLE"), false);
	assert.equal(body.includes("sk-proj-abcdefghijklmnopqrstuvwxyz"), false);
	assert.equal(body.includes(ghToken), false);
	assert.equal(body.includes("ghs_installtokenvalue1234567890"), false);

	const again = createApp({
		FEEDBACK_GITHUB_APP_ID: "4242",
		FEEDBACK_GITHUB_APP_PRIVATE_KEY: keys.pkcs1,
		FEEDBACK_GITHUB_TOKEN: ghToken,
		FEEDBACK_REPO: repo,
	}, { fetch: gh.fetch, now: () => now });
	assert.equal((await post(again, { message: "second", source: "cli" })).status, 200);
	assert.equal(gh.calls.filter((call) => call.url.endsWith("/installation")).length, 1);
	assert.equal(gh.calls.filter((call) => call.url.includes("/access_tokens")).length, 1);
	assert.equal(gh.calls.filter((call) => call.url.endsWith("/issues")).length, 2);

	now += 70_000;
	assert.equal((await post(app, { message: "third", source: "cli" })).status, 200);
	assert.equal(gh.calls.filter((call) => call.url.endsWith("/installation")).length, 1);
	assert.equal(gh.calls.filter((call) => call.url.includes("/access_tokens")).length, 2);
	const refreshed = [...gh.calls].reverse().find((call) => call.url.endsWith("/issues"))!;
	assert.equal(refreshed.authorization, "Bearer ghs_refreshedtokenvalue1234567890");
});

test("an explicit installation id and a PKCS#8 key skip the lookup, including a one-line PEM", async () => {
	const keys = appKeys();
	const gh = appGithub({ expiresAt: "2026-10-12T12:00:00.000Z" });
	const app = createApp({
		FEEDBACK_GITHUB_APP_ID: "4242",
		FEEDBACK_GITHUB_APP_PRIVATE_KEY: keys.pkcs8.replace(/\n/g, "\\n"),
		FEEDBACK_GITHUB_APP_INSTALLATION_ID: "77",
		FEEDBACK_REPO: repo,
	}, { fetch: gh.fetch, now: () => Date.parse("2026-10-12T10:00:00.000Z") });
	const res = await post(app, { message: "from pkcs8", source: "cli" });
	assert.equal(res.status, 200);
	assert.equal(gh.calls.some((call) => call.url.endsWith("/installation")), false);
	assert.equal(gh.calls.find((call) => call.url.includes("/access_tokens"))?.url, "https://api.github.com/app/installations/77/access_tokens");
	const payload = jwtPayload(gh.calls[0].authorization.slice("Bearer ".length), keys.publicKey);
	assert.equal(payload.iss, "4242");
});

test("a set app id with a malformed key is 502 and does not use the personal access token", async () => {
	const calls: string[] = [];
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		assertWorkerdRedirect(init);
		calls.push(new Headers(init?.headers).get("authorization") ?? "");
		return Response.json({ html_url: issue() }, { status: 201 });
	}) as typeof fetch;
	const logs: string[] = [];
	const orig = console.error;
	console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
	try {
		for (const partial of [
			{ FEEDBACK_GITHUB_APP_ID: "4242", FEEDBACK_GITHUB_APP_PRIVATE_KEY: "not-a-pem", FEEDBACK_GITHUB_TOKEN: ghToken, FEEDBACK_REPO: repo },
			{ FEEDBACK_GITHUB_APP_ID: "nope", FEEDBACK_GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----", FEEDBACK_GITHUB_TOKEN: ghToken, FEEDBACK_REPO: repo },
			{ FEEDBACK_GITHUB_APP_ID: "4242", FEEDBACK_GITHUB_APP_PRIVATE_KEY: "not-a-pem", FEEDBACK_REPO: repo },
		]) {
			const app = createApp(partial, { fetch });
			const res = await post(app, { message: "hi", source: "cli" });
			assert.equal(res.status, 502, JSON.stringify(partial));
			assert.deepEqual(await res.json(), { error: "unavailable" });
			const page = await app.request(`${origin}/app/feedback`);
			assert.equal(page.status, 200, JSON.stringify(partial));
		}
		assert.equal(calls.length, 0);
		const text = logs.join("\n");
		assert.match(text, /"error":"key_parse"/);
		assert.equal(text.includes('"error":"fetch"'), false);
		assert.equal(text.includes(ghToken), false);
		assert.equal(text.includes("not-a-pem"), false);
	} finally {
		console.error = orig;
	}
});

test("a PEM with heredoc markers, CRLF, or literal newlines still signs", async () => {
	const keys = appKeys();
	const pkcs1 = keys.pkcs1.trim();
	const pkcs8 = keys.pkcs8.trim();
	const wrapped = [
		`<<-EOT\n${pkcs1}\nEOT`,
		`\r\n${pkcs1.replace(/\n/g, "\r\n")}\r\n`,
		`<<-EOT\\n${pkcs1.replace(/\n/g, "\\n")}\\nEOT`,
		`  note\n<<-EOT\r\n${pkcs1.replace(/\n/g, "\r\n")}\r\nEOT\n`,
		`<<-EOT\\n${pkcs8.replace(/\n/g, "\\n")}\\nEOT`,
	];
	for (const privateKey of wrapped) {
		const gh = appGithub();
		const app = createApp({
			FEEDBACK_GITHUB_APP_ID: "4242",
			FEEDBACK_GITHUB_APP_PRIVATE_KEY: privateKey,
			FEEDBACK_GITHUB_APP_INSTALLATION_ID: "77",
			FEEDBACK_REPO: repo,
		}, { fetch: gh.fetch, now: () => 1_700_000_000_000, githubCache: {} });
		const res = await post(app, { message: "wrapped", source: "cli" });
		assert.equal(res.status, 200, JSON.stringify(privateKey.slice(0, 24)));
		const tokenCall = gh.calls.find((call) => call.url.includes("/access_tokens"));
		assert.ok(tokenCall);
		const payload = jwtPayload(tokenCall.authorization.slice("Bearer ".length), keys.publicKey);
		assert.equal(payload.iss, "4242");
		assert.equal(gh.calls.some((call) => call.url.endsWith("/installation")), false);
		assert.equal(JSON.stringify(gh.calls).includes("<<-EOT"), false);
	}
});

test("GitHub App auth failures are 502 and the log does not include the key or the token", async () => {
	const logs: string[] = [];
	const orig = console.error;
	console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
	try {
		const marker = "THISKEYMATERIALSHOULDNOTBELOGGED";
		const badKey = createApp({
			FEEDBACK_GITHUB_APP_ID: "4242",
			FEEDBACK_GITHUB_APP_PRIVATE_KEY: `-----BEGIN RSA PRIVATE KEY-----\n${marker}\n-----END RSA PRIVATE KEY-----`,
			FEEDBACK_REPO: repo,
		}, { fetch: (async () => { throw new Error("should not fetch"); }) as typeof fetch });
		const bad = await post(badKey, { message: "hi", source: "cli" });
		assert.equal(bad.status, 502);
		assert.deepEqual(await bad.json(), { error: "unavailable" });

		const badId = createApp({
			FEEDBACK_GITHUB_APP_ID: "4242",
			FEEDBACK_GITHUB_APP_PRIVATE_KEY: `-----BEGIN RSA PRIVATE KEY-----\n${marker}\n-----END RSA PRIVATE KEY-----`,
			FEEDBACK_GITHUB_APP_INSTALLATION_ID: "not-an-id",
			FEEDBACK_REPO: repo,
		}, { fetch: (async () => { throw new Error("should not fetch"); }) as typeof fetch });
		const badIdRes = await post(badId, { message: "hi", source: "cli" });
		assert.equal(badIdRes.status, 502);
		assert.deepEqual(await badIdRes.json(), { error: "unavailable" });

		const keys = appKeys();
		const gh = appGithub({ tokenStatus: 401 });
		const denied = createApp({
			FEEDBACK_GITHUB_APP_ID: "4242",
			FEEDBACK_GITHUB_APP_PRIVATE_KEY: keys.pkcs1,
			FEEDBACK_REPO: repo,
		}, { fetch: gh.fetch });
		const res = await post(denied, { message: "hi", source: "cli" });
		const deniedBody = await res.json();
		assert.equal(res.status, 502);
		assert.deepEqual(deniedBody, { error: "unavailable" });

		const missedKeys = appKeys();
		const missed = appGithub({ installationStatus: 404 });
		const missingInstall = createApp({
			FEEDBACK_GITHUB_APP_ID: "4242",
			FEEDBACK_GITHUB_APP_PRIVATE_KEY: missedKeys.pkcs1,
			FEEDBACK_REPO: repo,
		}, { fetch: missed.fetch });
		const missingRes = await post(missingInstall, { message: "hi", source: "cli" });
		assert.equal(missingRes.status, 502);
		assert.deepEqual(await missingRes.json(), { error: "unavailable" });
		assert.equal(missed.calls.some((call) => call.url.includes("/access_tokens")), false);

		const rejectedJwt = appGithub({ installationStatus: 401 });
		const badJwt = createApp({
			FEEDBACK_GITHUB_APP_ID: "4242",
			FEEDBACK_GITHUB_APP_PRIVATE_KEY: keys.pkcs8,
			FEEDBACK_REPO: repo,
		}, { fetch: rejectedJwt.fetch });
		const badJwtRes = await post(badJwt, { message: "hi", source: "cli" });
		assert.equal(badJwtRes.status, 502);
		assert.deepEqual(await badJwtRes.json(), { error: "unavailable" });

		const minted = appGithub({ tokenStatus: 422 });
		const badToken = createApp({
			FEEDBACK_GITHUB_APP_ID: "4242",
			FEEDBACK_GITHUB_APP_PRIVATE_KEY: keys.pkcs8,
			FEEDBACK_GITHUB_APP_INSTALLATION_ID: "77",
			FEEDBACK_REPO: repo,
		}, { fetch: minted.fetch });
		const badTokenRes = await post(badToken, { message: "hi", source: "cli" });
		assert.equal(badTokenRes.status, 502);
		assert.deepEqual(await badTokenRes.json(), { error: "unavailable" });
		assert.equal(minted.calls.some((call) => call.url.endsWith("/installation")), false);

		const text = logs.join("\n");
		assert.match(text, /"status":0,"error":"key_parse"/);
		assert.match(text, /"status":0,"error":"installation:0"/);
		assert.match(text, /"status":401,"error":"jwt_rejected:401"/);
		assert.match(text, /"status":404,"error":"installation:404"/);
		assert.match(text, /"status":422,"error":"token:422"/);
		assert.match(text, /"error":"key_parse","step":"jwt","message":"GithubAuthError key_parse"/);
		assert.match(text, /"error":"installation:0","step":"installation"/);
		assert.match(text, /"error":"jwt_rejected:401","step":"jwt"/);
		assert.match(text, /"error":"installation:404","step":"installation"/);
		assert.match(text, /"error":"token:422","step":"token"/);
		assert.equal(text.includes('"error":"fetch"'), false);
		assert.equal(text.includes(marker), false);
		assert.equal(text.includes("PRIVATE KEY"), false);
		assert.equal(text.includes("ghs_shouldnotbeloggedvalue"), false);
		assert.equal(text.includes("eyJ"), false);
		assert.equal(text.includes(keys.pkcs1), false);
		assert.equal(text.includes(keys.pkcs8), false);
		assert.equal(text.includes(missedKeys.pkcs1), false);
		assert.equal(JSON.stringify(deniedBody).includes("ghs_"), false);
	} finally {
		console.error = orig;
	}
});

test("the GitHub mock throws the workerd TypeError unless redirect is follow or manual", async () => {
	const gh = githubFetch();
	const url = `https://api.github.com/repos/${repo}/issues`;
	await assert.rejects(
		() => gh.fetch(url, { method: "POST", redirect: "error", body: "{}" }),
		(error: unknown) => {
			assert.ok(error instanceof TypeError);
			assert.equal(error.message, WORKERD_REDIRECT);
			return true;
		},
	);
	await assert.rejects(() => gh.fetch(url, { method: "POST", body: "{}" }), (error: unknown) => error instanceof TypeError);
	const followed = await gh.fetch(url, { method: "POST", redirect: "follow", body: "{}" });
	assert.equal(followed.status, 201);
});

function captureLogs() {
	const logs: string[] = [];
	const orig = console.error;
	console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
	return {
		logs,
		restore() { console.error = orig; },
		text() { return logs.join("\n"); },
	};
}

test("a GitHub redirect is a failure for that step", async () => {
	const logs = captureLogs();
	try {
		const keys = appKeys();
		const installation = appGithub({ installationStatus: 302 });
		const missed = createApp({
			FEEDBACK_GITHUB_APP_ID: "4242",
			FEEDBACK_GITHUB_APP_PRIVATE_KEY: keys.pkcs1,
			FEEDBACK_REPO: repo,
		}, { fetch: installation.fetch, githubCache: {} });
		const missedRes = await post(missed, { message: "hi", source: "cli" });
		assert.equal(missedRes.status, 502);
		assert.deepEqual(await missedRes.json(), { error: "unavailable" });
		assert.equal(installation.calls.some((call) => call.url.includes("/access_tokens")), false);
		assert.equal(installation.calls.some((call) => call.url.endsWith("/issues")), false);

		const tokenKeys = appKeys();
		const minted = appGithub({ tokenStatus: 307 });
		const badToken = createApp({
			FEEDBACK_GITHUB_APP_ID: "4242",
			FEEDBACK_GITHUB_APP_PRIVATE_KEY: tokenKeys.pkcs8,
			FEEDBACK_GITHUB_APP_INSTALLATION_ID: "77",
			FEEDBACK_REPO: repo,
		}, { fetch: minted.fetch, githubCache: {} });
		const badTokenRes = await post(badToken, { message: "hi", source: "cli" });
		assert.equal(badTokenRes.status, 502);
		assert.deepEqual(await badTokenRes.json(), { error: "unavailable" });
		assert.equal(minted.calls.some((call) => call.url.endsWith("/issues")), false);

		const issueRedirect = githubFetch({ html_url: issue() }, 301);
		const issueApp = createApp(env(), { fetch: issueRedirect.fetch });
		const issueRes = await post(issueApp, { message: "hi", source: "cli" });
		assert.equal(issueRes.status, 502);
		assert.deepEqual(await issueRes.json(), { error: "unavailable" });
		assert.equal(issueRedirect.calls.length, 1);

		let retries = 0;
		const retryRedirect = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			assertWorkerdRedirect(init);
			retries += 1;
			if (retries === 1) return Response.json({ message: "missing" }, { status: 422 });
			return Response.json({ html_url: issue() }, { status: 302 });
		}) as typeof fetch;
		const retryApp = createApp(env(), { fetch: retryRedirect });
		const retryRes = await post(retryApp, { message: "hi", source: "cli" });
		assert.equal(retryRes.status, 502);
		assert.equal(retries, 2);

		const text = logs.text();
		assert.match(text, /"status":302,"error":"installation:302","step":"installation","message":"GithubAuthError installation:302"/);
		assert.match(text, /"status":307,"error":"token:307","step":"token","message":"GithubAuthError token:307"/);
		assert.match(text, /"status":301,"error":"http","step":"issue","message":"Error HTTP 301"/);
		assert.match(text, /"status":302,"error":"http","step":"issue_retry","message":"Error HTTP 302"/);
		assert.equal(text.includes(issue()), false);
	} finally {
		logs.restore();
	}
});

test("a thrown GitHub error logs the step and a scrubbed message", async () => {
	const token = "ghs_" + "supersecretinstallation";
	const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiI0MjQyIn0.sigvalue1234567890";
	const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEsecretkeymaterial\n-----END RSA PRIVATE KEY-----";
	const logs = captureLogs();
	try {
		const thrown = (step: string) => (async (_input: RequestInfo | URL, init?: RequestInit) => {
			assertWorkerdRedirect(init);
			const error = new TypeError(`${WORKERD_REDIRECT} ${step} ${token} Bearer ${jwt} authorization: Bearer ${token} ${pem} ${"x".repeat(400)}`);
			Object.assign(error, { headers: { authorization: `Bearer ${token}`, key: pem }, key: pem });
			throw error;
		}) as typeof fetch;

		const issueApp = createApp(env(), { fetch: thrown("issue") });
		const issueRes = await post(issueApp, { message: "hi", source: "cli" });
		assert.equal(issueRes.status, 502);
		assert.deepEqual(await issueRes.json(), { error: "unavailable" });

		let retries = 0;
		const retryFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			assertWorkerdRedirect(init);
			retries += 1;
			if (retries === 1) return Response.json({ message: "missing" }, { status: 422 });
			const error = new Error(`retry ${token} ${jwt} ${pem}`);
			Object.assign(error, { headers: { authorization: `Bearer ${jwt}` }, key: pem });
			throw error;
		}) as typeof fetch;
		const retryApp = createApp(env(), { fetch: retryFetch });
		const retryRes = await post(retryApp, { message: "hi", source: "cli" });
		assert.equal(retryRes.status, 502);
		assert.equal(retries, 2);

		const keys = appKeys();
		const installApp = createApp({
			FEEDBACK_GITHUB_APP_ID: "4242",
			FEEDBACK_GITHUB_APP_PRIVATE_KEY: keys.pkcs1,
			FEEDBACK_REPO: repo,
		}, { fetch: thrown("installation"), githubCache: {} });
		const installRes = await post(installApp, { message: "hi", source: "cli" });
		assert.equal(installRes.status, 502);

		const text = logs.text();
		const lines = text.split("\n").map((line) => JSON.parse(line) as { event: string; step: string; message: string; error: string; status: number });
		const issueLine = lines.find((line) => line.step === "issue");
		const retryLine = lines.find((line) => line.step === "issue_retry");
		const installLine = lines.find((line) => line.step === "installation");
		assert.ok(issueLine);
		assert.ok(retryLine);
		assert.ok(installLine);
		assert.equal(issueLine.event, "feedback_failed");
		assert.equal(issueLine.error, "fetch");
		assert.equal(issueLine.status, 0);
		assert.match(issueLine.message, /^TypeError /);
		assert.match(issueLine.message, /manual/);
		assert.match(retryLine.message, /^Error retry \[redacted\] \[redacted\]/);
		assert.match(installLine.message, /^TypeError /);
		assert.equal(installLine.step, "installation");
		for (const line of [issueLine, retryLine, installLine]) {
			assert.equal(line.message.includes(token), false);
			assert.equal(line.message.includes(jwt), false);
			assert.equal(line.message.includes("eyJ"), false);
			assert.equal(line.message.includes("MIIE"), false);
			assert.equal(line.message.includes("PRIVATE KEY"), false);
			assert.equal(line.message.includes("authorization"), false);
			const detail = line.message.slice(line.message.indexOf(" ") + 1);
			assert.ok(detail.length <= 200);
		}
		assert.equal(text.includes('"headers"'), false);
		assert.equal(text.includes(token), false);
		assert.equal(text.includes(jwt), false);
		assert.equal(text.includes("eyJ"), false);
		assert.equal(text.includes("MIIE"), false);
		assert.equal(text.includes(keys.pkcs1), false);
	} finally {
		logs.restore();
	}
});
