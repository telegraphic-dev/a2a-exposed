import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { createTenant } from "../src/tenants/create.ts";
import { deleteTenant } from "../src/tenants/delete.ts";
import { dataPlaneFromEnv, deliverOutbox, type DataPlane, type OutboxRow, type TenantPush } from "../src/tenants/push.ts";
import { openDb } from "./sql.ts";

const secret = "test-secret-test-secret-test-secret";
const origin = "https://control.example.com";

function plane(fail: "none" | "storage" | "push" = "none") {
	const pushes: TenantPush[] = [];
	const directory: { name: string; status: string; version: number }[] = [];
	const removed: string[] = [];
	const wiped: string[] = [];
	let storageCalls = 0;
	const data: DataPlane = {
		async putDirectory(name, entry) {
			directory.push({ name, status: entry.status, version: entry.version });
		},
		async pushConfig(body) {
			pushes.push(body);
			if (fail === "push" && body.status === "deleting" && pushes.filter((push) => push.status === "deleting").length === 1) {
				throw new Error("push down");
			}
			return { version: body.version, applied: true };
		},
		async owner() {
			return { status: 200, body: { configured: false, hasKey: false, request: null } };
		},
		async deleteDirectory(name) {
			removed.push(name);
		},
		async deleteStorage(tenantId) {
			storageCalls += 1;
			if (fail === "storage" && storageCalls === 1) throw new Error("storage down");
			wiped.push(tenantId);
		},
	};
	return { data, pushes, directory, removed, wiped };
}

async function signIn(app: ReturnType<typeof createApp>, sent: { text: string }[]) {
	const posted = await app.request(`${origin}/app/sign-in`, {
		method: "POST",
		headers: { origin, "content-type": "application/x-www-form-urlencoded" },
		body: "provider=email&email=person@example.com",
	});
	assert.equal(posted.status, 303);
	const link = sent[0].text.match(/https:\/\/control\.example\.com\/api\/auth\/magic-link\/verify\?[^\s]+/);
	assert.ok(link);
	const verified = await app.request(link[0]);
	return verified.headers.getSetCookie().find((value) => value.startsWith("__Host-a2a_session="))!.split(";")[0];
}

async function ageSession(db: ReturnType<typeof openDb>) {
	const session = await db.prepare("SELECT id, createdAt FROM session").first<{ id: string; createdAt: string | number }>();
	assert.ok(session);
	const staleAt = new Date(new Date(session!.createdAt).getTime() - 11 * 60 * 1000);
	const stored = typeof session!.createdAt === "number" ? staleAt.getTime() : staleAt.toISOString();
	await db.prepare("UPDATE session SET createdAt = ? WHERE id = ?").bind(stored, session!.id).run();
}

test("the agent page deletes an agent after the name is typed", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const target = plane();
	const lines: string[] = [];
	const original = console.log;
	console.log = (...args: unknown[]) => { lines.push(args.map((part) => String(part)).join(" ")); };
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com", FREE_AGENT_LIMIT: "1" },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } }, dataPlane: target.data },
	);
	try {
		const cookie = await signIn(app, sent);
		const headers = { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
		const created = await app.request(`${origin}/api/v1/tenants`, { method: "POST", headers, body: "name=Northwind" });
		assert.equal(created.status, 303);
		const fresh = await (await app.request(`${origin}/app/agents/northwind`, { headers: { cookie } })).text();
		assert.match(fresh, /inbox data, peers, MCP connectors, and wake settings/);
		assert.match(fresh, /npx a2a-exposed export/);
		assert.match(fresh, /name="action" value="delete-agent"/);
		assert.equal(fresh.includes("Sign in again"), false);
		assert.equal(fresh.includes('name="agent-name"'), false);

		const ask = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=delete-agent" });
		assert.match(ask.headers.get("location") ?? "", /confirm-delete=1$/);
		assert.equal(target.wiped.length, 0);
		const confirm = await (await app.request(ask.headers.get("location") ?? "", { headers: { cookie } })).text();
		assert.match(confirm, /Type <strong>northwind<\/strong> to delete this agent\./);
		assert.match(confirm, /name="agent-name"/);

		const wrong = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=delete-agent&agent-name=other" });
		assert.match(wrong.headers.get("location") ?? "", /delete=name/);
		assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM tenants").first<{ n: number }>())?.n, 1);

		const cross = await app.request(`${origin}/app/agents/northwind`, {
			method: "POST",
			headers: { cookie, origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/x-www-form-urlencoded" },
			body: "action=delete-agent&agent-name=northwind",
		});
		assert.match(cross.headers.get("location") ?? "", /error=origin$/);
		assert.equal(target.wiped.length, 0);

		const bearer = await app.request(`${origin}/app/agents/northwind`, {
			method: "POST",
			headers: { authorization: "Bearer cli-session", origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
			body: "action=delete-agent&agent-name=northwind",
		});
		assert.match(bearer.headers.get("location") ?? "", /\/app$/);
		assert.equal(target.wiped.length, 0);

		const removed = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=delete-agent&agent-name=northwind" });
		assert.equal(removed.status, 303);
		assert.match(removed.headers.get("location") ?? "", /\/app\?deleted=1$/);
		assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM tenants").first<{ n: number }>())?.n, 0);
		assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM config_outbox").first<{ n: number }>())?.n, 0);
		assert.equal(target.removed.length, 0);
		assert.deepEqual(target.directory.at(-1), { name: "northwind", status: "deleted", version: target.directory.at(-2)?.version });
		assert.equal(target.directory.at(-2)?.status, "deleting");
		assert.equal(target.wiped.length, 1);
		assert.equal(target.pushes.at(-1)?.status, "deleting");
		assert.match(lines.find((line) => line.includes("agent_deleted")) ?? "", /"event":"dashboard_decision"/);
		const home = await (await app.request(`${origin}/app?deleted=1`, { headers: { cookie } })).text();
		assert.match(home, /That agent was deleted/);
		assert.equal(home.includes("northwind"), false);

		const again = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=delete-agent&agent-name=northwind" });
		assert.match(again.headers.get("location") ?? "", /\/app\?deleted=1$/);
		const missing = await app.request(`${origin}/app/agents/northwind`, { headers: { cookie } });
		assert.equal(missing.status, 404);

		const capped = await app.request(`${origin}/api/v1/tenants`, { method: "POST", headers, body: "name=eastwind" });
		assert.equal(capped.status, 303);
		assert.equal((await db.prepare("SELECT name FROM tenants").first<{ name: string }>())?.name, "eastwind");
	} finally {
		console.log = original;
	}
});

test("a failed delete leaves the agent and a retry finishes it", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const target = plane("storage");
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com", FREE_AGENT_LIMIT: "1" },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } }, dataPlane: target.data },
	);
	const cookie = await signIn(app, sent);
	const headers = { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
	assert.equal((await app.request(`${origin}/api/v1/tenants`, { method: "POST", headers, body: "name=northwind" })).status, 303);
	const failed = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=delete-agent&agent-name=northwind" });
	assert.match(failed.headers.get("location") ?? "", /delete=failed/);
	const row = await db.prepare("SELECT status FROM tenants WHERE name = ?").bind("northwind").first<{ status: string }>();
	assert.equal(row?.status, "deleting");
	assert.equal(target.directory.some((entry) => entry.status === "deleted"), false);
	assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM config_outbox").first<{ n: number }>())?.n, 0);
	const blocked = await app.request(`${origin}/api/v1/tenants`, { method: "POST", headers, body: "name=eastwind" });
	assert.match(blocked.headers.get("location") ?? "", /error=limit/);
	const retried = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=delete-agent&agent-name=northwind" });
	assert.match(retried.headers.get("location") ?? "", /\/app\?deleted=1$/);
	assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM tenants").first<{ n: number }>())?.n, 0);
	assert.equal(target.wiped.length, 1);
	assert.equal(target.directory.at(-1)?.status, "deleted");
	const freed = await app.request(`${origin}/api/v1/tenants`, { method: "POST", headers, body: "name=eastwind" });
	assert.equal(freed.status, 303);
});

test("a push that fails does not remove the agent", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const target = plane("push");
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com" },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } }, dataPlane: target.data },
	);
	const cookie = await signIn(app, sent);
	const headers = { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
	assert.equal((await app.request(`${origin}/api/v1/tenants`, { method: "POST", headers, body: "name=northwind" })).status, 303);
	const failed = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=delete-agent&agent-name=northwind" });
	assert.match(failed.headers.get("location") ?? "", /delete=failed/);
	assert.equal(target.wiped.length, 0);
	assert.equal(target.removed.length, 0);
	assert.equal(target.directory.some((entry) => entry.status === "deleted"), false);
	const row = await db.prepare("SELECT status FROM tenants WHERE name = ?").bind("northwind").first<{ status: string }>();
	assert.equal(row?.status, "deleting");
});

test("an old sign-in is named on the agent page before a destructive post", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const target = plane();
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com" },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } }, dataPlane: target.data },
	);
	const cookie = await signIn(app, sent);
	const headers = { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
	assert.equal((await app.request(`${origin}/api/v1/tenants`, { method: "POST", headers, body: "name=northwind" })).status, 303);
	await ageSession(db);
	const page = await (await app.request(`${origin}/app/agents/northwind`, { headers: { cookie } })).text();
	assert.match(page, /Your sign-in is older than 10 minutes\./);
	assert.match(page, /href="\/app\/sign-in\?return=%2Fapp%2Fagents%2Fnorthwind"/);
	assert.match(page, /Sign in again/);
	assert.match(page, /before you approve, deny, revoke, rotate, or delete/);
	const stale = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=delete-agent&agent-name=northwind" });
	assert.match(stale.headers.get("location") ?? "", /\/app\?error=reauth$/);
	assert.equal(target.wiped.length, 0);

	const signInPage = await (await app.request(`${origin}/app/sign-in?return=/app/agents/northwind`)).text();
	assert.match(signInPage, /name="next" value="\/app\/agents\/northwind"/);
	const evil = await (await app.request(`${origin}/app/sign-in?return=https://evil.example`)).text();
	assert.equal(evil.includes("evil.example"), false);
	assert.equal(evil.includes('name="next"'), false);
});

test("sign-in from the agent page returns to that page", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } } },
	);
	const posted = await app.request(`${origin}/app/sign-in`, {
		method: "POST",
		headers: { origin, "content-type": "application/x-www-form-urlencoded" },
		body: "provider=email&email=person@example.com&next=/app/agents/northwind",
	});
	assert.equal(posted.status, 303);
	const link = sent[0].text.match(/https:\/\/control\.example\.com\/api\/auth\/magic-link\/verify\?[^\s]+/);
	assert.ok(link);
	assert.equal(new URL(link[0]).searchParams.get("callbackURL"), "/app/agents/northwind");
	const verified = await app.request(link[0]);
	assert.match(verified.headers.get("location") ?? "", /\/app\/agents\/northwind$/);
	const rejected = await app.request(`${origin}/app/sign-in`, {
		method: "POST",
		headers: { origin, "content-type": "application/x-www-form-urlencoded" },
		body: "provider=email&email=person@example.com&next=https://evil.example/app/agents/northwind",
	});
	assert.equal(rejected.status, 303);
	const bad = sent[1].text.match(/https:\/\/control\.example\.com\/api\/auth\/magic-link\/verify\?[^\s]+/);
	assert.ok(bad);
	assert.equal(new URL(bad[0]).searchParams.get("callbackURL"), "/app");
});

function kvPlane() {
	const store = new Map<string, string>();
	const pushes: TenantPush[] = [];
	const wiped: string[] = [];
	let onActive: (() => Promise<void>) | null = null;
	const kv = {
		async get(key: string) {
			const raw = store.get(key);
			return raw ? JSON.parse(raw) as unknown : null;
		},
		async put(key: string, value: string) { store.set(key, value); },
		async delete(key: string) { store.delete(key); },
	};
	const objects = {
		idFromName(name: string) { return name; },
		get(id: unknown) {
			return {
				async pushConfig(body: TenantPush) {
					if (onActive && body.status === "active") await onActive();
					pushes.push(body);
					return { version: body.version, applied: true };
				},
				async deleteStorage() { wiped.push(String(id)); },
			};
		},
	};
	const plane = dataPlaneFromEnv({ TENANT_DIRECTORY: kv, TENANT_DO: objects });
	if (!plane) throw new Error("data plane");
	return {
		plane, pushes, wiped,
		holdActive(fn: () => Promise<void>) { onActive = fn; },
		entry(name: string) {
			const raw = store.get(`tenant:${name}`);
			return raw ? JSON.parse(raw) as { id: string; status: string; version: number } : null;
		},
	};
}

async function staleRow(db: ReturnType<typeof openDb>, name: string): Promise<OutboxRow> {
	const stored = await db.prepare(
		`SELECT id, name, status, region, config_json, limits_json, approval_json, owner_token_hash, secrets_enc, config_version, created_at
		 FROM tenants WHERE name = ?`,
	).bind(name).first<OutboxRow & { config_version: number }>();
	if (!stored) throw new Error("missing tenant");
	return { ...stored, version: stored.config_version };
}

test("a flush that already loaded the agent does not write it back after delete", async () => {
	const db = openDb();
	const target = kvPlane();
	const created = await createTenant(db, target.plane, { accountId: "acct", name: "northwind" });
	assert.equal(created.ok, true);
	if (!created.ok) return;
	const stale = await staleRow(db, "northwind");
	let release!: () => void;
	const hold = new Promise<void>((resolve) => { release = resolve; });
	let entered!: () => void;
	const saw = new Promise<void>((resolve) => { entered = resolve; });
	const delivery = deliverOutbox(db, target.plane, stale, async () => {
		entered();
		await hold;
	});
	await saw;
	const pushesAtDelete = target.pushes.length;
	const removed = await deleteTenant(db, target.plane, { accountId: "acct", name: "northwind" });
	assert.equal(removed.ok, true);
	assert.equal(target.entry("northwind")?.status, "deleted");
	assert.equal(target.entry("northwind")?.id, created.tenant.id);
	const pushesAfterDelete = target.pushes.length;
	assert.ok(pushesAfterDelete > pushesAtDelete);
	release();
	assert.equal(await delivery, true);
	assert.equal(target.pushes.length, pushesAfterDelete);
	assert.equal(target.entry("northwind")?.status, "deleted");
	assert.equal(target.entry("northwind")?.id, created.tenant.id);
	assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM tenants").first<{ n: number }>())?.n, 0);

	const reused = await createTenant(db, target.plane, { accountId: "acct", name: "northwind" });
	assert.equal(reused.ok, true);
	if (!reused.ok) return;
	assert.notEqual(reused.tenant.id, created.tenant.id);
	assert.equal(target.entry("northwind")?.id, reused.tenant.id);
	assert.equal(target.entry("northwind")?.status, "active");
	const afterReuse = target.pushes.length;
	assert.equal(await deliverOutbox(db, target.plane, stale), true);
	assert.equal(target.pushes.length, afterReuse);
	assert.equal(target.entry("northwind")?.id, reused.tenant.id);
	assert.equal(target.entry("northwind")?.status, "active");
});

test("delete waits until an in-flight delivery finishes, then the hostname stays deleted", async () => {
	const db = openDb();
	const target = kvPlane();
	const created = await createTenant(db, target.plane, { accountId: "acct", name: "northwind" });
	assert.equal(created.ok, true);
	const stale = await staleRow(db, "northwind");
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let entered!: () => void;
	const saw = new Promise<void>((resolve) => { entered = resolve; });
	target.holdActive(async () => {
		entered();
		await gate;
	});
	const delivery = deliverOutbox(db, target.plane, stale);
	await saw;
	let settled = false;
	const deleting = deleteTenant(db, target.plane, { accountId: "acct", name: "northwind" }).then((result) => {
		settled = true;
		return result;
	});
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(settled, false);
	assert.equal(target.wiped.length, 0);
	release();
	assert.equal((await deleting).ok, true);
	assert.equal(await delivery, true);
	assert.equal(target.wiped.length, 1);
	assert.equal(target.entry("northwind")?.status, "deleted");
	assert.equal(target.entry("northwind")?.id, created.ok ? created.tenant.id : "");
});
