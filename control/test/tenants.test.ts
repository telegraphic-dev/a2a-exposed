import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { dataPlaneFromEnv, flushOutbox, type DataPlane, type TenantPush } from "../src/tenants/push.ts";
import { openDb } from "./sql.ts";

const secret = "test-secret-test-secret-test-secret";

function plane() {
	const directory = new Map<string, { id: string; status: string; region: string; version: number }>();
	const pushes: { body: TenantPush; region: string }[] = [];
	let fail = false;
	const data: DataPlane = {
		async putDirectory(name, entry) {
			const current = directory.get(name);
			if (current && current.version > entry.version) return;
			directory.set(name, entry);
		},
		async pushConfig(body, region) {
			if (fail) throw new Error("plane down");
			pushes.push({ body, region });
			return { version: body.version, applied: true };
		},
	};
	return { directory, pushes, data, setFail(next: boolean) { fail = next; } };
}

test("tenants stay closed until login and the data plane are both configured", async () => {
	const app = createApp({ AUTH_SECRET: secret, DB: openDb() }, { mailer: { async send() {} } });
	const response = await app.request("https://control.example.com/api/v1/tenants", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "northwind" }),
	});
	assert.equal(response.status, 404);
});

test("create writes the directory and the object, and the token is shown once", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const target = plane();
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com", DATA_REGION: "eu" },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } }, dataPlane: target.data },
	);
	const posted = await app.request("https://control.example.com/app/sign-in", {
		method: "POST",
		headers: { origin: "https://control.example.com", "content-type": "application/x-www-form-urlencoded" },
		body: "provider=email&email=person@example.com",
	});
	assert.equal(posted.status, 303);
	const link = sent[0].text.match(/https:\/\/control\.example\.com\/api\/auth\/magic-link\/verify\?[^\s]+/);
	assert.ok(link);
	const verified = await app.request(link[0]);
	const cookie = verified.headers.getSetCookie().find((value) => value.startsWith("__Host-a2a_session="));
	assert.ok(cookie);

	const unauth = await app.request("https://control.example.com/api/v1/tenants", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "northwind" }),
	});
	assert.equal(unauth.status, 401);

	const reserved = await app.request("https://control.example.com/api/v1/tenants", {
		method: "POST",
		headers: { cookie: cookie.split(";")[0], "content-type": "application/json" },
		body: JSON.stringify({ name: "admin" }),
	});
	assert.equal(reserved.status, 400);

	const created = await app.request("https://control.example.com/api/v1/tenants", {
		method: "POST",
		headers: { cookie: cookie.split(";")[0], "content-type": "application/json" },
		body: JSON.stringify({ name: "Northwind" }),
	});
	assert.equal(created.status, 201);
	assert.equal(created.headers.get("x-robots-tag"), "noindex");
	const body = await created.json() as { tenant: string; public_url: string; owner_token: string; pushed: boolean; region: string };
	assert.equal(body.tenant, "northwind");
	assert.equal(body.public_url, "https://northwind.example.com");
	assert.equal(body.region, "eu");
	assert.equal(body.pushed, true);
	assert.match(body.owner_token, /^a2aot_/);
	assert.equal(target.directory.get("northwind")?.region, "eu");
	assert.equal(target.pushes.length, 1);
	assert.equal(target.pushes[0].region, "eu");
	assert.equal(target.pushes[0].body.name, "northwind");
	assert.equal(target.pushes[0].body.version, 1);
	assert.equal(target.pushes[0].body.ownerTokenHash.length, 64);
	assert.equal(JSON.stringify(target.pushes[0]).includes(body.owner_token), false);

	const again = await app.request("https://control.example.com/api/v1/tenants", {
		method: "POST",
		headers: { cookie: cookie.split(";")[0], "content-type": "application/json" },
		body: JSON.stringify({ name: "northwind" }),
	});
	assert.equal(again.status, 409);

	const list = await app.request("https://control.example.com/api/v1/tenants", { headers: { cookie: cookie.split(";")[0] } });
	const listed = await list.json() as { tenants: { name: string; public_url: string | null }[] };
	assert.equal(listed.tenants.length, 1);
	assert.equal(listed.tenants[0].name, "northwind");
	assert.equal(listed.tenants[0].public_url, "https://northwind.example.com");
	assert.equal(JSON.stringify(listed).includes(body.owner_token), false);
	assert.equal(JSON.stringify(listed).includes("owner_token"), false);
});

test("a failed push stays in the outbox and a later flush delivers it", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const target = plane();
	target.setFail(true);
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } }, dataPlane: target.data },
	);
	const posted = await app.request("https://control.example.com/app/sign-in", {
		method: "POST",
		headers: { origin: "https://control.example.com", "content-type": "application/x-www-form-urlencoded" },
		body: "provider=email&email=person@example.com",
	});
	assert.equal(posted.status, 303);
	const link = sent[0].text.match(/https:\/\/control\.example\.com\/api\/auth\/magic-link\/verify\?[^\s]+/);
	assert.ok(link);
	const verified = await app.request(link[0]);
	const cookie = verified.headers.getSetCookie().find((value) => value.startsWith("__Host-a2a_session="))!.split(";")[0];
	const created = await app.request("https://control.example.com/api/v1/tenants", {
		method: "POST",
		headers: { cookie, "content-type": "application/json" },
		body: JSON.stringify({ name: "northwind" }),
	});
	const body = await created.json() as { pushed: boolean; owner_token: string };
	assert.equal(created.status, 201);
	assert.equal(body.pushed, false);
	assert.match(body.owner_token, /^a2aot_/);
	assert.equal(target.pushes.length, 0);
	target.setFail(false);
	const flushed = await flushOutbox(db, target.data, Date.parse("2099-01-01T00:00:00.000Z"));
	assert.equal(flushed.delivered, 1);
	assert.equal(flushed.pending, 0);
	assert.equal(target.pushes.length, 1);
	assert.equal(target.directory.get("northwind")?.region, "default");
});

test("eu and fedramp select a jurisdiction and default stays on the namespace", async () => {
	const seen: string[] = [];
	const stub = {
		idFromName(name: string) { return name; },
		get(id: unknown) {
			seen.push(`get:${String(id)}`);
			return { async pushConfig(body: TenantPush) { return { version: body.version, applied: true }; } };
		},
		jurisdiction(location: string) {
			seen.push(`jurisdiction:${location}`);
			return this;
		},
	};
	const kv = { async get() { return null; }, async put() {} };
	const bound = dataPlaneFromEnv({ TENANT_DIRECTORY: kv, TENANT_DO: stub });
	assert.ok(bound);
	const body: TenantPush = {
		version: 1, tenantId: "t1", name: "northwind", status: "active",
		config: {}, limits: {}, approval: {}, ownerTokenHash: "ab", secretsEnc: null,
	};
	await bound.pushConfig(body, "eu");
	await bound.pushConfig({ ...body, version: 2 }, "fedramp");
	await bound.pushConfig({ ...body, version: 3 }, "default");
	assert.deepEqual(seen, ["jurisdiction:eu", "get:t1", "jurisdiction:fedramp", "get:t1", "get:t1"]);
});

test("a directory write does not roll a newer version backwards", async () => {
	const versions: number[] = [];
	const kv = {
		async get() { return { version: 4 }; },
		async put(_key: string, value: string) { versions.push(JSON.parse(value).version); },
	};
	const objects = {
		idFromName(name: string) { return name; },
		get() { return { async pushConfig(body: TenantPush) { return { version: body.version, applied: true }; } }; },
	};
	const bound = dataPlaneFromEnv({ TENANT_DIRECTORY: kv, TENANT_DO: objects });
	assert.ok(bound);
	await bound.putDirectory("northwind", { id: "t1", status: "active", region: "default", version: 2 });
	assert.deepEqual(versions, []);
	await bound.putDirectory("northwind", { id: "t1", status: "active", region: "default", version: 5 });
	assert.deepEqual(versions, [5]);
});
