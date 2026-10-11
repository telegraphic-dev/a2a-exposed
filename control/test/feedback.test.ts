// POST /api/feedback and /app/feedback. No network: GitHub and Turnstile are stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { issueDocument, scrubFeedbackText } from "../src/feedback.ts";
import { openDb } from "./sql.ts";

const origin = "https://control.example.com";
const repo = "example-org/example-repo";
const ghToken = "ghp_testtokenvalue1234567890";

function env(over: Record<string, unknown> = {}) {
	return { FEEDBACK_GITHUB_TOKEN: ghToken, FEEDBACK_REPO: repo, ...over };
}

function issue(n = 7) {
	return `https://github.com/${repo}/issues/${n}`;
}

function githubFetch(body: Record<string, unknown> = { html_url: issue() }, status = 201) {
	const calls: { url: string; init: RequestInit; json: any }[] = [];
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
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

test("scrubFeedbackText strips tokens, setup secrets, userinfo, and Bearer values", () => {
	const token = "a2aot_" + "AbcdEf0123456789abcd";
	const text = scrubFeedbackText(`see ${token} Bearer supersecretvalue https://user:pass@agent.example.com/x?t=setupsecrettokenvalue`);
	assert.equal(text.includes(token), false);
	assert.equal(text.includes("supersecretvalue"), false);
	assert.equal(text.includes("user:pass"), false);
	assert.equal(text.includes("setupsecrettokenvalue"), false);
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
		mode: "self-host",
	}, ghToken);
	assert.equal(doc.title, "[bug] hello <b>there</b> & [redacted]");
	assert.match(doc.body, /## What happened\n\nhello &lt;b&gt;there&lt;\/b&gt; &amp; \[redacted\]/);
	assert.match(doc.body, /## Steps\n\n1\. open &lt;b&gt;x&lt;\/b&gt;/);
	assert.match(doc.body, /## Expected\n\na card/);
	assert.match(doc.body, /## Actual\n\na blank page/);
	assert.match(doc.body, /## Agent\n\nAda/);
	assert.match(doc.body, /## Environment\n\nlocal laptop/);
	assert.match(doc.body, /## OS\n\nlinux 6\.12\.94/);
	assert.match(doc.body, /## Node\n\nv22\.20\.0/);
	assert.match(doc.body, /## Mode\n\nself-host/);
	assert.match(doc.body, /## Contact\n\nada@example.com/);
	assert.equal(doc.body.includes(ghToken), false);
	assert.deepEqual(doc.labels, ["feedback", "from-agent"]);
	assert.deepEqual(issueDocument({ message: "hi", kind: "idea", contact: "", source: "web", agent: "", version: "", steps: "", expected: "", actual: "", environment: "", os: "", node: "", mode: "" }, ghToken).labels, ["feedback"]);
});

test("unconfigured feedback is 404, including a partial config", async () => {
	const off = createApp();
	const api = await off.request(`${origin}/api/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: "{\"message\":\"hi\",\"source\":\"cli\"}" });
	assert.equal(api.status, 404);
	assert.deepEqual(await api.json(), { error: "not_found" });
	const page = await off.request(`${origin}/app/feedback`);
	assert.equal(page.status, 404);
	assert.deepEqual(await page.json(), { error: "not_found" });
	const shell = await off.request(`${origin}/app`);
	assert.equal((await shell.text()).includes("/app/feedback"), false);

	for (const partial of [
		{ FEEDBACK_GITHUB_TOKEN: ghToken },
		{ FEEDBACK_REPO: repo },
		{ FEEDBACK_GITHUB_TOKEN: "   ", FEEDBACK_REPO: repo },
		{ FEEDBACK_GITHUB_TOKEN: ghToken, FEEDBACK_REPO: "not a repo" },
		{ FEEDBACK_GITHUB_TOKEN: ghToken, FEEDBACK_REPO: "a/b/c" },
	]) {
		const app = createApp(partial);
		const res = await post(app, { message: "hi", source: "cli" });
		assert.equal(res.status, 404, JSON.stringify(partial));
	}
});

test("a configured post files an issue and the page links to feedback", async () => {
	const gh = githubFetch();
	const app = createApp(env(), { fetch: gh.fetch });
	const res = await post(app, { message: "the form forgot a field", kind: "bug", source: "web", version: "0.7.0" });
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { ok: true, issue_url: issue() });
	assert.equal(gh.calls.length, 1);
	assert.equal(gh.calls[0].url, `https://api.github.com/repos/${repo}/issues`);
	assert.equal(new Headers(gh.calls[0].init.headers).get("user-agent"), "a2a-exposed");
	assert.equal(new Headers(gh.calls[0].init.headers).get("authorization"), `Bearer ${ghToken}`);
	assert.deepEqual(gh.calls[0].json.labels, ["feedback"]);
	assert.match(gh.calls[0].json.body, /Source: web/);
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
	assert.match(page, /cloud agent sandbox/);
	assert.match(page, /name="mode"/);
	assert.match(form.headers.get("content-security-policy") ?? "", /script-src 'none'/);
	assert.equal(/<script/.test(page), false);
});

test("a missing GitHub label is retried once without labels", async () => {
	let n = 0;
	const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
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

test("a mode that is not hosted or self-host is rejected", async () => {
	const gh = githubFetch();
	const app = createApp(env(), { fetch: gh.fetch });
	const res = await post(app, { message: "hi", source: "cli", mode: "both" });
	assert.equal(res.status, 400);
	assert.deepEqual(await res.json(), { error: "invalid_mode" });
	assert.equal(gh.calls.length, 0);
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
