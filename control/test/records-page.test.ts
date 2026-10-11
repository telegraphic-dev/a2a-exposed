import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.ts";
import type { DataPlane, OwnerCall, TenantPush } from "../src/tenants/push.ts";
import { openDb } from "./sql.ts";

const secret = "test-secret-test-secret-test-secret";
const origin = "https://control.example.com";
const token = "a2aow_" + "a".repeat(30);
const owner = "a2aot_" + "Q".repeat(43);
const sql = "-- a2a-exposed-export 1\nINSERT INTO history (text) VALUES ('see https://[redacted]@hooks.example/hook?t=[redacted]');\n";

function plane() {
	const calls: { tenantId: string; region: string; input: OwnerCall }[] = [];
	let exportBody: unknown = { exportedAt: "2026-10-11T00:00:00.000Z", sql };
	const data: DataPlane = {
		async putDirectory() {},
		async pushConfig(body: TenantPush) {
			return { version: body.version, applied: true };
		},
		async owner(_tenantId, region, input) {
			calls.push({ tenantId: _tenantId, region, input });
			if (input.path === "/owner/summary") {
				return { status: 200, body: { tasks: { submitted: 0, working: 0, "input-required": 0, completed: 0, failed: 0, rejected: 0, canceled: 0 }, pairingPending: 0 } };
			}
			if (input.path === "/owner/pairing") return { status: 200, body: { pending: [] } };
			if (input.path === "/owner/peers") return { status: 200, body: [] };
			if (input.path === "/owner/outbound-peers") return { status: 200, body: [] };
			if (input.path === "/owner/mcp") {
				return {
					status: 200,
					body: {
						enabled: true,
						url: "https://northwind.example.com/mcp",
						grants: [
							{
								label: "mcp-claude",
								client_id: "client-1",
								client_name: "Claude <script>alert(1)</script>",
								redirect_host: "claude.ai",
								scope: "mcp",
								created_at: "2026-10-01T08:00:00.000Z",
								last_used_at: "2026-10-02T09:30:00.000Z",
								revoked_at: null,
								access_hash: "hash-should-not-render",
								refresh_hash: "refresh-should-not-render",
							},
							{ label: "mcp-old", client_name: "Old", revoked_at: "2026-10-03T00:00:00.000Z", created_at: "2026-10-01T08:00:00.000Z" },
						],
					},
				};
			}
			if (input.path === "/owner/log") {
				return {
					status: 200,
					body: {
						entries: [
							{ seq: 2, contextId: "ctx-1", ts: "2026-10-11T12:00:00.000Z", dir: "in", peer: "ada", text: "hello <script>alert(1)</script>", event: "message", state: "submitted", data_json: JSON.stringify({ token }) },
							{ seq: 1, contextId: "ctx-1", ts: "2026-10-11T11:00:00.000Z", dir: "out", peer: "ada", text: `note ${token} and ${owner} end` },
						],
					},
				};
			}
			if (input.path === "/owner/export") return { status: 200, body: exportBody };
			if (input.method === "DELETE" && input.path === "/owner/mcp/mcp-claude") return { status: 200, body: { revoked: true, label: "mcp-claude" } };
			if (input.path === "/owner/wake/preview") return { status: 200, body: { configured: false, hasKey: false, request: null } };
			return { status: 404, body: {} };
		},
	};
	return { data, calls, setExport(body: unknown) { exportBody = body; } };
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

test("the agent page lists MCP connectors, a read-only log, and downloads a redacted export", async () => {
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
		const page = await app.request(`${origin}/app/agents/northwind`, { headers: { cookie } });
		const html = await page.text();
		assert.equal(page.status, 200);
		assert.match(html, /<h2>MCP connectors<\/h2>/);
		assert.match(html, /MCP is on\./);
		assert.match(html, /<code>mcp-claude<\/code>/);
		assert.match(html, /<time datetime="2026-10-01T08:00:00.000Z">2026-10-01 08:00 UTC<\/time>/);
		assert.match(html, /<time datetime="2026-10-11T12:00:00.000Z">2026-10-11 12:00 UTC<\/time>/);
		assert.match(html, /Claude &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
		assert.equal(html.includes("<script>alert"), false);
		assert.match(html, /claude\.ai/);
		assert.equal(html.includes("mcp-old"), false);
		assert.equal(html.includes("hash-should-not-render"), false);
		assert.equal(html.includes("refresh-should-not-render"), false);
		assert.match(html, /name="action" value="revoke-mcp"/);
		assert.match(html, /<h2>Message log<\/h2>/);
		assert.match(html, /does not mark a task as seen/);
		assert.match(html, /hello &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
		assert.match(html, /note \[redacted\] and \[redacted\] end/);
		assert.equal(html.includes(token), false);
		assert.equal(html.includes(owner), false);
		assert.equal(html.includes("data_json"), false);
		assert.match(html, /<h2>Export<\/h2>/);
		assert.match(html, /name="action" value="export"/);
		assert.match(html, /not a backup/);
		const posts = [...html.matchAll(/method="post" action="([^"]+)"/g)].map((match) => match[1]);
		assert.ok(posts.every((action) => action === "/app/agents/northwind"));

		const before = target.calls.length;
		const cross = await app.request(`${origin}/app/agents/northwind`, {
			method: "POST",
			headers: { cookie, origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/x-www-form-urlencoded" },
			body: "action=revoke-mcp&label=mcp-claude&confirm=1",
		});
		assert.match(cross.headers.get("location") ?? "", /error=origin$/);
		assert.equal(target.calls.length, before);

		const ask = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=revoke-mcp&label=mcp-claude" });
		assert.match(ask.headers.get("location") ?? "", /confirm-mcp=mcp-claude$/);
		assert.equal(target.calls.some((call) => call.input.method === "DELETE"), false);
		const confirm = await (await app.request(ask.headers.get("location") ?? "", { headers: { cookie } })).text();
		assert.match(confirm, /Revoke the connector mcp-claude\?/);
		assert.match(confirm, /name="confirm" value="1"/);
		const odd = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=revoke-mcp&label=../export&confirm=1" });
		assert.match(odd.headers.get("location") ?? "", /mcp=label$/);
		assert.equal(target.calls.some((call) => call.input.method === "DELETE"), false);
		const revoked = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=revoke-mcp&label=mcp-claude&confirm=1" });
		assert.match(revoked.headers.get("location") ?? "", /mcp=revoked$/);
		assert.equal(target.calls.at(-1)?.input.method, "DELETE");
		assert.equal(target.calls.at(-1)?.input.path, "/owner/mcp/mcp-claude");
		assert.equal(target.calls.at(-1)?.input.actor, undefined);
		const revokedPage = await (await app.request(revoked.headers.get("location") ?? "", { headers: { cookie } })).text();
		assert.match(revokedPage, /Revoked\. That connector no longer works\./);
		const decision = lines.find((line) => line.includes("mcp_revoked"));
		assert.match(decision ?? "", /"decision":"mcp_revoked"/);
		assert.equal((decision ?? "").includes("mcp-claude"), false);

		const downloaded = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=export" });
		assert.equal(downloaded.status, 200);
		assert.match(downloaded.headers.get("content-disposition") ?? "", /attachment; filename="northwind\.sql"/);
		assert.match(downloaded.headers.get("cache-control") ?? "", /no-store/);
		assert.equal(await downloaded.text(), sql);
		const exportCall = target.calls.at(-1)!;
		assert.equal(exportCall.input.method, "GET");
		assert.equal(exportCall.input.path, "/owner/export");
		assert.deepEqual(exportCall.input.query, { format: "sql" });
		assert.equal(exportCall.input.actor, undefined);

		target.setExport({ exportedAt: "2026-10-11T00:00:00.000Z", sql: `${sql}${token}\n${owner}\n` });
		const scrubbed = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=export" });
		assert.equal(scrubbed.status, 200);
		const scrubbedSql = await scrubbed.text();
		assert.equal(scrubbedSql.includes(token), false);
		assert.equal(scrubbedSql.includes(owner), false);
		assert.match(scrubbedSql, /\[redacted\]/);
		target.setExport({ exportedAt: "2026-10-11T00:00:00.000Z", sql: `${sql}https://user:secret@hooks.example/hook\n` });
		const leaked = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=export" });
		assert.match(leaked.headers.get("location") ?? "", /export=failed$/);
		assert.equal(leaked.headers.get("location")!.includes("user:secret"), false);
		const failedPage = await (await app.request(leaked.headers.get("location") ?? "", { headers: { cookie } })).text();
		assert.match(failedPage, /The export was not downloaded\./);
		assert.equal(failedPage.includes("user:secret"), false);

		const session = await db.prepare('SELECT id, createdAt FROM session').first<{ id: string; createdAt: string | number }>();
		assert.ok(session);
		const createdAt = new Date(session!.createdAt);
		const staleAt = new Date(createdAt.getTime() - 11 * 60 * 1000);
		const stored = typeof session!.createdAt === "number" ? staleAt.getTime() : staleAt.toISOString();
		await db.prepare("UPDATE session SET createdAt = ? WHERE id = ?").bind(stored, session!.id).run();
		target.setExport({ exportedAt: "2026-10-11T00:00:00.000Z", sql });
		const staleExport = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=export" });
		assert.equal(staleExport.status, 200);
		assert.equal(await staleExport.text(), sql);
		const callsBefore = target.calls.length;
		const staleRevoke = await app.request(`${origin}/app/agents/northwind`, { method: "POST", headers, body: "action=revoke-mcp&label=mcp-claude&confirm=1" });
		assert.match(staleRevoke.headers.get("location") ?? "", /\/app\?error=reauth$/);
		assert.equal(target.calls.length, callsBefore);
		assert.equal(lines.some((line) => line.includes("dashboard_reauth") && line.includes("revoke-mcp") && !line.includes("mcp-claude")), true);
	} finally {
		console.log = original;
	}
});
