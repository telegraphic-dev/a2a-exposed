import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/a2a-exposed.mjs", import.meta.url));
const TOKEN = "a2aow_dummy-peer-token";
function fixture(t, peers = { alice: { url: "https://agents.example.com/alice", token_env: "PEER_ALICE_TOKEN" } }) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-credential-"));
 t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 fs.writeFileSync(path.join(dir, "peers.json"), JSON.stringify(peers), { mode: 0o600 });
 fs.writeFileSync(path.join(dir, "config.env"), `PEER_ALICE_TOKEN=${TOKEN}\nA2A_OWNER_TOKEN=owner-dummy-token\n`, { mode: 0o600 });
 const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(A2A_|PEER_|CONTROL_|WAKE_|CF_|CLOUDFLARE_|UPSTREAM_)/.test(k)));
 const run = (input, extra = {}, args = ["credential", "get"]) => spawnSync(process.execPath, [BIN, "--config-dir", dir, ...args], { encoding: "utf8", input: typeof input === "string" ? input : JSON.stringify(input), env: { ...env, ...extra }, timeout: 8000 });
 return { dir, env, run };
}
function refused(r, pattern) {
 assert.equal(r.status, 1, r.stderr);
 assert.equal(r.stdout, "");
 assert.match(r.stderr, pattern);
 assert.doesNotMatch(r.stderr, /dummy-peer-token|owner-dummy-token|a2aow_override|input-secret/);
}

test("exact endpoint and standard cards return only Bazel headers without changing config", t => {
 const { dir, run } = fixture(t);
 const before = fs.readdirSync(dir).map(f => [f, fs.readFileSync(path.join(dir, f), "utf8"), fs.statSync(path.join(dir, f)).mode]);
 for (const suffix of ["", "/", "/.well-known/agent-card.json", "/.well-known/agent.json"]) {
  const r = run({ uri: "https://agents.example.com/alice" + suffix });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.deepEqual(JSON.parse(r.stdout), { headers: { Authorization: [`Bearer ${TOKEN}`] } });
 }
 assert.deepEqual(fs.readdirSync(dir).map(f => [f, fs.readFileSync(path.join(dir, f), "utf8"), fs.statSync(path.join(dir, f)).mode]), before);
});

test("origin, port and tenant path isolation; no prefix, wildcard, redirect or generic-token fallback", t => {
 const { run } = fixture(t);
 for (const uri of ["https://agents.example.com", "https://agents.example.com/bob", "https://agents.example.com/alice/owner", "https://agents.example.com/alice-more", "https://evil.example.com/alice", "https://agents.example.com:8443/alice", "http://agents.example.com/alice", "https://agents.example.com/alice?input-secret", "https://user:input-secret@agents.example.com/alice", "https://agents.example.com/alice#input-secret", "https://agents.example.com/bob/../alice", "https://agents.example.com/%61lice", "https://agents.example.com/alice//", "file:///input-secret"]) {
  refused(run({ uri }, { A2A_PEER_TOKEN: "input-secret" }), /peers list --json/);
 }
});

test("two peers on one host keep separate tokens", t => {
 const { run } = fixture(t, { alice: { url: "https://agents.example.com/alice", token_env: "PEER_ALICE_TOKEN" }, bob: { url: "https://agents.example.com/bob", token_env: "PEER_BOB_TOKEN" } });
 const r = run({ uri: "https://agents.example.com/bob" }, { PEER_BOB_TOKEN: "bob-dummy" });
 assert.equal(r.status, 0, r.stderr);
 assert.equal(JSON.parse(r.stdout).headers.Authorization[0], "Bearer bob-dummy");
});

test("environment override follows config precedence and warns without values", t => {
 const { run } = fixture(t);
 const r = run({ uri: "https://agents.example.com/alice" }, { PEER_ALICE_TOKEN: "a2aow_override" });
 assert.equal(r.status, 0);
 assert.equal(JSON.parse(r.stdout).headers.Authorization[0], "Bearer a2aow_override");
 assert.match(r.stderr, /environment token overrides/);
 assert.doesNotMatch(r.stderr, /a2aow_override|dummy-peer-token/);
});

test("missing, ambiguous and privileged credentials fail without output", t => {
 for (const peers of [
  {}, { a: { url: "https://agents.example.com/alice" } },
  { a: { url: "https://agents.example.com/alice", token_env: "MISSING" } },
  { a: { url: "https://agents.example.com/alice", token_env: "constructor" } },
  { a: { url: "https://agents.example.com/alice", token_env: "A2A_OWNER_TOKEN" } },
  { a: { url: "https://agents.example.com/alice", token_env: "CONTROL_TOKEN" } },
  { a: { url: "https://agents.example.com/alice", token_env: "A2A_PEER_TOKEN" } },
  { a: { url: "https://agents.example.com/alice", token_env: "PEER_ALICE_TOKEN" }, b: { url: "https://agents.example.com/alice/", token_env: "OTHER" } },
 ]) refused(fixture(t, peers).run({ uri: "https://agents.example.com/alice" }), /peers list --json/);
 const { run } = fixture(t);
 refused(run({ uri: "https://agents.example.com/alice" }, { PEER_ALICE_TOKEN: "owner-dummy-token" }), /dedicated bearer token/);
 refused(run({ uri: "https://agents.example.com/alice" }, { PEER_ALICE_TOKEN: "a2amcp_input-secret" }), /dedicated bearer token/);
 refused(run({ uri: "https://agents.example.com/alice" }, { PEER_ALICE_TOKEN: "input-secret\r\nx: bad" }), /dedicated bearer token/);
});

test("encrypted configs and pinned peers cannot be bypassed via helper", t => {
 const a = fixture(t);
 fs.mkdirSync(path.join(a.dir, "encryption"));
 fs.writeFileSync(path.join(a.dir, "encryption/state.sqlite"), "dummy");
 refused(a.run({ uri: "https://agents.example.com/alice" }), /cannot enforce encryption/);
 const b = fixture(t, { a: { url: "https://agents.example.com/alice", token_env: "PEER_ALICE_TOKEN", sealed: { policy: "required" } } });
 refused(b.run({ uri: "https://agents.example.com/alice" }), /cannot enforce encryption/);
});

test("malformed, multiple, missing and oversized input gives fixed errors without echoing data", t => {
 const { run } = fixture(t);
 for (const input of ["input-secret", "", "{}{}", "null", "[]", '{"uri":1}', '{}', "input-secret".repeat(6000)]) refused(run(input), /credential get/);
 for (const args of [["credential"], ["credential", "store"], ["credential", "get", "input-secret"]]) refused(run({}, {}, args), /usage:.*credential get/);
});

test("HTTP loopback fixtures are explicit exact matches", t => {
 const { run } = fixture(t, { local: { url: "http://127.0.0.1:12345", token_env: "PEER_ALICE_TOKEN" } });
 assert.equal(run({ uri: "http://127.0.0.1:12345/" }).status, 0);
 refused(run({ uri: "http://127.0.0.1:12346/" }), /No outbound peer/);
});

test("unclosed stdin fails within bounded time without prompting", async t => {
 const { dir, env } = fixture(t);
 const child = spawn(process.execPath, [BIN, "--config-dir", dir, "credential", "get"], { env, stdio: ["pipe", "pipe", "pipe"] });
 t.after(() => child.kill());
 let stdout = "", stderr = "";
 child.stdout.on("data", d => stdout += d);
 child.stderr.on("data", d => stderr += d);
 child.stdin.write('{"uri":"input-secret"}');
 const status = await new Promise(resolve => child.once("exit", resolve));
 child.stdin.destroy();
 refused({ status, stdout, stderr }, /within 5 seconds/);
});
