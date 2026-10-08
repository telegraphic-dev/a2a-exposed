// Fixes from the v0.2.0 from-scratch test: Node guidance, update notice, Cloudflare error codes, card propagation,
// --config-dir / url, the web password-setup link, pairing requests in the inbox, token revoke, re-pairing with
// --replace, expired resumes and friendly 401s. No network: everything listens on 127.0.0.1 (real Worker code on
// node:sqlite where it matters).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "../lib/config.mjs";
import { cfErrorCode, describeHttp } from "../lib/a2a.mjs";
import { checkNode, NODE_HELP, verifyCard } from "../lib/deploy.mjs";
import { nextStep } from "../lib/status.mjs";
import * as U from "../lib/update.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "a2a-exposed.mjs");

function sandbox(t, cfg = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-fix-test-"));
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
	const peers = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, "peers.json"), "utf8")); } catch { return {}; } };
	return { dir, env, cli, config, peers };
}

async function realWorker(t, envOver = {}) {
	const { default: worker } = await import("../../worker/src/index.ts");
	const { d1 } = await import("../../worker/test/d1.ts");
	const env = { DB: d1(new URL("../../worker/migrations/", import.meta.url)), OWNER_TOKEN: "owner-tok", AGENT_NAME: "Server Inbox", PUBLIC_URL: "", ...envOver };
	let skewMs = 0;
	const realNow = Date.now;
	Date.now = () => realNow() + skewMs;
	t.after(() => { Date.now = realNow; });
	const srv = http.createServer(async (req, res) => {
		let body = "";
		for await (const c of req) body += c;
		if (req.url === "/oauth/token") skewMs += 6000;
		const r = await worker.fetch(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: body || undefined }), { ...env }, { waitUntil() {}, passThroughOnException() {} });
		const h = Object.fromEntries(r.headers);
		res.writeHead(r.status, h);
		res.end(Buffer.from(await r.arrayBuffer()));
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	t.after(() => srv.close());
	return { url: `http://127.0.0.1:${srv.address().port}`, env };
}
const jsonLines = (s) => s.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

// ------------------------------------------------------------------ F1: Node guidance
test("checkNode: an old Node is refused with ways to get Node 22 (mise first, then nvm, fnm, installer)", () => {
	assert.throws(() => checkNode("20.19.2"), (e) => /Node 20\.19\.2 found; init\/deploy need Node 22\.18\+/.test(e.message) && e.message.includes(NODE_HELP));
	assert.throws(() => checkNode("v22.17.9"), /22\.18\+/);
	checkNode("22.18.0"); checkNode("24.1.0");
	for (const re of [/mise exec node@22 -- npx a2a-exposed/, /mise use node@22/, /telegraphic-dev\/mise-skill/, /nvm install 22/, /fnm install 22/, /nodejs\.org/])
		assert.match(NODE_HELP, re);
});

// ------------------------------------------------------------------ F3: update notice
test("update notice: version compare, 24 h cache, opt-outs, no notice from a checkout", (t) => {
	assert.ok(U.newer("0.3.0", "0.2.0") && U.newer("0.10.0", "0.9.9") && U.newer("1.0.0", "1.0.0-rc.1"));
	assert.ok(!U.newer("0.2.0", "0.2.0") && !U.newer("0.1.9", "0.2.0"));
	assert.equal(U.notice("0.2.0", { latest: "0.2.0" }), "");
	assert.equal(U.notice("0.2.0", null), "");
	assert.match(U.notice("0.2.0", { latest: "0.3.1" }), /^a2a-exposed 0\.3\.1 is available \(you have 0\.2\.0\): npm i -g a2a-exposed@latest, then a2a-exposed deploy/);
	const now = Date.now();
	assert.ok(U.due(null, now) && U.due({ checkedAt: now - U.CHECK_INTERVAL_MS - 1 }, now) && !U.due({ checkedAt: now - 1000 }, now));
	const installed = path.join("/usr/lib/node_modules/a2a-exposed/lib/update.mjs");
	assert.equal(U.disabled({}, installed), false);
	for (const env of [{ A2A_NO_UPDATE_CHECK: "1" }, { DO_NOT_TRACK: "1" }, { NO_UPDATE_NOTIFIER: "1" }, { CI: "true" }]) assert.equal(U.disabled(env, installed), true, JSON.stringify(env));
	assert.equal(U.disabled({ DO_NOT_TRACK: "0" }, installed), false);
	assert.equal(U.disabled({}, "/home/me/src/a2a-exposed/cli/lib/update.mjs"), true, "a repo checkout");
	// check(): prints from the cache, and only refreshes when the cache is older than 24 h
	const cache = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-upd-"));
	t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
	const env = { XDG_CACHE_HOME: cache };
	const file = U.cacheFile(env);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ latest: "9.9.9", checkedAt: now }));
	const out = [];
	U.check("0.2.0", { env, here: installed, spawnCheck: false, write: (s) => out.push(s) });
	assert.equal(out.length, 1);
	assert.match(out[0], /^note: a2a-exposed 9\.9\.9 is available/);
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).checkedAt, now, "fresh cache: not touched");
	fs.writeFileSync(file, JSON.stringify({ latest: "0.2.0", checkedAt: 1 }));
	U.check("0.2.0", { env, here: installed, spawnCheck: false, write: (s) => out.push(s) });
	assert.equal(out.length, 1, "up to date: no notice");
	assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).checkedAt > 1, "stale cache: refresh slot claimed");
	U.check("0.1.0", { env: { ...env, A2A_NO_UPDATE_CHECK: "1" }, here: installed, spawnCheck: false, write: (s) => out.push(s) });
	assert.equal(out.length, 1, "opted out");
});

// ------------------------------------------------------------------ F4: Cloudflare error codes, propagation
test("describeHttp names Cloudflare error codes instead of dumping HTML; JSON errors stay readable", () => {
	assert.equal(cfErrorCode("error code: 1042"), 1042);
	assert.equal(cfErrorCode("<html><title>Worker threw exception | Error 1101</title>"), 1101);
	assert.equal(cfErrorCode({ error: "x" }), null);
	assert.match(describeHttp(404, "error code: 1042"), /^HTTP 404, Cloudflare error 1042: no Worker answers on this workers\.dev host yet: a new deployment takes up to ~30 s/);
	assert.match(describeHttp(503, "<html>Error 1102 ...</html>"), /Cloudflare error 1102: the Worker exceeded its CPU or memory limit/);
	assert.equal(describeHttp(401, { error: "unauthorized" }), "HTTP 401: unauthorized");
	assert.equal(describeHttp(200, { error: { code: -32001, message: "Task not found" } }), "HTTP 200: -32001 Task not found");
	assert.ok(describeHttp(502, "<html>" + "x".repeat(1000) + "</html>").length < 200, "excerpt only");
});

test("verifyCard: a card counts as up only when served twice in a row (200, then 1042 while propagating)", async (t) => {
	const answers = [[200, true], [404, false], [200, true], [200, true]];
	let n = 0;
	const srv = http.createServer((req, res) => {
		const [status, card] = answers[Math.min(n++, answers.length - 1)];
		if (card) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ name: "Card", supportedInterfaces: [{ url: `http://${req.headers.host}/`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }] })); }
		res.writeHead(status, { "content-type": "text/plain" }); res.end("error code: 1042");
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	t.after(() => srv.close());
	const base = `http://127.0.0.1:${srv.address().port}`;
	const waits = [];
	const r = await verifyCard(base, { tries: 6, intervalMs: 5, onWait: (w) => waits.push(w) });
	assert.equal(r.ok, true);
	assert.equal(n, 4, "OK, 1042, OK, OK");
	assert.deepEqual(waits, ["Cloudflare error 1042 (the new Worker is still propagating)"]);
	n = 1; answers.splice(0, answers.length, [404, false]);
	const bad = await verifyCard(base, { tries: 3, intervalMs: 5 });
	assert.equal(bad.ok, false);
	assert.match(bad.lastError, /1042/);
});

test("status: Cloudflare 1042 on the card is 'still propagating, retry in 30 s', not a raw error", () => {
	const s = { deployed: true, baseUrl: "https://a.example.com", hasOwnerToken: true, configFile: "/cfg/config.env",
		card: { ok: false, error: "HTTP 404, Cloudflare error 1042: ...", cfError: 1042 }, ownerApi: { ok: true }, wake: { configured: false } };
	const r = nextStep(s);
	assert.equal(r.ok, false);
	assert.match(r.text, /^the Worker is still propagating \(Cloudflare error 1042.*run `a2a-exposed status` again in 30 seconds/);
});

// ------------------------------------------------------------------ F16 / F17: --config-dir, url
test("url exits 1 when nothing is configured; --config-dir picks the config dir (both forms)", async (t) => {
	const empty = sandbox(t);
	let r = await empty.cli(["url"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /no base URL configured in .*config\.env: run `a2a-exposed init`/);
	const other = sandbox(t, { A2A_BASE_URL: "https://other.example.com" });
	r = await empty.cli(["url", "--config-dir", other.dir]);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout.trim(), "https://other.example.com");
	r = await empty.cli([`--config-dir=${other.dir}`, "config"]);
	assert.equal(r.stdout.split("\n")[0], `# ${path.join(other.dir, "config.env")}`);
	r = await empty.cli(["url", "--config-dir"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /--config-dir needs a directory/);
});

test("init --pbkdf2-iterations and --workers-logs are validated", async (t) => {
	const s = sandbox(t);
	let r = await s.cli(["init", "--pbkdf2-iterations", "10000", "--skip-install"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /--pbkdf2-iterations must be an integer from 50000 to 100000/);
	r = await s.cli(["init", "--workers-logs", "yes", "--skip-install"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /--workers-logs must be on or off/);
});

// ------------------------------------------------------------------ web password setup link
async function setPasswordOnPage(link, password, password2 = password) {
	const g = await fetch(link);
	const cookie = (g.headers.get("set-cookie") || "").split(";")[0];
	const html = await g.text();
	const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] || cookie.split("=")[1];
	const t = new URL(link).searchParams.get("t");
	const p = await fetch(new URL("/device/setup", link), { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: new URL(link).origin },
		body: new URLSearchParams({ csrf, t, password, password2 }).toString() });
	return { get: g.status, html, status: p.status, body: await p.text() };
}

test("pair set-password --web: a one-time link; the human sets the password on the page; list and status show when", async (t) => {
	const w = await realWorker(t);
	const s = sandbox(t, { A2A_BASE_URL: w.url, A2A_OWNER_TOKEN: "owner-tok", A2A_D1_ID: "d1", A2A_WORKER_NAME: "server", A2A_WORKER_DIR: "/nonexistent" });
	let r = await s.cli(["pair", "set-password", "--web"]);
	assert.equal(r.status, 0, r.stderr);
	const link = r.stdout.trim();
	assert.match(link, new RegExp(`^${w.url.replace(/\./g, "\\.")}/device/setup\\?t=[A-Za-z0-9_-]{43}$`));
	assert.match(r.stderr, /valid 15 minutes.*single use/);
	assert.match(r.stderr, /Send this link to your human, privately.*Never open the link, fill in the page, or ask for the password yourself/);
	r = await s.cli(["pair", "list"]);
	assert.match(r.stdout, /^setup link: one is open until \S+/m);
	// a second link invalidates the first
	r = await s.cli(["pair", "set-password", "--web", "--json", "--ttl", "5"]);
	const j = JSON.parse(r.stdout);
	assert.equal(j.expiresIn, 300);
	assert.equal(j.singleUse, true);
	assert.match(j.instructions, /Never open the link/);
	assert.equal((await fetch(link)).status, 404, "old link invalidated");
	const page = await setPasswordOnPage(j.url, "correct horse battery");
	assert.equal(page.get, 200);
	assert.match(page.html, /name="password2"/);
	assert.equal(page.status, 200, page.body);
	assert.match(page.body, /Approval password set/);
	assert.ok(!page.body.includes("correct horse battery"), "never echoed");
	assert.equal((await fetch(j.url)).status, 404, "single use");
	r = await s.cli(["pair", "list"]);
	assert.match(r.stdout, /^approval password: set \d{4}-\d\d-\d\dT\S+ \(via web\)$/m);
	assert.doesNotMatch(r.stdout, /setup link:/);
	r = await s.cli(["status", "--json"], { extraEnv: { A2A_VERIFY_TRIES: "0" } });
	const st = JSON.parse(r.stdout);
	assert.equal(st.pairing.passwordSet, true);
	assert.equal(st.pairing.passwordSetVia, "web");
	assert.ok(!(st.also || []).some((a) => /set-password/.test(a)));
	// argument checks: the password itself is never an argument
	for (const args of [["pair", "set-password", "--ttl", "0", "--web"], ["pair", "set-password", "--ttl", "61", "--web"]]) {
		r = await s.cli(args);
		assert.equal(r.status, 1, args.join(" "));
		assert.match(r.stderr, /--ttl is the link lifetime in minutes, 1 to 60/);
	}
	r = await s.cli(["pair", "set-password", "--web", "hunter2hunter2"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /takes no password argument/);
});

test("pair set-password: the terminal path explains the --web alternative; pairing off refuses links", async (t) => {
	const off = await realWorker(t, { PAIRING_APPROVAL: "off" });
	const s = sandbox(t, { A2A_BASE_URL: off.url, A2A_OWNER_TOKEN: "owner-tok" });
	let r = await s.cli(["pair", "set-password"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /stdin is not a terminal[\s\S]*`a2a-exposed pair set-password --web` prints a one-time link/);
	r = await s.cli(["pair", "set-password", "--web"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /could not create a setup link: device-flow pairing is disabled/);
});

// ------------------------------------------------------------------ F5: pairing requests in the inbox
test("inbox shows pending pairing requests to polling agents (text and --json)", async (t) => {
	const w = await realWorker(t);
	const ownerSide = sandbox(t, { A2A_BASE_URL: w.url, A2A_OWNER_TOKEN: "owner-tok" });
	const client = sandbox(t, { A2A_AGENT_NAME: "Client Bot" });
	let r = await ownerSide.cli(["inbox"]);
	assert.equal(r.stdout.trim(), "(no unhandled tasks, no pending pairing requests)");
	r = await client.cli(["connect", w.url, "--no-wait", "--json"]);
	const code = jsonLines(r.stdout)[0].user_code;
	r = await ownerSide.cli(["inbox"]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /^=== 1 pending pairing request \(another agent asks to connect; human approval\)$/m);
	assert.match(r.stdout, new RegExp(`^--- code ${code}  "Client Bot" \\(claimed, untrusted\\)`, "m"));
	assert.match(r.stdout, new RegExp(`link: ${w.url.replace(/\./g, "\\.")}/device\\?user_code=${code}`));
	assert.match(r.stdout, /Never approve on your own/);
	r = await ownerSide.cli(["inbox", "--json"]);
	assert.deepEqual(JSON.parse(r.stdout), [], "stdout keeps the task array");
	const note = JSON.parse(r.stderr.trim());
	assert.equal(note.pendingPairingRequests, 1);
	assert.equal(note.requests[0].userCode, code);
	// --context is one conversation: no pairing section
	r = await ownerSide.cli(["inbox", "--context", "ctx-1"]);
	assert.doesNotMatch(r.stdout, /pairing/);
});

// ------------------------------------------------------------------ F12: token revoke
test("token revoke: unknown or already revoked labels exit 1; rotate of an unknown label exits 1", async (t) => {
	const w = await realWorker(t);
	const s = sandbox(t, { A2A_BASE_URL: w.url, A2A_OWNER_TOKEN: "owner-tok" });
	let r = await s.cli(["token", "revoke", "nobody"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /no active token with label nobody \(see token list\)/);
	r = await s.cli(["token", "issue", "bob"]);
	assert.equal(r.status, 0, r.stderr);
	r = await s.cli(["token", "revoke", "bob"]);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout.trim(), "revoked bob: its token gets HTTP 401 from now on");
	r = await s.cli(["token", "revoke", "bob"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /already revoked/);
	r = await s.cli(["token", "rotate", "bobb"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /HTTP 404/);
});

// ------------------------------------------------------------------ F6/F7/F8/F18: connect
test("connect: a working token is kept unless --replace; --replace swaps it under the same label; a revoked one re-pairs", async (t) => {
	const w = await realWorker(t, { PAIRING_APPROVAL: "agent" });
	const ownerSide = sandbox(t, { A2A_BASE_URL: w.url, A2A_OWNER_TOKEN: "owner-tok" });
	const client = sandbox(t, { A2A_AGENT_NAME: "Client Bot", A2A_WORKER_NAME: "client-bot" });
	const approveNext = async () => {
		const list = JSON.parse((await ownerSide.cli(["pair", "list", "--json"])).stdout);
		assert.equal(list.pending.length, 1);
		assert.equal((await ownerSide.cli(["pair", "approve", list.pending[0].userCode])).status, 0);
		return list.pending[0];
	};
	let r = await client.cli(["connect", w.url, "--alias", "srv", "--no-wait"]);
	await approveNext();
	r = await client.cli(["connect", w.url, "--alias", "srv", "--no-wait", "--json"]);
	assert.equal(r.status, 0, r.stderr);
	let lines = jsonLines(r.stdout);
	assert.deepEqual(lines.map((l) => l.status), ["authorization_pending", "connected"], "a resumed --no-wait checks once");
	assert.equal(lines[1].peer_label, "Client-Bot");
	assert.equal(client.peers().srv.paired.label, "Client-Bot");
	const tok1 = client.config().PEER_SRV_TOKEN;

	// again: refused, nothing requested
	r = await client.cli(["connect", w.url, "--alias", "srv"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /peer "srv" already has a token that works \(PEER_SRV_TOKEN\)\. Nothing to do[\s\S]*--replace/);
	assert.equal(JSON.parse((await ownerSide.cli(["pair", "list", "--json"])).stdout).pending.length, 0);

	// --replace: the request carries the old token, so approval swaps it under the same label
	r = await client.cli(["connect", w.url, "--alias", "srv", "--replace", "--no-wait", "--json"]);
	assert.equal(r.status, 0, r.stderr);
	lines = jsonLines(r.stdout);
	assert.equal(lines[0].replaces_label, "Client-Bot");
	assert.match(lines[0].instructions, /replaces our token "Client-Bot"/);
	assert.match(lines[1].next, /--alias srv --replace --no-wait --json$/, "the hint keeps every flag");
	const pending = await approveNext();
	assert.equal(pending.replacesLabel, "Client-Bot");
	r = await client.cli(["connect", w.url, "--alias", "srv", "--replace"]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stderr, /It replaced our previous token there \(label "Client-Bot"\)/);
	const tok2 = client.config().PEER_SRV_TOKEN;
	assert.notEqual(tok2, tok1);
	const call = (tok) => fetch(w.url + "/", { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", "a2a-version": "1.0" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "none" } }) });
	assert.equal((await call(tok1)).status, 401, "old token gone");
	assert.equal((await call(tok2)).status, 200);
	r = await ownerSide.cli(["token", "list"]);
	assert.equal(r.stdout.split("\n").filter((l) => /\tactive\t/.test(l)).length, 1, "no orphan token, no -2 label");

	// revoked on the peer: send explains how to re-pair; connect proceeds without --replace
	assert.equal((await ownerSide.cli(["token", "revoke", "Client-Bot"])).status, 0);
	r = await client.cli(["send", "--to", "srv", "--text", "hi"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, new RegExp(`peer "srv" rejected our token \\(HTTP 401: revoked, rotated, or never valid there\\)\\. Re-pair: a2a-exposed connect ${w.url.replace(/\./g, "\\.")} --alias srv`));
	r = await client.cli(["connect", w.url, "--alias", "srv", "--no-wait"]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stderr, /note: peer "srv" rejects the stored token \(HTTP 401: revoked or rotated\); requesting a new one/);
});

test("connect: resuming an expired request exits 1 and says so; the rerun hint keeps --alias and --name", async (t) => {
	const w = await realWorker(t);
	const ownerSide = sandbox(t, { A2A_BASE_URL: w.url, A2A_OWNER_TOKEN: "owner-tok" });
	const client = sandbox(t);
	let r = await client.cli(["connect", w.url, "--alias", "late", "--name", "My Bot", "--no-wait", "--json"]);
	const code = jsonLines(r.stdout)[0].user_code;
	const st = path.join(client.dir, "pairing-late.json");
	const saved = JSON.parse(fs.readFileSync(st, "utf8"));
	fs.writeFileSync(st, JSON.stringify({ ...saved, expiresAt: Date.now() - 1000 }), { mode: 0o600 });
	r = await client.cli(["connect", w.url, "--alias", "late", "--name", "My Bot"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, new RegExp(`the earlier pairing request to Server Inbox \\(code ${code}\\) expired before it was approved; nothing was stored\\.`));
	assert.match(r.stderr, /For a new code \(a new approval request to its owner\), run: a2a-exposed connect http:\/\/127\.0\.0\.1:\d+ --alias late --name 'My Bot'$/m);
	assert.ok(!fs.existsSync(st), "state dropped");
	assert.equal(JSON.parse((await ownerSide.cli(["pair", "list", "--json"])).stdout).pending.length, 1, "no second request was made");
});
