// Run: npm test   (node --test, Node >= 22.18 native TypeScript type stripping)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { publicTask, normMessage, randomToken, sha256, fingerprint, taskFromAny, movedResponse } from "../src/a2a.ts";

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

