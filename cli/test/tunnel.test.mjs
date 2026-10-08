// Tunnel helpers: pure builders + Access header wiring (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	ORIGIN_DEFAULTS, HOSTED_PRESETS, ACCESS_SESSION, HOST_RE, randomLabel, zoneFor, validateOrigin, wakeUrl,
	cloudflareErrorCode, tunnelCreateBody, tunnelConfigBody, dnsCnameBody, serviceTokenBody, accessAppBody, secretsPatch, connectorInstructions,
} from "../lib/tunnel.mjs";

test("randomLabel: wake-<word>-<word>-<hex4>", () => {
	let i = 0;
	const seq = [0, 1, 0xab]; // first two pick WORDS[0]/WORDS[1], then hex
	assert.equal(randomLabel(() => seq[i++]), "wake-amber-brisk-00ab");
	assert.match(randomLabel(), /^wake-[a-z]+-[a-z]+-[0-9a-f]{4}$/);
});

test("zoneFor: longest matching suffix", () => {
	const zones = [{ name: "example.com", id: "1" }, { name: "sub.example.com", id: "2" }, { name: "other.org", id: "3" }];
	assert.equal(zoneFor("wake-a.example.com", zones).id, "1");
	assert.equal(zoneFor("wake-a.sub.example.com", zones).id, "2");
	assert.equal(zoneFor("example.com", zones).id, "1");
	assert.equal(zoneFor("nope.com", zones), null);
});

test("validateOrigin / wakeUrl / HOST_RE", () => {
	assert.equal(validateOrigin("http://127.0.0.1:18789"), "http://127.0.0.1:18789");
	assert.equal(validateOrigin("http://127.0.0.1:18789/"), "http://127.0.0.1:18789");
	assert.throws(() => validateOrigin("http://127.0.0.1:18789/hooks"), /scheme:\/\/host:port only/);
	assert.throws(() => validateOrigin("not-a-url"), /must be a URL/);
	assert.equal(wakeUrl("wake.example.com", "/hooks/wake"), "https://wake.example.com/hooks/wake");
	assert.ok(HOST_RE.test("wake-a.example.com") && !HOST_RE.test("bad_host") && !HOST_RE.test(".x.com"));
});

test("request builders: tunnel, DNS, Access app (service-token-only), secrets patch", () => {
	assert.deepEqual(tunnelCreateBody("a2a wake"), { name: "a2a wake", config_src: "cloudflare" });
	const cfg = tunnelConfigBody({ hostname: "wake.example.com", origin: "http://127.0.0.1:18789", wpath: "/hooks/wake.v1", teamName: "myteam", audTag: "aud123" });
	assert.equal(cfg.config.ingress.length, 2);
	assert.deepEqual(cfg.config.ingress[0], {
		hostname: "wake.example.com", path: "^/hooks/wake\\.v1$", service: "http://127.0.0.1:18789",
		originRequest: { access: { required: true, teamName: "myteam", audTag: ["aud123"] } },
	});
	assert.deepEqual(cfg.config.ingress[1], { service: "http_status:404" });
	assert.deepEqual(dnsCnameBody("wake.example.com", "tid", "c"), {
		type: "CNAME", name: "wake.example.com", content: "tid.cfargotunnel.com", proxied: true, ttl: 1, comment: "c",
	});
	assert.equal(serviceTokenBody("n").duration, "8760h");
	const app = accessAppBody({ name: "n", hostname: "wake.example.com", serviceTokenId: "stid" });
	assert.equal(app.type, "self_hosted");
	assert.equal(app.session_duration, ACCESS_SESSION);
	assert.equal(app.service_auth_401_redirect, true);
	assert.equal(app.policies.length, 1);
	assert.equal(app.policies[0].decision, "non_identity");
	assert.deepEqual(app.policies[0].include, [{ service_token: { token_id: "stid" } }]);
	assert.ok(!JSON.stringify(app).includes("everyone") && !JSON.stringify(app).includes("email"));
	assert.deepEqual(secretsPatch({ A: "v", B: null }), {
		secrets: { A: { name: "A", type: "secret_text", text: "v" }, B: null },
	});
});

test("connectorInstructions: token only with --show-token; --token-file preferred", () => {
	const quiet = connectorInstructions("/tmp/tok");
	assert.match(quiet, /cloudflared tunnel run --token-file \/tmp\/tok/);
	assert.match(quiet, /cloudflared service install "\$\(cat \/tmp\/tok\)"/);
	assert.ok(!quiet.includes("eyJ")); // no literal token
	const shown = connectorInstructions("/tmp/tok", "eyJtoken");
	assert.match(shown, /--token eyJtoken/);
	assert.match(shown, /service install eyJtoken/);
	assert.match(shown, /--show-token/);
});

test("cloudflareErrorCode: text and HTML error pages", () => {
	assert.equal(cloudflareErrorCode("error code: 1033"), "1033");
	assert.equal(cloudflareErrorCode('properties:{errorCode: 1033 }'), "1033");
	assert.equal(cloudflareErrorCode("<title>Error 1016</title>"), "1016");
	assert.equal(cloudflareErrorCode("all good"), "");
});

test("ORIGIN_DEFAULTS / HOSTED_PRESETS", () => {
	assert.deepEqual(ORIGIN_DEFAULTS["openclaw-wake"], ["http://127.0.0.1:18789", "/hooks/wake"]);
	assert.deepEqual(ORIGIN_DEFAULTS["openclaw-agent"], ["http://127.0.0.1:18789", "/hooks/agent"]);
	assert.deepEqual(ORIGIN_DEFAULTS.hermes, ["http://127.0.0.1:8644", ""]);
	assert.ok(HOSTED_PRESETS.includes("grok-bot") && HOSTED_PRESETS.includes("claude-code"));
});

// ------------------------------------------------------------------ tunnel create / rm against a stub cf
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "../lib/config.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "a2a-over-webhook.mjs");
const STUB = `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
const val = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
const pos = a.filter((x, i) => !x.startsWith("-") && !(i > 0 && a[i - 1].startsWith("--")) && !(i > 0 && a[i - 1] === "-z"));
const cmd = pos.slice(0, 4).join(" ");
const entry = { cmd: a.filter((x) => x !== val("--body")).join(" ") };
if (val("--body")) entry.body = JSON.parse(val("--body"));
if (val("--file")) entry.file = JSON.parse(fs.readFileSync(val("--file"), "utf8"));
fs.appendFileSync(process.env.STUB_DIR + "/calls.jsonl", JSON.stringify(entry) + "\\n");
const out = (o) => { process.stdout.write(typeof o === "string" ? o : JSON.stringify(o)); process.exit(0); };
const fail = (m) => { process.stderr.write(m); process.exit(1); };
const has = (s) => cmd.startsWith(s);
if (process.env.STUB_FAIL && has(process.env.STUB_FAIL)) fail("[1000] stub failure");
if (has("zones list")) out([{ id: "z1", name: "example.com" }]);
if (has("dns records list")) out(process.env.STUB_DNS_TAKEN ? [{ id: "x" }] : []);
if (has("zero-trust organization get")) process.env.STUB_NO_ACCESS ? fail("APIError [9999] access.api.error.not_enabled: Access is not enabled.") : out({ auth_domain: "team.cloudflareaccess.com" });
if (has("zero-trust organization create")) out({ auth_domain: JSON.parse(val("--body")).auth_domain });
if (has("zero-trust access service-tokens create")) out({ id: "st1", client_id: "cid.access", client_secret: "csecret" });
if (has("zero-trust access applications create")) out({ id: "app1", aud: "aud1" });
if (has("tunnels create")) out({ id: "tun1" });
if (has("tunnels token get")) out("eyJstubtoken");
if (has("dns records create")) out({ id: "dns1" });
out({});
`;

async function tunnelEnv(t, { preset = "openclaw-wake", hostname = "agent.example.com", stub = {} } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-tun-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const bin = path.join(dir, "worker", "node_modules", ".bin");
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(bin, "cf"), STUB, { mode: 0o755 });
	// owner API stand-in: wake preview reports the URL fingerprint the Worker holds
	let workerUrl = "";
	const srv = http.createServer((req, res) => {
		res.setHeader("content-type", "application/json");
		const fp = workerUrl ? createHash("sha256").update(workerUrl).digest("hex").slice(0, 12) : null;
		res.end(JSON.stringify({ configured: !!workerUrl, hasAccessServiceToken: true, fingerprints: { url: fp } }));
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	t.after(() => srv.close());
	const cfg = path.join(dir, "cfg");
	fs.mkdirSync(cfg);
	fs.writeFileSync(path.join(cfg, "config.env"), [
		"A2A_WORKER_NAME=tuntest", "A2A_D1_ID=d1", "CLOUDFLARE_ACCOUNT_ID=acc1", `WAKE_PRESET=${preset}`, "A2A_OWNER_TOKEN=owner",
		`A2A_BASE_URL=http://127.0.0.1:${srv.address().port}`, `A2A_WORKER_DIR=${path.join(dir, "worker")}`, ...(hostname ? [`A2A_HOSTNAME=${hostname}`] : []),
	].join("\n") + "\n", { mode: 0o600 });
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(A2A_|PEER_|CLOUDFLARE_|CF_)|WAKE_/.test(k)));
	Object.assign(env, { A2A_CONFIG_DIR: cfg, STUB_DIR: dir, ...stub });
	const cli = (args, extraEnv = {}) => new Promise((resolve) => {
		const ch = spawn(process.execPath, [BIN, ...args], { env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		ch.stdout.on("data", (d) => (stdout += d));
		ch.stderr.on("data", (d) => (stderr += d));
		ch.on("close", (status) => resolve({ status, stdout, stderr }));
	});
	const calls = () => { try { return fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
	const config = () => parseEnv(fs.readFileSync(path.join(cfg, "config.env"), "utf8"));
	return { dir, cfg, cli, calls, config, setWorkerUrl: (u) => (workerUrl = u) };
}

test("tunnel create: Access app + token before tunnel/DNS, secrets uploaded, token in a chmod-600 file, not printed", async (t) => {
	const s = await tunnelEnv(t);
	const r = await s.cli(["tunnel", "create", "--tunnel-hostname", "wake-test.example.com"], { WAKE_WEBHOOK_KEY: "hooks-token" });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout.trim(), "https://wake-test.example.com/hooks/wake");
	const cmds = s.calls().map((c) => c.cmd.split(" ").slice(0, 4).join(" "));
	const idx = (p) => cmds.findIndex((c) => c.startsWith(p));
	assert.ok(idx("zero-trust access service-tokens create") < idx("zero-trust access applications create"));
	assert.ok(idx("zero-trust access applications create") < idx("tunnels create"), "Access protects the hostname before it exists");
	assert.ok(idx("tunnels config update") < idx("dns records create"));
	const app = s.calls().find((c) => c.cmd.startsWith("zero-trust access applications create")).body;
	assert.deepEqual(app.policies.map((p) => [p.decision, p.include]), [["non_identity", [{ service_token: { token_id: "st1" } }]]]);
	const ingress = s.calls().find((c) => c.cmd.startsWith("tunnels config update")).body.config.ingress[0];
	assert.deepEqual(ingress, { hostname: "wake-test.example.com", path: "^/hooks/wake$", service: "http://127.0.0.1:18789",
		originRequest: { access: { required: true, teamName: "team", audTag: ["aud1"] } } });
	const bulk = s.calls().find((c) => c.cmd.startsWith("workers secrets bulk"));
	assert.match(bulk.cmd, /--worker tuntest/);
	assert.deepEqual(Object.keys(bulk.file.secrets).sort(), ["WAKE_ACCESS_CLIENT_ID", "WAKE_ACCESS_CLIENT_SECRET", "WAKE_WEBHOOK_KEY", "WAKE_WEBHOOK_URL"]);
	assert.equal(bulk.file.secrets.WAKE_WEBHOOK_URL.text, "https://wake-test.example.com/hooks/wake");
	const tokFile = path.join(s.cfg, "tunnel-token");
	assert.equal(fs.readFileSync(tokFile, "utf8").trim(), "eyJstubtoken");
	assert.equal(fs.statSync(tokFile).mode & 0o777, 0o600);
	assert.ok(!(r.stdout + r.stderr).includes("eyJstubtoken"), "token not printed without --show-token");
	assert.ok(!(r.stdout + r.stderr).includes("csecret"), "service token secret never printed");
	assert.match(r.stderr, /cloudflared tunnel run --token-file /);
	const c = s.config();
	assert.equal(c.A2A_TUNNEL_ID, "tun1");
	assert.equal(c.A2A_TUNNEL_ACCESS_APP_ID, "app1");
	assert.equal(c.A2A_TUNNEL_DNS_ID, "dns1");
	assert.equal(c.A2A_TUNNEL_ACCESS_CLIENT_SECRET, "csecret");

	// a different wake URL must not silently replace the tunnel's
	const d = await s.cli(["deploy", "--skip-install"], { WAKE_WEBHOOK_URL: "https://elsewhere.example.net/x" });
	assert.equal(d.status, 1);
	assert.match(d.stderr, /wakes through the tunnel/);

	// rm: secrets (incl. the URL, which the Worker reports as ours), DNS, tunnel, Access app, token; config cleaned
	s.setWorkerUrl("https://wake-test.example.com/hooks/wake");
	const before = s.calls().length;
	const rm = await s.cli(["tunnel", "rm"]);
	assert.equal(rm.status, 0, rm.stderr);
	const rmCalls = s.calls().slice(before);
	const rmCmds = rmCalls.map((c) => c.cmd);
	const ri = (p) => rmCmds.findIndex((c) => c.startsWith(p));
	assert.deepEqual(rmCalls[ri("workers secrets bulk")].file, { secrets: { WAKE_ACCESS_CLIENT_ID: null, WAKE_ACCESS_CLIENT_SECRET: null, WAKE_WEBHOOK_URL: null } });
	assert.ok(ri("workers secrets bulk") < ri("dns records delete dns1"));
	assert.ok(ri("dns records delete dns1") < ri("zero-trust access applications delete app1"), "DNS goes before its Access app");
	assert.ok(ri("tunnels delete tun1") >= 0 && ri("zero-trust access service-tokens delete st1") >= 0);
	assert.ok(!fs.existsSync(tokFile));
	assert.ok(!Object.keys(s.config()).some((k) => k.startsWith("A2A_TUNNEL_")));
});

test("tunnel create rolls back when a step fails", async (t) => {
	const s = await tunnelEnv(t, { stub: { STUB_FAIL: "dns records create" } });
	const r = await s.cli(["tunnel", "create", "--tunnel-hostname", "wake-test.example.com"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /rolling back/);
	const cmds = s.calls().map((c) => c.cmd);
	for (const p of ["tunnels delete tun1", "zero-trust access applications delete app1", "zero-trust access service-tokens delete st1"])
		assert.ok(cmds.some((c) => c.startsWith(p)), p);
	assert.ok(!Object.keys(s.config()).some((k) => k.startsWith("A2A_TUNNEL_")));
});

test("tunnel create refuses workers.dev-only deployments, hosted presets, and accounts without Access (nothing created)", async (t) => {
	const wd = await tunnelEnv(t, { hostname: "" });
	let r = await wd.cli(["tunnel", "create"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /needs a Cloudflare zone/);
	assert.match(r.stderr, /polling/);
	assert.equal(wd.calls().length, 0);

	const hosted = await tunnelEnv(t, { preset: "grok-bot" });
	r = await hosted.cli(["tunnel", "create"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /only for local-only webhooks/);

	const hermes = await tunnelEnv(t, { preset: "hermes" });
	r = await hermes.cli(["tunnel", "create"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /--tunnel-path is required/);

	const noAccess = await tunnelEnv(t, { stub: { STUB_NO_ACCESS: "1" } });
	r = await noAccess.cli(["tunnel", "create"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /Access \(Zero Trust\) is not enabled/);
	assert.match(r.stderr, /--zero-trust-org/);
	assert.ok(!noAccess.calls().some((c) => / create/.test(c.cmd)), "nothing created");

	const taken = await tunnelEnv(t, { stub: { STUB_DNS_TAKEN: "1" } });
	r = await taken.cli(["tunnel", "create", "--tunnel-hostname", "wake-x.example.com"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /already has a DNS record/);
});

test("tunnel create --zero-trust-org creates the organization when Access is off", async (t) => {
	const s = await tunnelEnv(t, { stub: { STUB_NO_ACCESS: "1" } });
	const r = await s.cli(["tunnel", "create", "--zero-trust-org", "myteam"]);
	assert.equal(r.status, 0, r.stderr);
	const org = s.calls().find((c) => c.cmd.startsWith("zero-trust organization create"));
	assert.deepEqual(org.body, { name: "myteam", auth_domain: "myteam.cloudflareaccess.com" });
	assert.match(r.stdout.trim(), /^https:\/\/wake-[a-z]+-[a-z]+-[0-9a-f]{4}\.example\.com\/hooks\/wake$/);
});
