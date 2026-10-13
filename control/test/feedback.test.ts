// POST /api/feedback. No network: GitHub is stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { inboxConnection, issueDocument, scrubFeedbackText } from "../src/feedback.ts";
import { openDb } from "./sql.ts";

const origin = "https://control.example.com";
const repo = "example-org/example-repo";
const ghToken = "ghp_testtokenvalue1234567890";

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

function captureErrors() {
	const lines: string[] = [];
	const orig = console.error;
	console.error = (...args: unknown[]) => {
		lines.push(args.map((arg) => String(arg)).join(" "));
	};
	return { lines, restore: () => { console.error = orig; }, text: () => lines.join("\n") };
}

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
		{ FEEDBACK_GITHUB_APP_ID: "4242", FEEDBACK_GITHUB_APP_PRIVATE_KEY: pemHeaders, FEEDBACK_REPO: repo },
	]) {
		const app = createApp(partial);
		const res = await post(app, { message: "hi", source: "cli" });
		assert.equal(res.status, 404, JSON.stringify(partial));
	}
});

test("a configured post files an issue", async () => {
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
});

test("inboxConnection prefers an upstream, then a wake URL", () => {
	assert.equal(inboxConnection({}), "polling");
	assert.equal(inboxConnection({ UPSTREAM_URL: "none", WAKE_WEBHOOK_URL: "https://hooks.example/wake" }), "webhook");
	assert.equal(inboxConnection({ UPSTREAM_URL: "off" }), "polling");
	assert.equal(inboxConnection({ UPSTREAM_URL: "https://up.example", WAKE_WEBHOOK_URL: "https://hooks.example/wake" }), "proxy");
});

test("a GitHub redirect is a failure", async () => {
	const logs = captureErrors();
	try {
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
		assert.match(logs.text(), /"status":301,"error":"http","step":"issue"/);
		assert.match(logs.text(), /"status":302,"error":"http","step":"issue_retry"/);
		assert.equal(logs.text().includes(issue()), false);
	} finally {
		logs.restore();
	}
});

test("a GitHub issue URL matches the repository without regard to case", async () => {
	const canonical = "https://github.com/Example-Org/Example-Repo/issues/9";
	const gh = githubFetch({ html_url: canonical });
	const app = createApp(env(), { fetch: gh.fetch });
	const res = await post(app, { message: "hi", source: "cli" });
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { ok: true, issue_url: canonical });
});

test("feedback posts without a database share one limit across Worker requests", async () => {
	const worker = (await import("../src/index.ts")).default;
	const previous = globalThis.fetch;
	const gh = githubFetch();
	globalThis.fetch = gh.fetch;
	const ctx = { waitUntil() {}, passThroughOnException() {} } as ExecutionContext;
	const headers = { "content-type": "application/json", origin, "cf-connecting-ip": "198.51.100.77" };
	const send = (message: string) => worker.fetch(new Request(`${origin}/api/feedback`, {
		method: "POST",
		headers,
		body: JSON.stringify({ message, source: "cli" }),
	}), env(), ctx);
	try {
		for (let i = 0; i < 5; i++) assert.equal((await send(`n ${i}`)).status, 200, String(i));
		assert.equal((await send("over")).status, 429);
	} finally {
		globalThis.fetch = previous;
	}
});

test("a thrown GitHub error logs the step and a scrubbed message", async () => {
	const token = "ghs_" + "supersecretinstallation";
	const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiI0MjQyIn0.sigvalue1234567890";
	const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEsecretkeymaterial\n-----END RSA PRIVATE KEY-----";
	const logs = captureErrors();
	try {
		const thrown = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			assertWorkerdRedirect(init);
			const error = new TypeError(`${WORKERD_REDIRECT} issue ${token} Bearer ${jwt} authorization: Bearer ${token} ${pem}`);
			throw error;
		}) as typeof fetch;
		const app = createApp(env(), { fetch: thrown });
		const res = await post(app, { message: "hi", source: "cli" });
		assert.equal(res.status, 502);
		assert.deepEqual(await res.json(), { error: "unavailable" });
		const text = logs.text();
		assert.match(text, /"step":"issue"/);
		assert.equal(text.includes(token), false);
		assert.equal(text.includes(jwt), false);
		assert.equal(text.includes("MIIEsecretkeymaterial"), false);
	} finally {
		logs.restore();
	}
});
