// Owner RPC allowlist and response filter. No Durable Object: the hosted test calls TenantStore.owner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { accountIdOf, matchOwnerRpc, ownerResponseLeaks, ownerRpcBody, scrubOwnerClaims } from "../src/owner-rpc.ts";

test("owner RPC allowlist is the management reads and the calls that do not return a secret", () => {
	const ok = (method: string, path: string, query?: Record<string, string>) => {
		const m = matchOwnerRpc(method, path, query);
		assert.equal(m.ok, true, `${method} ${path}`);
		return m.ok ? m.route : null;
	};
	assert.equal(ok("GET", "/owner/inbox")?.name, "GET /owner/inbox");
	assert.equal(ok("GET", "/owner/summary")?.name, "GET /owner/summary");
	assert.equal(ok("GET", "/owner/inbox", { context: "ctx-1", all: "1" })?.search, "?context=ctx-1&all=1");
	assert.equal(ok("GET", "/owner/inbox", { from: "ada" })?.search, "?from=ada");
	assert.equal(ok("GET", "/owner/inbox", { limit: "20", cursor: "abc_DEF-012" })?.search, "?limit=20&cursor=abc_DEF-012");
	assert.equal(ok("GET", "/owner/tasks/task-1")?.path, "/owner/tasks/task-1");
	assert.equal(ok("GET", "/owner/history/ctx-1", { n: "50" })?.search, "?n=50");
	assert.equal(ok("GET", "/owner/history/ctx-1", { n: "50", from: "ada" })?.search, "?n=50&from=ada");
	assert.equal(ok("GET", "/owner/outbound/task-1")?.name, "GET /owner/outbound/:id");
	assert.equal(ok("GET", "/owner/peers")?.name, "GET /owner/peers");
	assert.equal(ok("DELETE", "/owner/peers/ada")?.path, "/owner/peers/ada");
	assert.equal(ok("GET", "/owner/pairing")?.name, "GET /owner/pairing");
	assert.equal(ok("POST", "/owner/pairing/WDJB-4827/approve")?.name, "POST /owner/pairing/:code/approve");
	assert.equal(ok("POST", "/owner/pairing/wdjb4827/deny")?.name, "POST /owner/pairing/:code/deny");
	assert.equal(ok("GET", "/owner/mcp")?.name, "GET /owner/mcp");
	assert.equal(ok("DELETE", "/owner/mcp/mcp-claude")?.path, "/owner/mcp/mcp-claude");
	assert.equal(ok("POST", "/owner/mcp/send")?.name, "POST /owner/mcp/send");
	assert.equal(ok("POST", "/owner/mcp/reply")?.path, "/owner/mcp/reply");
	assert.equal(ok("POST", "/owner/mcp/mark_working")?.name, "POST /owner/mcp/mark_working");
	assert.equal(ok("GET", "/owner/outbound-peers")?.name, "GET /owner/outbound-peers");
	assert.equal(ok("PUT", "/owner/outbound-peers/ada.bot")?.name, "PUT /owner/outbound-peers/:alias");
	assert.equal(ok("PUT", "/owner/outbound-peers/ada.bot")?.path, "/owner/outbound-peers/ada.bot");
	assert.equal(ok("DELETE", "/owner/outbound-peers/ada.bot")?.path, "/owner/outbound-peers/ada.bot");
	assert.equal(ok("GET", "/owner/facade")?.name, "GET /owner/facade");
	assert.equal(ok("POST", "/owner/facade/verify")?.name, "POST /owner/facade/verify");
	assert.equal(ok("GET", "/owner/wake/preview")?.name, "GET /owner/wake/preview");
	assert.equal(ok("POST", "/owner/wake/test")?.name, "POST /owner/wake/test");
	assert.equal(ok("GET", "/owner/contexts")?.name, "GET /owner/contexts");
	assert.equal(ok("GET", "/owner/log")?.name, "GET /owner/log");
	assert.equal(ok("GET", "/owner/export")?.name, "GET /owner/export");
	assert.equal(ok("GET", "/owner/export", { format: "sql" })?.search, "?format=sql");

	const refused = (method: string, path: string, query?: Record<string, string>) => matchOwnerRpc(method, path, query);
	assert.deepEqual(refused("POST", "/owner/peers"), { ok: false, reason: "path" });
	assert.deepEqual(refused("POST", "/owner/pairing/password-link"), { ok: false, reason: "path" });
	assert.deepEqual(refused("PUT", "/owner/pairing/password"), { ok: false, reason: "path" });
	assert.deepEqual(refused("PUT", "/owner/outbound-peers"), { ok: false, reason: "path" });
	assert.deepEqual(refused("PUT", "/owner/peers/ada"), { ok: false, reason: "path" });
	assert.deepEqual(refused("GET", "/owner/export", { format: "json" }), { ok: false, reason: "query" });
	assert.deepEqual(refused("GET", "/owner/export", { format: "sql", n: "1" }), { ok: false, reason: "query" });
	assert.deepEqual(refused("POST", "/owner/export"), { ok: false, reason: "path" });
	assert.deepEqual(refused("GET", "/owner/log", { n: "10" }), { ok: false, reason: "query" });
	assert.deepEqual(refused("POST", "/owner/purge"), { ok: false, reason: "path" });
	assert.deepEqual(refused("POST", "/owner/tasks/task-1/reply"), { ok: false, reason: "path" });
	assert.deepEqual(refused("POST", "/owner/mcp/send", { to: "alpha" }), { ok: false, reason: "query" });
	assert.deepEqual(refused("POST", "/owner/mcp/poll_outbound"), { ok: false, reason: "path" });
	assert.deepEqual(refused("PUT", "/owner/mcp/send"), { ok: false, reason: "path" });
	assert.deepEqual(refused("POST", "/owner/history"), { ok: false, reason: "path" });
	assert.deepEqual(refused("GET", "/owner/peers/../export"), { ok: false, reason: "path" });
	assert.deepEqual(refused("GET", "/owner/%2e%2e/peers"), { ok: false, reason: "path" });
	assert.deepEqual(refused("GET", "/owner/inbox?all=1"), { ok: false, reason: "path" });
	assert.deepEqual(refused("POST", "/owner/pairing/AEIO-4827/approve"), { ok: false, reason: "path" });
	assert.deepEqual(refused("GET", "/owner/inbox", { format: "sql" }), { ok: false, reason: "query" });
	assert.deepEqual(refused("GET", "/owner/inbox", { limit: "201" }), { ok: false, reason: "query" });
	assert.deepEqual(refused("GET", "/owner/inbox", { limit: "0" }), { ok: false, reason: "query" });
	assert.deepEqual(refused("GET", "/owner/inbox", { cursor: "bad+cursor" }), { ok: false, reason: "query" });
	assert.deepEqual(refused("GET", "/owner/inbox", { from: "bad peer" }), { ok: false, reason: "query" });
	assert.deepEqual(refused("GET", "/owner/history/ctx-1", { from: "../x" }), { ok: false, reason: "query" });
	assert.deepEqual(refused("GET", "/owner/summary", { all: "1" }), { ok: false, reason: "query" });
	assert.deepEqual(refused("GET", "/owner/history/ctx-1", { n: "1001" }), { ok: false, reason: "query" });
	assert.deepEqual(refused("GET", "/owner/history/.."), { ok: false, reason: "path" });
	assert.equal(accountIdOf("acct_carol"), "acct_carol");
	assert.equal(accountIdOf("../acct"), null);
	assert.equal(accountIdOf(""), null);
});

test("owner RPC accepts a tool-argument body only on send, reply, and mark_working", () => {
	const absent = ownerRpcBody("GET /owner/peers", undefined);
	assert.equal(absent.ok, true);
	assert.equal(absent.ok && absent.value, undefined);
	assert.equal(ownerRpcBody("GET /owner/peers", null).ok, true);
	assert.deepEqual(ownerRpcBody("GET /owner/peers", { label: "bob" }), { ok: false, error: "this call takes no body" });
	assert.deepEqual(ownerRpcBody("POST /owner/wake/test", {}), { ok: false, error: "this call takes no body" });

	const sent = ownerRpcBody("POST /owner/mcp/send", { to: "alpha", text: "status?", contextId: "ctx-1" });
	assert.deepEqual(sent, { ok: true, value: { to: "alpha", text: "status?", contextId: "ctx-1" } });
	assert.deepEqual(ownerRpcBody("POST /owner/mcp/send", { to: "alpha", text: "status?", taskId: "task-1" }), {
		ok: true, value: { to: "alpha", text: "status?", taskId: "task-1" },
	});
	assert.deepEqual(ownerRpcBody("POST /owner/mcp/reply", { taskId: "task-1", text: "done", state: "input-required" }), {
		ok: true, value: { taskId: "task-1", text: "done", state: "input-required" },
	});
	assert.deepEqual(ownerRpcBody("POST /owner/mcp/mark_working", { taskId: "task-1" }), { ok: true, value: { taskId: "task-1" } });

	assert.equal(ownerRpcBody("POST /owner/mcp/send", undefined).ok, false);
	assert.equal(ownerRpcBody("POST /owner/mcp/send", null).ok, false);
	assert.equal(ownerRpcBody("POST /owner/mcp/send", []).ok, false);
	assert.equal(ownerRpcBody("POST /owner/mcp/send", "hi").ok, false);
	assert.deepEqual(ownerRpcBody("POST /owner/mcp/send", {}), { ok: false, error: "to is required" });
	assert.deepEqual(ownerRpcBody("POST /owner/mcp/send", { to: "alpha" }), { ok: false, error: "text is required" });
	assert.deepEqual(ownerRpcBody("POST /owner/mcp/send", { to: "https://alpha.example", text: "hi" }), { ok: false, error: "to is invalid" });
	assert.deepEqual(ownerRpcBody("POST /owner/mcp/send", { to: "alpha", text: "   " }), { ok: false, error: "text is required" });
	assert.deepEqual(ownerRpcBody("POST /owner/mcp/send", { to: "alpha", text: "x".repeat(100_001) }), { ok: false, error: "text is too long" });
	assert.deepEqual(ownerRpcBody("POST /owner/mcp/send", { to: "alpha", text: "hi", token: "tok-alpha" }), { ok: false, error: "body is not allowed" });
	assert.deepEqual(ownerRpcBody("POST /owner/mcp/send", { to: "alpha", text: "hi", url: "https://evil.example" }), { ok: false, error: "body is not allowed" });
	assert.deepEqual(ownerRpcBody("POST /owner/mcp/reply", { taskId: "task-1", text: "done", state: "canceled" }), { ok: false, error: "state is invalid" });
	assert.deepEqual(ownerRpcBody("POST /owner/mcp/reply", { taskId: "task-1", text: "done", force: true }), { ok: false, error: "body is not allowed" });
	assert.deepEqual(ownerRpcBody("POST /owner/mcp/mark_working", { taskId: ".." }), { ok: false, error: "taskId is invalid" });
	assert.deepEqual(ownerRpcBody("POST /owner/mcp/mark_working", { taskId: "task-1", text: "no" }), { ok: false, error: "body is not allowed" });

	assert.deepEqual(ownerRpcBody("POST /owner/peers/announce", { to: "alpha", reissue: true }), { ok: true, value: { to: "alpha", reissue: "true" } });
	assert.deepEqual(ownerRpcBody("POST /owner/peers/announce", { all: true, reissue: true }), { ok: false, error: "reissue needs one alias" });
	assert.deepEqual(ownerRpcBody("POST /owner/mcp/announce_address", { to: "alpha" }), { ok: true, value: { to: "alpha" } });
	assert.deepEqual(ownerRpcBody("POST /owner/mcp/announce_address", { all: true }), { ok: true, value: { all: "true" } });
	for (const reissue of [true, "true", false, null]) {
		const refused = ownerRpcBody("POST /owner/mcp/announce_address", { to: "alpha", reissue });
		assert.equal(refused.ok, false);
		assert.equal(!refused.ok && refused.code, "reissue_owner_only");
	}
	const synced = ownerRpcBody("PUT /owner/outbound-peers/:alias", { url: "https://alpha.example.org", token: "tok-alpha" });
	assert.deepEqual(synced, { ok: true, value: { url: "https://alpha.example.org", token: "tok-alpha" } });
	assert.deepEqual(ownerRpcBody("PUT /owner/outbound-peers/:alias", { url: "https://alpha.example.org" }), {
		ok: true, value: { url: "https://alpha.example.org" },
	});
	assert.deepEqual(ownerRpcBody("PUT /owner/outbound-peers/:alias", undefined), { ok: false, error: "body must be an object" });
	assert.deepEqual(ownerRpcBody("PUT /owner/outbound-peers/:alias", {}), { ok: false, error: "url is required" });
	assert.deepEqual(ownerRpcBody("PUT /owner/outbound-peers/:alias", { url: "https://alpha.example.org", token: "" }), { ok: false, error: "token is invalid" });
	assert.deepEqual(ownerRpcBody("PUT /owner/outbound-peers/:alias", { url: "https://alpha.example.org", token: "t".repeat(4097) }), { ok: false, error: "token is invalid" });
	assert.deepEqual(ownerRpcBody("PUT /owner/outbound-peers/:alias", { url: "https://alpha.example.org", token: "tok-alpha", pushToken: "x" }), { ok: false, error: "body is not allowed" });
});

test("owner RPC withholds peer tokens and decrypted secrets", () => {
	const token = "a2aow_" + "a".repeat(43);
	assert.equal(ownerResponseLeaks("a2aot_" + "Q".repeat(43)), true);
	assert.equal(ownerResponseLeaks({ label: "ada", revoked_at: null }), false);
	assert.equal(ownerResponseLeaks([{ text: "hello" }]), false);
	assert.equal(ownerResponseLeaks({ token }), true);
	assert.equal(ownerResponseLeaks({ nested: { access_token: "a2amcp_" + "b".repeat(30) } }), true);
	assert.equal(ownerResponseLeaks({ url: "https://agent.example/device/setup?t=" + "c".repeat(20) }), true);
	assert.equal(ownerResponseLeaks({ clientSecret: "tenant-secret-value" }), true);
	assert.equal(ownerResponseLeaks({ secretsEnc: "v1.ciphertext-value" }), true);
	assert.equal(ownerResponseLeaks("https://user:pass@hooks.example/wake"), true);
	assert.equal(ownerResponseLeaks({ method: "POST", headers: { authorization: "Bearer abcd…" } }), true);
	assert.equal(ownerResponseLeaks({ method: "POST", headers: { authorization: "Bearer ••••" } }), false);
	assert.equal(ownerResponseLeaks({ method: "POST", headers: { "x-credential": "••••" } }), false);
	assert.equal(ownerResponseLeaks({
		request: { method: "POST", url: "https://hooks.example/wake", headers: { "x-credential": "supersecretvalue", "content-type": "application/json" }, body: "{}" },
	}), true);
	assert.equal(ownerResponseLeaks({
		request: { method: "POST", url: "https://hooks.example/wake", headers: { "x-credential": "Bearer ••••", "content-type": "application/json", "x-request-id": "req-1" }, body: "{}" },
	}), false);
	assert.equal(ownerResponseLeaks({ fingerprints: { url: "0123456789ab", key: null } }), false);
	assert.equal(ownerResponseLeaks({ token_hash: "ab".repeat(32) }), false);
});

test("a token-shaped claim is blanked and the rest of the list is returned", () => {
	const token = "a2aow_" + "a".repeat(20);
	const setup = "https://card.example/card.json?t=" + "c".repeat(16);
	const userinfo = "https://user:secret@card.example/card.json";
	const raw = {
		pending: [
			{ userCode: "WDJB-4827", clientName: token, clientId: "barry-alias", agentCardUrl: setup },
			{ userCode: "BCDF-2345", clientName: "Barry Bot", clientId: token, agentCardUrl: "https://barry.example/card.json" },
			{ client_name: token, agent_card_url: userinfo },
		],
		token,
	};
	assert.equal(ownerResponseLeaks(raw), true);
	const scrubbed = scrubOwnerClaims(raw) as { pending: { clientName: string; clientId: string; agentCardUrl: string; client_name?: string; agent_card_url?: string }[]; token: string };
	assert.equal(scrubbed.pending[0]!.clientName, "");
	assert.equal(scrubbed.pending[0]!.clientId, "barry-alias");
	assert.equal(scrubbed.pending[0]!.agentCardUrl, "");
	assert.equal(scrubbed.pending[1]!.clientName, "Barry Bot");
	assert.equal(scrubbed.pending[1]!.clientId, "");
	assert.equal(scrubbed.pending[1]!.agentCardUrl, "https://barry.example/card.json");
	assert.equal(scrubbed.pending[2]!.client_name, "");
	assert.equal(scrubbed.pending[2]!.agent_card_url, "");
	assert.equal(scrubbed.token, token);
	assert.equal(ownerResponseLeaks(scrubbed), true, "a real token under another key is still withheld");
	const listed = scrubOwnerClaims({ pending: raw.pending });
	assert.equal(ownerResponseLeaks(listed), false);
	assert.equal(JSON.stringify(listed).includes(token), false);
	assert.equal(JSON.stringify(listed).includes("t=" + "c".repeat(16)), false);
	assert.equal(JSON.stringify(listed).includes("user:secret"), false);
});
