import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVISION_TAG_NAME, cfCall, permissionNotReady } from "../src/provision/cloudflare-api.ts";
import { openCloudflareRefresh, refreshCloudflareGrant, refreshTokenAfterResponse, saveCloudflareGrant } from "../src/provision/grant.ts";
import { INBOX_MIGRATIONS } from "../src/provision/inbox-migrations.ts";
import {
	PERMISSION_DELAYS_MS,
	PERMISSION_TRIES,
	PERMISSION_WAIT,
	hashOwnerToken,
	permissionRetryDue,
	readCloudflareInbox,
	runInboxStep,
	type InboxWizard,
	type ProvisionFields,
} from "../src/provision/inbox.ts";
import { deleteCloudflareInbox } from "../src/provision/inbox-row.ts";
import { zoneForHostname } from "../src/provision/names.ts";
import { REMOVAL_PERMISSION_DELAYS_MS, REMOVAL_PERMISSION_WINDOW_MS, removalItems, removalRetryDue, removalSteps, runRemovalStep, type RemovalEvent } from "../src/provision/remove.ts";
import { consentScope } from "../src/provision/setup.ts";
import { sqlStatements } from "../src/provision/statements.ts";
import { openDb } from "./sql.ts";

const secret = "test-secret-test-secret-test-secret";
const accountId = "a".repeat(32);
const d1Id = "b".repeat(32);
const stubScript = "export default { fetch() { return new Response('inbox-stub') } }";
const stubMigration = [{ name: "0001_stub.sql", sql: "CREATE TABLE IF NOT EXISTS inbox_stub (id INTEGER PRIMARY KEY)" }];
const WORKER_STEPS = ["account", "address", "name", "database", "migrations", "upload", "verify"] as const;

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
	queryStatus?: number;
	verifyStatus?: number;
	permissionLeft?: { d1?: number; query?: number; upload?: number; account?: number };
	d1Name?: string;
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
		if (url.endsWith("/workers/domains") && method === "GET") return json({ success: true, result: [] });
		if (url.includes("/d1/database/") && method === "GET") return json({ success: true, result: { uuid: d1Id, name: options.d1Name ?? "my-agent" } });
		if (url.includes("/d1/database/") && method === "DELETE") return json({ success: true, result: {} });
		if (method === "DELETE" && /\/workers\/scripts\/[^/]+$/.test(url)) return json({ success: true, result: {} });
		return new Response(`unexpected ${method} ${url}`, { status: 500 });
	}) as typeof fetch;
	return { calls, restore: () => { globalThis.fetch = original; } };
}

function captureLogs() {
	const lines: string[] = [];
	const orig = console.log;
	console.log = (...args: unknown[]) => {
		lines.push(args.map((arg) => String(arg)).join(" "));
	};
	return { lines, restore: () => { console.log = orig; } };
}

let users = 0;

async function seed(db: ReturnType<typeof openDb>, choice: "inbox" | "facade" | "both", host: "workers" | "zone") {
	const userId = `user-${++users}`;
	const stamp = "2026-01-01T00:00:00.000Z";
	await db.prepare(
		`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)`,
	).bind(userId, "Mona", `${userId}@example.com`, stamp, stamp).run();
	const scope = consentScope(choice, host);
	await saveCloudflareGrant(db, secret, {
		userId,
		accountId: "cf-user",
		choice,
		host,
		requestedScope: scope,
		grantedScope: scope,
		refreshToken: "cf_refresh_SECRET",
		expiresIn: 3600,
	});
	return userId;
}

function fields(step: string, extra: Partial<ProvisionFields> = {}): ProvisionFields {
	return { name: "my-agent", hostname: "", subdomain: "", account: "", step, inbox: "", zone: "", ...extra };
}

async function runStep(
	db: ReturnType<typeof openDb>,
	userId: string,
	step: string,
	extra: Partial<ProvisionFields> = {},
	opts: { delays?: number[]; now?: number } = {},
) {
	return runInboxStep({
		database: db,
		secret,
		clientId: "cf-id",
		clientSecret: "cf-secret",
		userId,
		fields: fields(step, extra),
		script: stubScript,
		migrations: stubMigration,
		fetchMs: 1_000,
		now: opts.now,
		permissionDelaysMs: opts.delays ?? [0, 0, 0],
	});
}

function stepText(wizard: InboxWizard, id: string): string {
	return wizard.steps.find((item) => item.id === id)?.text ?? "";
}

function stepState(wizard: InboxWizard, id: string): string {
	return wizard.steps.find((item) => item.id === id)?.state ?? "";
}

async function walk(db: ReturnType<typeof openDb>, userId: string, through: (typeof WORKER_STEPS)[number], extra: Partial<ProvisionFields> = {}, delays?: number[]) {
	let last = await runStep(db, userId, WORKER_STEPS[0], extra, { delays });
	for (const step of WORKER_STEPS) {
		last = await runStep(db, userId, step, extra, { delays });
		if (step === through) break;
	}
	return last;
}

async function finishWaits(db: ReturnType<typeof openDb>, userId: string, step: string, first: Awaited<ReturnType<typeof runStep>>) {
	let current = first;
	let hops = 0;
	while (stepText(current.wizard, step).includes(PERMISSION_WAIT)) {
		assert.ok(hops < 6, stepText(current.wizard, step));
		current = await runStep(db, userId, step);
		hops++;
	}
	return { current, hops };
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
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const api = cloudflareApi({});
	t.after(api.restore);
	let ownerToken = "";
	for (const step of WORKER_STEPS) {
		const result = await runStep(db, userId, step);
		if (result.ownerToken) ownerToken = result.ownerToken;
		assert.equal(stepState(result.wizard, step), "pass", `${step}: ${stepText(result.wizard, step)}`);
	}
	assert.match(ownerToken, /^a2aot_/);
	const again = await runStep(db, userId, "verify");
	assert.equal(again.ownerToken, undefined);
	assert.equal(again.wizard.publicUrl, "https://my-agent.example.workers.dev");
	const inbox = await readCloudflareInbox(db, userId);
	assert.equal(inbox?.status, "ready");
	assert.equal(inbox?.owner_token_hash, await hashOwnerToken(ownerToken));
	assert.equal(JSON.stringify(inbox).includes(ownerToken), false);
	assert.equal(JSON.stringify(inbox).includes("cf_access_SECRET"), false);
	const upload = api.calls.find((call) => call.method === "PUT" && call.url.includes("/workers/scripts/my-agent"));
	assert.ok(upload?.body.includes(ownerToken));
	assert.ok(upload?.body.includes(stubScript));
});

test("a later step does not run before the earlier ones", async (t) => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const api = cloudflareApi({});
	t.after(api.restore);
	const skipped = await runStep(db, userId, "database");
	assert.equal(stepState(skipped.wizard, "account"), "wait");
	assert.equal(api.calls.some((call) => call.url.includes("api.cloudflare.com")), false);
});

test("your own domain attaches the hostname", async (t) => {
	const db = openDb();
	const userId = await seed(db, "both", "zone");
	const api = cloudflareApi({ zones: [{ id: "c".repeat(32), name: "example.com", status: "active" }] });
	t.after(api.restore);
	const extra = { hostname: "agent.example.com" };
	for (const step of ["account", "address", "name", "database", "migrations", "upload", "verify"] as const) {
		const result = await runStep(db, userId, step, extra);
		assert.equal(stepState(result.wizard, step), "pass", `${step}: ${stepText(result.wizard, step)} ${result.wizard.steps.find((item) => item.id === step)?.cloudflare}`);
	}
	const inbox = await readCloudflareInbox(db, userId);
	assert.equal(inbox?.public_url, "https://agent.example.com");
	assert.ok(api.calls.some((call) => call.method === "PUT" && call.url.endsWith("/workers/domains") && call.body.includes("agent.example.com")));
	assert.ok(api.calls.some((call) => call.method === "POST" && call.url.endsWith("/subdomain") && call.body.includes("false")));
	assert.ok(api.calls.some((call) => call.url === "https://agent.example.com/.well-known/agent-card.json"));
});

test("a missing workers.dev name asks for one and does not create a database", async (t) => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const api = cloudflareApi({ subdomain: "" });
	t.after(api.restore);
	await walk(db, userId, "account");
	const asked = await runStep(db, userId, "address");
	assert.match(stepText(asked.wizard, "address"), /no workers\.dev name yet/);
	assert.equal(api.calls.some((call) => call.method === "POST" && call.url.endsWith("/d1/database")), false);
	const retried = await runStep(db, userId, "address", { subdomain: "picked" });
	assert.match(stepText(retried.wizard, "address"), /Address name picked\.workers\.dev/);
	assert.ok(api.calls.some((call) => call.method === "PUT" && call.url.endsWith("/workers/subdomain")));
	assert.equal(api.calls.some((call) => call.method === "POST" && call.url.endsWith("/d1/database")), false);
});

test("a workers.dev error code asks for a name and does not log a failure", async (t) => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const api = cloudflareApi({ subdomainStatus: 400, subdomainErrors: [{ code: 10063, message: "You need a workers.dev subdomain" }] });
	t.after(api.restore);
	const logs = captureLogs();
	t.after(logs.restore);
	await walk(db, userId, "account");
	const posted = await runStep(db, userId, "address");
	assert.match(stepText(posted.wizard, "address"), /no workers\.dev name yet/);
	assert.match(posted.wizard.steps.find((item) => item.id === "address")?.cloudflare ?? "", /code 10063/);
	assert.equal(logs.lines.some((line) => line.includes("cloudflare_provision_failed")), false);
	assert.equal(api.calls.some((call) => call.method === "POST" && call.url.endsWith("/d1/database")), false);
});

test("a thrown accounts call names the step and the error", async (t) => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const api = cloudflareApi({ accountsThrow: true });
	t.after(api.restore);
	const logs = captureLogs();
	t.after(logs.restore);
	const posted = await runStep(db, userId, "account");
	assert.match(stepText(posted.wizard, "account"), /Cloudflare stops while reading your accounts/);
	assert.match(posted.wizard.steps.find((item) => item.id === "account")?.cloudflare ?? "", /Invalid header value/);
	assert.equal(stepText(posted.wizard, "account").includes("cf_access_SECRET"), false);
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
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const options: ApiOptions = { d1Status: 400, d1Errors: [{ code: 7500, message: "database name is invalid" }] };
	const api = cloudflareApi(options);
	t.after(api.restore);
	const logs = captureLogs();
	t.after(logs.restore);
	await walk(db, userId, "name");
	const failed = await runStep(db, userId, "database");
	assert.match(stepText(failed.wizard, "database"), /Cloudflare stops while creating the database/);
	const detail = failed.wizard.steps.find((item) => item.id === "database")?.cloudflare ?? "";
	assert.match(detail, /code 7500/);
	assert.match(detail, /database name is invalid/);
	const line = logs.lines.find((entry) => entry.includes("cloudflare_provision_failed"));
	assert.ok(line);
	const parsed = JSON.parse(line!) as { step: string; status: number; errors: { code: number; message: string }[] };
	assert.equal(parsed.step, "d1-create");
	assert.equal(parsed.status, 400);
	assert.equal(parsed.errors[0]?.code, 7500);
	options.d1Errors = [{ code: 7500, message: "Bearer cf_access_SECRET refused" }];
	logs.lines.length = 0;
	const secretStep = await runStep(db, userId, "database");
	const hidden = secretStep.wizard.steps.find((item) => item.id === "database")?.cloudflare ?? "";
	assert.match(hidden, /code 7500/);
	assert.match(hidden, /hidden because it contains a secret/);
	assert.equal(hidden.includes("cf_access_SECRET"), false);
	const secretLine = logs.lines.find((entry) => entry.includes("d1-create"));
	assert.ok(secretLine);
	assert.equal(secretLine!.includes("cf_access_SECRET"), false);
	assert.match(secretLine!, /redacted/);
});

test("a failed database setup retries without creating the database again", async (t) => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const options: ApiOptions = { queryStatus: 500 };
	const api = cloudflareApi(options);
	t.after(api.restore);
	await walk(db, userId, "database");
	const creates = () => api.calls.filter((call) => call.method === "POST" && call.url.endsWith("/d1/database")).length;
	assert.equal(creates(), 1);
	const failed = await runStep(db, userId, "migrations");
	assert.match(stepText(failed.wizard, "migrations"), /Cloudflare stops while applying the database setup/);
	assert.equal(creates(), 1);
	options.queryStatus = undefined;
	const retried = await runStep(db, userId, "migrations");
	assert.match(stepText(retried.wizard, "migrations"), /The database setup is applied/);
	assert.equal(creates(), 1);
});

test("an existing Worker name is refused and a failed upload can be continued", async (t) => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const taken = cloudflareApi({ scriptExists: true });
	t.after(taken.restore);
	await walk(db, userId, "address");
	const refused = await runStep(db, userId, "name");
	assert.match(stepText(refused.wizard, "name"), /A Worker with that name is already in this Cloudflare account/);
	assert.equal(taken.calls.some((call) => call.method === "POST" && call.url.endsWith("/d1/database")), false);
	taken.restore();

	const upload = { uploadStatus: 500 as number | undefined };
	const failed = cloudflareApi(upload);
	t.after(failed.restore);
	const db2 = openDb();
	const user2 = await seed(db2, "inbox", "workers");
	await walk(db2, user2, "migrations");
	const partial = await runStep(db2, user2, "upload");
	assert.match(stepText(partial.wizard, "upload"), /Cloudflare stops while uploading the inbox/);
	assert.equal((await readCloudflareInbox(db2, user2))?.d1_id, d1Id);
	assert.equal((await readCloudflareInbox(db2, user2))?.status, "pending");
	const creates = () => failed.calls.filter((call) => call.method === "POST" && call.url.endsWith("/d1/database")).length;
	assert.equal(creates(), 1);
	upload.uploadStatus = undefined;
	const continued = await runStep(db2, user2, "upload");
	assert.match(stepText(continued.wizard, "upload"), /The inbox is uploaded/);
	assert.equal(creates(), 1);
	const verified = await runStep(db2, user2, "verify");
	assert.equal(verified.wizard.publicUrl, "https://my-agent.example.workers.dev");
	assert.equal((await readCloudflareInbox(db2, user2))?.status, "ready");
});

test("a retry does not replace a Worker that only contains the inbox comment", async (t) => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const options = { scriptExists: false, uploadStatus: 500 as number | undefined, scriptTag: "" };
	const api = cloudflareApi(options);
	t.after(api.restore);
	await walk(db, userId, "migrations");
	await runStep(db, userId, "upload");
	assert.equal((await readCloudflareInbox(db, userId))?.d1_id, d1Id);
	options.scriptExists = true;
	options.uploadStatus = undefined;
	const puts = () => api.calls.filter((call) => call.method === "PUT" && call.url.includes("/workers/scripts/")).length;
	const before = puts();
	const again = await runStep(db, userId, "upload");
	assert.match(stepText(again.wizard, "upload"), /Choose another name/);
	assert.equal(puts(), before);
	assert.equal((await readCloudflareInbox(db, userId))?.status, "pending");
	assert.equal((await readCloudflareInbox(db, userId))?.d1_id, d1Id);
});

test("a retry continues when the script settings carry the tag this setup stored", async (t) => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const options = { scriptExists: false, uploadStatus: 500 as number | undefined, scriptTag: "" };
	const api = cloudflareApi(options);
	t.after(api.restore);
	await walk(db, userId, "migrations");
	await runStep(db, userId, "upload");
	const savedTag = (await readCloudflareInbox(db, userId))?.script_tag ?? "";
	assert.equal(savedTag.length, 64);
	options.scriptTag = savedTag;
	options.scriptExists = true;
	options.uploadStatus = undefined;
	const again = await runStep(db, userId, "upload");
	assert.match(stepText(again.wizard, "upload"), /The inbox is uploaded/);
	assert.equal((await readCloudflareInbox(db, userId))?.status, "pending");
	assert.equal((await readCloudflareInbox(db, userId))?.public_url, null);
	assert.ok(api.calls.some((call) => call.method === "PUT" && call.url.includes("/workers/scripts/") && call.body.includes(PROVISION_TAG_NAME) && call.body.includes(savedTag)));
	const verified = await runStep(db, userId, "verify");
	assert.equal((await readCloudflareInbox(db, userId))?.status, "ready");
	assert.equal(verified.wizard.publicUrl, "https://my-agent.example.workers.dev");
});

test("the inbox check can be retried without uploading again", async (t) => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const options: ApiOptions = { verifyStatus: 503 };
	const api = cloudflareApi(options);
	t.after(api.restore);
	await walk(db, userId, "upload");
	const puts = () => api.calls.filter((call) => call.method === "PUT" && call.url.includes("/workers/scripts/")).length;
	const before = puts();
	const failed = await runStep(db, userId, "verify");
	assert.match(stepText(failed.wizard, "verify"), /The inbox does not answer yet\. HTTP 503\./);
	assert.equal((await readCloudflareInbox(db, userId))?.public_url, null);
	options.verifyStatus = 200;
	const retried = await runStep(db, userId, "verify");
	assert.equal(retried.wizard.publicUrl, "https://my-agent.example.workers.dev");
	assert.equal(puts(), before);
});

test("a façade alone does not create Cloudflare resources", async (t) => {
	const db = openDb();
	const userId = await seed(db, "facade", "workers");
	const api = cloudflareApi({});
	t.after(api.restore);
	const result = await runStep(db, userId, "account");
	assert.equal(result.wizard.facade, true);
	assert.equal(stepState(result.wizard, "grant"), "fixable");
	assert.equal(api.calls.some((call) => call.url.includes("api.cloudflare.com")), false);
	assert.equal(await readCloudflareInbox(db, userId), null);
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
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const options: ApiOptions = { permissionLeft: { d1: 2 } };
	const api = cloudflareApi(options);
	t.after(api.restore);
	await walk(db, userId, "name");
	const creates = () => api.calls.filter((call) => call.method === "POST" && call.url.endsWith("/d1/database")).length;
	const started = await runStep(db, userId, "database");
	const done = await finishWaits(db, userId, "database", started);
	assert.equal(done.hops, 2);
	assert.match(stepText(done.current.wizard, "database"), /Database my-agent is created/);
	assert.equal(stepText(done.current.wizard, "database").includes(PERMISSION_WAIT), false);
	assert.equal(creates(), 3);
});

test("database setup shows code 7403 only after four tries", async (t) => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const options: ApiOptions = { permissionLeft: { query: 4 } };
	const api = cloudflareApi(options);
	t.after(api.restore);
	await walk(db, userId, "database");
	const queries = () => api.calls.filter((call) => call.method === "POST" && call.url.endsWith("/query")).length;
	const started = await runStep(db, userId, "migrations");
	const done = await finishWaits(db, userId, "migrations", started);
	assert.equal(done.hops, 3);
	assert.match(stepText(done.current.wizard, "migrations"), /Cloudflare stops while applying the database setup/);
	assert.match(done.current.wizard.steps.find((item) => item.id === "migrations")?.cloudflare ?? "", /code 7403/);
	assert.equal(queries(), 4);
});

test("uploading the inbox waits through no access, then shows the owner token", async (t) => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const options: ApiOptions = { permissionLeft: { upload: 3 } };
	const api = cloudflareApi(options);
	t.after(api.restore);
	await walk(db, userId, "migrations");
	const puts = () => api.calls.filter((call) => call.method === "PUT" && call.url.includes("/workers/scripts/")).length;
	const started = await runStep(db, userId, "upload");
	const done = await finishWaits(db, userId, "upload", started);
	assert.equal(done.hops, 3);
	assert.match(stepText(done.current.wizard, "upload"), /The inbox is uploaded/);
	assert.match(done.current.ownerToken ?? "", /^a2aot_/);
	assert.equal(stepText(done.current.wizard, "upload").includes("No access to the specified resource"), false);
	assert.equal(puts(), 4);
});

test("an account permission error is shown at once and is not retried", async (t) => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const options: ApiOptions = { permissionLeft: { account: 5 } };
	const api = cloudflareApi(options);
	t.after(api.restore);
	const accounts = () => api.calls.filter((call) => call.url.endsWith("/accounts?per_page=50")).length;
	const failed = await runStep(db, userId, "account");
	assert.match(stepText(failed.wizard, "account"), /Cloudflare stops while reading your accounts/);
	assert.match(failed.wizard.steps.find((item) => item.id === "account")?.cloudflare ?? "", /code 10000/);
	assert.equal(stepText(failed.wizard, "account").includes(PERMISSION_WAIT), false);
	assert.equal(accounts(), 1);
	assert.equal(permissionRetryDue(await readCloudflareInbox(db, userId)), false);
	assert.equal(accounts(), 1);
});

test("a permission wait does not run again until the pause has passed", async (t) => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const options: ApiOptions = { permissionLeft: { d1: 5 } };
	const api = cloudflareApi(options);
	t.after(api.restore);
	const now = Date.now();
	await walk(db, userId, "name");
	const creates = () => api.calls.filter((call) => call.method === "POST" && call.url.endsWith("/d1/database")).length;
	const waiting = await runStep(db, userId, "database", {}, { delays: [60_000, 0, 0], now });
	assert.match(stepText(waiting.wizard, "database"), /Waiting for Cloudflare to apply the new permission/);
	assert.ok((waiting.wizard.refreshSeconds ?? 0) >= 58);
	assert.equal(creates(), 1);
	const row = await readCloudflareInbox(db, userId);
	assert.equal(permissionRetryDue(row, now + 1_000), false);
	assert.equal(permissionRetryDue(row, now + 60_000), true);
	assert.equal(creates(), 1);
});

test("several Cloudflare accounts defer later calls until one is chosen", async (t) => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const second = "d".repeat(32);
	const api = cloudflareApi({ accounts: [{ id: accountId, name: "One" }, { id: second, name: "Two" }] });
	t.after(api.restore);
	const asked = await runStep(db, userId, "account");
	assert.match(stepText(asked.wizard, "account"), /Choose the Cloudflare account to use/);
	assert.equal(asked.wizard.accounts?.length, 2);
	assert.equal(api.calls.some((call) => call.url.includes("/workers/")), false);
	const chosen = await runStep(db, userId, "account", { account: second });
	assert.equal(stepState(chosen.wizard, "account"), "pass");
	assert.equal((await readCloudflareInbox(db, userId))?.cf_account_id, second);
});

test("Remove from my Cloudflare deletes the Worker and database this setup created", async (t) => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const options: ApiOptions = {};
	const api = cloudflareApi(options);
	t.after(api.restore);
	await walk(db, userId, "verify");
	const row = await readCloudflareInbox(db, userId);
	assert.ok(row?.id);
	options.scriptExists = true;
	options.scriptTag = row!.script_tag ?? "";
	const before = api.calls.length;
	const items = removalItems(row!);
	assert.equal(items.some((item) => item.id === "worker" && item.detail === "my-agent"), true);
	assert.equal(items.some((item) => item.id === "database"), true);
	assert.equal(api.calls.length, before);
	const worker = await runRemovalStep({ database: db, secret, clientId: "cf-id", clientSecret: "cf-secret", userId, inboxId: row!.id, fetchMs: 1_000 });
	assert.equal(worker.finished, false);
	assert.match(worker.row?.step_error ?? "", /my-agent is removed/);
	assert.equal(api.calls.filter((call) => call.method === "DELETE" && /\/workers\/scripts\/my-agent$/.test(call.url)).length, 1);
	assert.equal(api.calls.filter((call) => call.method === "DELETE" && call.url.includes("/d1/database/")).length, 0);
	const finished = await runRemovalStep({ database: db, secret, clientId: "cf-id", clientSecret: "cf-secret", userId, inboxId: row!.id, fetchMs: 1_000 });
	assert.equal(finished.finished, true);
	assert.equal(api.calls.filter((call) => call.method === "DELETE" && call.url.includes("/d1/database/")).length, 1);
	assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM cloudflare_inbox").first<{ n: number }>())?.n, 0);
});

test("a Worker this setup did not create stays, and one already deleted counts as gone", async (t) => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const options: ApiOptions = {};
	const api = cloudflareApi(options);
	t.after(api.restore);
	await walk(db, userId, "verify");
	const row = await readCloudflareInbox(db, userId);
	assert.ok(row?.id);
	options.scriptExists = true;
	options.scriptTag = "not-this-setup";
	const mismatch = await runRemovalStep({ database: db, secret, clientId: "cf-id", clientSecret: "cf-secret", userId, inboxId: row!.id, fetchMs: 1_000 });
	assert.match(mismatch.row?.step_error ?? "", /This Worker was not created by this setup, so it stays/);
	assert.equal(api.calls.some((call) => call.method === "DELETE" && call.url.includes("/workers/scripts/")), false);
	await db.prepare("UPDATE cloudflare_inbox SET status = 'ready', step_error = NULL WHERE id = ?").bind(row!.id).run();
	options.scriptExists = false;
	const gone = await runRemovalStep({ database: db, secret, clientId: "cf-id", clientSecret: "cf-secret", userId, inboxId: row!.id, fetchMs: 1_000 });
	assert.match(gone.row?.step_error ?? "", /Already gone/);
	assert.equal(api.calls.some((call) => call.method === "DELETE" && call.url.includes("/workers/scripts/")), false);
});

interface RemovalCall {
	method: string;
	url: string;
	authorization: string;
}

function removalApi(options: {
	tag?: string;
	omitRefresh?: boolean;
	scope?: string;
	fail?: { match: (method: string, url: string) => boolean; left: number; code: number; message: string };
}) {
	const tokens: string[] = [];
	const calls: RemovalCall[] = [];
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = (init?.method ?? "GET").toUpperCase();
		const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
		if (url.startsWith("https://dash.cloudflare.com/oauth2/token")) {
			tokens.push(body);
			const refresh = new URLSearchParams(body).get("refresh_token");
			const payload: Record<string, unknown> = { access_token: "cf_access_SECRET", expires_in: 3600, token_type: "bearer" };
			if (!options.omitRefresh) payload.refresh_token = `next-${refresh}`;
			if (options.scope != null) payload.scope = options.scope;
			return Response.json(payload);
		}
		calls.push({ method, url, authorization: new Headers(init?.headers).get("authorization") ?? "" });
		if (options.fail && options.fail.left > 0 && options.fail.match(method, url)) {
			options.fail.left -= 1;
			return Response.json({ success: false, errors: [{ code: options.fail.code, message: options.fail.message }] }, { status: 403 });
		}
		const json = (payload: unknown, status = 200) => Response.json(payload, { status });
		if (url.endsWith("/settings") && method === "GET") {
			if (!options.tag) return new Response("", { status: 404 });
			return json({ success: true, result: { bindings: [{ type: "plain_text", name: PROVISION_TAG_NAME, text: options.tag }] } });
		}
		if (url.endsWith("/workers/domains") && method === "GET") return json({ success: true, result: [] });
		if (url.includes("/d1/database/") && method === "GET") return json({ success: true, result: { uuid: d1Id, name: "my-agent" } });
		if (url.includes("/d1/database/") && method === "DELETE") return json({ success: true, result: {} });
		if (method === "DELETE" && /\/workers\/scripts\/[^/]+$/.test(url)) return json({ success: true, result: {} });
		return new Response(`unexpected ${method} ${url}`, { status: 500 });
	}) as typeof fetch;
	return { fetchImpl, tokens, calls };
}

function showsSecret(value: unknown): boolean {
	const text = JSON.stringify(value);
	return /cf_access_SECRET|cf_refresh_SECRET|cf-secret|hook_access_SECRET|given_access_SECRET/.test(text);
}

async function grantRefresh(db: ReturnType<typeof openDb>, userId: string): Promise<string | null> {
	const row = await db.prepare(`SELECT refresh_enc FROM cloudflare_grant WHERE "userId" = ?`).bind(userId).first<{ refresh_enc: string | null }>();
	return openCloudflareRefresh(secret, userId, row?.refresh_enc);
}

test("a refresh response with no refresh_token keeps the stored token and the granted scopes", async () => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	await db.prepare(`UPDATE cloudflare_grant SET granted_scope = ? WHERE "userId" = ?`).bind("d1.write", userId).run();
	const bodies: string[] = [];
	const fetchImpl = (async (_url: string, init?: RequestInit) => {
		bodies.push(String(init?.body ?? ""));
		return Response.json({ access_token: "cf_access_SECRET", expires_in: 1200, refresh_token: "" });
	}) as typeof fetch;
	const input = { database: db, secret, clientId: "cf-id", clientSecret: "cf-secret", userId, fetchMs: 1_000, fetchImpl };
	const first = await refreshCloudflareGrant(input);
	assert.equal(first.ok, true);
	if (first.ok) assert.equal(first.scope, "d1.write");
	const sent = new URLSearchParams(bodies[0] ?? "");
	assert.equal(sent.get("grant_type"), "refresh_token");
	assert.equal(sent.get("scope"), null);
	assert.equal(await grantRefresh(db, userId), "cf_refresh_SECRET");
	assert.equal((await db.prepare(`SELECT granted_scope FROM cloudflare_grant WHERE "userId" = ?`).bind(userId).first<{ granted_scope: string }>())?.granted_scope, "d1.write");
	const second = await refreshCloudflareGrant(input);
	assert.equal(second.ok, true);
	assert.equal(new URLSearchParams(bodies[1] ?? "").get("refresh_token"), "cf_refresh_SECRET");
	assert.equal(refreshTokenAfterResponse(undefined, "cf_refresh_SECRET"), "cf_refresh_SECRET");
});

test("a refresh response with a new token and scope replaces both, and a 401 drops the stored token", async () => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const fetchImpl = (async () => Response.json({
		access_token: "cf_access_SECRET",
		refresh_token: "cf_refresh_NEXT",
		expires_in: 1200,
		scope: "d1.write workers-scripts.admin",
	})) as typeof fetch;
	const replaced = await refreshCloudflareGrant({ database: db, secret, clientId: "cf-id", clientSecret: "cf-secret", userId, fetchMs: 1_000, fetchImpl });
	assert.equal(replaced.ok, true);
	if (replaced.ok) assert.equal(replaced.scope, "d1.write workers-scripts.admin");
	assert.equal(await grantRefresh(db, userId), "cf_refresh_NEXT");
	const denied = (async () => new Response("no", { status: 401 })) as typeof fetch;
	const rejected = await refreshCloudflareGrant({ database: db, secret, clientId: "cf-id", clientSecret: "cf-secret", userId, fetchMs: 1_000, fetchImpl: denied });
	assert.deepEqual(rejected, { ok: false, error: "invalid_grant" });
	assert.equal(await grantRefresh(db, userId), null);
});

test("a 500 from the token endpoint leaves the stored refresh token in place", async () => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const result = await refreshCloudflareGrant({
		database: db,
		secret,
		clientId: "cf-id",
		clientSecret: "cf-secret",
		userId,
		fetchMs: 1_000,
		fetchImpl: (async () => new Response("down", { status: 500 })) as typeof fetch,
	});
	assert.deepEqual(result, { ok: false, error: "failed" });
	assert.equal(await grantRefresh(db, userId), "cf_refresh_SECRET");
});

test("D1 removal waits through code 10000 with one refresh, then deletes", async (t) => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const api = cloudflareApi({});
	t.after(api.restore);
	await walk(db, userId, "verify");
	const row = await readCloudflareInbox(db, userId);
	assert.ok(row?.id);
	await db.prepare(`UPDATE cloudflare_inbox SET status = 'removing', step_error = ? WHERE id = ?`).bind(JSON.stringify({ removing: true, passed: ["worker"], texts: { worker: "my-agent is removed." } }), row!.id).run();
	const fail = { match: (method: string, url: string) => method === "GET" && url.includes("/d1/database/"), left: 1, code: 10000, message: "Authentication error" };
	const removal = removalApi({ fail });
	const events: RemovalEvent[] = [];
	const now = Date.UTC(2026, 5, 2);
	const input = {
		database: db,
		secret,
		clientId: "cf-id",
		clientSecret: "cf-secret",
		userId,
		inboxId: row!.id,
		fetchMs: 1_000,
		fetchImpl: removal.fetchImpl,
		consentedAt: now,
		permissionDelaysMs: [5_000],
		onEvent: (event: RemovalEvent) => events.push(event),
	};
	const waiting = await runRemovalStep({ ...input, now });
	assert.equal(waiting.status, "waiting");
	assert.equal(waiting.finished, false);
	assert.equal(waiting.retryAt, now + 5_000);
	assert.match(waiting.row?.step_error ?? "", new RegExp(PERMISSION_WAIT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	const steps = removalSteps(waiting.row!);
	assert.equal(steps.find((item) => item.id === "database")?.state, "wait");
	assert.equal(steps.find((item) => item.id === "database")?.text, PERMISSION_WAIT);
	assert.equal(steps.find((item) => item.id === "worker")?.state, "pass");
	assert.equal(removalRetryDue(waiting.row, now + 1_000), false);
	assert.equal(removalRetryDue(waiting.row, now + 5_000), true);
	assert.equal(removal.tokens.length, 1);
	assert.equal(removal.calls.length, 1);
	const early = await runRemovalStep({ ...input, now: now + 1_000 });
	assert.equal(early.status, "waiting");
	assert.equal(removal.tokens.length, 1);
	assert.equal(removal.calls.length, 1);
	const held = await db.prepare(`SELECT removal_access FROM cloudflare_grant WHERE "userId" = ?`).bind(userId).first<{ removal_access: string | null }>();
	assert.equal(showsSecret(held?.removal_access), false);
	assert.equal(showsSecret(waiting.row?.step_error), false);
	assert.equal(showsSecret(events), false);
	assert.deepEqual(events[0], {
		event: "removal_step",
		step: "database",
		status: 403,
		code: 10000,
		secondsSinceConsent: 0,
		rotations: 1,
		lock: "claimed",
	});
	const done = await runRemovalStep({ ...input, now: now + 5_000 });
	assert.equal(done.status, "finished");
	assert.equal(done.finished, true);
	assert.equal(removal.tokens.length, 1);
	assert.equal(removal.calls.filter((call) => call.method === "DELETE" && call.url.includes("/d1/database/")).length, 1);
	assert.equal(removal.calls.every((call) => call.authorization === "Bearer cf_access_SECRET"), true);
	assert.equal(events.at(-2)?.lock, "skipped");
	assert.equal(events.at(-2)?.rotations, 1);
	assert.equal(events.at(-2)?.code, null);
	assert.equal((await db.prepare(`SELECT removal_access FROM cloudflare_grant WHERE "userId" = ?`).bind(userId).first<{ removal_access: string | null }>())?.removal_access, null);
	assert.equal(showsSecret(events), false);
});

test("Worker removal waits through code 7403 and a later code 7500 fails at once", async (t) => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const api = cloudflareApi({});
	t.after(api.restore);
	await walk(db, userId, "verify");
	const row = await readCloudflareInbox(db, userId);
	assert.ok(row?.script_tag);
	const waitingApi = removalApi({
		tag: row!.script_tag ?? "",
		fail: { match: (method, url) => method === "DELETE" && /\/workers\/scripts\/[^/]+$/.test(url), left: 1, code: 7403, message: "Unauthorized" },
	});
	const now = Date.UTC(2026, 5, 3);
	const waiting = await runRemovalStep({
		database: db,
		secret,
		clientId: "cf-id",
		clientSecret: "cf-secret",
		userId,
		inboxId: row!.id,
		fetchMs: 1_000,
		now,
		fetchImpl: waitingApi.fetchImpl,
		secondsSinceConsent: 10,
		permissionDelaysMs: [0],
	});
	assert.equal(waiting.status, "waiting");
	assert.match(waiting.row?.step_error ?? "", /Waiting for Cloudflare to apply the new permission/);
	assert.equal(waitingApi.tokens.length, 1);
	const removed = await runRemovalStep({
		database: db,
		secret,
		clientId: "cf-id",
		clientSecret: "cf-secret",
		userId,
		inboxId: row!.id,
		fetchMs: 1_000,
		now,
		fetchImpl: waitingApi.fetchImpl,
		permissionDelaysMs: [0],
	});
	assert.equal(removed.status, "pass");
	assert.equal(waitingApi.tokens.length, 1);
	assert.equal(removalSteps(removed.row!).find((item) => item.id === "worker")?.state, "pass");

	const other = await seed(db, "inbox", "workers");
	const setup = cloudflareApi({});
	t.after(setup.restore);
	await walk(db, other, "verify");
	const otherRow = await readCloudflareInbox(db, other);
	const denied = removalApi({
		fail: { match: (method, url) => method === "GET" && url.includes("/d1/database/"), left: 1, code: 7500, message: "database name is invalid" },
	});
	await db.prepare(`UPDATE cloudflare_inbox SET status = 'removing', step_error = ? WHERE id = ?`).bind(JSON.stringify({ removing: true, passed: ["worker"] }), otherRow!.id).run();
	const failed = await runRemovalStep({
		database: db,
		secret,
		clientId: "cf-id",
		clientSecret: "cf-secret",
		userId: other,
		inboxId: otherRow!.id,
		fetchMs: 1_000,
		now,
		fetchImpl: denied.fetchImpl,
		consentedAt: now,
	});
	assert.equal(failed.status, "fail");
	assert.match(failed.row?.step_error ?? "", /code 7500/);
	assert.equal((failed.row?.step_error ?? "").includes(PERMISSION_WAIT), false);
});

test("a permission error after the consent window fails, and the address step stays a failure", async (t) => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const api = cloudflareApi({});
	t.after(api.restore);
	await walk(db, userId, "verify");
	const row = await readCloudflareInbox(db, userId);
	await db.prepare(`UPDATE cloudflare_inbox SET status = 'removing', step_error = ? WHERE id = ?`).bind(JSON.stringify({ removing: true, passed: ["worker"] }), row!.id).run();
	const late = removalApi({
		fail: { match: (method, url) => method === "GET" && url.includes("/d1/database/"), left: 2, code: 10000, message: "Authentication error" },
	});
	const events: RemovalEvent[] = [];
	const failed = await runRemovalStep({
		database: db,
		secret,
		clientId: "cf-id",
		clientSecret: "cf-secret",
		userId,
		inboxId: row!.id,
		fetchMs: 1_000,
		fetchImpl: late.fetchImpl,
		secondsSinceConsent: 100,
		onEvent: (event) => events.push(event),
	});
	assert.equal(failed.status, "fail");
	assert.equal(events[0]?.event, "removal_step_failed");
	assert.equal(events[0]?.code, 10000);
	assert.equal(events[0]?.secondsSinceConsent, 100);
	assert.equal(late.calls.length, 1);

	const zoneUser = await seed(db, "inbox", "zone");
	const zoneApi = cloudflareApi({ zones: [{ id: "c".repeat(32), name: "example.com", status: "active" }] });
	t.after(zoneApi.restore);
	await walk(db, zoneUser, "verify", { hostname: "agent.example.com" });
	const zoneRow = await readCloudflareInbox(db, zoneUser);
	const address = removalApi({
		fail: { match: (_method, url) => url.endsWith("/workers/domains"), left: 1, code: 10000, message: "Authentication error" },
	});
	const addressResult = await runRemovalStep({
		database: db,
		secret,
		clientId: "cf-id",
		clientSecret: "cf-secret",
		userId: zoneUser,
		inboxId: zoneRow!.id,
		fetchMs: 1_000,
		fetchImpl: address.fetchImpl,
		consentedAt: Date.now(),
	});
	assert.equal(addressResult.status, "fail");
	assert.equal(removalSteps(addressResult.row!).find((item) => item.id === "address")?.state, "fail");
	assert.equal((addressResult.row?.step_error ?? "").includes(PERMISSION_WAIT), false);
});

test("refreshAccess and accessToken skip a second token rotation between retries", async (t) => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const api = cloudflareApi({});
	t.after(api.restore);
	await walk(db, userId, "verify");
	const row = await readCloudflareInbox(db, userId);
	await db.prepare(`UPDATE cloudflare_inbox SET status = 'removing', step_error = ? WHERE id = ?`).bind(JSON.stringify({ removing: true, passed: ["worker"] }), row!.id).run();
	const removal = removalApi({
		fail: { match: (method, url) => method === "GET" && url.includes("/d1/database/"), left: 1, code: 10000, message: "Authentication error" },
	});
	const events: RemovalEvent[] = [];
	let hooks = 0;
	const now = Date.UTC(2026, 5, 4);
	const hookInput = {
		database: db,
		secret,
		clientId: "cf-id",
		clientSecret: "cf-secret",
		userId,
		inboxId: row!.id,
		fetchMs: 1_000,
		fetchImpl: removal.fetchImpl,
		permissionDelaysMs: [0],
		consentedAt: now,
		now,
		onEvent: (event: RemovalEvent) => events.push(event),
		refreshAccess: async () => {
			hooks += 1;
			return { ok: true as const, accessToken: "hook_access_SECRET", scope: "d1.write", rotated: false, lock: "skipped" as const };
		},
	};
	const waiting = await runRemovalStep(hookInput);
	assert.equal(waiting.status, "waiting");
	const done = await runRemovalStep(hookInput);
	assert.equal(done.finished, true);
	assert.equal(hooks, 2);
	assert.equal(removal.tokens.length, 0);
	assert.equal(removal.calls.every((call) => call.authorization === "Bearer hook_access_SECRET"), true);
	assert.equal(events.filter((event) => event.step === "database").every((event) => event.rotations === 0 && event.lock === "skipped"), true);
	assert.equal(showsSecret(events), false);

	const directUser = await seed(db, "inbox", "workers");
	const directSetup = cloudflareApi({});
	t.after(directSetup.restore);
	await walk(db, directUser, "verify");
	const directRow = await readCloudflareInbox(db, directUser);
	await db.prepare(`UPDATE cloudflare_inbox SET status = 'removing', step_error = ? WHERE id = ?`).bind(JSON.stringify({ removing: true, passed: ["worker"] }), directRow!.id).run();
	const direct = removalApi({
		fail: { match: (method, url) => method === "GET" && url.includes("/d1/database/"), left: 1, code: 7403, message: "Unauthorized" },
	});
	const shared = {
		database: db,
		secret,
		clientId: "cf-id",
		clientSecret: "cf-secret",
		userId: directUser,
		inboxId: directRow!.id,
		fetchMs: 1_000,
		fetchImpl: direct.fetchImpl,
		permissionDelaysMs: [0],
		now,
		accessToken: "given_access_SECRET",
	};
	assert.equal((await runRemovalStep(shared)).status, "waiting");
	assert.equal((await runRemovalStep(shared)).finished, true);
	assert.equal(direct.tokens.length, 0);
	assert.equal(direct.calls.every((call) => call.authorization === "Bearer given_access_SECRET"), true);
});

test("a busy refresh lock is a removal failure and does not call the Cloudflare API", async (t) => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const api = cloudflareApi({});
	t.after(api.restore);
	await walk(db, userId, "verify");
	const row = await readCloudflareInbox(db, userId);
	const now = Date.UTC(2026, 5, 5);
	await db.prepare(
		`INSERT INTO control_locks (name, holder, expires_ms) VALUES (?, 'busy-holder', ?)
		 ON CONFLICT(name) DO UPDATE SET holder = 'busy-holder', expires_ms = excluded.expires_ms`,
	).bind(`cf-refresh:${userId}`, now + 60_000).run();
	const removal = removalApi({});
	const events: RemovalEvent[] = [];
	const failed = await runRemovalStep({
		database: db,
		secret,
		clientId: "cf-id",
		clientSecret: "cf-secret",
		userId,
		inboxId: row!.id,
		fetchMs: 1_000,
		now,
		fetchImpl: removal.fetchImpl,
		onEvent: (event) => events.push(event),
	});
	assert.equal(failed.status, "fail");
	assert.match(failed.row?.step_error ?? "", /Connect Cloudflare again/);
	assert.equal(removal.tokens.length, 0);
	assert.equal(removal.calls.length, 0);
	assert.equal(events[0]?.lock, "busy");
	assert.equal(events[0]?.event, "removal_step_failed");
	assert.equal(showsSecret(events), false);
});

test("removal keeps the stored refresh token when the token response omits it", async (t) => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const api = cloudflareApi({});
	t.after(api.restore);
	await walk(db, userId, "verify");
	const row = await readCloudflareInbox(db, userId);
	const before = await grantRefresh(db, userId);
	assert.ok(before);
	const removal = removalApi({ omitRefresh: true });
	const finished = await runRemovalStep({
		database: db,
		secret,
		clientId: "cf-id",
		clientSecret: "cf-secret",
		userId,
		inboxId: row!.id,
		fetchMs: 1_000,
		fetchImpl: removal.fetchImpl,
	});
	assert.equal(finished.status, "pass");
	const done = await runRemovalStep({
		database: db,
		secret,
		clientId: "cf-id",
		clientSecret: "cf-secret",
		userId,
		inboxId: row!.id,
		fetchMs: 1_000,
		fetchImpl: removal.fetchImpl,
	});
	assert.equal(done.finished, true);
	assert.equal(removal.tokens.length, 2);
	assert.equal(removal.tokens.every((body) => new URLSearchParams(body).get("refresh_token") === before), true);
	assert.equal(await grantRefresh(db, userId), before);
	assert.equal(REMOVAL_PERMISSION_DELAYS_MS.reduce((sum, delay) => sum + delay, 0), REMOVAL_PERMISSION_WINDOW_MS);
});

test("forgetting an inbox drops the row and does not call Cloudflare", async (t) => {
	const db = openDb();
	const userId = await seed(db, "inbox", "workers");
	const api = cloudflareApi({});
	t.after(api.restore);
	await walk(db, userId, "verify");
	const row = await readCloudflareInbox(db, userId);
	assert.ok(row?.id);
	const before = api.calls.length;
	assert.equal(await deleteCloudflareInbox(db, userId, row!.id), true);
	assert.equal(api.calls.length, before);
	assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM cloudflare_inbox").first<{ n: number }>())?.n, 0);
});
