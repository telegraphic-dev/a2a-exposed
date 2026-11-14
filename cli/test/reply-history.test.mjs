import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/a2a-exposed.mjs", import.meta.url));
const stub = fileURLToPath(new URL("./fetch-stub.mjs", import.meta.url));
const ts = "2026-11-07T01:00:00.000Z";
function fixture(t, extra = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-reply-history-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const routes = path.join(dir, "routes.json");
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(A2A_|PEER_|WAKE_|CF_|CLOUDFLARE_)/.test(key)));
	Object.assign(env, { A2A_CONFIG_DIR: dir, A2A_BASE_URL: "https://agent.example.com", A2A_OWNER_TOKEN: "test-owner", A2A_NO_UPDATE_CHECK: "1", A2A_TEST_FETCH_ROUTES: routes }, extra);
	return (args, body) => {
		fs.writeFileSync(routes, JSON.stringify({ "https://agent.example.com/owner/": { status: 200, body } }));
		return spawnSync(process.execPath, ["--import", stub, bin, ...args], { env, encoding: "utf8" });
	};
}

test("reply prints safe per-callback results and saved state even on failure or retry", (t) => {
	const cli = fixture(t);
	for (const idempotent of [false, true]) {
		const r = cli(["reply", "task-1", "--text", "done"], {
			task: { status: { state: "completed" } }, idempotent,
			delivery: { status: "delivery-failed", method: "push", push: [
				{ role: "message push", host: "hooks.example.net", fingerprint: "aabbcc112233", ok: false, info: "HTTP 401" },
				{ role: "task push config", host: "hooks.example.net", fingerprint: "aabbcc112234", ok: true, info: "HTTP 200" },
			] },
		});
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stderr, /message push hooks.example.net \[aabbcc112233\]: FAILED \(HTTP 401\)/);
		assert.match(r.stderr, /task push config hooks.example.net \[aabbcc112234\]: ok \(HTTP 200\)/);
		assert.match(r.stdout, /task state saved: completed \(peers can read it with GetTask even if a push fails\)\n$/);
	}
	const old = cli(["working", "task-1"], { push: [{ url: "https://hooks.example.net/private?secret=hidden", ok: false, info: "failed https://hooks.example.net/private?secret=hidden" }] });
	assert.equal(old.status, 0, old.stderr);
	assert.doesNotMatch(old.stderr, /hidden|private|secret=/);
});

test("history marks forced transitions and ends with saved current state even for limited rows", (t) => {
	const cli = fixture(t);
	const rows = [{ ts, dir: "out", peer: "ada", task_id: "task-1", event: "forced", state: "input-required", text: "question", data: { forced: true, previousState: "completed", state: "input-required" }, currentState: { state: "completed", timestamp: ts } }];
	const r = cli(["history", "ctx", "--from", "ada", "-n", "1"], rows);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /forced: completed → input-required/);
	assert.ok(r.stdout.endsWith(`current state: completed (${ts})\n`));
	assert.deepEqual(JSON.parse(cli(["history", "ctx", "--json"], rows).stdout), rows);
	const multi = cli(["history", "ctx"], [...rows, { ts, peer: "bob", task_id: "task-2", state: "working" }]);
	assert.match(multi.stdout, /ada\/task-1 current state: completed/);
	assert.match(multi.stdout, /bob\/task-2 current state: working/);
});

test("inbox ends each task with its current state and timestamp without changing JSON", (t) => {
	const cli = fixture(t);
	const rows = [{ taskId: "task-1", contextId: "ctx", from: "ada", state: "working", updated: ts, text: "hello" }];
	const r = cli(["inbox", "--context", "ctx"], rows);
	assert.equal(r.status, 0, r.stderr);
	assert.ok(r.stdout.endsWith(`current state: working (${ts})\n`));
	assert.deepEqual(JSON.parse(cli(["inbox", "--context", "ctx", "--json"], rows).stdout), rows);
});

test("wake status prints queue and honest receiver acceptance, with JSON for agents", t => {
	const cli = fixture(t);
	const data = { configured: true, transport: "webhook", pendingCount: 1, pending: [{ peer: "ada", contextId: "ctx", reason: "retry", attempts: 2, dueAt: ts }], lastAttempt: { at: ts, httpStatus: 503 }, lastAccepted: null, next: "Handler execution and owner notification are unverified; check receiver logs." };
	const result = cli(["wake", "status"], data);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /1 pending conversation.*\nada\/ctx: retry/);
	assert.match(result.stdout, /last receiver acceptance: unknown/);
	assert.match(result.stdout, /unverified/);
	assert.deepEqual(JSON.parse(cli(["wake", "status", "--json"], data).stdout), data);
});

test("inbox prints callback guidance once per peer while preserving every task", t => {
	const cli = fixture(t);
	const continuation = { kind: "announce-address", next: "Ask the peer owner to run peer announce on their side." };
	const rows = [
		{ taskId: "task-1", from: "ada", state: "submitted", text: "one", continuation },
		{ taskId: "task-2", from: "ada", state: "submitted", text: "two", continuation },
		{ taskId: "task-3", from: "bob", state: "submitted", text: "three", continuation },
	];
	const result = cli(["inbox", "--context", "ctx"], rows);
	assert.equal(result.status, 0, result.stderr);
	assert.equal((result.stdout.match(/Ask the peer owner/g) || []).length, 2);
	assert.equal((result.stdout.match(/current state: submitted/g) || []).length, 3);
});

test("reply passes optional --intent and --wake to the owner reply and checks them first (#401)", (t) => {
	const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "a2a-reply-route-")), "fetch.log");
	t.after(() => fs.rmSync(path.dirname(log), { recursive: true, force: true }));
	const cli = fixture(t, { A2A_TEST_FETCH_LOG: log });
	const saved = { task: { status: { state: "completed" } }, delivery: { status: "stored-only", method: "stored" } };
	const bodies = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((r) => r.url.endsWith("/owner/tasks/task-1/reply")).map((r) => JSON.parse(r.body));
	const labelled = cli(["reply", "task-1", "--text", "done", "--intent", "status", "--wake", "auto"], saved);
	assert.equal(labelled.status, 0, labelled.stderr);
	assert.equal(bodies().at(-1).intent, "status");
	assert.equal(bodies().at(-1).wake, "auto");
	const plain = cli(["reply", "task-1", "--text", "done"], saved);
	assert.equal(plain.status, 0, plain.stderr);
	assert.equal("intent" in bodies().at(-1), false);
	assert.equal("wake" in bodies().at(-1), false);
	const sent = bodies().length;
	const badIntent = cli(["reply", "task-1", "--text", "done", "--intent", "ping"], saved);
	assert.notEqual(badIntent.status, 0);
	assert.match(badIntent.stderr, /--intent must be handoff, blocker, question, status, ack/);
	const badWake = cli(["reply", "task-1", "--text", "done", "--wake", "later"], saved);
	assert.notEqual(badWake.status, 0);
	assert.match(badWake.stderr, /--wake must be auto, always, never/);
	assert.equal(bodies().length, sent);
});
