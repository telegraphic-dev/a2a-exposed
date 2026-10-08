// A peer token set in the environment overrides the one in config.env (like every setting). When the two differ,
// connect / send / poll / peers warn on stderr, naming the variable but never either value. Covers the stale-variable
// case: connect saves a new token, but an old PEER_<ALIAS>_TOKEN in the environment still wins on the next send.
// No network: the real Worker (worker/src, D1 on node:sqlite) listens on 127.0.0.1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "../lib/config.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "a2a-exposed.mjs");

function sandbox(t, cfg = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-envtok-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	if (Object.keys(cfg).length) fs.writeFileSync(path.join(dir, "config.env"), Object.entries(cfg).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(A2A_|PEER_|CF_|CLOUDFLARE_)|WAKE_/.test(k)));
	Object.assign(env, { A2A_CONFIG_DIR: dir, A2A_POLL_SCALE: "0.05", A2A_NO_UPDATE_CHECK: "1" });
	const cli = (args, { input = "", extraEnv = {} } = {}) => new Promise((resolve) => {
		const ch = spawn(process.execPath, [BIN, ...args], { env: { ...env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		ch.stdout.on("data", (d) => (stdout += d));
		ch.stderr.on("data", (d) => (stderr += d));
		ch.on("close", (status) => resolve({ status, stdout, stderr }));
		ch.stdin.end(input);
	});
	const config = () => { try { return parseEnv(fs.readFileSync(path.join(dir, "config.env"), "utf8")); } catch { return {}; } };
	return { dir, file: path.join(dir, "config.env"), cli, config };
}

async function realWorker(t, envOver = {}) {
	const { default: worker } = await import("../../worker/src/index.ts");
	const { d1 } = await import("../../worker/test/d1.ts");
	const env = { DB: d1(new URL("../../worker/migrations/", import.meta.url)), OWNER_TOKEN: "owner-tok", AGENT_NAME: "Server Inbox", PUBLIC_URL: "", ...envOver };
	let skewMs = 0; // the Worker's clock: moved forward on every token poll, so the 5 s interval passes instantly
	const realNow = Date.now;
	Date.now = () => realNow() + skewMs;
	t.after(() => { Date.now = realNow; });
	const srv = http.createServer(async (req, res) => {
		let body = "";
		for await (const c of req) body += c;
		if (req.url === "/oauth/token") skewMs += 6000;
		const r = await worker.fetch(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: body || undefined }), env, { waitUntil() {}, passThroughOnException() {} });
		res.writeHead(r.status, Object.fromEntries(r.headers));
		res.end(Buffer.from(await r.arrayBuffer()));
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	t.after(() => srv.close());
	return { url: `http://127.0.0.1:${srv.address().port}` };
}

const overrides = (v, file) => `warning: ${v} is set in the environment and overrides the different peer token saved in ${file}; using the environment value. To use the saved token: unset ${v} (in the shell or service that sets it)`;
const justSaved = (v, file) => `warning: ${v} is set in the environment and overrides the token just saved in ${file}; the next send or poll would still use the environment value. To use the new token: unset ${v} (in the shell or service that sets it)`;

test("connect saves a new token while a stale PEER_<ALIAS>_TOKEN is exported: connect and the next send warn, without printing either value", async (t) => {
	const w = await realWorker(t, { PAIRING_APPROVAL: "agent" });
	const ownerSide = sandbox(t, { A2A_BASE_URL: w.url, A2A_OWNER_TOKEN: "owner-tok" });
	// the client's own inbox is the same Worker (history / outbound records), like the loopback self-test
	const client = sandbox(t, { A2A_AGENT_NAME: "Client Bot", A2A_BASE_URL: w.url, A2A_OWNER_TOKEN: "owner-tok" });
	const STALE = "a2aow_stale-env-token-value";
	const stale = { extraEnv: { PEER_SRV_TOKEN: STALE } };
	const leaks = (r, ...vals) => vals.filter(Boolean).some((v) => (r.stdout + r.stderr).includes(v));

	let r = await client.cli(["connect", w.url, "--alias", "srv", "--no-wait"], stale);
	assert.equal(r.status, 0, r.stderr);
	assert.ok(!r.stderr.includes("warning: PEER_SRV_TOKEN"), "nothing saved yet: nothing to warn about");
	const list = JSON.parse((await ownerSide.cli(["pair", "list", "--json"])).stdout);
	assert.equal((await ownerSide.cli(["pair", "approve", list.pending[0].userCode])).status, 0);

	// connect stores the new token; the exported stale one would still win: warned on stderr (also with --json)
	r = await client.cli(["connect", w.url, "--alias", "srv", "--no-wait", "--json"], stale);
	assert.equal(r.status, 0, r.stderr);
	const saved = client.config().PEER_SRV_TOKEN;
	assert.match(saved, /^a2aow_/);
	assert.ok(r.stderr.includes(justSaved("PEER_SRV_TOKEN", client.file)), r.stderr);
	const connected = r.stdout.trim().split("\n").map((l) => JSON.parse(l)).at(-1);
	assert.deepEqual([connected.status, connected.env_overrides_token], ["connected", true]);
	assert.ok(!leaks(r, STALE, saved));

	// next send: the environment still wins (the peer rejects the stale token), and the CLI says why
	r = await client.cli(["send", "--to", "srv", "--text", "hi"], stale);
	assert.equal(r.status, 1);
	assert.ok(r.stderr.includes(overrides("PEER_SRV_TOKEN", client.file)), r.stderr);
	assert.match(r.stderr, /peer "srv" rejected our token/);
	assert.ok(!leaks(r, STALE, saved));

	// poll by URL resolves to the same alias and warns the same way
	r = await client.cli(["poll", "--to", w.url, "00000000-0000-4000-8000-000000000000"], stale);
	assert.ok(r.stderr.includes(overrides("PEER_SRV_TOKEN", client.file)), r.stderr);
	assert.ok(!leaks(r, STALE, saved));

	// after `unset`: the saved token is used, no warning; the same value in both places is no override either
	for (const opts of [{}, { extraEnv: { PEER_SRV_TOKEN: saved } }]) {
		r = await client.cli(["send", "--to", "srv", "--text", "hi"], opts);
		assert.equal(r.status, 0, r.stderr);
		assert.ok(!r.stderr.includes("warning: PEER_SRV_TOKEN"), r.stderr);
	}
});

test("peers add --token-stdin and peers list warn when the environment shadows a different saved token", async (t) => {
	const s = sandbox(t);
	const env = { extraEnv: { PEER_BOB_TOKEN: "env-value-secret" } };
	let r = await s.cli(["peers", "add", "bob", "https://bob.example.com", "--token-stdin"], { input: "saved-value-secret\n", ...env });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(s.config().PEER_BOB_TOKEN, "saved-value-secret");
	assert.ok(r.stderr.includes(justSaved("PEER_BOB_TOKEN", s.file)), r.stderr);
	r = await s.cli(["peers", "list"], env);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /^bob\thttps:\/\/bob\.example\.com\ttoken_env=PEER_BOB_TOKEN\t\(set\)$/m, "stdout unchanged");
	assert.ok(r.stderr.includes(overrides("PEER_BOB_TOKEN", s.file)), r.stderr);
	for (const x of [r.stdout, r.stderr]) assert.ok(!x.includes("env-value-secret") && !x.includes("saved-value-secret"));
	// only in config.env, or only in the environment: nothing to warn about
	assert.equal((await s.cli(["peers", "list"])).stderr, "");
	assert.equal((await s.cli(["peers", "add", "amy", "https://amy.example.com"], { extraEnv: { PEER_AMY_TOKEN: "x" } })).stderr, "");
});
