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
function fixture(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-reply-history-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const routes = path.join(dir, "routes.json");
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(A2A_|PEER_|WAKE_|CF_|CLOUDFLARE_)/.test(key)));
	Object.assign(env, { A2A_CONFIG_DIR: dir, A2A_BASE_URL: "https://agent.example.com", A2A_OWNER_TOKEN: "test-owner", A2A_NO_UPDATE_CHECK: "1", A2A_TEST_FETCH_ROUTES: routes });
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
