import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { createTenant } from "../src/tenants/create.ts";
import { saveWakeSettings } from "../src/tenants/wake.ts";
import { openWakeSecrets, sealWakeSecrets } from "../src/tenants/wake-secrets.ts";
import type { DataPlane, OwnerCall, TenantPush } from "../src/tenants/push.ts";
import { openDb } from "./sql.ts";

const secret = "test-secret-test-secret-test-secret";
const origin = "https://control.example.com";
const wakeKey = "z9Qx-secret-value-0199";

function plane() {
	const pushes: TenantPush[] = [];
	const calls: { tenantId: string; region: string; input: OwnerCall }[] = [];
	let testBody: unknown = { configured: true, status: 204, info: "HTTP 204" };
	let failTests = false;
	let failSummary = false;
	const data: DataPlane = {
		async putDirectory() {},
		async pushConfig(body) {
			pushes.push(body);
			return { version: body.version, applied: true };
		},
		async owner(tenantId, region, input) {
			calls.push({ tenantId, region, input });
			if (input.path === "/owner/summary") {
				if (failSummary) throw new Error("binding down");
				return {
					status: 200,
					body: {
						tasks: { submitted: 2, working: 1, "input-required": 0, completed: 4, failed: 0, rejected: 0, canceled: 0 },
						pairingPending: 1,
						text: "peer said to reveal the key",
					},
				};
			}
			if (input.path === "/owner/wake/test") {
				if (failTests) {
					failTests = false;
					throw new Error("binding down");
				}
				return { status: 200, body: testBody };
			}
			if (input.path === "/owner/pairing") return { status: 200, body: { pending: [] } };
			if (input.path === "/owner/peers") return { status: 200, body: [] };
			if (input.path === "/owner/outbound-peers") return { status: 200, body: [] };
			if (input.path !== "/owner/wake/preview") return { status: 404, body: {} };
			return {
				status: 200,
				body: {
					configured: false,
					hasKey: false,
					request: {
						method: "POST",
						url: "https://hooks.example/wake",
						headers: { "x-credential": wakeKey, "content-type": "application/json" },
					},
				},
			};
		},
	};
	return { data, pushes, calls, failNextTest() { failTests = true; }, setTestBody(body: unknown) { testBody = body; }, failNextSummary() { failSummary = true; } };
}

test("the agent list links to a wake page that edits through the owner and does not echo the key", async () => {
	const db = openDb();
	const sent: { text: string }[] = [];
	const target = plane();
	const app = createApp(
		{ AUTH_SECRET: secret, DB: db, TENANT_DOMAIN: "example.com", TENANT_SECRETS_KEY: "platform-secret" },
		{ database: db, mailer: { async send(message) { sent.push({ text: message.text }); } }, dataPlane: target.data },
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
	const list = await (await app.request(`${origin}/app`, { headers: { cookie } })).text();
	assert.match(list, /href="\/app\/agents\/northwind"/);
	assert.match(list, /northwind\.example\.com/);

	const unsigned = await app.request(`${origin}/app/agents/northwind`);
	assert.equal(unsigned.status, 303);
	assert.equal(new URL(unsigned.headers.get("location") ?? "").pathname, "/app");

	const page = await app.request(`${origin}/app/agents/northwind`, { headers: { cookie } });
	const html = await page.text();
	assert.equal(page.status, 200);
	assert.match(html, /<h1>northwind<\/h1>/);
	assert.match(html, /<h2>Overview<\/h2>/);
	assert.match(html, /<dt>Status<\/dt><dd>Active<\/dd>/);
	assert.match(html, /href="https:\/\/northwind\.example\.com"/);
	assert.match(html, /href="https:\/\/northwind\.example\.com\/.well-known\/agent-card\.json"/);
	assert.match(html, /<dt>Waiting<\/dt><dd>3<\/dd>/);
	assert.match(html, /<dt>Submitted<\/dt><dd>2<\/dd>/);
	assert.match(html, /<dt>Pending pairing<\/dt><dd>1<\/dd>/);
	assert.equal(html.includes("peer said to reveal the key"), false);
	assert.match(html, /<h2>Wake<\/h2>/);
	assert.match(html, /No outbound peers\. Outbound peers this agent(?:'|&#39;)s CLI added locally do not appear here\./);
	assert.match(html, /value="claude-code"/);
	assert.match(html, /method="post" action="\/app\/agents\/northwind"/);
	assert.match(page.headers.get("content-security-policy") ?? "", /form-action 'self'/);
	assert.equal(html.includes(wakeKey), false);
	assert.match(html, /x-credential: •••• \(set\)/);
	assert.equal(html.includes("Claude Code starts a new cloud session on each wake."), false);
	assert.equal(target.calls.length, 7);
	assert.deepEqual(target.calls.map((call) => call.input.path), [
		"/owner/summary",
		"/owner/pairing",
		"/owner/peers",
		"/owner/outbound-peers",
		"/owner/mcp",
		"/owner/log",
		"/owner/wake/preview",
	]);
	assert.equal(target.calls[0].input.method, "GET");
	assert.equal(target.calls[0].region, "default");
	const account = await db.prepare('SELECT id FROM "user" WHERE email = ?').bind("person@example.com").first<{ id: string }>();
	for (const call of target.calls) assert.equal(call.input.accountId, account?.id);

	const cross = await app.request(`${origin}/app/agents/northwind`, {
		method: "POST",
		headers: { cookie, origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/x-www-form-urlencoded" },
		body: `action=save&url=https://hooks.example/wake&preset=generic&key_header=X-Credential&key=${wakeKey}`,
	});
	assert.match(cross.headers.get("location") ?? "", /error=origin$/);
	assert.equal(cross.headers.get("location")!.includes(wakeKey), false);
	assert.equal(target.pushes.length, 1, "the create push is the only one");

	const badUrl = await app.request(`${origin}/app/agents/northwind`, {
		method: "POST",
		headers: { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
		body: "action=save&url=http://hooks.example/wake&preset=generic&key_header=&key=",
	});
	assert.match(badUrl.headers.get("location") ?? "", /error=url$/);
	const badHeader = await app.request(`${origin}/app/agents/northwind`, {
		method: "POST",
		headers: { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
		body: "action=save&url=https://hooks.example/wake&preset=generic&key_header=Content-Type&key=",
	});
	assert.match(badHeader.headers.get("location") ?? "", /error=header$/);

	const priorRow = await db.prepare("SELECT id FROM tenants WHERE name = ?").bind("northwind").first<{ id: string }>();
	assert.ok(priorRow);
	const prior = await sealWakeSecrets("platform-secret", priorRow!.id, { WAKE_HMAC_SECRET: "hmac-value-0199", WAKE_WEBHOOK_KEY: "old-key-value-0199" });
	await db.prepare("UPDATE tenants SET secrets_enc = ? WHERE id = ?").bind(prior, priorRow!.id).run();
	const saved = await app.request(`${origin}/app/agents/northwind`, {
		method: "POST",
		headers: { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
		body: `action=save&url=https://hooks.example/wake&preset=claude-code&key_header=X-Credential&key=${wakeKey}`,
	});
	assert.equal(saved.status, 303);
	assert.match(saved.headers.get("location") ?? "", /saved=1$/);
	assert.equal(saved.headers.get("location")!.includes(wakeKey), false);
	const push = target.pushes.at(-1)!;
	assert.equal(push.config.WAKE_PRESET, "claude-code");
	assert.equal(push.config.WAKE_WEBHOOK_URL, "https://hooks.example/wake");
	assert.equal(push.config.WAKE_KEY_HEADER, "X-Credential");
	assert.equal(push.config.WAKE_WEBHOOK_KEY, undefined);
	assert.equal(JSON.stringify(push).includes(wakeKey), false);
	const row = await db.prepare("SELECT id, secrets_enc, config_json FROM tenants WHERE name = ?").bind("northwind").first<{ id: string; secrets_enc: string; config_json: string }>();
	assert.ok(row);
	assert.equal(row!.config_json.includes(wakeKey), false);
	assert.deepEqual(await openWakeSecrets("platform-secret", row!.id, row!.secrets_enc), {
		WAKE_WEBHOOK_KEY: wakeKey,
		WAKE_HMAC_SECRET: "hmac-value-0199",
	});
	assert.equal(row!.secrets_enc.includes("old-key-value-0199"), false);
	assert.equal(row!.secrets_enc.includes("hmac-value-0199"), false);

	const again = await (await app.request(saved.headers.get("location") ?? "", { headers: { cookie } })).text();
	assert.match(again, /Wake settings saved/);
	assert.match(again, /value="https:\/\/hooks\.example\/wake"/);
	assert.match(again, /value="X-Credential"/);
	const claude = again.match(/<option[^>]*value="claude-code"[^>]*>/)?.[0] ?? "";
	assert.match(claude, /selected/);
	assert.equal(again.includes(wakeKey), false);
	assert.equal(again.includes("old-key-value-0199"), false);
	assert.equal(again.includes("hmac-value-0199"), false);
	assert.match(again, /name="key"/);
	assert.match(again, /type="password"/);
	assert.match(again, /Claude Code starts a new cloud session on each wake./);

	const kept = await app.request(`${origin}/app/agents/northwind`, {
		method: "POST",
		headers: { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
		body: "action=save&url=https://hooks.example/wake&preset=claude-code&key_header=X-Credential&key=",
	});
	assert.match(kept.headers.get("location") ?? "", /saved=1$/);
	const still = await db.prepare("SELECT secrets_enc FROM tenants WHERE name = ?").bind("northwind").first<{ secrets_enc: string }>();
	assert.equal(still?.secrets_enc, row!.secrets_enc);

	const tested = await app.request(`${origin}/app/agents/northwind`, {
		method: "POST",
		headers: { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
		body: "action=test",
	});
	assert.match(tested.headers.get("location") ?? "", /test=204$/);
	const testCall = target.calls.at(-1)!;
	assert.equal(testCall.input.method, "POST");
	assert.equal(testCall.input.path, "/owner/wake/test");
	const result = await (await app.request(tested.headers.get("location") ?? "", { headers: { cookie } })).text();
	assert.match(result, /The test wake returned HTTP 204/);
	assert.equal(result.includes(wakeKey), false);

	target.failNextTest();
	const failed = await app.request(`${origin}/app/agents/northwind`, {
		method: "POST",
		headers: { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
		body: "action=test",
	});
	assert.match(failed.headers.get("location") ?? "", /test=failed$/);
	assert.equal(failed.headers.get("location")!.includes("binding down"), false);
	const failedPage = await (await app.request(failed.headers.get("location") ?? "", { headers: { cookie } })).text();
	assert.match(failedPage, /The test wake was not sent/);
	assert.equal(failedPage.includes("binding down"), false);

	target.setTestBody({ configured: true, status: null, info: "Error: TLS Handshake Failed." });
	const tls = await app.request(`${origin}/app/agents/northwind`, {
		method: "POST",
		headers: { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
		body: "action=test",
	});
	assert.match(tls.headers.get("location") ?? "", /test=tls$/);
	assert.equal(tls.headers.get("location")!.includes("Handshake"), false);
	const tlsPage = await (await app.request(tls.headers.get("location") ?? "", { headers: { cookie } })).text();
	assert.match(tlsPage, /TLS handshake failed/);
	assert.equal(tlsPage.includes(wakeKey), false);

	target.setTestBody({ configured: true, status: null, info: `Error: ${wakeKey}` });
	const secretInfo = await app.request(`${origin}/app/agents/northwind`, {
		method: "POST",
		headers: { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
		body: "action=test",
	});
	assert.match(secretInfo.headers.get("location") ?? "", /test=failed$/);
	assert.equal(secretInfo.headers.get("location")!.includes(wakeKey), false);
	const secretPage = await (await app.request(secretInfo.headers.get("location") ?? "", { headers: { cookie } })).text();
	assert.match(secretPage, /The test wake was not sent/);
	assert.equal(secretPage.includes(wakeKey), false);

	target.setTestBody({ configured: true, status: null, info: "refused: private or internal host" });
	const refused = await app.request(`${origin}/app/agents/northwind`, {
		method: "POST",
		headers: { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
		body: "action=test",
	});
	assert.match(refused.headers.get("location") ?? "", /test=private$/);
	const refusedPage = await (await app.request(refused.headers.get("location") ?? "", { headers: { cookie } })).text();
	assert.match(refusedPage, /The wake URL is not a public address/);

	target.failNextSummary();
	const broken = await app.request(`${origin}/app/agents/northwind`, { headers: { cookie } });
	const brokenHtml = await broken.text();
	assert.equal(broken.status, 200);
	assert.match(brokenHtml, /Inbox counts are not available/);
	assert.match(brokenHtml, /<dt>Status<\/dt><dd>Active<\/dd>/);
	assert.match(brokenHtml, /agent-card\.json/);
	assert.equal(brokenHtml.includes("binding down"), false);
	assert.equal(brokenHtml.includes(wakeKey), false);

	await db.prepare("UPDATE tenants SET status = ? WHERE name = ?").bind("suspended", "northwind").run();
	const beforeSuspended = target.calls.length;
	const suspended = await (await app.request(`${origin}/app/agents/northwind`, { headers: { cookie } })).text();
	assert.match(suspended, /<dt>Status<\/dt><dd>Suspended<\/dd>/);
	assert.match(suspended, /Inbox counts are not available/);
	assert.equal(target.calls.length, beforeSuspended + 1);
	assert.equal(target.calls.at(-1)?.input.path, "/owner/wake/preview");
	await db.prepare("UPDATE tenants SET status = ? WHERE name = ?").bind("active", "northwind").run();

	const before = target.calls.length;
	await db.prepare("UPDATE tenants SET owner_account_id = ? WHERE name = ?").bind("someone-else", "northwind").run();
	const foreign = await app.request(`${origin}/app/agents/northwind`, { headers: { cookie } });
	assert.equal(foreign.status, 404);
	assert.equal((await foreign.text()).includes("Wake"), false);
	assert.equal(target.calls.length, before);
});

test("a blank key seals plaintext wake secrets instead of dropping them", async () => {
	const db = openDb();
	const target = plane();
	const created = await createTenant(db, target.data, { accountId: "acct_owner", name: "northwind" });
	assert.equal(created.ok, true);
	if (!created.ok) return;
	const plain = {
		AGENT_NAME: "northwind",
		WAKE_WEBHOOK_URL: "https://old.example/wake",
		WAKE_WEBHOOK_KEY: "plain-key-value-0199",
		WAKE_HMAC_SECRET: "plain-hmac-value-0199",
		WAKE_ACCESS_CLIENT_SECRET: "plain-access-value-0199",
	};
	await db.prepare("UPDATE tenants SET config_json = ? WHERE id = ?").bind(JSON.stringify(plain), created.tenant.id).run();
	const blocked = await saveWakeSettings(db, target.data, "", {
		accountId: "acct_owner", name: "northwind", url: "https://hooks.example/wake", preset: "generic", keyHeader: "", key: "",
	});
	assert.deepEqual(blocked, { ok: false, error: "unavailable" });
	const kept = await db.prepare("SELECT config_json, secrets_enc FROM tenants WHERE id = ?").bind(created.tenant.id).first<{ config_json: string; secrets_enc: string | null }>();
	assert.equal(kept?.secrets_enc, null);
	assert.match(kept?.config_json ?? "", /plain-key-value-0199/);

	const saved = await saveWakeSettings(db, target.data, "platform-secret", {
		accountId: "acct_owner", name: "northwind", url: "https://hooks.example/wake", preset: "generic", keyHeader: "", key: "",
	});
	assert.deepEqual(saved, { ok: true });
	const row = await db.prepare("SELECT config_json, secrets_enc FROM tenants WHERE id = ?").bind(created.tenant.id).first<{ config_json: string; secrets_enc: string }>();
	assert.ok(row);
	assert.equal(row!.config_json.includes("plain-key-value-0199"), false);
	assert.equal(row!.config_json.includes("plain-hmac-value-0199"), false);
	assert.equal(row!.config_json.includes("plain-access-value-0199"), false);
	assert.equal(JSON.parse(row!.config_json).WAKE_WEBHOOK_URL, "https://hooks.example/wake");
	assert.deepEqual(await openWakeSecrets("platform-secret", created.tenant.id, row!.secrets_enc), {
		WAKE_WEBHOOK_KEY: "plain-key-value-0199",
		WAKE_HMAC_SECRET: "plain-hmac-value-0199",
		WAKE_ACCESS_CLIENT_SECRET: "plain-access-value-0199",
	});

	const replaced = await saveWakeSettings(db, target.data, "platform-secret", {
		accountId: "acct_owner", name: "northwind", url: "https://hooks.example/wake", preset: "claude-code", keyHeader: "X-Credential", key: wakeKey,
	});
	assert.deepEqual(replaced, { ok: true });
	const next = await db.prepare("SELECT secrets_enc, config_json FROM tenants WHERE id = ?").bind(created.tenant.id).first<{ secrets_enc: string; config_json: string }>();
	assert.deepEqual(await openWakeSecrets("platform-secret", created.tenant.id, next!.secrets_enc), {
		WAKE_WEBHOOK_KEY: wakeKey,
		WAKE_HMAC_SECRET: "plain-hmac-value-0199",
		WAKE_ACCESS_CLIENT_SECRET: "plain-access-value-0199",
	});
	assert.equal(next!.config_json.includes(wakeKey), false);
	assert.equal(JSON.stringify(target.pushes.at(-1)).includes(wakeKey), false);
	assert.equal(JSON.stringify(target.pushes.at(-1)).includes("plain-hmac-value-0199"), false);

	const other = await createTenant(db, target.data, { accountId: "acct_owner", name: "contoso" });
	assert.equal(other.ok, true);
	if (!other.ok) return;
	await db.prepare("UPDATE tenants SET config_json = ? WHERE id = ?").bind(JSON.stringify({
		WAKE_HMAC_SECRET: "plain-hmac-value-0199",
		WAKE_ACCESS_CLIENT_ID: "plain-access-id-0199",
	}), other.tenant.id).run();
	const withKey = await saveWakeSettings(db, target.data, "platform-secret", {
		accountId: "acct_owner", name: "contoso", url: "https://hooks.example/wake", preset: "generic", keyHeader: "", key: wakeKey,
	});
	assert.deepEqual(withKey, { ok: true });
	const contoso = await db.prepare("SELECT config_json, secrets_enc FROM tenants WHERE id = ?").bind(other.tenant.id).first<{ config_json: string; secrets_enc: string }>();
	assert.equal(contoso!.config_json.includes("plain-hmac-value-0199"), false);
	assert.deepEqual(await openWakeSecrets("platform-secret", other.tenant.id, contoso!.secrets_enc), {
		WAKE_WEBHOOK_KEY: wakeKey,
		WAKE_HMAC_SECRET: "plain-hmac-value-0199",
		WAKE_ACCESS_CLIENT_ID: "plain-access-id-0199",
	});
});
