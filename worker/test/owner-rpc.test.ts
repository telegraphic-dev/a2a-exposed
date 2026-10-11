// Owner RPC allowlist and response filter. No Durable Object: the hosted test calls TenantStore.owner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { accountIdOf, matchOwnerRpc, ownerResponseLeaks } from "../src/owner-rpc.ts";

test("owner RPC allowlist is the management reads and the calls that do not return a secret", () => {
	const ok = (method: string, path: string, query?: Record<string, string>) => {
		const m = matchOwnerRpc(method, path, query);
		assert.equal(m.ok, true, `${method} ${path}`);
		return m.ok ? m.route : null;
	};
	assert.equal(ok("GET", "/owner/inbox")?.name, "GET /owner/inbox");
	assert.equal(ok("GET", "/owner/summary")?.name, "GET /owner/summary");
	assert.equal(ok("GET", "/owner/inbox", { context: "ctx-1", all: "1" })?.search, "?context=ctx-1&all=1");
	assert.equal(ok("GET", "/owner/tasks/task-1")?.path, "/owner/tasks/task-1");
	assert.equal(ok("GET", "/owner/history/ctx-1", { n: "50" })?.search, "?n=50");
	assert.equal(ok("GET", "/owner/outbound/task-1")?.name, "GET /owner/outbound/:id");
	assert.equal(ok("GET", "/owner/peers")?.name, "GET /owner/peers");
	assert.equal(ok("DELETE", "/owner/peers/ada")?.path, "/owner/peers/ada");
	assert.equal(ok("GET", "/owner/pairing")?.name, "GET /owner/pairing");
	assert.equal(ok("POST", "/owner/pairing/WDJB-4827/approve")?.name, "POST /owner/pairing/:code/approve");
	assert.equal(ok("POST", "/owner/pairing/wdjb4827/deny")?.name, "POST /owner/pairing/:code/deny");
	assert.equal(ok("GET", "/owner/mcp")?.name, "GET /owner/mcp");
	assert.equal(ok("DELETE", "/owner/mcp/mcp-claude")?.path, "/owner/mcp/mcp-claude");
	assert.equal(ok("GET", "/owner/outbound-peers")?.name, "GET /owner/outbound-peers");
	assert.equal(ok("DELETE", "/owner/outbound-peers/ada.bot")?.path, "/owner/outbound-peers/ada.bot");
	assert.equal(ok("GET", "/owner/facade")?.name, "GET /owner/facade");
	assert.equal(ok("POST", "/owner/facade/verify")?.name, "POST /owner/facade/verify");
	assert.equal(ok("GET", "/owner/wake/preview")?.name, "GET /owner/wake/preview");
	assert.equal(ok("POST", "/owner/wake/test")?.name, "POST /owner/wake/test");
	assert.equal(ok("GET", "/owner/contexts")?.name, "GET /owner/contexts");

	const refused = (method: string, path: string, query?: Record<string, string>) => matchOwnerRpc(method, path, query);
	assert.deepEqual(refused("POST", "/owner/peers"), { ok: false, reason: "path" });
	assert.deepEqual(refused("POST", "/owner/pairing/password-link"), { ok: false, reason: "path" });
	assert.deepEqual(refused("PUT", "/owner/pairing/password"), { ok: false, reason: "path" });
	assert.deepEqual(refused("PUT", "/owner/outbound-peers/ada"), { ok: false, reason: "path" });
	assert.deepEqual(refused("GET", "/owner/export"), { ok: false, reason: "path" });
	assert.deepEqual(refused("POST", "/owner/purge"), { ok: false, reason: "path" });
	assert.deepEqual(refused("POST", "/owner/tasks/task-1/reply"), { ok: false, reason: "path" });
	assert.deepEqual(refused("POST", "/owner/history"), { ok: false, reason: "path" });
	assert.deepEqual(refused("GET", "/owner/peers/../export"), { ok: false, reason: "path" });
	assert.deepEqual(refused("GET", "/owner/%2e%2e/peers"), { ok: false, reason: "path" });
	assert.deepEqual(refused("GET", "/owner/inbox?all=1"), { ok: false, reason: "path" });
	assert.deepEqual(refused("POST", "/owner/pairing/AEIO-4827/approve"), { ok: false, reason: "path" });
	assert.deepEqual(refused("GET", "/owner/inbox", { format: "sql" }), { ok: false, reason: "query" });
	assert.deepEqual(refused("GET", "/owner/summary", { all: "1" }), { ok: false, reason: "query" });
	assert.deepEqual(refused("GET", "/owner/history/ctx-1", { n: "1001" }), { ok: false, reason: "query" });
	assert.deepEqual(refused("GET", "/owner/history/.."), { ok: false, reason: "path" });
	assert.equal(accountIdOf("acct_carol"), "acct_carol");
	assert.equal(accountIdOf("../acct"), null);
	assert.equal(accountIdOf(""), null);
});

test("owner RPC withholds peer tokens and decrypted secrets", () => {
	const token = "a2aow_" + "a".repeat(43);
	assert.equal(ownerResponseLeaks({ label: "ada", revoked_at: null }), false);
	assert.equal(ownerResponseLeaks([{ text: "hello" }]), false);
	assert.equal(ownerResponseLeaks({ token }), true);
	assert.equal(ownerResponseLeaks({ nested: { access_token: "a2amcp_" + "b".repeat(30) } }), true);
	assert.equal(ownerResponseLeaks({ url: "https://agent.example/device/setup?t=" + "c".repeat(20) }), true);
	assert.equal(ownerResponseLeaks({ clientSecret: "tenant-secret-value" }), true);
	assert.equal(ownerResponseLeaks({ secretsEnc: "v1.ciphertext-value" }), true);
	assert.equal(ownerResponseLeaks("https://user:pass@hooks.example/wake"), true);
	assert.equal(ownerResponseLeaks({ authorization: "Bearer abcd…" }), false);
	assert.equal(ownerResponseLeaks({
		request: { method: "POST", url: "https://hooks.example/wake", headers: { "x-credential": "supersecretvalue", "content-type": "application/json" }, body: "{}" },
	}), true);
	assert.equal(ownerResponseLeaks({
		request: { method: "POST", url: "https://hooks.example/wake", headers: { "x-credential": "supe…", "content-type": "application/json", "x-request-id": "req-1" }, body: "{}" },
	}), false);
	assert.equal(ownerResponseLeaks({ fingerprints: { url: "0123456789ab", key: null } }), false);
	assert.equal(ownerResponseLeaks({ token_hash: "ab".repeat(32) }), false);
});