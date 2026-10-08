// Tunnel helpers: pure builders + Access header wiring (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	ORIGIN_DEFAULTS, HOSTED_PRESETS, ACCESS_SESSION, HOST_RE, randomLabel, zoneFor, pickTunnelHostname, noZoneHelp, validateOrigin, wakeUrl,
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

test("pickTunnelHostname: any zone on the account, whether the inbox is on workers.dev or a custom hostname", () => {
	const label = () => "wake-x";
	const one = [{ id: "z1", name: "example.com", status: "active" }];
	const two = [...one, { id: "z2", name: "example.org", status: "active" }];
	// workers.dev inbox (no inbox hostname), one zone: auto-picked, and said so
	let r = pickTunnelHostname({ zones: one, label });
	assert.equal(r.hostname, "wake-x.example.com");
	assert.equal(r.zone.id, "z1");
	assert.match(r.note, /one zone, example\.com/);
	// several zones: the inbox hostname's zone wins; without one, stop and list them
	r = pickTunnelHostname({ zones: two, inboxHost: "agent.example.org", label });
	assert.equal(r.hostname, "wake-x.example.org");
	assert.throws(() => pickTunnelHostname({ zones: two, label }), (e) =>
		/2 zones/.test(e.message) && /example\.com/.test(e.message) && /example\.org/.test(e.message) && /--tunnel-zone <zone>/.test(e.message) && /--tunnel-hostname wake-<name>\.<zone>/.test(e.message));
	// explicit choices
	assert.equal(pickTunnelHostname({ zones: two, tunnelZone: "Example.ORG", label }).hostname, "wake-x.example.org");
	assert.throws(() => pickTunnelHostname({ zones: two, tunnelZone: "nope.net", label }), /not an active zone[\s\S]*example\.com/);
	r = pickTunnelHostname({ zones: two, tunnelHostname: "Wake-Me.example.com", label });
	assert.deepEqual([r.hostname, r.zone.id], ["wake-me.example.com", "z1"]);
	assert.throws(() => pickTunnelHostname({ zones: two, tunnelHostname: "wake.other.net", label }), /not on a zone in this Cloudflare account[\s\S]*example\.org/);
	// no zone: plain words, polling is the option
	for (const zones of [[], undefined]) assert.throws(() => pickTunnelHostname({ zones, label }), (e) => /has no domain \(zone\)/.test(e.message) && /polling/.test(e.message));
	// pending zones are not offered, and not accepted through --tunnel-hostname or --tunnel-zone either
	const pending = { id: "z3", name: "new.example", status: "pending" };
	assert.throws(() => pickTunnelHostname({ zones: [pending], label }), /not active yet: new\.example \[pending\]/);
	assert.throws(() => pickTunnelHostname({ zones: [pending], tunnelHostname: "wake.new.example", label }), /on the zone new\.example, which is not active yet \(pending\); wait until it is active/);
	assert.throws(() => pickTunnelHostname({ zones: [...one, pending], tunnelHostname: "wake.new.example", label }), /not active yet \(pending\); pick a hostname on an active zone:\n {2}example\.com/);
	assert.throws(() => pickTunnelHostname({ zones: [...one, pending], tunnelZone: "new.example", label }), /not an active zone/);
	assert.match(noZoneHelp([]), /workers\.dev or a custom hostname/);
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
if (has("zones list") && process.env.STUB_MANY_ZONES) { // 50 zones on page 1, one more on page 2
	const page = Number(val("--page") || 1);
	out(page === 1 ? Array.from({ length: 50 }, (_, i) => ({ id: "m" + i, name: "zone" + i + ".example", status: "active" })) : page === 2 ? [{ id: "last", name: "last.example", status: "active" }] : []);
}
if (has("zones list")) out(process.env.STUB_ZONES ? JSON.parse(process.env.STUB_ZONES) : [{ id: "z1", name: "example.com", status: "active" }]);
if (has("tunnels get")) out({ id: "tun1", status: process.env.STUB_CONNS === "0" ? "down" : "healthy", connections: process.env.STUB_CONNS === "0" ? [] : [{ id: "c1" }] });
// what init needs (init --workers-dev --tunnel)
if (has("auth whoami")) out({ authenticated: true, accounts: [{ id: "acc1", name: "Test" }] });
if (has("d1 list")) out([{ name: "tuntest", uuid: "d1" }]);
if (has("d1 migrations")) out([]);
if (has("deploy")) out("Deployed tuntest\\n  https://tuntest.acme.workers.dev\\n");
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
	// Worker stand-in: the agent card, and a wake preview that reports the URL fingerprint the Worker holds
	let workerUrl = "", preview = {}, cardStatus = 200;
	const srv = http.createServer((req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.url.startsWith("/.well-known/agent-card.json")) {
			res.statusCode = cardStatus;
			return res.end(JSON.stringify(cardStatus === 200 ? { name: "Tun Test", supportedInterfaces: [{ protocolVersion: "1.0" }, { protocolVersion: "0.3" }] } : { error: "not found" }));
		}
		const fp = workerUrl ? createHash("sha256").update(workerUrl).digest("hex").slice(0, 12) : null;
		res.end(JSON.stringify({ preset, configured: !!workerUrl, hasKey: true, hasAccessServiceToken: true, fingerprints: { url: fp }, ...preview }));
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
	const setConfig = (upd) => fs.writeFileSync(path.join(cfg, "config.env"), Object.entries({ ...config(), ...upd }).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
	return { dir, cfg, cli, calls, config, setConfig, setWorkerUrl: (u) => (workerUrl = u), setPreview: (p) => (preview = p), setCardStatus: (c) => (cardStatus = c) };
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

test("tunnel create refuses hosted presets, a missing --tunnel-path, accounts without Access, and taken hostnames (nothing created)", async (t) => {
	const hosted = await tunnelEnv(t, { preset: "grok-bot" });
	let r = await hosted.cli(["tunnel", "create"]);
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

const TWO_ZONES = JSON.stringify([{ id: "z1", name: "example.com", status: "active" }, { id: "z2", name: "example.org", status: "active" }]);

test("tunnel create on a workers.dev inbox: the account's only zone is picked and named; zones listed for this account only", async (t) => {
	const s = await tunnelEnv(t, { hostname: "" });
	const r = await s.cli(["tunnel", "create"], { WAKE_WEBHOOK_KEY: "hooks-token" });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout.trim(), /^https:\/\/wake-[a-z]+-[a-z]+-[0-9a-f]{4}\.example\.com\/hooks\/wake$/);
	assert.match(r.stderr, /the account has one zone, example\.com: the wake hostname goes there \(the inbox URL is unchanged\)/);
	assert.match(s.calls().find((c) => c.cmd.startsWith("zones list")).cmd, /--account-id acc1/);
	assert.equal(s.calls().filter((c) => c.cmd.startsWith("zones list")).length, 1, "one page is enough");
	assert.ok(s.calls().some((c) => c.cmd.startsWith("dns records create -z z1")));
	assert.equal(s.config().A2A_TUNNEL_ZONE_ID, "z1");
});

test("tunnel create on a workers.dev inbox with several zones stops and lists them; --tunnel-zone picks one", async (t) => {
	const s = await tunnelEnv(t, { hostname: "", stub: { STUB_ZONES: TWO_ZONES } });
	let r = await s.cli(["tunnel", "create"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /this Cloudflare account has 2 zones; choose one for the wake hostname/);
	assert.match(r.stderr, /^ {2}example\.com$/m);
	assert.match(r.stderr, /^ {2}example\.org$/m);
	assert.match(r.stderr, /--tunnel-zone <zone>/);
	assert.ok(!s.calls().some((c) => / create/.test(c.cmd)), "nothing created");
	r = await s.cli(["tunnel", "create", "--tunnel-zone", "example.org"]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout.trim(), /^https:\/\/wake-[a-z-]+-[0-9a-f]{4}\.example\.org\/hooks\/wake$/);
	assert.ok(s.calls().some((c) => c.cmd.startsWith("dns records create -z z2")));
	// re-running is safe: nothing new is created
	const before = s.calls().length;
	s.setWorkerUrl(r.stdout.trim());
	const again = await s.cli(["tunnel", "create", "--tunnel-zone", "example.org"]);
	assert.equal(again.status, 0, again.stderr);
	assert.equal(again.stdout.trim(), r.stdout.trim());
	assert.match(again.stderr, /tunnel already set up/);
	assert.ok(!s.calls().slice(before).some((c) => / create|secrets bulk/.test(c.cmd)), "no new objects, secrets already on the Worker");
});

test("tunnel create reads every page of zones (accounts with more than 50)", async (t) => {
	const s = await tunnelEnv(t, { hostname: "", stub: { STUB_MANY_ZONES: "1" } });
	const r = await s.cli(["tunnel", "create", "--tunnel-zone", "last.example"]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout.trim(), /\.last\.example\/hooks\/wake$/);
	assert.deepEqual(s.calls().filter((c) => c.cmd.startsWith("zones list")).map((c) => /--page (\d+)/.exec(c.cmd)[1]), ["1", "2"]);
});

test("tunnel create with no zone on the account says so plainly and points to polling (nothing created)", async (t) => {
	const s = await tunnelEnv(t, { hostname: "", stub: { STUB_ZONES: "[]" } });
	const r = await s.cli(["tunnel", "create"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /this Cloudflare account has no domain \(zone\)/);
	assert.match(r.stderr, /polling/);
	assert.ok(!s.calls().some((c) => / create/.test(c.cmd)));
	const both = await s.cli(["tunnel", "create", "--tunnel-zone", "example.com", "--tunnel-hostname", "wake.example.com"]);
	assert.match(both.stderr, /not both/);
});

test("init --workers-dev --tunnel deploys the inbox on workers.dev, then creates the tunnel on the account's zone", async (t) => {
	const s = await tunnelEnv(t, { hostname: "" });
	s.setConfig({ A2A_WORKERS_DEV_SUBDOMAIN: "acme" });
	const r = await s.cli(["init", "--workers-dev", "--tunnel", "--skip-install"], { A2A_VERIFY_TRIES: "0" });
	assert.equal(r.status, 0, r.stderr);
	const cmds = s.calls().map((c) => c.cmd);
	const di = cmds.findIndex((c) => c.startsWith("deploy")), ti = cmds.findIndex((c) => c.startsWith("tunnels create"));
	assert.ok(di >= 0 && ti > di, "deploy first, then the tunnel");
	assert.match(r.stdout, /^https:\/\/tuntest\.acme\.workers\.dev$/m);
	assert.match(r.stdout, /^https:\/\/wake-[a-z-]+-[0-9a-f]{4}\.example\.com\/hooks\/wake$/m);
	assert.equal(s.config().A2A_BASE_URL, "https://tuntest.acme.workers.dev");

	// several zones: the inbox stays deployed and the error says how to continue
	const m = await tunnelEnv(t, { hostname: "", stub: { STUB_ZONES: TWO_ZONES } });
	m.setConfig({ A2A_WORKERS_DEV_SUBDOMAIN: "acme" });
	const r2 = await m.cli(["init", "--workers-dev", "--tunnel", "--skip-install"], { A2A_VERIFY_TRIES: "0" });
	assert.equal(r2.status, 1);
	assert.match(r2.stderr, /--tunnel-zone <zone>/);
	assert.match(r2.stderr, /the inbox is deployed and works/);
	assert.ok(m.calls().some((c) => c.cmd.startsWith("deploy")));
});

test("tunnel create after an interruption: partial ids -> tunnel rm first; complete but Worker lacks secrets -> re-uploaded", async (t) => {
	const partial = await tunnelEnv(t);
	partial.setConfig({ A2A_TUNNEL_HOSTNAME: "wake-p.example.com", A2A_TUNNEL_ACCESS_TOKEN_ID: "st1" });
	let r = await partial.cli(["tunnel", "create"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /did not finish[\s\S]*tunnel rm/);
	assert.equal(partial.calls().length, 0);

	const s = await tunnelEnv(t);
	assert.equal((await s.cli(["tunnel", "create", "--tunnel-hostname", "wake-test.example.com"])).status, 0);
	s.setPreview({ hasAccessServiceToken: false, hasKey: false }); // e.g. interrupted before the secrets upload
	const before = s.calls().length;
	r = await s.cli(["tunnel", "create"]);
	assert.equal(r.status, 0, r.stderr);
	const after = s.calls().slice(before);
	assert.ok(!after.some((c) => / create/.test(c.cmd)));
	const bulk = after.find((c) => c.cmd.startsWith("workers secrets bulk"));
	assert.deepEqual(Object.keys(bulk.file.secrets).sort(), ["WAKE_ACCESS_CLIENT_ID", "WAKE_ACCESS_CLIENT_SECRET", "WAKE_WEBHOOK_URL"]);
	assert.equal(bulk.file.secrets.WAKE_WEBHOOK_URL.text, "https://wake-test.example.com/hooks/wake");
	assert.ok(!(r.stdout + r.stderr).includes("csecret"));
	// the agent-side auth travels with it, as on a first run; without it on the Worker, a warning
	assert.match(r.stderr, /Worker has no WAKE_WEBHOOK_KEY \/ WAKE_HMAC_SECRET, so the openclaw-wake webhook will reject wakes/);
	s.setPreview({ hasAccessServiceToken: false, hasKey: false });
	const n = s.calls().length;
	r = await s.cli(["tunnel", "create"], { WAKE_WEBHOOK_KEY: "hooks-token" });
	assert.equal(r.status, 0, r.stderr);
	const bulk2 = s.calls().slice(n).find((c) => c.cmd.startsWith("workers secrets bulk"));
	assert.equal(bulk2.file.secrets.WAKE_WEBHOOK_KEY.text, "hooks-token");
	assert.ok(bulk2.file.secrets.WAKE_ACCESS_CLIENT_SECRET && bulk2.file.secrets.WAKE_WEBHOOK_URL);
	assert.ok(!/will reject wakes/.test(r.stderr) && !r.stderr.includes("hooks-token"));
	// complete and in place: an exported key alone is uploaded too (rotating it)
	s.setPreview({});
	s.setWorkerUrl("https://wake-test.example.com/hooks/wake");
	const m = s.calls().length;
	r = await s.cli(["tunnel", "create"], { WAKE_HMAC_SECRET: "new-hmac" });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(s.calls().slice(m).find((c) => c.cmd.startsWith("workers secrets bulk")).file.secrets.WAKE_HMAC_SECRET.text, "new-hmac");
	const k = s.calls().length;
	r = await s.cli(["tunnel", "create"]);
	assert.equal(r.status, 0, r.stderr);
	assert.ok(!s.calls().slice(k).some((c) => /secrets bulk/.test(c.cmd)), "nothing to upload: no call");
	const other = await s.cli(["tunnel", "create", "--tunnel-hostname", "wake-other.example.com"]);
	assert.equal(other.status, 1);
	assert.match(other.stderr, /already exists on wake-test\.example\.com/);
});

// ------------------------------------------------------------------ status (read-only snapshot + next step)
test("status on a workers.dev inbox with no wake: card OK, polling expected, tunnel suggested on the account's zone", async (t) => {
	const s = await tunnelEnv(t, { preset: "hermes", hostname: "" });
	s.setPreview({ preset: "hermes", configured: false });
	let r = await s.cli(["status"]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /^agent card: +OK: "Tun Test" \(A2A 1\.0, 0\.3\)$/m);
	assert.match(r.stdout, /^base URL: +http:\/\/127\.0\.0\.1:\d+ \(workers\.dev\)$/m);
	assert.match(r.stdout, /^wake: +none: no WAKE_WEBHOOK_URL on the Worker, so the agent is expected to poll the inbox/m);
	assert.match(r.stdout, /^tunnel: +none$/m);
	assert.match(r.stdout, /^next step: +no wake webhook, so the agent must check the inbox on a schedule.*run `a2a-over-webhook tunnel create` \(it uses the account's zone example\.com; no redeploy needed\)/m);
	assert.ok(!s.calls().some((c) => !/^(zones list)/.test(c.cmd)), "read-only: only zones list");
	const j = JSON.parse((await s.cli(["status", "--json"])).stdout);
	assert.equal(j.ok, true);
	assert.deepEqual(j.zones, ["example.com"]);
	assert.equal(j.card.name, "Tun Test");
	assert.equal(j.hasOwnerToken, true);
	assert.ok(!Object.values(j).includes("owner"), "the owner token itself is never printed");

	const none = await tunnelEnv(t, { preset: "hermes", hostname: "", stub: { STUB_ZONES: "[]" } });
	none.setPreview({ preset: "hermes", configured: false });
	r = await none.cli(["status"]);
	assert.match(r.stdout, /no domain \(zone\), so the secure tunnel is not available/);
	const many = await tunnelEnv(t, { preset: "hermes", hostname: "", stub: { STUB_ZONES: TWO_ZONES } });
	many.setPreview({ preset: "hermes", configured: false });
	r = await many.cli(["status"]);
	assert.match(r.stdout, /tunnel create --tunnel-zone <zone>` with one of: example\.com, example\.org/);
});

test("status follows a tunnel through: no connector -> start cloudflared; connected -> complete; unreachable card -> exit 1", async (t) => {
	const s = await tunnelEnv(t, { stub: { STUB_CONNS: "0" } });
	const c = await s.cli(["tunnel", "create", "--tunnel-hostname", "wake-test.example.com"]);
	assert.equal(c.status, 0, c.stderr);
	s.setWorkerUrl("https://wake-test.example.com/hooks/wake");
	let r = await s.cli(["status"]);
	assert.equal(r.status, 1);
	assert.match(r.stdout, /^tunnel: +https:\/\/wake-test\.example\.com\/hooks\/wake -> http:\/\/127\.0\.0\.1:18789; set up; down, 0 connector connection\(s\)$/m);
	assert.match(r.stdout, /^next step: +the tunnel has no running connector: on the agent's machine run `cloudflared tunnel run --token-file .*tunnel-token`/m);
	r = await s.cli(["status"], { STUB_CONNS: "1" });
	assert.equal(r.status, 0, r.stdout);
	assert.match(r.stdout, /^wake: +webhook \(preset openclaw-wake, through the tunnel\); auth: bearer\/API key \+ Access service token/m);
	assert.match(r.stdout, /^next step: +none: setup is complete/m);
	s.setPreview({ hasAccessServiceToken: false });
	r = await s.cli(["status"], { STUB_CONNS: "1" });
	assert.match(r.stdout, /Worker does not have the tunnel's wake secrets: run `a2a-over-webhook tunnel create` again/);
	s.setPreview({});
	s.setCardStatus(404);
	r = await s.cli(["status"], { STUB_CONNS: "1" });
	assert.equal(r.status, 1);
	assert.match(r.stdout, /^agent card: +FAILED: HTTP 404/m);
	assert.match(r.stdout, /^next step: +the agent card is not reachable/m);
	assert.ok(!(r.stdout + r.stderr).includes("csecret") && !(r.stdout + r.stderr).includes("eyJstubtoken"));

	const partial = await tunnelEnv(t);
	partial.setConfig({ A2A_TUNNEL_HOSTNAME: "wake-p.example.com", A2A_TUNNEL_ID: "tun1" });
	r = await partial.cli(["status"]);
	assert.equal(r.status, 1);
	assert.match(r.stdout, /INCOMPLETE/);
	assert.match(r.stdout, /a previous `tunnel create` did not finish: run `a2a-over-webhook tunnel rm`, then `a2a-over-webhook tunnel create`/);
});

test("tunnel create --zero-trust-org creates the organization when Access is off", async (t) => {
	const s = await tunnelEnv(t, { stub: { STUB_NO_ACCESS: "1" } });
	const r = await s.cli(["tunnel", "create", "--zero-trust-org", "myteam"]);
	assert.equal(r.status, 0, r.stderr);
	const org = s.calls().find((c) => c.cmd.startsWith("zero-trust organization create"));
	assert.deepEqual(org.body, { name: "myteam", auth_domain: "myteam.cloudflareaccess.com" });
	assert.match(r.stdout.trim(), /^https:\/\/wake-[a-z]+-[a-z]+-[0-9a-f]{4}\.example\.com\/hooks\/wake$/);
});
