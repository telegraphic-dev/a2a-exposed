import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import { RECENT_SIGN_IN_MS, recentSignIn } from "../src/auth/recent.ts";
import type { DataPlane, OwnerCall, TenantPush } from "../src/tenants/push.ts";
import { openDb } from "./sql.ts";

const secret = "test-secret-test-secret-test-secret";
const origin = "https://control.example.com";
const token = "a2aow_" + "a".repeat(30);
const thrown = "binding down " + token;

function plane() {
	const pushes: TenantPush[] = [];
	const calls: { tenantId: string; region: string; input: OwnerCall }[] = [];
	let failApprove = false;
	const data: DataPlane = {
		async putDirectory() {},
		async pushConfig(body) {
			pushes.push(body);
			return { version: body.version, applied: true };
		},
		async owner(_tenantId, _region, input) {
			calls.push({ tenantId: _tenantId, region: _region, input });
			if (input.path === "/owner/summary") {
				return {
					status: 200,
					body: { tasks: { submitted: 0, working: 0, "input-required": 0, completed: 0, failed: 0, rejected: 0, canceled: 0 }, pairingPending: 2 },
				};
			}
			if (input.path === "/owner/pairing") {
				return {
					status: 200,
					body: {
						mode: "human",
						pending: [
							{
								userCode: "WDJB-4827",
								clientName: "Barry <script>alert(1)</script>",
								clientId: "barry-alias",
								agentCardUrl: "https://barry.example/.well-known/agent-card.json",
								expiresAt: "2026-10-11T12:00:00.000Z",
								replacesLabel: "old-peer",
								verificationUriComplete: "https://northwind.example.com/device?user_code=WDJB-4827",
								ip: "198.51.100.7",
							},
							{
								userCode: "BCDF-2345",
								clientName: "Odd",
								clientId: "odd-alias",
								agentCardUrl: "javascript:alert(1)",
							},
							{
								userCode: "GHJK-6789",
								clientName: "Query",
								clientId: "query-alias",
								agentCardUrl: "https://user:secret@card.example/card.json",
							},
							{
								userCode: "MNPR-2345",
								clientName: "Local",
								clientId: "local-alias",
								agentCardUrl: "https://localhost/card.json",
							},
							{
								userCode: "STVW-6789",
								clientName: "Tail",
								clientId: "tail-alias",
								agentCardUrl: "https://box.ts.net/card.json",
							},
							{
								userCode: "BCDF-6789",
								clientName: "Lan",
								clientId: "lan-alias",
								agentCardUrl: "https://10.1.2.3/card.json",
							},
						],
					},
				};
			}
			if (input.path === "/owner/peers") {
				return {
					status: 200,
					body: [
						{ label: "ada", source: "pairing", client_name: "Ada <b>", created_at: "2026-10-01T08:00:00.000Z", revoked_at: null, user_code: "WDJB-4827", token_hash: "ab".repeat(32) },
						{ label: "gone", source: "pairing", client_name: "Gone Peer", created_at: "2026-10-01T08:00:00.000Z", revoked_at: "2026-10-02T00:00:00.000Z" },
					],
				};
			}
			if (input.path === "/owner/outbound-peers") {
				return {
					status: 200,
					body: [{ alias: "north", url: "https://north.example", has_token: true, token, token_enc: "ciphertext-secret" }],
				};
			}
			if (input.path.endsWith("/approve") && failApprove) throw new Error(thrown);
			if (input.method === "POST" && input.path.endsWith("/approve")) return { status: 200, body: { ok: true, decision: "approved", token } };
			if (input.method === "POST" && input.path.endsWith("/deny")) return { status: 200, body: { ok: true, decision: "denied" } };
			if (input.method === "DELETE") return { status: 200, body: { revoked: true, label: "ada" } };
			return { status: 200, body: { configured: false, hasKey: false, request: { method: "POST", url: "https://hooks.example/wake", headers: {} } } };
		},
	};
	return { data, pushes, calls, failNextApprove() { failApprove = true; } };
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

test("a dashboard decision needs a sign-in from the last 10 minutes", () => {
	const now = 1_700_000_000_000;
	assert.equal(recentSignIn({ session: { createdAt: new Date(now - RECENT_SIGN_IN_MS) } }, now), true);
	assert.equal(recentSignIn({ session: { createdAt: new Date(now - RECENT_SIGN_IN_MS - 1) } }, now), false);
	assert.equal(recentSignIn({ session: { createdAt: new Date(now + 60_000) } }, now), true);
	assert.equal(recentSignIn({ session: { createdAt: new Date(now + 60_001) } }, now), false);
	assert.equal(recentSignIn({ session: { createdAt: "not-a-date" } }, now), false);
	assert.equal(recentSignIn(null, now), false);
});

test("the agent page approves a claimed pairing, confirms revoke, and lists outbound peers", async () => {
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
		const created = await app.request(`${origin}/api/v1/tenants`, {
			method: "POST",
			headers,
			body: "name=Northwind",
		});
		assert.equal(created.status, 303);
		const page = await app.request(`${origin}/app/agents/northwind`, { headers: { cookie } });
		const html = await page.text();
		assert.equal(page.status, 200);
		assert.match(html, /<h2>Pairing<\/h2>/);
		assert.match(html, /Alias \(claimed\)/);
		assert.match(html, /barry-alias/);
		assert.match(html, /Barry &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
		assert.equal(html.includes("<script>alert"), false);
		assert.match(html, /href="https:\/\/barry\.example\/.well-known\/agent-card\.json"/);
		assert.match(html, /rel="noreferrer"/);
		assert.match(html, /javascript:alert\(1\)/);
		assert.equal(html.includes('href="javascript:'), false);
		assert.match(html, /user:secret@card\.example/);
		assert.equal(html.includes('href="https://user:secret@'), false);
		assert.match(html, /https:\/\/localhost\/card\.json/);
		assert.equal(html.includes('href="https://localhost/'), false);
		assert.match(html, /https:\/\/box\.ts\.net\/card\.json/);
		assert.equal(html.includes('href="https://box.ts.net/'), false);
		assert.match(html, /https:\/\/10\.1\.2\.3\/card\.json/);
		assert.equal(html.includes('href="https://10.1.2.3/'), false);
		assert.match(html, /the token old-peer/);
		assert.match(html, /<code>WDJB-4827<\/code>/);
		assert.match(html, /name="action" value="approve"/);
		assert.match(html, /name="action" value="deny"/);
		assert.match(html, /<code>ada<\/code>/);
		assert.match(html, /pairing WDJB-4827/);
		assert.match(html, /<time datetime="2026-10-01T08:00:00.000Z">2026-10-01 08:00 UTC<\/time>/);
		assert.match(html, /Ada &lt;b&gt;/);
		assert.equal(html.includes("Gone Peer"), false);
		assert.match(html, /<code>north<\/code>/);
		assert.match(html, /href="https:\/\/north\.example"/);
		assert.match(html, /token stored/);
		assert.equal(html.includes(token), false);
		assert.equal(html.includes("ciphertext-secret"), false);
		assert.equal(html.includes("198.51.100.7"), false);
		const posts = [...html.matchAll(/method="post" action="([^"]+)"/g)].map((match) => match[1]);
		assert.ok(posts.every((action) => action === "/app/agents/northwind" || action === "/app/sign-out"));

		const before = target.calls.length;
		const cross = await app.request(`${origin}/app/agents/northwind`, {
			method: "POST",
			headers: { cookie, origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/x-www-form-urlencoded" },
			body: "action=approve&code=WDJB-4827",
		});
		assert.match(cross.headers.get("location") ?? "", /error=origin$/);
		assert.equal(target.calls.length, before);

		const bad = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=approve&code=not-a-code" });
		assert.match(bad.headers.get("location") ?? "", /peer=code$/);
		assert.equal(target.calls.length, before);

		const sessionToken = await db.prepare("SELECT token FROM session").first<{ token: string }>();
		assert.ok(sessionToken?.token);
		const bearerSession = await app.request(`${origin}/api/auth/get-session`, { headers: { authorization: `Bearer ${sessionToken!.token}` } });
		assert.equal((await bearerSession.json() as { user?: { email?: string } }).user?.email, "person@example.com");
		const bearerOnly = await app.request(`${origin}/app/agents/northwind`, {
			method: "POST",
			headers: { authorization: `Bearer ${sessionToken!.token}`, origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
			body: "action=approve&code=WDJB-4827",
		});
		assert.equal(bearerOnly.status, 303);
		assert.match(bearerOnly.headers.get("location") ?? "", /\/app$/);
		assert.equal(target.calls.length, before);

		const approved = await app.request(`${origin}/app/agents/northwind`, {
			method: "POST",
			headers: { ...headers, authorization: "Bearer not-a-session" },
			body: "action=approve&code=WDJB-4827",
		});
		assert.match(approved.headers.get("location") ?? "", /peer=approved$/);
		assert.equal(approved.headers.get("location")!.includes(token), false);
		const approveCall = target.calls.at(-1)!;
		assert.equal(approveCall.input.method, "POST");
		assert.equal(approveCall.input.path, "/owner/pairing/WDJB-4827/approve");
		assert.equal(approveCall.input.actor, "human");
		const account = await db.prepare('SELECT id FROM "user" WHERE email = ?').bind("person@example.com").first<{ id: string }>();
		const tenant = await db.prepare("SELECT id FROM tenants WHERE name = ?").bind("northwind").first<{ id: string }>();
		assert.equal(approveCall.input.accountId, account?.id);
		const decision = lines.find((line) => line.includes("dashboard_decision"));
		assert.match(decision ?? "", new RegExp(`"tenant":"${tenant?.id}"`));
		assert.match(decision ?? "", /"decision":"approved"/);
		assert.equal((decision ?? "").includes("WDJB-4827"), false);
		assert.equal((decision ?? "").includes("barry.example"), false);
		assert.equal((decision ?? "").includes(token), false);
		const approvedPage = await (await app.request(approved.headers.get("location") ?? "", { headers: { cookie } })).text();
		assert.match(approvedPage, /Approved\. That agent can collect its token\./);
		assert.equal(approvedPage.includes(token), false);

		const denied = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=deny&code=BCDF-2345" });
		assert.match(denied.headers.get("location") ?? "", /peer=denied$/);
		assert.equal(target.calls.at(-1)?.input.path, "/owner/pairing/BCDF-2345/deny");
		assert.equal(target.calls.at(-1)?.input.actor, "human");

		const ask = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=revoke&label=ada" });
		assert.match(ask.headers.get("location") ?? "", /confirm=ada$/);
		assert.equal(target.calls.some((call) => call.input.method === "DELETE"), false);
		const confirm = await (await app.request(ask.headers.get("location") ?? "", { headers: { cookie } })).text();
		assert.match(confirm, /Revoke the token for ada\?/);
		assert.match(confirm, /name="confirm" value="1"/);
		const odd = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=revoke&label=../export&confirm=1" });
		assert.match(odd.headers.get("location") ?? "", /peer=label$/);
		assert.equal(target.calls.some((call) => call.input.method === "DELETE"), false);
		const revoked = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=revoke&label=ada&confirm=1" });
		assert.match(revoked.headers.get("location") ?? "", /peer=revoked$/);
		assert.equal(target.calls.at(-1)?.input.method, "DELETE");
		assert.equal(target.calls.at(-1)?.input.path, "/owner/peers/ada");
		assert.equal(target.calls.at(-1)?.input.actor, undefined);
		const revokedPage = await (await app.request(revoked.headers.get("location") ?? "", { headers: { cookie } })).text();
		assert.match(revokedPage, /Revoked\. That token no longer works\./);

		target.failNextApprove();
		const failed = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=approve&code=WDJB-4827" });
		assert.match(failed.headers.get("location") ?? "", /peer=failed$/);
		assert.equal(failed.headers.get("location")!.includes(thrown), false);
		assert.equal(failed.headers.get("location")!.includes(token), false);
		const failedPage = await (await app.request(failed.headers.get("location") ?? "", { headers: { cookie } })).text();
		assert.match(failedPage, /That change was not saved\./);
		assert.equal(failedPage.includes("binding down"), false);
		assert.equal(failedPage.includes(token), false);
		assert.equal(lines.some((line) => line.includes(thrown) || line.includes(token)), false);

		const owned = target.calls.length;
		await db.prepare("UPDATE tenants SET owner_account_id = ? WHERE name = ?").bind("someone-else", "northwind").run();
		const foreign = await app.request(`${origin}/app/agents/northwind`, { headers: { cookie } });
		assert.equal(foreign.status, 404);
		assert.equal(target.calls.length, owned);
		const foreignPost = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=approve&code=WDJB-4827" });
		assert.equal(foreignPost.status, 404);
		assert.equal(target.calls.length, owned);
		await db.prepare("UPDATE tenants SET owner_account_id = ? WHERE name = ?").bind(account?.id, "northwind").run();

		const session = await db.prepare('SELECT id, createdAt FROM session').first<{ id: string; createdAt: string | number }>();
		assert.ok(session);
		const createdAt = new Date(session!.createdAt);
		assert.equal(Number.isNaN(createdAt.getTime()), false);
		const staleAt = new Date(createdAt.getTime() - 11 * 60 * 1000);
		const stored = typeof session!.createdAt === "number" ? staleAt.getTime() : staleAt.toISOString();
		await db.prepare("UPDATE session SET createdAt = ? WHERE id = ?").bind(stored, session!.id).run();
		const viewed = await app.request(`${origin}/app/agents/northwind`, { headers: { cookie } });
		assert.equal(viewed.status, 200);
		assert.match(await viewed.text(), /<h2>Pairing<\/h2>/);
		const callsBeforeStale = target.calls.length;
		const stale = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=approve&code=WDJB-4827" });
		assert.equal(stale.status, 303);
		assert.match(stale.headers.get("location") ?? "", /\/app\?error=reauth$/);
		assert.equal(target.calls.length, callsBeforeStale);
		const cleared = stale.headers.getSetCookie().find((value) => value.startsWith("__Host-a2a_session=")) ?? "";
		assert.match(cleared, /Max-Age=0/);
		const home = await (await app.request(`${origin}/app?error=reauth`)).text();
		assert.match(home, /Sign in again to approve, deny, revoke, rotate the owner token, or delete the agent\. This session is older than 10 minutes\./);
		const who = await (await app.request(`${origin}/api/auth/get-session`, { headers: { cookie } })).json() as { user?: { id?: string } } | null;
		assert.equal(who?.user?.id, undefined);
		assert.equal(lines.some((line) => line.includes("dashboard_reauth") && line.includes(tenant?.id ?? "missing") && !line.includes("WDJB-4827")), true);
	} finally {
		console.log = original;
	}
});
