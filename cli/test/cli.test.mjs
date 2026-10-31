// Run: npm test   (node --test; no network, uses a throwaway A2A_CONFIG_DIR)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "../lib/config.mjs";
import { fingerprint, plainState } from "../lib/a2a.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "a2a-exposed.mjs");

function sandbox() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-cli-test-"));
	// a clean environment: no real deployment config, no wake secrets from the caller's shell
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(A2A_|PEER_)|WAKE_/.test(k)));
	env.A2A_CONFIG_DIR = dir;
	env.A2A_NO_UPDATE_CHECK = "1";
	const cli = (args, input) => spawnSync(process.execPath, [BIN, ...args], { env, input: input ?? "", encoding: "utf8" });
	const config = () => { try { return parseEnv(fs.readFileSync(path.join(dir, "config.env"), "utf8")); } catch { return {}; } };
	const peers = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, "peers.json"), "utf8")); } catch { return {}; } };
	return { dir, env, cli, config, peers, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("peers rm also removes the token stored with --token-stdin (loopback self-test cleanup)", (t) => {
	const s = sandbox(); t.after(s.done);
	let r = s.cli(["peers", "add", "self", "https://agent.example.com", "--token-stdin"], "a2aow_testtoken\n");
	assert.equal(r.status, 0, r.stderr);
	assert.equal(s.config().PEER_SELF_TOKEN, "a2aow_testtoken");
	assert.match(s.cli(["peers", "list"]).stdout, /self\thttps:\/\/agent\.example\.com\ttoken_env=PEER_SELF_TOKEN\t\(set\)/);
	r = s.cli(["peers", "rm", "self"]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /removed self \(and PEER_SELF_TOKEN/);
	assert.ok(!("PEER_SELF_TOKEN" in s.config()));
	assert.deepEqual(s.peers(), {});
	assert.equal(fs.statSync(path.join(s.dir, "config.env")).mode & 0o777, 0o600);
});

test("peers rm cleans a token left behind by an older version", (t) => {
	const s = sandbox(); t.after(s.done);
	fs.writeFileSync(path.join(s.dir, "config.env"), "A2A_BASE_URL=https://agent.example.com\nPEER_SELF_TOKEN=leftover\n", { mode: 0o600 });
	const r = s.cli(["peers", "rm", "self"]);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(s.config(), { A2A_BASE_URL: "https://agent.example.com" });
});

test("peers rm leaves user-managed --token-env variables alone", (t) => {
	const s = sandbox(); t.after(s.done);
	fs.writeFileSync(path.join(s.dir, "config.env"), "MY_PEER_TOKEN=keep\n", { mode: 0o600 });
	assert.equal(s.cli(["peers", "add", "bob", "https://bob.example.com", "--token-env", "MY_PEER_TOKEN"]).status, 0);
	assert.equal(s.cli(["peers", "rm", "bob"]).status, 0);
	assert.equal(s.config().MY_PEER_TOKEN, "keep");
	assert.deepEqual(s.peers(), {});
});

test("peers rm keeps a stored token another peer still uses", (t) => {
	const s = sandbox(); t.after(s.done);
	assert.equal(s.cli(["peers", "add", "a", "https://a.example.com", "--token-env", "SHARED_TOKEN", "--token-stdin"], "tok").status, 0);
	assert.equal(s.cli(["peers", "add", "b", "https://b.example.com", "--token-env", "SHARED_TOKEN"]).status, 0);
	assert.equal(s.cli(["peers", "rm", "a"]).status, 0);
	assert.equal(s.config().SHARED_TOKEN, "tok");
	assert.equal(s.cli(["peers", "rm", "b"]).status, 0);
	assert.equal(s.config().SHARED_TOKEN, "tok", "b never stored it, so b does not remove it");
});

// Older CLIs wrote peers.json entries without `token_stored`, and stored --token-stdin tokens under any
// --token-env name. Such a token in config.env (CLI-owned) must not outlive the peer.
function legacy(s, peers, configText) {
	fs.writeFileSync(path.join(s.dir, "peers.json"), JSON.stringify(peers));
	fs.writeFileSync(path.join(s.dir, "config.env"), configText, { mode: 0o600 });
}

test("peers rm (legacy entry) removes its custom --token-env token from config.env", (t) => {
	const s = sandbox(); t.after(s.done);
	legacy(s, { bob: { url: "https://bob.example.com", token_env: "CUSTOM_VAR" } }, "A2A_BASE_URL=https://agent.example.com\nCUSTOM_VAR=a2aow_old\n");
	const r = s.cli(["peers", "rm", "bob"]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /removed bob \(and CUSTOM_VAR/);
	assert.deepEqual(s.config(), { A2A_BASE_URL: "https://agent.example.com" });
	assert.deepEqual(s.peers(), {});
});

test("peers rm (legacy entry) keeps a custom token another peer still references", (t) => {
	const s = sandbox(); t.after(s.done);
	legacy(s, { bob: { url: "https://bob.example.com", token_env: "SHARED_VAR" }, carol: { url: "https://carol.example.com", token_env: "SHARED_VAR" } }, "SHARED_VAR=tok\n");
	assert.equal(s.cli(["peers", "rm", "bob"]).status, 0);
	assert.equal(s.config().SHARED_VAR, "tok");
	assert.equal(s.cli(["peers", "rm", "carol"]).status, 0);
	assert.ok(!("SHARED_VAR" in s.config()), "the last legacy peer referencing it takes it along");
});

test("peers rm (legacy entry) leaves a token that only lives in the process environment, and CLI settings", (t) => {
	const s = sandbox(); t.after(s.done);
	legacy(s, { bob: { url: "https://bob.example.com", token_env: "ENV_ONLY_VAR" }, odd: { url: "https://odd.example.com", token_env: "A2A_OWNER_TOKEN" } }, "A2A_OWNER_TOKEN=owner\n");
	s.env.ENV_ONLY_VAR = "users-own";
	let r = s.cli(["peers", "rm", "bob"]);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout.trim(), "removed bob");
	r = s.cli(["peers", "rm", "odd"]);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(s.config(), { A2A_OWNER_TOKEN: "owner" }, "never drops the CLI's own settings");
	assert.deepEqual(s.peers(), {});
});

test("peers add records token_stored either way, so new entries are never treated as legacy", (t) => {
	const s = sandbox(); t.after(s.done);
	assert.equal(s.cli(["peers", "add", "bob", "https://bob.example.com", "--token-env", "MY_VAR"]).status, 0);
	assert.equal(s.cli(["peers", "add", "amy", "https://amy.example.com", "--token-stdin"], "tok").status, 0);
	assert.equal(s.peers().bob.token_stored, false);
	assert.equal(s.peers().amy.token_stored, true);
});

test("peers rm of an unknown alias fails", (t) => {
	const s = sandbox(); t.after(s.done);
	const r = s.cli(["peers", "rm", "nobody"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /unknown peer alias/);
});

test("wake fingerprint: first 12 hex of sha256 of the local env values", (t) => {
	const s = sandbox(); t.after(s.done);
	let r = s.cli(["wake", "fingerprint"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /no WAKE_WEBHOOK_URL/);
	const url = "https://hooks.example.com/routine/abc", key = "not-a-real-key";
	r = spawnSync(process.execPath, [BIN, "wake", "fingerprint"], { env: { ...s.env, WAKE_WEBHOOK_URL: url, WAKE_WEBHOOK_KEY: key }, encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	const fp = JSON.parse(r.stdout);
	assert.equal(fp.url, createHash("sha256").update(url).digest("hex").slice(0, 12));
	assert.equal(fp.key, fingerprint(key));
	assert.equal(fp.hmacSecret, null);
	assert.ok(!r.stdout.includes(key) && !r.stdout.includes(url));
});

test("wake test without a deployment points at init", (t) => {
	const s = sandbox(); t.after(s.done);
	const r = s.cli(["wake", "test"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /A2A_BASE_URL \/ A2A_OWNER_TOKEN missing/);
});

test("plainState reads 1.0 and 0.3 task states", () => {
	assert.equal(plainState({ status: { state: "TASK_STATE_INPUT_REQUIRED" } }), "input-required");
	assert.equal(plainState({ status: { state: "completed" } }), "completed");
	assert.ok(!plainState(null));
});

test("status without a deployment names the config directory and points at init (exit 1)", (t) => {
	const s = sandbox(); t.after(s.done);
	const r = s.cli(["status"]);
	assert.equal(r.status, 1);
	assert.match(r.stdout, /^deployment: +none$/m);
	assert.match(r.stdout, new RegExp(`^next step: +nothing is deployed from ${s.dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. Run \`npx -y a2a-exposed@latest init\` \\(see the quick start\\)\\. Another deployment\\? Set A2A_CONFIG_DIR\\.`, "m"));
	const j = JSON.parse(s.cli(["status", "--json"]).stdout);
	assert.equal(j.ok, false);
	assert.equal(j.deployed, false);
	assert.equal(j.layers.length, 8);
});

test("status reports Worker version, stale exit code, and cached latest with notices disabled", (t) => {
	const s = sandbox(); t.after(s.done);
	const base = "https://agent.example.com";
	fs.writeFileSync(path.join(s.dir, "config.env"), `A2A_BASE_URL=${base}\nA2A_OWNER_TOKEN=dummy-owner\nA2A_WORKER_NAME=test-worker\nA2A_D1_ID=dummy-db\n`, { mode: 0o600 });
	const routesFile = path.join(s.dir, "routes.json");
	s.env.NODE_OPTIONS = `--import=${fileURLToPath(new URL("./fetch-stub.mjs", import.meta.url))}`;
	s.env.A2A_TEST_FETCH_ROUTES = routesFile;
	s.env.XDG_CACHE_HOME = path.join(s.dir, "cache");
	const cache = path.join(s.env.XDG_CACHE_HOME, "a2a-exposed", "update-check.json");
	fs.mkdirSync(path.dirname(cache), { recursive: true });
	fs.writeFileSync(cache, JSON.stringify({ latest: "99.0.0", checkedAt: 1 }));
	const routes = {
		[`${base}/.well-known/agent-card.json`]: { status: 200, body: { name: "Test", supportedInterfaces: [{ url: base, protocolVersion: "1.0" }] } },
		[`${base}/health`]: { status: 200, body: { ok: true, version: "0.0.1" } },
		[`${base}/owner/wake/preview`]: { status: 200, body: { configured: true, preset: "grok-bot", hasKey: true } },
	};
	fs.writeFileSync(routesFile, JSON.stringify(routes));
	const r = s.cli(["status", "--json"]);
	assert.equal(r.status, 1, r.stderr);
	const j = JSON.parse(r.stdout);
	assert.equal(j.workerVersion, "0.0.1");
	assert.equal(j.ok, false);
	assert.match(j.nextStep, /older than this CLI.*deploy/);
	assert.ok(j.also.includes("a2a-exposed 99.0.0 is available: run npx -y a2a-exposed@latest deploy"));
	assert.deepEqual(JSON.parse(fs.readFileSync(cache, "utf8")), { latest: "99.0.0", checkedAt: 1 }, "status only reads the cache");
	assert.match(s.cli(["status"]).stdout, /worker version: +0\.0\.1 \(CLI /);
	routes[`${base}/health`] = { status: 503, body: {} };
	fs.writeFileSync(routesFile, JSON.stringify(routes));
	const unreachable = s.cli(["status", "--json"]);
	assert.equal(unreachable.status, 1, unreachable.stderr);
	const unhealthy = JSON.parse(unreachable.stdout);
	assert.equal(unhealthy.workerVersion, null);
	const worker = unhealthy.layers.find((l) => l.name === "Worker");
	assert.equal(worker.result, "FAIL");
	assert.match(worker.detail, /\/health HTTP 503/);
});
