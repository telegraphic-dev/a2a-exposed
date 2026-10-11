import { test } from "node:test";
import assert from "node:assert/strict";
import { OWNER_COOKIE } from "../src/auth/cookies.ts";
import { createApp } from "../src/app.ts";
import type { DataPlane, TenantPush } from "../src/tenants/push.ts";
import { openDb } from "./sql.ts";

const secret = "test-secret-test-secret-test-secret";
const origin = "https://control.example.com";

function plane(mode: "apply" | "refuse" | "raced" | "retry" | "throw" | "down" | "landed" = "apply") {
	const pushes: TenantPush[] = [];
	const directory: { name: string; version: number }[] = [];
	let retried = false;
	const data: DataPlane = {
		async putDirectory(name, entry) {
			directory.push({ name, version: entry.version });
		},
		async pushConfig(body) {
			pushes.push(body);
			if (mode === "retry" && body.version > 1 && !retried) {
				retried = true;
				throw new Error("push down");
			}
			if (mode === "throw" && body.version === 2) throw new Error("push down");
			if (mode === "down" && body.version > 1) throw new Error("push down");
			if (mode === "refuse" && body.version === 2) return { version: 1, applied: false };
			if (mode === "landed" && body.version === 2 && pushes.filter((push) => push.version === 2).length === 1) return { version: 1, applied: false };
			if (mode === "landed" && body.version === 2) return { version: body.version, applied: false };
			if (mode === "raced" && body.version > 1) return { version: body.version, applied: false };
			return { version: body.version, applied: true };
		},
		async owner() {
			return { status: 200, body: { configured: false, hasKey: false, request: null } };
		},
	};
	return { data, pushes, directory };
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

function cookieValue(header: string): string {
	const raw = header.split(";")[0]?.slice(`${OWNER_COOKIE}=`.length) ?? "";
	return decodeURIComponent(raw);
}

test("the agent page rotates the owner token once after confirmation", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const target = plane();
	const lines: string[] = [];
	const original = console.log;
	console.log = (...args: unknown[]) => { lines.push(args.map((part) => String(part)).join(" ")); };
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com" },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } }, dataPlane: target.data },
	);
	try {
		const cookie = await signIn(app, sent);
		const headers = { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
		const created = await app.request(`${origin}/api/v1/tenants`, { method: "POST", headers, body: "name=Northwind" });
		assert.equal(created.status, 303);
		const before = await db.prepare("SELECT owner_token_hash, config_version FROM tenants WHERE name = ?").bind("northwind").first<{ owner_token_hash: string; config_version: number }>();
		assert.equal(before?.config_version, 1);
		assert.equal(target.pushes[0]?.ownerTokenHash, before?.owner_token_hash);

		const first = await (await app.request(`${origin}/app/agents/northwind`, { headers: { cookie } })).text();
		assert.match(first, /name="action" value="rotate-token"/);
		assert.equal(first.includes('name="confirm"'), false);
		const ask = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=rotate-token" });
		assert.match(ask.headers.get("location") ?? "", /confirm-token=1$/);
		assert.equal(target.pushes.length, 1);
		const confirm = await (await app.request(ask.headers.get("location") ?? "", { headers: { cookie } })).text();
		assert.match(confirm, /Rotate the owner token\?/);
		assert.match(confirm, /name="confirm" value="1"/);

		const cross = await app.request(`${origin}/app/agents/northwind`, {
			method: "POST",
			headers: { cookie, origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/x-www-form-urlencoded" },
			body: "action=rotate-token&confirm=1",
		});
		assert.match(cross.headers.get("location") ?? "", /error=origin$/);
		assert.equal(target.pushes.length, 1);

		const bearer = await app.request(`${origin}/app/agents/northwind`, {
			method: "POST",
			headers: { authorization: "Bearer cli-session", origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
			body: "action=rotate-token&confirm=1",
		});
		assert.match(bearer.headers.get("location") ?? "", /\/app$/);
		assert.equal(target.pushes.length, 1);

		const rotated = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=rotate-token&confirm=1" });
		assert.equal(rotated.status, 303);
		assert.equal((rotated.headers.get("location") ?? "").includes("a2aot_"), false);
		const set = rotated.headers.getSetCookie().find((value) => value.startsWith(`${OWNER_COOKIE}=`));
		assert.ok(set);
		const packed = cookieValue(set!);
		assert.match(packed, /^northwind\.a2aot_[A-Za-z0-9_-]{43}$/);
		const token = packed.slice("northwind.".length);
		assert.match(set!, /Max-Age=120/);
		assert.match(set!, /Path=\//);
		assert.match(set!, /HttpOnly/);
		assert.match(set!, /Secure/);
		assert.match(set!, /SameSite=Lax/);
		assert.equal(/domain=/i.test(set!), false);
		const after = await db.prepare("SELECT owner_token_hash, config_version FROM tenants WHERE name = ?").bind("northwind").first<{ owner_token_hash: string; config_version: number }>();
		assert.equal(after?.config_version, 2);
		assert.notEqual(after?.owner_token_hash, before?.owner_token_hash);
		assert.equal(target.pushes.at(-1)?.ownerTokenHash, after?.owner_token_hash);
		assert.equal(target.pushes.at(-1)?.version, 2);
		assert.deepEqual(target.directory.at(-1), { name: "northwind", version: 2 });
		assert.equal(JSON.stringify(target.pushes).includes(token), false);
		assert.equal(lines.some((line) => line.includes(token)), false);
		assert.match(lines.find((line) => line.includes("owner_token_rotated")) ?? "", /"event":"owner_token_rotated"/);

		const shown = await app.request(`${origin}/app/agents/northwind`, { headers: { cookie: `${cookie}; ${OWNER_COOKIE}=${encodeURIComponent(packed)}` } });
		const html = await shown.text();
		assert.match(html, /Copy this owner token now/);
		assert.match(html, new RegExp(token));
		assert.match(html, /src="\/owner-token\.js"/);
		assert.match(shown.headers.get("content-security-policy") ?? "", /script-src 'self'/);
		assert.match(shown.headers.get("cache-control") ?? "", /no-store/);
		assert.match(shown.headers.get("set-cookie") ?? "", new RegExp(`${OWNER_COOKIE}=`));
		assert.match(shown.headers.get("set-cookie") ?? "", /Max-Age=0/);
		const again = await (await app.request(`${origin}/app/agents/northwind`, { headers: { cookie } })).text();
		assert.equal(again.includes(token), false);

		const session = await db.prepare("SELECT id, createdAt FROM session").first<{ id: string; createdAt: string | number }>();
		assert.ok(session);
		const staleAt = new Date(new Date(session!.createdAt).getTime() - 11 * 60 * 1000);
		const stored = typeof session!.createdAt === "number" ? staleAt.getTime() : staleAt.toISOString();
		await db.prepare("UPDATE session SET createdAt = ? WHERE id = ?").bind(stored, session!.id).run();
		const pushes = target.pushes.length;
		const stale = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=rotate-token&confirm=1" });
		assert.match(stale.headers.get("location") ?? "", /\/app\?error=reauth$/);
		assert.equal(target.pushes.length, pushes);
		assert.equal(lines.some((line) => line.includes("dashboard_reauth") && line.includes("rotate-token") && !line.includes(token)), true);
	} finally {
		console.log = original;
	}
});

test("a push that does not apply keeps the previous owner token", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const target = plane("refuse");
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com" },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } }, dataPlane: target.data },
	);
	const cookie = await signIn(app, sent);
	const headers = { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
	assert.equal((await app.request(`${origin}/api/v1/tenants`, { method: "POST", headers, body: "name=Northwind" })).status, 303);
	const before = await db.prepare("SELECT owner_token_hash, config_version FROM tenants WHERE name = ?").bind("northwind").first<{ owner_token_hash: string; config_version: number }>();
	const rotated = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=rotate-token&confirm=1" });
	assert.match(rotated.headers.get("location") ?? "", /token=failed$/);
	assert.equal(rotated.headers.getSetCookie().some((value) => value.startsWith(`${OWNER_COOKIE}=`) && !value.includes("Max-Age=0")), false);
	const after = await db.prepare("SELECT owner_token_hash, config_version FROM tenants WHERE name = ?").bind("northwind").first<{ owner_token_hash: string; config_version: number }>();
	assert.equal(after?.owner_token_hash, before?.owner_token_hash);
	assert.equal(after?.config_version, 3);
	assert.equal(target.pushes.at(-1)?.version, 3);
	assert.equal(target.pushes.at(-1)?.ownerTokenHash, before?.owner_token_hash);
	assert.equal(target.pushes.filter((body) => body.version === 2).every((body) => body.ownerTokenHash !== before?.owner_token_hash), true);
	const html = await (await app.request(rotated.headers.get("location") ?? "", { headers: { cookie } })).text();
	assert.match(html, /The owner token was not rotated/);
	assert.equal(html.includes("a2aot_"), false);
	const pending = await db.prepare("SELECT COUNT(*) AS n FROM config_outbox").first<{ n: number }>();
	assert.equal(Number(pending?.n), 0);
	assert.deepEqual(target.directory, [{ name: "northwind", version: 1 }, { name: "northwind", version: 3 }]);
});

test("a flush that stores the new hash after a low version is shown, not rolled back", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const target = plane("landed");
	let exposed = 0;
	const push = target.data.pushConfig.bind(target.data);
	target.data.pushConfig = async (body, region) => {
		if (body.version === 2) {
			const pending = await db.prepare("SELECT COUNT(*) AS n FROM config_outbox WHERE version = ?").bind(2).first<{ n: number }>();
			exposed += Number(pending?.n ?? 0);
		}
		return push(body, region);
	};
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com" },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } }, dataPlane: target.data },
	);
	const cookie = await signIn(app, sent);
	const headers = { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
	assert.equal((await app.request(`${origin}/api/v1/tenants`, { method: "POST", headers, body: "name=Northwind" })).status, 303);
	const before = await db.prepare("SELECT owner_token_hash FROM tenants WHERE name = ?").bind("northwind").first<{ owner_token_hash: string }>();
	const rotated = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=rotate-token&confirm=1" });
	assert.equal(rotated.status, 303);
	assert.match(cookieValue(rotated.headers.getSetCookie().find((value) => value.startsWith(`${OWNER_COOKIE}=`)) ?? ""), /^northwind\.a2aot_/);
	const after = await db.prepare("SELECT owner_token_hash, config_version FROM tenants WHERE name = ?").bind("northwind").first<{ owner_token_hash: string; config_version: number }>();
	assert.equal(after?.config_version, 2);
	assert.notEqual(after?.owner_token_hash, before?.owner_token_hash);
	assert.equal(target.pushes.some((body) => body.version === 3), false);
	assert.equal(exposed, 0);
	const pending = await db.prepare("SELECT COUNT(*) AS n FROM config_outbox").first<{ n: number }>();
	assert.equal(Number(pending?.n), 0);
});

test("a push that throws keeps the previous owner token", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const target = plane("throw");
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com" },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } }, dataPlane: target.data },
	);
	const cookie = await signIn(app, sent);
	const headers = { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
	assert.equal((await app.request(`${origin}/api/v1/tenants`, { method: "POST", headers, body: "name=Northwind" })).status, 303);
	const before = await db.prepare("SELECT owner_token_hash, config_version FROM tenants WHERE name = ?").bind("northwind").first<{ owner_token_hash: string; config_version: number }>();
	const rotated = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=rotate-token&confirm=1" });
	assert.match(rotated.headers.get("location") ?? "", /token=failed$/);
	assert.equal(rotated.headers.getSetCookie().some((value) => value.startsWith(`${OWNER_COOKIE}=`) && !value.includes("Max-Age=0")), false);
	const after = await db.prepare("SELECT owner_token_hash, config_version FROM tenants WHERE name = ?").bind("northwind").first<{ owner_token_hash: string; config_version: number }>();
	assert.equal(after?.owner_token_hash, before?.owner_token_hash);
	assert.equal(after?.config_version, 3);
	assert.equal(target.pushes.at(-1)?.version, 3);
	assert.equal(target.pushes.at(-1)?.ownerTokenHash, before?.owner_token_hash);
	const pending = await db.prepare("SELECT COUNT(*) AS n FROM config_outbox").first<{ n: number }>();
	assert.equal(Number(pending?.n), 0);
	assert.deepEqual(target.directory, [{ name: "northwind", version: 1 }, { name: "northwind", version: 3 }]);
});

test("a push the tenant already stored still shows the new token", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const target = plane("raced");
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com" },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } }, dataPlane: target.data },
	);
	const cookie = await signIn(app, sent);
	const headers = { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
	assert.equal((await app.request(`${origin}/api/v1/tenants`, { method: "POST", headers, body: "name=Northwind" })).status, 303);
	const before = await db.prepare("SELECT owner_token_hash, config_version FROM tenants WHERE name = ?").bind("northwind").first<{ owner_token_hash: string; config_version: number }>();
	const rotated = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=rotate-token&confirm=1" });
	assert.equal(rotated.status, 303);
	assert.match(rotated.headers.get("location") ?? "", /\/app\/agents\/northwind$/);
	const packed = cookieValue(rotated.headers.getSetCookie().find((value) => value.startsWith(`${OWNER_COOKIE}=`)) ?? "");
	assert.match(packed, /^northwind\.a2aot_/);
	const after = await db.prepare("SELECT owner_token_hash, config_version FROM tenants WHERE name = ?").bind("northwind").first<{ owner_token_hash: string; config_version: number }>();
	assert.equal(after?.config_version, 2);
	assert.notEqual(after?.owner_token_hash, before?.owner_token_hash);
	assert.equal(target.pushes.at(-1)?.ownerTokenHash, after?.owner_token_hash);
	const pending = await db.prepare("SELECT COUNT(*) AS n FROM config_outbox").first<{ n: number }>();
	assert.equal(Number(pending?.n), 0);
});

test("a lost push is sent again before the token is shown", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const target = plane("retry");
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com" },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } }, dataPlane: target.data },
	);
	const cookie = await signIn(app, sent);
	const headers = { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
	assert.equal((await app.request(`${origin}/api/v1/tenants`, { method: "POST", headers, body: "name=Northwind" })).status, 303);
	const rotated = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=rotate-token&confirm=1" });
	assert.equal(rotated.status, 303);
	assert.match(cookieValue(rotated.headers.getSetCookie().find((value) => value.startsWith(`${OWNER_COOKIE}=`)) ?? ""), /^northwind\.a2aot_/);
	const after = await db.prepare("SELECT config_version FROM tenants WHERE name = ?").bind("northwind").first<{ config_version: number }>();
	assert.equal(after?.config_version, 2);
	assert.equal(target.pushes.filter((body) => body.version === 2).length, 2);
});

test("a push that cannot be restored still returns the new token", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const target = plane("down");
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com" },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } }, dataPlane: target.data },
	);
	const cookie = await signIn(app, sent);
	const headers = { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
	assert.equal((await app.request(`${origin}/api/v1/tenants`, { method: "POST", headers, body: "name=Northwind" })).status, 303);
	const before = await db.prepare("SELECT owner_token_hash FROM tenants WHERE name = ?").bind("northwind").first<{ owner_token_hash: string }>();
	const rotated = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=rotate-token&confirm=1" });
	assert.equal(rotated.status, 303);
	const packed = cookieValue(rotated.headers.getSetCookie().find((value) => value.startsWith(`${OWNER_COOKIE}=`)) ?? "");
	assert.match(packed, /^northwind\.a2aot_/);
	const after = await db.prepare("SELECT owner_token_hash, config_version FROM tenants WHERE name = ?").bind("northwind").first<{ owner_token_hash: string; config_version: number }>();
	assert.equal(after?.config_version, 3);
	assert.notEqual(after?.owner_token_hash, before?.owner_token_hash);
	const pending = await db.prepare("SELECT COUNT(*) AS n FROM config_outbox").first<{ n: number }>();
	assert.equal(Number(pending?.n), 1);
});

test("the rotation cookie is shown only on that agent's page", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const target = plane();
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com" },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } }, dataPlane: target.data },
	);
	const cookie = await signIn(app, sent);
	const headers = { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
	assert.equal((await app.request(`${origin}/api/v1/tenants`, { method: "POST", headers, body: "name=Northwind" })).status, 303);
	assert.equal((await app.request(`${origin}/api/v1/tenants`, { method: "POST", headers, body: "name=Eastwind" })).status, 303);
	const rotated = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=rotate-token&confirm=1" });
	const packed = cookieValue(rotated.headers.getSetCookie().find((value) => value.startsWith(`${OWNER_COOKIE}=`)) ?? "");
	const token = packed.slice("northwind.".length);
	const withCookie = { cookie: `${cookie}; ${OWNER_COOKIE}=${encodeURIComponent(packed)}` };
	const east = await app.request(`${origin}/app/agents/eastwind`, { headers: withCookie });
	assert.equal((await east.text()).includes(token), false);
	assert.equal(east.headers.getSetCookie().some((value) => value.startsWith(`${OWNER_COOKIE}=`)), false);
	const home = await app.request(`${origin}/app`, { headers: withCookie });
	assert.equal((await home.text()).includes(token), false);
	assert.equal(home.headers.getSetCookie().some((value) => value.startsWith(`${OWNER_COOKIE}=`)), false);
	const shown = await (await app.request(`${origin}/app/agents/northwind`, { headers: withCookie })).text();
	assert.match(shown, new RegExp(token));
});

test("a later rotation is not shown this token", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const target = plane();
	const push = target.data.pushConfig.bind(target.data);
	target.data.pushConfig = async (body, region) => {
		if (body.version === 2) {
			await db.prepare("UPDATE tenants SET owner_token_hash = ?, config_version = ? WHERE name = ?").bind("later-rotation", 3, "northwind").run();
			target.pushes.push(body);
			return { version: 3, applied: false };
		}
		return push(body, region);
	};
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com" },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } }, dataPlane: target.data },
	);
	const cookie = await signIn(app, sent);
	const headers = { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
	assert.equal((await app.request(`${origin}/api/v1/tenants`, { method: "POST", headers, body: "name=Northwind" })).status, 303);
	const before = await db.prepare("SELECT owner_token_hash FROM tenants WHERE name = ?").bind("northwind").first<{ owner_token_hash: string }>();
	const rotated = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=rotate-token&confirm=1" });
	assert.match(rotated.headers.get("location") ?? "", /token=replaced$/);
	assert.equal(rotated.headers.getSetCookie().some((value) => value.startsWith(`${OWNER_COOKIE}=`) && !value.includes("Max-Age=0")), false);
	const after = await db.prepare("SELECT owner_token_hash, config_version FROM tenants WHERE name = ?").bind("northwind").first<{ owner_token_hash: string; config_version: number }>();
	assert.equal(after?.owner_token_hash, "later-rotation");
	assert.equal(after?.config_version, 3);
	assert.equal(target.pushes.some((body) => body.version > 2), false);
	assert.notEqual(target.pushes.find((body) => body.version === 2)?.ownerTokenHash, before?.owner_token_hash);
	const html = await (await app.request(rotated.headers.get("location") ?? "", { headers: { cookie } })).text();
	assert.match(html, /A later rotation replaced this token/);
	assert.equal(html.includes("a2aot_"), false);
	const pending = await db.prepare("SELECT COUNT(*) AS n FROM config_outbox").first<{ n: number }>();
	assert.equal(Number(pending?.n), 0);
});

test("a newer config version that still has this hash shows the token", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const target = plane();
	const push = target.data.pushConfig.bind(target.data);
	target.data.pushConfig = async (body, region) => {
		if (body.version === 2) {
			await db.prepare("UPDATE tenants SET config_version = ? WHERE name = ?").bind(4, "northwind").run();
			target.pushes.push(body);
			return { version: 4, applied: false };
		}
		return push(body, region);
	};
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com" },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } }, dataPlane: target.data },
	);
	const cookie = await signIn(app, sent);
	const headers = { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
	assert.equal((await app.request(`${origin}/api/v1/tenants`, { method: "POST", headers, body: "name=Northwind" })).status, 303);
	const before = await db.prepare("SELECT owner_token_hash FROM tenants WHERE name = ?").bind("northwind").first<{ owner_token_hash: string }>();
	const rotated = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=rotate-token&confirm=1" });
	assert.equal(rotated.status, 303);
	assert.match(cookieValue(rotated.headers.getSetCookie().find((value) => value.startsWith(`${OWNER_COOKIE}=`)) ?? ""), /^northwind\.a2aot_/);
	const after = await db.prepare("SELECT owner_token_hash, config_version FROM tenants WHERE name = ?").bind("northwind").first<{ owner_token_hash: string; config_version: number }>();
	assert.equal(after?.config_version, 4);
	assert.notEqual(after?.owner_token_hash, before?.owner_token_hash);
	assert.equal(target.pushes.some((body) => body.version > 2), false);
});

test("a low version after a later rotation does not restore the previous hash", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const target = plane();
	let attempts = 0;
	target.data.pushConfig = async (body) => {
		if (body.version === 2) {
			attempts += 1;
			if (attempts === 1) {
				await db.prepare("UPDATE tenants SET owner_token_hash = ?, config_version = ? WHERE name = ?").bind("later-rotation", 5, "northwind").run();
			}
			target.pushes.push(body);
			return { version: 1, applied: false };
		}
		target.pushes.push(body);
		return { version: body.version, applied: true };
	};
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com" },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } }, dataPlane: target.data },
	);
	const cookie = await signIn(app, sent);
	const headers = { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
	assert.equal((await app.request(`${origin}/api/v1/tenants`, { method: "POST", headers, body: "name=Northwind" })).status, 303);
	const before = await db.prepare("SELECT owner_token_hash FROM tenants WHERE name = ?").bind("northwind").first<{ owner_token_hash: string }>();
	const rotated = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=rotate-token&confirm=1" });
	assert.match(rotated.headers.get("location") ?? "", /token=replaced$/);
	const after = await db.prepare("SELECT owner_token_hash, config_version FROM tenants WHERE name = ?").bind("northwind").first<{ owner_token_hash: string; config_version: number }>();
	assert.equal(after?.owner_token_hash, "later-rotation");
	assert.equal(after?.config_version, 5);
	assert.equal(target.pushes.some((body) => body.ownerTokenHash === before?.owner_token_hash && body.version > 1), false);
	assert.equal(rotated.headers.getSetCookie().some((value) => value.includes("a2aot_")), false);
});

test("a restore reserves its version before another rotation can take it", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const target = plane("refuse");
	const push = target.data.pushConfig.bind(target.data);
	let reserved = false;
	target.data.pushConfig = async (body, region) => {
		if (body.version === 3) {
			const row = await db.prepare("SELECT owner_token_hash, config_version FROM tenants WHERE name = ?").bind("northwind").first<{ owner_token_hash: string; config_version: number }>();
			assert.equal(row?.config_version, 3);
			assert.notEqual(row?.owner_token_hash, body.ownerTokenHash);
			const stolen = await db.prepare(
				"UPDATE tenants SET owner_token_hash = ?, config_version = ? WHERE name = ? AND config_version = ?",
			).bind("later-rotation", 3, "northwind", 2).run();
			assert.equal(stolen.meta?.changes, 0);
			reserved = true;
		}
		return push(body, region);
	};
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com" },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } }, dataPlane: target.data },
	);
	const cookie = await signIn(app, sent);
	const headers = { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
	assert.equal((await app.request(`${origin}/api/v1/tenants`, { method: "POST", headers, body: "name=Northwind" })).status, 303);
	const before = await db.prepare("SELECT owner_token_hash FROM tenants WHERE name = ?").bind("northwind").first<{ owner_token_hash: string }>();
	const rotated = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=rotate-token&confirm=1" });
	assert.equal(reserved, true);
	assert.match(rotated.headers.get("location") ?? "", /token=failed$/);
	assert.equal(rotated.headers.getSetCookie().some((value) => value.includes("a2aot_")), false);
	const after = await db.prepare("SELECT owner_token_hash, config_version FROM tenants WHERE name = ?").bind("northwind").first<{ owner_token_hash: string; config_version: number }>();
	assert.equal(after?.owner_token_hash, before?.owner_token_hash);
	assert.equal(after?.config_version, 3);
	assert.equal(target.pushes.at(-1)?.version, 3);
	assert.equal(target.pushes.at(-1)?.ownerTokenHash, before?.owner_token_hash);
	const html = await (await app.request(rotated.headers.get("location") ?? "", { headers: { cookie } })).text();
	assert.match(html, /The owner token was not rotated/);
	assert.equal(html.includes("a2aot_"), false);
});

test("a later rotation during restore is left in place", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const target = plane("refuse");
	const push = target.data.pushConfig.bind(target.data);
	target.data.pushConfig = async (body, region) => {
		if (body.version === 3 && body.ownerTokenHash !== "later-rotation") {
			await db.prepare("UPDATE tenants SET owner_token_hash = ?, config_version = ? WHERE name = ?").bind("later-rotation", 4, "northwind").run();
		}
		return push(body, region);
	};
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com" },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } }, dataPlane: target.data },
	);
	const cookie = await signIn(app, sent);
	const headers = { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
	assert.equal((await app.request(`${origin}/api/v1/tenants`, { method: "POST", headers, body: "name=Northwind" })).status, 303);
	const before = await db.prepare("SELECT owner_token_hash FROM tenants WHERE name = ?").bind("northwind").first<{ owner_token_hash: string }>();
	const rotated = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=rotate-token&confirm=1" });
	assert.match(rotated.headers.get("location") ?? "", /token=replaced$/);
	assert.equal(rotated.headers.getSetCookie().some((value) => value.includes("a2aot_")), false);
	const after = await db.prepare("SELECT owner_token_hash, config_version FROM tenants WHERE name = ?").bind("northwind").first<{ owner_token_hash: string; config_version: number }>();
	assert.equal(after?.owner_token_hash, "later-rotation");
	assert.equal(after?.config_version, 4);
	assert.equal(target.pushes.some((body) => body.version > 3), false);
	assert.equal(target.pushes.some((body) => body.version === 3 && body.ownerTokenHash === before?.owner_token_hash), true);
	const html = await (await app.request(rotated.headers.get("location") ?? "", { headers: { cookie } })).text();
	assert.match(html, /A later rotation replaced this token/);
	assert.equal(html.includes("a2aot_"), false);
});

test("a deleting agent does not rotate", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const target = plane();
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com" },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } }, dataPlane: target.data },
	);
	const cookie = await signIn(app, sent);
	const headers = { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
	assert.equal((await app.request(`${origin}/api/v1/tenants`, { method: "POST", headers, body: "name=Northwind" })).status, 303);
	await db.prepare("UPDATE tenants SET status = 'deleting' WHERE name = ?").bind("northwind").run();
	const before = target.pushes.length;
	const html = await (await app.request(`${origin}/app/agents/northwind`, { headers: { cookie } })).text();
	assert.equal(html.includes("rotate-token"), false);
	const rotated = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=rotate-token&confirm=1" });
	assert.match(rotated.headers.get("location") ?? "", /token=gone$/);
	assert.equal(target.pushes.length, before);
	const page = await (await app.request(rotated.headers.get("location") ?? "", { headers: { cookie } })).text();
	assert.match(page, /This agent is gone/);
	assert.equal(page.includes("a2aot_"), false);
});
