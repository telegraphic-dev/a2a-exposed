import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.ts";
import { OWNER_COOKIE } from "../src/auth/cookies.ts";
import type { DataPlane, TenantPush } from "../src/tenants/push.ts";
import { openDb } from "./sql.ts";

const secret = "test-secret-test-secret-test-secret";
const origin = "https://control.example.com";

function plane() {
	const data: DataPlane = {
		async putDirectory() {},
		async pushConfig(_body: TenantPush) {
			return { version: 1, applied: true };
		},
	};
	return data;
}

test("a signed-in account sees itself, can sign out, and creates two agents", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com", FREE_AGENT_LIMIT: "2" },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } }, dataPlane: plane() },
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
	await db.prepare('UPDATE "user" SET name = ?, image = ? WHERE email = ?').bind(
		"Mona Lisa",
		"https://avatars.githubusercontent.com/u/1",
		"person@example.com",
	).run();

	const unsigned = await app.request(`${origin}/app`);
	assert.match(await unsigned.text(), /action="\/app\/sign-in"/);

	const page = await app.request(`${origin}/app`, { headers: { cookie } });
	const html = await page.text();
	assert.match(html, /Mona Lisa/);
	assert.match(html, /person@example.com/);
	assert.match(html, /src="https:\/\/avatars\.githubusercontent\.com\/u\/1"/);
	assert.match(html, /No agents yet/);
	assert.match(html, /action="\/app\/sign-out"/);
	assert.match(html, /action="\/api\/v1\/tenants"/);
	assert.equal(html.includes("action=\"/app/sign-in\""), false);
	assert.equal(html.includes("style="), false);
	const policy = page.headers.get("content-security-policy") ?? "";
	assert.match(policy, /img-src 'self' https:\/\/avatars\.githubusercontent\.com/);
	assert.match(policy, /form-action 'self'(?:;|$)/);
	assert.equal(/form-action[^;]*https:\/\/github\.com/.test(policy), false);
	assert.match(policy, /script-src 'none'/);

	await db.prepare('UPDATE "user" SET image = ? WHERE email = ?').bind("https://evil.example/a.png", "person@example.com").run();
	const blocked = await (await app.request(`${origin}/app`, { headers: { cookie } })).text();
	assert.equal(blocked.includes("evil.example"), false);
	assert.equal(blocked.includes("avatar"), false);

	const cross = await app.request(`${origin}/api/v1/tenants`, {
		method: "POST",
		headers: { cookie, origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/x-www-form-urlencoded" },
		body: "name=northwind",
	});
	assert.match(cross.headers.get("location") ?? "", /error=origin$/);
	assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM tenants").first<{ n: number }>())?.n, 0);

	const created = await app.request(`${origin}/api/v1/tenants`, {
		method: "POST",
		headers: { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
		body: "name=Northwind",
	});
	assert.equal(created.status, 303);
	assert.equal(new URL(created.headers.get("location") ?? "").pathname, "/app");
	const owner = created.headers.getSetCookie().find((value) => value.startsWith(`${OWNER_COOKIE}=`));
	assert.ok(owner);
	assert.match(owner, /HttpOnly/);
	assert.equal(/domain=/i.test(owner), false);
	const shown = await app.request(`${origin}/app`, { headers: { cookie: `${cookie}; ${owner.split(";")[0]}` } });
	const once = await shown.text();
	const token = once.match(/a2aot_[A-Za-z0-9_-]+/)?.[0] ?? "";
	assert.match(token, /^a2aot_/);
	assert.match(once, new RegExp(`value="${token}"`));
	assert.equal(once.includes(`>${token}<`), false);
	assert.equal(once.includes(`${token}\n`), false);
	assert.equal(once.includes(`\n${token}`), false);
	assert.match(once, /Copy this owner token now/);
	assert.match(once, /will not be shown again/);
	assert.match(once, /https:\/\/northwind\.example\.com/);
	assert.match(once, /\d{4}-\d{2}-\d{2}/);
	assert.match(once, /src="\/owner-token\.js"/);
	assert.match(once, /class="action copy-token"/);
	assert.match(once, /type="button"/);
	assert.match(once, /hidden=""/);
	assert.equal(shown.headers.get("cache-control"), "no-store");
	assert.match(shown.headers.get("content-security-policy") ?? "", /script-src 'self'/);
	assert.match(shown.headers.get("set-cookie") ?? "", new RegExp(`${OWNER_COOKIE}=`));
	assert.match(shown.headers.get("set-cookie") ?? "", /Max-Age=0/);
	const again = await (await app.request(`${origin}/app`, { headers: { cookie } })).text();
	assert.equal(again.includes(token), false);
	assert.match(again, /northwind/);

	const reserved = await app.request(`${origin}/api/v1/tenants`, {
		method: "POST",
		headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
		body: "name=admin",
	});
	assert.match(reserved.headers.get("location") ?? "", /error=reserved_name$/);
	const short = await app.request(`${origin}/api/v1/tenants`, {
		method: "POST",
		headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
		body: "name=ab",
	});
	assert.match(short.headers.get("location") ?? "", /error=invalid_name$/);
	const reservedPage = await (await app.request(reserved.headers.get("location") ?? "", { headers: { cookie } })).text();
	assert.match(reservedPage, /That name is reserved/);

	const second = await app.request(`${origin}/api/v1/tenants`, {
		method: "POST",
		headers: { cookie, "content-type": "application/json" },
		body: JSON.stringify({ name: "contoso" }),
	});
	assert.equal(second.status, 201);
	const third = await app.request(`${origin}/api/v1/tenants`, {
		method: "POST",
		headers: { cookie, "content-type": "application/json" },
		body: JSON.stringify({ name: "fabrikam" }),
	});
	assert.equal(third.status, 403);
	assert.deepEqual(await third.json(), { error: "limit" });
	const formLimited = await app.request(`${origin}/api/v1/tenants`, {
		method: "POST",
		headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
		body: "name=adventure",
	});
	assert.equal(formLimited.status, 303);
	assert.match(formLimited.headers.get("location") ?? "", /error=limit$/);
	assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM tenants").first<{ n: number }>())?.n, 2);
	const limited = await (await app.request(`${origin}/app?error=limit`, { headers: { cookie } })).text();
	assert.match(limited, /This account can have 2 agents/);
	assert.equal(limited.includes("Create agent"), false);
	assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM tenants").first<{ n: number }>())?.n, 2);

	await db.prepare('UPDATE "user" SET agent_limit = 10 WHERE email = ?').bind("person@example.com").run();
	const raised = await app.request(`${origin}/api/v1/tenants`, {
		method: "POST",
		headers: { cookie, "content-type": "application/json" },
		body: JSON.stringify({ name: "fabrikam" }),
	});
	assert.equal(raised.status, 201);
	const raisedPage = await (await app.request(`${origin}/app`, { headers: { cookie } })).text();
	assert.match(raisedPage, /Create agent/);
	assert.equal(raisedPage.includes("This account can have 2 agents"), false);

	const signedOut = await app.request(`${origin}/app/sign-out`, {
		method: "POST",
		headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
		body: "",
	});
	assert.equal(signedOut.status, 303);
	assert.equal(new URL(signedOut.headers.get("location") ?? "").pathname, "/app");
	const cleared = signedOut.headers.getSetCookie().find((value) => value.startsWith("__Host-a2a_session=")) ?? "";
	assert.match(cleared, /Max-Age=0/);
	const home = await (await app.request(`${origin}/app`)).text();
	assert.match(home, /action="\/app\/sign-in"/);
	const session = await app.request(`${origin}/api/auth/get-session`, { headers: { cookie } });
	const who = await session.json() as { user?: { id?: string } } | null;
	assert.equal(who?.user?.id, undefined);
});

test("the callback session cookie is __Host-a2a_session in production", async () => {
	const env = { ...process.env, NODE_ENV: "production" };
	delete env.TEST;
	const child = spawn(process.execPath, ["--import", "./test/register-hooks.mjs", "./test/session-cookie-prod.ts"], {
		cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
		env,
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const status = await new Promise((resolve) => child.on("close", resolve));
	assert.equal(status, 0, stderr);
});
