// Device-flow pairing from the CLI: `connect` against a mocked authorization server (timing, errors, discovery), and
// against the real Worker (worker/src, D1 on node:sqlite) for connect + pair list/approve/deny + token list.
// No network: everything listens on 127.0.0.1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "../lib/config.mjs";
import { deviceEndpointsFromCard, passwordRecord } from "../lib/pair.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "a2a-over-webhook.mjs");
const GRANT = "urn:ietf:params:oauth:grant-type:device_code";

function sandbox(t, cfg = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-pair-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	if (Object.keys(cfg).length) fs.writeFileSync(path.join(dir, "config.env"), Object.entries(cfg).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(A2A_|PEER_)|WAKE_/.test(k)));
	Object.assign(env, { A2A_CONFIG_DIR: dir, A2A_POLL_SCALE: "0.05" });
	const cli = (args, { input = "", extraEnv = {} } = {}) => new Promise((resolve) => {
		const ch = spawn(process.execPath, [BIN, ...args], { env: { ...env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		ch.stdout.on("data", (d) => (stdout += d));
		ch.stderr.on("data", (d) => (stderr += d));
		ch.on("close", (status) => resolve({ status, stdout, stderr }));
		ch.stdin.end(input);
	});
	const config = () => { try { return parseEnv(fs.readFileSync(path.join(dir, "config.env"), "utf8")); } catch { return {}; } };
	const peers = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, "peers.json"), "utf8")); } catch { return {}; } };
	return { dir, env, cli, config, peers };
}

/** A scripted authorization server: token responses come from `script` in order (the last one repeats). */
async function mockServer(t, { script = [], card = true, metadata = false } = {}) {
	const seen = { device: [], token: [] };
	let i = 0;
	const srv = http.createServer(async (req, res) => {
		let body = "";
		for await (const c of req) body += c;
		const base = `http://${req.headers.host}`;
		const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
		if (req.url === "/.well-known/agent-card.json")
			return card ? send(200, { name: "Peer Inbox", supportedInterfaces: [{ url: base + "/", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
				securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } },
					pairing: { oauth2SecurityScheme: { flows: { deviceCode: { deviceAuthorizationUrl: base + "/oauth/device_authorization", tokenUrl: base + "/oauth/token", scopes: {} } } } } } })
				: send(200, { name: "Peer Inbox", securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } } });
		if (req.url === "/.well-known/oauth-authorization-server")
			return metadata ? send(200, { issuer: base, device_authorization_endpoint: base + "/oauth/device_authorization", token_endpoint: base + "/oauth/token", grant_types_supported: [GRANT] }) : send(404, {});
		if (req.url === "/oauth/device_authorization") {
			seen.device.push({ type: req.headers["content-type"], params: Object.fromEntries(new URLSearchParams(body)) });
			return send(200, { device_code: "dev-code-secret", user_code: "WDJB-4827", verification_uri: base + "/device", verification_uri_complete: base + "/device?user_code=WDJB-4827", expires_in: 600, interval: 1 });
		}
		if (req.url === "/oauth/token") {
			seen.token.push({ at: Date.now(), params: Object.fromEntries(new URLSearchParams(body)) });
			const step = script[Math.min(i++, script.length - 1)];
			return send(step.access_token ? 200 : 400, step);
		}
		send(404, {});
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	t.after(() => srv.close());
	return { url: `http://127.0.0.1:${srv.address().port}`, seen };
}

test("deviceEndpointsFromCard reads the A2A 1.0 oauth2SecurityScheme deviceCode flow", () => {
	assert.equal(deviceEndpointsFromCard({ securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } } }), null);
	assert.deepEqual(deviceEndpointsFromCard({ securitySchemes: { x: { oauth2SecurityScheme: { flows: { deviceCode: { deviceAuthorizationUrl: "https://a/d", tokenUrl: "https://a/t" } } } } } }), { device: "https://a/d", token: "https://a/t" });
	assert.equal(deviceEndpointsFromCard(null), null);
});

test("connect: shows the code and link, honours interval and slow_down, stores the token as a peer without printing it", async (t) => {
	const m = await mockServer(t, { script: [{ error: "authorization_pending" }, { error: "slow_down" }, { error: "authorization_pending" }, { access_token: "a2aow_paired-secret", token_type: "Bearer" }] });
	const s = sandbox(t, { A2A_AGENT_NAME: "Client Bot", A2A_WORKER_NAME: "client-bot", A2A_BASE_URL: "https://client.example.com" });
	const r = await s.cli(["connect", m.url, "--alias", "peer1"]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stderr, /Pairing with Peer Inbox \(http:\/\/127\.0\.0\.1:\d+\):\n  code: WDJB-4827\n  link: http:\/\/127\.0\.0\.1:\d+\/device\?user_code=WDJB-4827\nShow this code and link to your human\. They confirm the code with the owner of Peer Inbox, who approves it on that page \(expires in 10 minutes\)\./);
	assert.match(r.stderr, /connected: peer "peer1" -> http:\/\/127\.0\.0\.1:\d+ \(token stored in .*config\.env as PEER_PEER1_TOKEN; not printed\)/);
	assert.ok(!(r.stdout + r.stderr).includes("a2aow_paired-secret") && !(r.stdout + r.stderr).includes("dev-code-secret"));
	assert.equal(s.config().PEER_PEER1_TOKEN, "a2aow_paired-secret");
	assert.deepEqual({ ...s.peers().peer1, paired: undefined }, { url: m.url, token_env: "PEER_PEER1_TOKEN", token_stored: true, paired: undefined });
	assert.equal(s.peers().peer1.paired.userCode, "WDJB-4827");
	assert.ok(!fs.existsSync(path.join(s.dir, "pairing-peer1.json")), "pending state removed");
	// the request: form-encoded, who is asking, our card
	assert.equal(m.seen.device.length, 1);
	assert.equal(m.seen.device[0].type, "application/x-www-form-urlencoded");
	assert.deepEqual(m.seen.device[0].params, { client_name: "Client Bot", client_id: "client-bot", agent_card_url: "https://client.example.com/.well-known/agent-card.json" });
	assert.equal(m.seen.token.length, 4);
	assert.ok(m.seen.token.every((x) => x.params.grant_type === GRANT && x.params.device_code === "dev-code-secret"));
	// interval 1 s and +5 s after slow_down (scaled by A2A_POLL_SCALE=0.05: 50 ms, then 300 ms)
	const gaps = m.seen.token.slice(1).map((x, k) => x.at - m.seen.token[k].at);
	assert.ok(gaps[0] >= 40, `gap ${gaps[0]}`);
	assert.ok(gaps[1] >= 270 && gaps[2] >= 270, `after slow_down: ${gaps}`);
});

test("connect --json: one JSON line per step, for agents", async (t) => {
	const m = await mockServer(t, { script: [{ access_token: "a2aow_x", token_type: "Bearer" }] });
	const s = sandbox(t);
	const r = await s.cli(["connect", `${m.url}/.well-known/agent-card.json`, "--json"]);
	assert.equal(r.status, 0, r.stderr);
	const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(lines.map((l) => l.status), ["authorization_pending", "connected"]);
	assert.equal(lines[0].user_code, "WDJB-4827");
	assert.equal(lines[0].verification_uri_complete, `${m.url}/device?user_code=WDJB-4827`);
	assert.match(lines[0].instructions, /Show the code and the link to your human/);
	assert.deepEqual([lines[1].alias, lines[1].token_env], ["peer-inbox", "PEER_PEER_INBOX_TOKEN"], "alias from the card name");
	assert.ok(!r.stdout.includes("a2aow_x"));
	assert.equal(m.seen.device[0].params.client_name, "a2a-over-webhook agent", "no agent name configured");
	assert.ok(!("agent_card_url" in m.seen.device[0].params), "no own https base URL: no card URL sent");
});

test("connect: denied, expired and used codes end cleanly (exit 1, no token, state removed)", async (t) => {
	for (const [error, re] of [["access_denied", /the owner of Peer Inbox denied the pairing request \(code WDJB-4827\)/], ["expired_token", /expired before it was approved; run `a2a-over-webhook connect .*` again/], ["invalid_grant", /no longer valid/]]) {
		const m = await mockServer(t, { script: [{ error: "authorization_pending" }, { error }] });
		const s = sandbox(t);
		const r = await s.cli(["connect", m.url, "--alias", "p"]);
		assert.equal(r.status, 1, error);
		assert.match(r.stderr, re);
		assert.deepEqual(s.peers(), {});
		assert.ok(!fs.existsSync(path.join(s.dir, "pairing-p.json")));
	}
});

test("connect --no-wait prints the code and exits; connect again resumes the same request", async (t) => {
	const m = await mockServer(t, { script: [{ access_token: "a2aow_y", token_type: "Bearer" }] });
	const s = sandbox(t);
	let r = await s.cli(["connect", m.url, "--alias", "p", "--no-wait"]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stderr, /code: WDJB-4827[\s\S]*Not waiting \(--no-wait\)\. Once approved, run `a2a-over-webhook connect http:\/\/127\.0\.0\.1:\d+ --alias p` again/);
	const st = path.join(s.dir, "pairing-p.json");
	assert.equal(fs.statSync(st).mode & 0o777, 0o600, "the device code is kept private");
	assert.equal(m.seen.token.length, 0);
	r = await s.cli(["connect", m.url, "--alias", "p"]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stderr, /Resuming the pairing request to Peer Inbox \(code WDJB-4827\)/);
	assert.equal(m.seen.device.length, 1, "no second request");
	assert.equal(s.config().PEER_P_TOKEN, "a2aow_y");
});

test("connect discovers the endpoints from RFC 8414 metadata; without any, it points to token issue", async (t) => {
	const m = await mockServer(t, { card: false, metadata: true, script: [{ access_token: "a2aow_z", token_type: "Bearer" }] });
	const s = sandbox(t);
	assert.equal((await s.cli(["connect", m.url, "--alias", "meta"])).status, 0);
	assert.equal(s.config().PEER_META_TOKEN, "a2aow_z");
	const none = await mockServer(t, { card: false, metadata: false });
	const r = await s.cli(["connect", none.url]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /does not offer device-flow pairing[\s\S]*token issue <label>[\s\S]*peers add <alias> http:\/\/127\.0\.0\.1:\d+ --token-stdin/);
	assert.equal((await s.cli(["connect", "not a url"])).status, 1);
});

test("pair set-password: refuses argv and non-terminal stdin; in a terminal it uploads only a PBKDF2 record", async (t) => {
	const got = [];
	const srv = http.createServer(async (req, res) => {
		let body = "";
		for await (const c of req) body += c;
		got.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, mode: "human" }));
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	t.after(() => srv.close());
	const s = sandbox(t, { A2A_BASE_URL: `http://127.0.0.1:${srv.address().port}`, A2A_OWNER_TOKEN: "owner-tok" });
	let r = await s.cli(["pair", "set-password", "hunter2hunter2"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /takes no arguments: it reads the password from the terminal/);
	r = await s.cli(["pair", "set-password", "--password", "x"]);
	assert.equal(r.status, 1);
	r = await s.cli(["pair", "set-password"], { input: "a long enough password\na long enough password\n" });
	assert.equal(r.status, 1);
	assert.match(r.stderr, /stdin is not a terminal[\s\S]*known only to the human/);
	assert.equal(got.length, 0);

	// a real pty (util-linux / BSD `script`), typing the password twice
	const pw = "a long enough passphrase";
	const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} pair set-password`;
	const args = process.platform === "darwin" ? ["-q", "/dev/null", "sh", "-c", cmd] : ["-qec", cmd, "/dev/null"];
	const out = await new Promise((resolve) => {
		const ch = spawn("script", args, { env: s.env, stdio: ["pipe", "pipe", "pipe"] });
		let o = "";
		ch.stdout.on("data", (d) => {
			o += d;
			if (/New approval password/.test(o) && !ch.typed1) { ch.typed1 = true; ch.stdin.write(pw + "\r"); }
			if (/Repeat it/.test(o) && !ch.typed2) { ch.typed2 = true; ch.stdin.write(pw + "\r"); }
		});
		ch.stderr.on("data", (d) => (o += d));
		ch.on("close", (status) => resolve({ status, o }));
	});
	assert.equal(out.status, 0, out.o);
	assert.ok(!out.o.includes(pw), "not echoed");
	assert.match(out.o, /approval password set/);
	assert.equal(got.length, 1);
	assert.deepEqual([got[0].method, got[0].url, got[0].auth], ["PUT", "/owner/pairing/password", "Bearer owner-tok"]);
	const rec = got[0].body;
	assert.deepEqual(Object.keys(rec).sort(), ["alg", "hash", "iterations", "salt"]);
	assert.equal(rec.alg, "pbkdf2-sha256");
	assert.equal(rec.iterations, 100000);
	assert.ok(!JSON.stringify(rec).includes(pw));
	assert.equal(crypto.pbkdf2Sync(pw, Buffer.from(rec.salt, "base64"), 100000, 32, "sha256").toString("base64"), rec.hash);
	assert.notEqual(passwordRecord(pw).salt, passwordRecord(pw).salt, "salted");
});

// ------------------------------------------------------------------ against the real Worker
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
	return { url: `http://127.0.0.1:${srv.address().port}`, env };
}

test("connect against the real Worker (agent approval): pair list, pair approve, token list shows the pairing", async (t) => {
	const w = await realWorker(t, { PAIRING_APPROVAL: "agent" });
	const ownerSide = sandbox(t, { A2A_BASE_URL: w.url, A2A_OWNER_TOKEN: "owner-tok" });
	const client = sandbox(t, { A2A_AGENT_NAME: "Client Bot", A2A_BASE_URL: "https://client.example.com" });
	let r = await client.cli(["connect", w.url, "--no-wait", "--json"]);
	assert.equal(r.status, 0, r.stderr);
	const code = JSON.parse(r.stdout.split("\n")[0]).user_code;
	assert.match(code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[2-9]{4}$/);

	r = await ownerSide.cli(["pair", "list"]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /^approval: agent \(`a2a-over-webhook pair approve <code>` after your human says yes/m);
	assert.match(r.stdout, /^approval password: NOT SET/m);
	assert.match(r.stdout, new RegExp(`^--- ${code}  "Client Bot" \\(claimed, untrusted\\)`, "m"));
	assert.match(r.stdout, /card: https:\/\/client\.example\.com\/\.well-known\/agent-card\.json/);
	assert.match(r.stdout, /never approve on your own/);
	r = await ownerSide.cli(["pair", "approve", code.toLowerCase()]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, new RegExp(`^approved ${code} \\("Client Bot"\\): the agent collects its token on its next poll, as peer "Client-Bot"`));

	r = await client.cli(["connect", w.url]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stderr, /connected: peer "server-inbox"/);
	const tok = client.config().PEER_SERVER_INBOX_TOKEN;
	assert.match(tok, /^a2aow_/);
	r = await ownerSide.cli(["token", "list"]);
	assert.match(r.stdout, new RegExp(`^Client-Bot\\tcreated=\\S+\\tactive\\tvia pairing: code ${code}, "Client Bot"$`, "m"));
	// the stored token works for A2A calls
	const rpc = await fetch(w.url + "/", { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", "a2a-version": "1.0" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "none" } }) });
	assert.equal((await rpc.json()).error.code, -32001);
	// deny in any mode; unknown codes are explained
	r = await client.cli(["connect", w.url, "--alias", "again", "--no-wait", "--json"]);
	const code2 = JSON.parse(r.stdout.split("\n")[0]).user_code;
	r = await ownerSide.cli(["pair", "deny", code2]);
	assert.match(r.stdout, new RegExp(`^denied ${code2}`));
	r = await client.cli(["connect", w.url, "--alias", "again"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /denied the pairing request/);
	r = await ownerSide.cli(["pair", "approve", "BCDF-2345"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /no pairing request with that code/);
});

test("human approval mode: pair approve is refused and points to the /device page", async (t) => {
	const w = await realWorker(t);
	const ownerSide = sandbox(t, { A2A_BASE_URL: w.url, A2A_OWNER_TOKEN: "owner-tok", A2A_D1_ID: "d1", A2A_WORKER_NAME: "server", A2A_WORKER_DIR: "/nonexistent" });
	const client = sandbox(t);
	const code = JSON.parse((await client.cli(["connect", w.url, "--no-wait", "--json"])).stdout.split("\n")[0]).user_code;
	const r = await ownerSide.cli(["pair", "approve", code]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, new RegExp(`approval mode is human: the owner approves on http://127\\.0\\.0\\.1:\\d+/device\\?user_code=${code} with the approval password`));
	const st = await ownerSide.cli(["status", "--json"], { extraEnv: { A2A_VERIFY_TRIES: "0" } });
	const j = JSON.parse(st.stdout);
	assert.deepEqual(j.pairing, { mode: "human", passwordSet: false, pending: 1 });
	assert.match(j.nextStep, /Peers can't connect with `a2a-over-webhook connect` yet: your human sets the approval password with `a2a-over-webhook pair set-password`/);
	const txt = await ownerSide.cli(["status"]);
	assert.match(txt.stdout, /^pairing: +human approval; approval password NOT SET; 1 pending request\(s\): a2a-over-webhook pair list$/m);
});

test("init --pairing-approval only takes human, agent or off", async (t) => {
	const s = sandbox(t);
	const r = await s.cli(["init", "--pairing-approval", "auto", "--skip-install"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /--pairing-approval must be one of human \| agent \| off/);
});
