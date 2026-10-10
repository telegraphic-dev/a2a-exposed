import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { SESSION_COOKIE } from "../src/auth/cookies.ts";
import { openDb } from "./sql.ts";

const secret = "test-secret-test-secret-test-secret";

test("device sign-in stays closed until login is configured", async () => {
	const app = createApp();
	const page = await app.request("https://control.example.com/app/device");
	assert.equal(page.status, 404);
	const code = await app.request("https://control.example.com/api/auth/device/code", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_id: "a2a-cli" }),
	});
	assert.equal(code.status, 404);
});

test("a signed-in owner can approve a CLI device code and the session is the access token", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } } },
	);
	const origin = "https://control.example.com";
	const started = await app.request(`${origin}/api/auth/device/code`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_id: "a2a-cli" }),
	});
	assert.equal(started.status, 200);
	const codes = await started.json() as { device_code: string; user_code: string; verification_uri_complete: string; interval: number };
	assert.match(codes.user_code, /^[A-Z2-9]{8}$/);
	assert.equal(new URL(codes.verification_uri_complete).origin, origin);
	assert.equal(new URL(codes.verification_uri_complete).pathname, "/app/device");
	assert.equal(new URL(codes.verification_uri_complete).searchParams.get("user_code"), codes.user_code);

	const rejected = await app.request(`${origin}/api/auth/device/code`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_id: "other" }),
	});
	assert.equal(rejected.status, 400);

	const pending = await app.request(`${origin}/api/auth/device/token`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			device_code: codes.device_code,
			client_id: "a2a-cli",
		}),
	});
	assert.equal(pending.status, 400);
	assert.equal((await pending.json() as { error: string }).error, "authorization_pending");

	const page = await app.request(codes.verification_uri_complete);
	assert.equal(page.status, 200);
	const html = await page.text();
	assert.match(html, new RegExp(codes.user_code));
	assert.match(html, /name="provider" value="email"/);
	const set = page.headers.get("set-cookie") ?? "";
	assert.match(set, /__Host-a2a_device=/);
	assert.equal(set.includes("Domain="), false);

	const posted = await app.request(`${origin}/app/sign-in`, {
		method: "POST",
		headers: { origin, "content-type": "application/x-www-form-urlencoded", cookie: set.split(";")[0] },
		body: "provider=email&email=person@example.com",
	});
	assert.equal(posted.status, 303);
	const link = sent[0].text.match(/https:\/\/control\.example\.com\/api\/auth\/magic-link\/verify\?[^\s]+/);
	assert.ok(link);
	const verified = await app.request(link[0]);
	const session = verified.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`))!.split(";")[0];
	const returned = await app.request(`${origin}/app`, { headers: { cookie: `${session}; ${set.split(";")[0]}` } });
	assert.equal(returned.status, 302);
	assert.equal(new URL(returned.headers.get("location") ?? "").pathname, "/app/device");

	for (let view = 0; view < 6; view++) {
		const shown = await app.request(`${origin}/app/device?user_code=${codes.user_code}`, { headers: { cookie: session } });
		assert.equal(shown.status, 200);
		const body = await shown.text();
		assert.match(body, /Do not approve a code from a message/);
		assert.match(body, /name="confirm"/);
		assert.match(body, new RegExp(codes.user_code));
	}
	const mismatched = await app.request(`${origin}/app/device`, {
		method: "POST",
		headers: { origin, "content-type": "application/x-www-form-urlencoded", cookie: session },
		body: `action=approve&user_code=${codes.user_code}&confirm=ZZZZZZZZ`,
	});
	assert.equal(mismatched.status, 303);
	assert.match(mismatched.headers.get("location") ?? "", /error=match/);
	const still = await db.prepare('select status, userId from "deviceCode"').first<{ status: string; userId: string | null }>();
	assert.equal(still?.status, "pending");
	assert.equal(still?.userId ?? null, null);

	const approved = await app.request(`${origin}/app/device`, {
		method: "POST",
		headers: { origin, "content-type": "application/x-www-form-urlencoded", cookie: session },
		body: `action=approve&user_code=${codes.user_code}&confirm=${codes.user_code}`,
	});
	assert.equal(approved.status, 303);
	assert.match(approved.headers.get("location") ?? "", /done=approved/);

	const tooFast = await app.request(`${origin}/api/auth/device/token`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			device_code: codes.device_code,
			client_id: "a2a-cli",
		}),
	});
	assert.equal(tooFast.status, 400);
	assert.equal((await tooFast.json() as { error: string }).error, "slow_down");
	await db.prepare('update "deviceCode" set "lastPolledAt" = null').run();

	const token = await app.request(`${origin}/api/auth/device/token`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			device_code: codes.device_code,
			client_id: "a2a-cli",
		}),
	});
	assert.equal(token.status, 200);
	const tokenBody = await token.json() as { access_token: string };
	const access = tokenBody.access_token;
	assert.ok(access);
	assert.equal(JSON.stringify(tokenBody).includes("person@example.com"), false);
	const who = await app.request(`${origin}/api/auth/get-session`, { headers: { authorization: `Bearer ${access}` } });
	assert.equal(who.status, 200);
	assert.equal((await who.json() as { user: { email: string } }).user.email, "person@example.com");

	const again = await app.request(`${origin}/api/auth/device/token`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			device_code: codes.device_code,
			client_id: "a2a-cli",
		}),
	});
	assert.notEqual(again.status, 200);
});
