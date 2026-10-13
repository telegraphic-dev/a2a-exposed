// Provisioning calls inside workerd. Outbound HTTP is mocked: nothing reaches Cloudflare.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { beforeAll, expect, it } from "vitest";
import type { Sql } from "../../src/core/sql.ts";
import { openCloudflareRefresh, saveCloudflareGrant } from "../../src/provision/grant.ts";
import { consentScope } from "../../src/provision/setup.ts";
import { listAccounts } from "../../src/provision/cloudflare-api.ts";
import { hashOwnerToken, readCloudflareInbox, runInboxStep, type InboxWizard, type ProvisionFields } from "../../src/provision/inbox.ts";
import { network } from "./network.ts";

const secret = "test-secret-test-secret-test-secret";
const accountId = "a".repeat(32);
const d1Id = "b".repeat(32);
const userId = "user-workers-1";
const now = Date.UTC(2026, 9, 13);
const scope = consentScope("inbox", "workers");
const stubScript = "export default { fetch() { return new Response('inbox-stub') } }";

interface Call {
	method: string;
	url: string;
	body: string;
	authorization: string;
	redirect: string;
}

function db(): Sql {
	return env.DB as unknown as Sql;
}

beforeAll(async () => {
	const migrations = env.TEST_MIGRATIONS as { name: string; queries: string[] }[];
	await applyD1Migrations(env.DB as D1Database, migrations);
});

function fields(step: string): ProvisionFields {
	return { name: "my-agent", hostname: "", subdomain: "", account: "", step, inbox: "", zone: "" };
}

function record(calls: Call[], request: Request, body: string): void {
	calls.push({
		method: request.method,
		url: request.url,
		body,
		authorization: request.headers.get("authorization") ?? "",
		redirect: request.redirect,
	});
}

// workerd warns when `.text()` reads a form body. The bytes are the entity as sent.
async function readBody(request: Request): Promise<string> {
	const bytes = new Uint8Array(await request.arrayBuffer());
	return new TextDecoder().decode(bytes);
}

it("strips a newline from the bearer token and does not follow a Cloudflare redirect", async () => {
	let followed = false;
	let call: Call | undefined;
	network.use(
		http.get("https://api.cloudflare.com/client/v4/accounts", async ({ request }) => {
			call = {
				method: request.method,
				url: request.url,
				body: await readBody(request),
				authorization: request.headers.get("authorization") ?? "",
				redirect: request.redirect,
			};
			return new HttpResponse(null, { status: 302, headers: { location: "https://evil.example/phish" } });
		}),
		http.all("https://evil.example/*", () => {
			followed = true;
			return HttpResponse.json({ success: true, result: [] });
		}),
	);
	const result = await listAccounts({ fetchImpl: fetch, token: "cf_access\r\nSECRET\0", fetchMs: 1_000 });
	expect(result).toMatchObject({ ok: false, status: 302 });
	expect(followed).toBe(false);
	expect(call).toMatchObject({
		method: "GET",
		url: "https://api.cloudflare.com/client/v4/accounts?per_page=50",
		body: "",
		authorization: "Bearer cf_accessSECRET",
		redirect: "manual",
	});
});

it("walks a workers.dev inbox against the mocked Cloudflare API", async () => {
	const calls: Call[] = [];
	network.use(
		http.post("https://dash.cloudflare.com/oauth2/token", async ({ request }) => {
			const body = await readBody(request);
			record(calls, request, body);
			const refresh = new URLSearchParams(body).get("refresh_token") ?? "";
			return HttpResponse.json({
				access_token: "cf_access_SECRET",
				refresh_token: `next-${refresh}`,
				expires_in: 3600,
				token_type: "bearer",
			});
		}),
		http.all("https://api.cloudflare.com/*", async ({ request }) => {
			const body = await readBody(request);
			record(calls, request, body);
			const url = request.url;
			const method = request.method.toUpperCase();
			if (url.endsWith("/accounts?per_page=50") && method === "GET") {
				return HttpResponse.json({ success: true, result: [{ id: accountId, name: "Example account" }] });
			}
			if (url.endsWith("/workers/subdomain") && method === "GET") {
				return HttpResponse.json({ success: true, result: { subdomain: "example" } });
			}
			if (url.endsWith("/settings") && method === "GET") return new HttpResponse(null, { status: 404 });
			if (url.includes("/d1/database?") && method === "GET") return HttpResponse.json({ success: true, result: [] });
			if (url.endsWith("/d1/database") && method === "POST") {
				return HttpResponse.json({ success: true, result: { uuid: d1Id, name: "my-agent" } });
			}
			if (url.endsWith("/query") && method === "POST") {
				return HttpResponse.json({ success: true, result: [{ results: [], success: true }] });
			}
			if (url.includes("/workers/scripts/") && method === "PUT") return HttpResponse.json({ success: true, result: {} });
			if (url.endsWith("/subdomain") && method === "POST") return HttpResponse.json({ success: true, result: { enabled: true } });
			return HttpResponse.json({ success: false, errors: [{ code: 7000, message: `unexpected ${method} ${url}` }] }, { status: 500 });
		}),
		http.get("https://my-agent.example.workers.dev/.well-known/agent-card.json", async ({ request }) => {
			record(calls, request, await readBody(request));
			return new HttpResponse(null, { status: 200 });
		}),
	);

	const stamp = new Date(now).toISOString();
	await db().prepare(
		`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)`,
	).bind(userId, "Mona", "mona-workers@example.com", stamp, stamp).run();
	await saveCloudflareGrant(db(), secret, {
		userId,
		accountId: "cf-user",
		choice: "inbox",
		host: "workers",
		requestedScope: scope,
		grantedScope: scope,
		refreshToken: "cf_refresh_SECRET",
		expiresIn: 3600,
		now,
	});

	const input = {
		database: db(),
		secret,
		clientId: "cf-id",
		clientSecret: "cf-secret",
		userId,
		script: stubScript,
		migrations: [{ name: "0001_stub.sql", sql: "CREATE TABLE IF NOT EXISTS inbox_stub (id INTEGER PRIMARY KEY)" }],
		fetchMs: 1_000,
		now,
		permissionDelaysMs: [0, 0, 0],
	};
	let ownerToken = "";
	for (const step of ["account", "address", "name", "database", "migrations", "upload", "verify"] as const) {
		const result = await runInboxStep({ ...input, fields: fields(step) });
		if (result.ownerToken) ownerToken = result.ownerToken;
		const current = result.wizard.steps.find((item) => item.id === step);
		expect(current?.state, JSON.stringify(summarize(result.wizard))).toBe("pass");
		if (step === "verify") expect(result.wizard.publicUrl).toBe("https://my-agent.example.workers.dev");
	}

	expect(ownerToken).toMatch(/^a2aot_/);
	const inbox = await readCloudflareInbox(db(), userId);
	expect(inbox?.status).toBe("ready");
	expect(inbox?.public_url).toBe("https://my-agent.example.workers.dev");
	expect(inbox?.cf_account_id).toBe(accountId);
	expect(inbox?.d1_id).toBe(d1Id);
	expect(inbox?.owner_token_hash).toBe(await hashOwnerToken(ownerToken));
	expect(JSON.stringify(inbox)).not.toContain(ownerToken);

	const api = calls.filter((call) => call.url.startsWith("https://api.cloudflare.com/"));
	expect(api.length).toBeGreaterThan(0);
	for (const call of api) {
		expect(call.authorization).toBe("Bearer cf_access_SECRET");
		expect(call.redirect).toBe("manual");
		if (call.method === "GET") expect(call.body).toBe("");
		expect(call.body).not.toContain("cf_refresh");
		expect(call.body).not.toContain("cf-secret");
		expect(call.authorization).not.toContain("cf_refresh");
	}
	const upload = calls.find((call) => call.method === "PUT" && call.url.includes("/workers/scripts/my-agent"));
	expect(upload?.body).toContain("inbox-stub");
	expect(upload?.body).toContain(ownerToken);
	expect(calls.some((call) => call.url === "https://my-agent.example.workers.dev/.well-known/agent-card.json")).toBe(true);
	expect(calls.filter((call) => call.url.startsWith("https://dash.cloudflare.com/oauth2/token"))).toHaveLength(6);

	const stored = await db().prepare(
		`SELECT refresh_enc FROM cloudflare_grant WHERE "userId" = ?`,
	).bind(userId).first<{ refresh_enc: string }>();
	expect(await openCloudflareRefresh(secret, userId, stored?.refresh_enc)).toBe(`${"next-".repeat(6)}cf_refresh_SECRET`);
});

function summarize(wizard: InboxWizard) {
	return wizard.steps.map((step) => ({ id: step.id, state: step.state, text: step.text, cloudflare: step.cloudflare }));
}
