// Run: npm test   (node --test, Node >= 22.18 native TypeScript type stripping)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { publicTask, normMessage, randomToken, sha256, fingerprint, taskFromAny, movedResponse, publicOrigin, isPrivateHost } from "../src/a2a.ts";

// Internal (0.3-shaped) task after a peer message and an owner reply, as stored in D1.
const reply = { kind: "message", role: "agent", messageId: "m2", contextId: "c1", taskId: "t1", parts: [{ kind: "text", text: "pong" }] };
const task = {
	id: "t1", contextId: "c1",
	status: { state: "completed", timestamp: "2026-01-01T00:00:00.000Z", message: reply },
	artifacts: [{ artifactId: "a1", name: "response", parts: [{ kind: "text", text: "pong" }] }],
	history: [normMessage({ role: "ROLE_USER", messageId: "m1", parts: [{ text: "ping" }] }), reply],
};

function roles(t: any): string[] {
	return [t.status.message.role, ...t.history.map((m: any) => m.role)];
}

test("1.0 GetTask: status.message and history both use ROLE_* enums", () => {
	const t = publicTask(task, "1.0");
	assert.equal(t.status.state, "TASK_STATE_COMPLETED");
	assert.deepEqual(roles(t), ["ROLE_AGENT", "ROLE_USER", "ROLE_AGENT"]);
	for (const m of [t.status.message, ...t.history]) {
		assert.ok(!("kind" in m), "1.0 messages carry no kind");
		for (const p of m.parts) assert.ok(!("kind" in p), "1.0 parts carry no kind");
	}
	assert.deepEqual(t.artifacts[0].parts, [{ text: "pong" }]);
	assert.ok(!("kind" in t));
});

test("0.3 tasks/get: status.message and history keep user/agent", () => {
	const t = publicTask(task, "0.3");
	assert.equal(t.status.state, "completed");
	assert.equal(t.kind, "task");
	assert.deepEqual(roles(t), ["agent", "user", "agent"]);
	assert.equal(t.history[0].parts[0].kind, "text");
});

test("publicTask does not mutate the stored task", () => {
	publicTask(task, "1.0");
	assert.equal(task.status.message.role, "agent");
	assert.equal(task.history[1].role, "agent");
});

test("historyLength trims history in both versions", () => {
	assert.deepEqual(publicTask(task, "1.0", 1).history.map((m: any) => m.role), ["ROLE_AGENT"]);
	assert.equal(publicTask(task, "0.3", 0).history, undefined);
});

test("inbound 1.0 roles normalise to the internal user/agent", () => {
	assert.equal(normMessage({ role: "ROLE_AGENT", parts: [{ text: "x" }] }).role, "agent");
	assert.equal(normMessage({ role: "ROLE_USER", parts: [{ text: "x" }] }).role, "user");
	assert.equal(taskFromAny({ id: "x", status: { state: "TASK_STATE_INPUT_REQUIRED" } }).status.state, "input-required");
});

test("peer tokens use the a2aow_ prefix and match by sha256", async () => {
	const t = randomToken();
	assert.match(t, /^a2aow_[A-Za-z0-9_-]{43}$/);
	assert.equal(await sha256(t), createHash("sha256").update(t).digest("hex"));
});

test("fingerprint is the first 12 hex chars of sha256, null when unset", async () => {
	const v = "https://hooks.example.com/abc?x=1";
	assert.equal(await fingerprint(v), createHash("sha256").update(v).digest("hex").slice(0, 12));
	assert.equal(await fingerprint(undefined), null);
	assert.equal(await fingerprint(""), null);
});

test("movedResponse: retired hostnames redirect the card (301) and answer 410; others are served", () => {
	const pub = "https://my-agent.acme.workers.dev";
	const card = movedResponse("https://old.example.com/.well-known/agent-card.json", pub, "old.example.com");
	assert.equal(card!.status, 301);
	assert.equal(card!.headers.location, "https://my-agent.acme.workers.dev/.well-known/agent-card.json");
	const rpc = movedResponse("https://OLD.example.com/a2a/v1", pub, " other.example.com , old.example.com ");
	assert.equal(rpc!.status, 410);
	assert.equal(JSON.parse(rpc!.body).agentCard, "https://my-agent.acme.workers.dev/.well-known/agent-card.json");
	assert.equal(movedResponse("https://my-agent.acme.workers.dev/a2a/v1", pub, "old.example.com"), null);
	assert.equal(movedResponse("https://old.example.com/a2a/v1", pub, ""), null);
	assert.equal(movedResponse("https://old.example.com/a2a/v1", "https://old.example.com", "old.example.com"), null, "never the live URL");
	assert.equal(movedResponse("https://old.example.com/", "", "old.example.com")!.status, 410);
});


test("publicOrigin: the card advertises the deployment's public https URL, never a local or Tailnet one", () => {
	const req = "https://agent-x.acme.workers.dev/.well-known/agent-card.json";
	assert.equal(publicOrigin("https://agent.example.com", req), "https://agent.example.com");
	assert.equal(publicOrigin("https://agent.example.com/", req), "https://agent.example.com");
	assert.equal(publicOrigin("", req), "https://agent-x.acme.workers.dev", "unknown yet: the request origin");
	assert.equal(publicOrigin(undefined, req), "https://agent-x.acme.workers.dev");
	for (const local of ["http://agent.example.com", "https://hermes.tail1234.ts.net", "http://100.101.102.103:8644", "https://100.64.0.1",
		"https://localhost:8644", "https://hermes", "https://192.168.1.10", "https://10.0.0.5", "https://box.local", "https://[::1]:8644", "not a url"])
		assert.equal(publicOrigin(local, req), "https://agent-x.acme.workers.dev", local);
});

test("isPrivateHost", () => {
	for (const h of ["localhost", "hermes", "hermes.tail1234.ts.net", "100.127.255.1", "172.16.0.1", "169.254.1.1", "127.0.0.1", "nas.home.arpa", "fd00::1",
		"::1", "[::1]", "::", "fe80::1", "febf::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "[::ffff:c0a8:101]", "64:ff9b::a00:1", "::a00:1"])
		assert.equal(isPrivateHost(h), true, h);
	for (const h of ["agent.example.com", "agent-x.acme.workers.dev", "100.128.0.1", "172.32.0.1", "8.8.8.8", "2606:4700::1", "::ffff:808:808", "64:ff9b::808:808", "2001:db8::1"])
		assert.equal(isPrivateHost(h), false, h);
});
