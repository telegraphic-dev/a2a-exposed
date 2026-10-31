// `status` layers: DNS-over-HTTPS fallback, and every layer in one run. Network is mocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint } from "../lib/a2a.mjs";
import { LAYER_NAMES, buildLayers, layerValue, noPublicDns, publicDnsMismatch, usablePin } from "../lib/layers.mjs";
import { queryDoh, resolveWakeDns, resolveWorkerDns } from "../lib/status.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "a2a-exposed.mjs");
const FETCH_STUB = path.join(HERE, "fetch-stub.mjs");
const BASE = "https://agent.example.com";
const WAKE = "https://wake-test.example.com/hooks/wake";
const SECRET = "not-a-real-access-secret";
const OWNER = "not-a-real-owner-token";

const enoent = () => {
	const err = new Error("getaddrinfo ENOTFOUND agent.example.com");
	err.code = "ENOTFOUND";
	return err;
};

const facts = (over = {}) => ({
	deployed: true, baseUrl: BASE, host: "agent.example.com", platform: "linux",
	workerDns: { kind: "system", ip: "203.0.113.10" },
	card: { ok: true, name: "Layer Test", httpStatus: 200 },
	health: { ok: true, version: "99.0.0", httpStatus: 200 },
	hasOwnerToken: true, ownerApi: { ok: true },
	wakeHost: "wake-test.example.com", wakeDns: { kind: "pass", ip: "203.0.113.11" },
	bare: { status: 401 }, authed: { status: 200 },
	serviceToken: "configured", localServiceToken: true,
	pairing: { mode: "human", passwordSet: true },
	tunnel: { complete: true, tokenFileOk: true, tokenFile: "/cfg/tunnel-token", connections: 1, grace: false, origin: "http://127.0.0.1:8644", down1033: false },
	...over,
});

test("injected ENOTFOUND lookup and a DoH A record still reports the tunnel and pairing layers", async () => {
	let dohType = "";
	const workerDns = await resolveWorkerDns("agent.example.com", {
		lookup: async () => { throw enoent(); },
		doh: async (name, type) => {
			assert.equal(name, "agent.example.com");
			dohType = type;
			return ["203.0.113.10"];
		},
	});
	assert.equal(dohType, "A");
	assert.equal(workerDns.kind, "public-only");
	const layers = buildLayers(facts({ workerDns, host: "agent.example.com" }));
	const text = layers.map((l) => `${l.name}: ${layerValue(l)}`).join("\n");
	assert.match(text, /this machine's resolver does not/);
	assert.ok(text.includes(publicDnsMismatch("agent.example.com")));
	assert.match(text, /^Connector: /m);
	assert.match(text, /^Pairing: /m);
	assert.equal(layers.length, 8);
	assert.equal(layers.find((l) => l.name === "Worker DNS").result, "FAIL");
});

test("a DoH answer with no A record prints no public DNS record", async () => {
	const workerDns = await resolveWorkerDns("agent.example.com", {
		lookup: async () => { throw enoent(); },
		doh: async () => [],
	});
	assert.equal(workerDns.kind, "no-record");
	const line = layerValue(buildLayers(facts({ workerDns })).find((l) => l.name === "Worker DNS"));
	assert.match(line, /no public DNS record/);
	assert.ok(line.includes(noPublicDns("agent.example.com")));
});

test("EAI_AGAIN uses the same DNS-over-HTTPS fallback", async () => {
	const err = new Error("getaddrinfo EAI_AGAIN agent.example.com");
	err.code = "EAI_AGAIN";
	const workerDns = await resolveWorkerDns("agent.example.com", {
		lookup: async () => { throw err; },
		doh: async () => ["203.0.113.9"],
	});
	assert.deepEqual(workerDns, { kind: "public-only", ip: "203.0.113.9" });
});

test("macOS resolver mismatch includes the cache-flush hint and does not print a token", () => {
	const text = layerValue(buildLayers(facts({
		platform: "darwin",
		workerDns: { kind: "public-only", ip: "203.0.113.10" },
	})).find((l) => l.name === "Worker DNS"));
	assert.match(text, /sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder/);
	assert.equal(text.includes(SECRET), false);
});

test("card failure, a down connector, and pairing are one report", () => {
	const layers = buildLayers(facts({
		card: { ok: false, error: "HTTP 404", httpStatus: 404 },
		health: { ok: false, httpStatus: null },
		authed: { status: 530, cf: "1033" },
		pairing: { mode: "human", passwordSet: false },
		tunnel: { complete: true, tokenFileOk: true, tokenFile: "/cfg/tunnel-token", connections: 0, grace: false, origin: "http://127.0.0.1:8644", down1033: true },
	}));
	const text = layers.map((l) => `${l.name}: ${layerValue(l)}`).join("\n");
	assert.match(text, /Worker: FAIL {2}Likely missing: deployed Worker\. Agent card: HTTP 404/);
	assert.match(text, /Connector: FAIL {2}Likely missing: cloudflared connector \(Cloudflare error 1033\)/);
	assert.match(text, /Pairing: FAIL {2}Likely missing: approval password/);
	assert.match(text, /pair set-password --web/);
	assert.deepEqual(layers.map((l) => l.name), [...LAYER_NAMES]);
	assert.deepEqual(layers.map((l) => l.result), ["PASS", "FAIL", "PASS", "PASS", "PASS", "FAIL", "SKIP", "FAIL"]);
});

test("TLS failure names the certificate, and Access does not require printing the token", () => {
	const tls = buildLayers(facts({
		card: { ok: false, error: "request to https://agent.example.com failed: ERR_TLS_CERT_ALTNAME_INVALID", httpStatus: null },
	}));
	assert.match(layerValue(tls.find((l) => l.name === "Worker")), /Likely mismatched: TLS certificate for agent\.example\.com/);
	const open = buildLayers(facts({ bare: { status: 200 }, serviceToken: "not-configured", localServiceToken: false }));
	const access = open.find((l) => l.name === "Access");
	assert.equal(access.result, "FAIL");
	assert.match(access.detail, /Likely missing: Access application/);
	assert.match(access.detail, /HTTP 200/);
	const locked = buildLayers(facts({ bare: { status: 403 }, serviceToken: "not-configured" }));
	assert.match(layerValue(locked.find((l) => l.name === "Access")), /Access service token not configured/);
	assert.match(layerValue(locked.find((l) => l.name === "Access")), /Likely missing: Access service token/);
	const ok = buildLayers(facts());
	assert.match(layerValue(ok.find((l) => l.name === "Access")), /protected \(HTTP 401\); Access service token configured/);
	assert.match(layerValue(ok.find((l) => l.name === "Worker")), /TLS ok; agent card HTTP 200 \("Layer Test"\); \/health HTTP 200/);
	assert.match(layerValue(ok.find((l) => l.name === "Local webhook")), /wake endpoint HTTP 200/);
	assert.equal(JSON.stringify(ok).includes(SECRET), false);
});

test("an Access login redirect or Access 403 fails the webhook layer; an origin 401 and an unclear status do not", () => {
	const login = "https://team.cloudflareaccess.com/cdn-cgi/access/login?token=secret-login";
	const redirected = buildLayers(facts({ authed: { status: 302, location: login } }));
	const hook = redirected.find((l) => l.name === "Local webhook");
	assert.equal(hook.result, "FAIL");
	assert.match(hook.detail, /Likely mismatched: Access service token or Access policy/);
	assert.match(hook.detail, /HTTP 302 redirect to the Cloudflare Access login/);
	assert.equal(hook.detail.includes(login), false);
	assert.equal(hook.detail.includes("secret-login"), false);
	assert.equal(redirected.find((l) => l.name === "Access").result, "PASS");
	const page = "<html>Cloudflare Access</html> secret-page-token";
	const byBody = buildLayers(facts({ authed: { status: 403, body: page } }));
	const bodyRow = byBody.find((l) => l.name === "Local webhook");
	assert.equal(bodyRow.result, "FAIL");
	assert.match(bodyRow.detail, /HTTP 403 from Cloudflare Access/);
	assert.match(bodyRow.detail, /Likely mismatched: Access service token or Access policy/);
	assert.match(bodyRow.fix, /tunnel status/);
	assert.equal(bodyRow.detail.includes("secret-page-token"), false);
	assert.equal(byBody.find((l) => l.name === "Access").result, "PASS");
	const byHeader = buildLayers(facts({ authed: { status: 403, body: "denied", accessHeaders: ["CF-Access-Domain"] } }));
	const headerRow = byHeader.find((l) => l.name === "Local webhook");
	assert.equal(headerRow.result, "FAIL");
	assert.match(headerRow.detail, /HTTP 403 from Cloudflare Access/);
	assert.equal(headerRow.detail.includes("CF-Access-Domain"), false);
	const byChallenge = buildLayers(facts({ authed: { status: 401, wwwAuthenticate: "Cloudflare-Access" } }));
	assert.equal(byChallenge.find((l) => l.name === "Local webhook").result, "FAIL");
	assert.match(byChallenge.find((l) => l.name === "Local webhook").detail, /HTTP 401 from Cloudflare Access/);
	const originAuth = buildLayers(facts({ authed: { status: 401, wwwAuthenticate: "Bearer realm=\"webhook\"", body: "{\"error\":\"missing bearer\"}" } }));
	const originRow = originAuth.find((l) => l.name === "Local webhook");
	assert.equal(originRow.result, "PASS");
	assert.equal(originRow.fix, "");
	assert.match(originRow.detail, /wake endpoint HTTP 401/);
	assert.doesNotMatch(originRow.detail, /Cloudflare Access|Access service token or Access policy/);
	assert.equal(originRow.detail.includes("missing bearer"), false);
	assert.equal(originAuth.find((l) => l.name === "Access").result, "PASS");
	const unclear = buildLayers(facts({ authed: { status: 403, body: "Forbidden" } }));
	const unclearRow = unclear.find((l) => l.name === "Local webhook");
	assert.equal(unclearRow.result, "PASS");
	assert.equal(unclearRow.fix, "");
	assert.match(unclearRow.detail, /wake endpoint HTTP 403/);
	assert.doesNotMatch(unclearRow.detail, /Cloudflare Access|Access service token or Access policy/);
	const reached = buildLayers(facts({ authed: { status: 405 } })).find((l) => l.name === "Local webhook");
	assert.equal(reached.result, "PASS");
	assert.match(reached.detail, /wake endpoint HTTP 405/);
	const other = buildLayers(facts({ authed: { status: 302, location: "https://wake-test.example.com/elsewhere" } }));
	assert.equal(other.find((l) => l.name === "Local webhook").result, "PASS");
});

test("a failed /health probe fails the Worker layer", () => {
	const cases = [
		[{ ok: false, httpStatus: 500 }, /\/health HTTP 500/],
		[{ ok: false, httpStatus: 200 }, /\/health HTTP 200 did not report ok/],
		[{ ok: false, httpStatus: null, error: "The operation was aborted due to timeout" }, /\/health unreachable \(The operation was aborted due to timeout\)/],
	];
	for (const [health, re] of cases) {
		const row = buildLayers(facts({ health })).find((l) => l.name === "Worker");
		assert.equal(row.result, "FAIL", JSON.stringify(health));
		assert.match(row.detail, /Likely missing: Worker \/health/);
		assert.match(row.detail, re);
		assert.match(row.fix, /deploy/);
	}
});

test("usablePin refuses loopback and private addresses", () => {
	assert.equal(usablePin("203.0.113.10"), true);
	assert.equal(usablePin("127.0.0.1"), false);
	assert.equal(usablePin("10.1.2.3"), false);
	assert.equal(usablePin("192.168.1.1"), false);
});

test("queryDoh asks Cloudflare for JSON and keeps only A records", async (t) => {
	const original = globalThis.fetch;
	t.after(() => { globalThis.fetch = original; });
	globalThis.fetch = async (url, init) => {
		assert.equal(String(url), "https://cloudflare-dns.com/dns-query?name=agent.example.com&type=A");
		assert.equal(init.method, "GET");
		assert.equal(init.redirect, "manual");
		assert.equal(init.headers.accept, "application/dns-json");
		assert.equal(init.headers["user-agent"], "a2a-exposed-cli");
		return new Response(JSON.stringify({
			Status: 0,
			Answer: [{ type: 5, data: "cname.example.net" }, { type: 1, data: "203.0.113.10" }],
		}), { status: 200 });
	};
	assert.deepEqual(await queryDoh("agent.example.com", "A"), ["203.0.113.10"]);
	globalThis.fetch = async () => new Response(JSON.stringify({ Status: 3 }), { status: 200 });
	assert.deepEqual(await resolveWakeDns("wake-test.example.com", { doh: queryDoh }), { kind: "no-record" });
});

function run(args, env) {
	return new Promise((resolve) => {
		const ch = spawn(process.execPath, [BIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		ch.stdout.on("data", (d) => (stdout += d));
		ch.stderr.on("data", (d) => (stderr += d));
		ch.on("close", (status) => resolve({ status, stdout, stderr }));
	});
}

function harness(t, { dns = "", doh = "answer", cardStatus = 200, conns = "1", passwordSet = true, wakeAuthed } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-layers-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const bin = path.join(dir, "worker", "node_modules", ".bin");
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(bin, "cf"), `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_DIR + "/calls.jsonl", JSON.stringify({ cmd: a.join(" ") }) + "\\n");
const n = process.env.STUB_CONNS === "0" ? [] : [{ id: "c1" }];
process.stdout.write(JSON.stringify({ id: "tun1", status: "healthy", connections: n }));
`, { mode: 0o755 });
	const token = path.join(dir, "tunnel-token");
	fs.writeFileSync(token, "connector-token-not-a-secret\n", { mode: 0o600 });
	const routes = path.join(dir, "routes.json");
	const log = path.join(dir, "fetch.log");
	const answer = doh === "empty" ? { Status: 3, Answer: [] } : { Status: 0, Answer: [{ name: "agent.example.com", type: 1, TTL: 30, data: "203.0.113.10" }] };
	fs.writeFileSync(routes, JSON.stringify({
		"https://cloudflare-dns.com/dns-query": { status: 200, body: answer },
		[`${BASE}/.well-known/agent-card.json`]: { status: cardStatus, body: cardStatus === 200 ? { name: "Layer Test", supportedInterfaces: [{ url: `${BASE}/`, protocolVersion: "1.0" }] } : { error: "missing" } },
		[`${BASE}/health`]: { status: 200, body: { ok: true, version: "99.0.0" } },
		[`${BASE}/owner/wake/preview`]: { status: 200, body: { preset: "hermes", configured: true, hasKey: false, hasHmacSecret: true, hasAccessServiceToken: true, fingerprints: { url: fingerprint(WAKE) } } },
		[`${BASE}/owner/pairing`]: { status: 200, body: { mode: "human", passwordSet, pending: [] } },
		[`${BASE}/owner/mcp`]: { status: 200, body: { enabled: false } },
		[WAKE]: {
			byHeader: { "cf-access-client-id": wakeAuthed || { status: 200, body: "ok" } },
			default: { status: 401, body: "denied" },
		},
	}));
	fs.writeFileSync(path.join(dir, "config.env"), [
		"A2A_WORKER_NAME=layer-test", "A2A_D1_ID=d1", "CLOUDFLARE_ACCOUNT_ID=acc1",
		`A2A_OWNER_TOKEN=${OWNER}`, `A2A_BASE_URL=${BASE}`, `A2A_WORKER_DIR=${path.join(dir, "worker")}`,
		"A2A_TUNNEL_HOSTNAME=wake-test.example.com", "A2A_TUNNEL_PATH=/hooks/wake", "A2A_TUNNEL_ORIGIN=http://127.0.0.1:8644",
		"A2A_TUNNEL_ID=tun1", "A2A_TUNNEL_DNS_ID=dns1", "A2A_TUNNEL_ZONE_ID=z1",
		"A2A_TUNNEL_ACCESS_APP_ID=app1", "A2A_TUNNEL_ACCESS_TOKEN_ID=st1",
		"A2A_TUNNEL_ACCESS_CLIENT_ID=cid.access", `A2A_TUNNEL_ACCESS_CLIENT_SECRET=${SECRET}`,
		`A2A_TUNNEL_TOKEN_FILE=${token}`,
	].join("\n") + "\n", { mode: 0o600 });
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(A2A_|PEER_|CLOUDFLARE_|CF_|WAKE_)/.test(k)));
	Object.assign(env, {
		A2A_CONFIG_DIR: dir, A2A_NO_UPDATE_CHECK: "1", STUB_DIR: dir, STUB_CONNS: conns,
		NODE_OPTIONS: `--import=${FETCH_STUB}`,
		A2A_TEST_FETCH_ROUTES: routes, A2A_TEST_FETCH_LOG: log,
		...(dns ? { A2A_TEST_DNS: dns } : {}),
	});
	const calls = () => fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8");
	const fetches = () => fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
	return { env, run: (args) => run(args, env), calls, fetches };
}

function noSecrets(text) {
	assert.equal(text.includes(SECRET), false);
	assert.equal(text.includes(OWNER), false);
}

test("status prints the resolver mismatch and still prints the tunnel and pairing rows", async (t) => {
	const h = harness(t, { dns: "ENOTFOUND" });
	const r = await h.run(["status"]);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.match(r.stdout, /this machine's resolver does not/);
	assert.match(r.stdout, /^tunnel: +https:\/\/wake-test\.example\.com\/hooks\/wake/m);
	assert.match(r.stdout, /^pairing: +human approval; approval password set/m);
	assert.match(r.stdout, /^Pairing: +PASS/m);
	noSecrets(r.stdout + r.stderr);
	const doh = h.fetches().find((f) => f.url.startsWith("https://cloudflare-dns.com/dns-query"));
	assert.ok(doh, "DNS-over-HTTPS was queried");
	assert.equal(doh.method, "GET");
	assert.equal(doh.headers.accept, "application/dns-json");
	assert.equal(doh.headers["user-agent"], "a2a-exposed-cli");
	assert.match(doh.url, /[?&]name=agent\.example\.com/);
	assert.match(doh.url, /[?&]type=A/);
	assert.equal(doh.headers["cf-access-client-secret"], undefined);
	assert.ok(h.fetches().every((f) => f.method === "GET"));
	assert.ok(!/create|delete|secrets/i.test(h.calls()));
	const j = JSON.parse((await h.run(["status", "--json"])).stdout);
	assert.equal(j.layers.length, 8);
	assert.deepEqual(j.layers.map((l) => l.name), [...LAYER_NAMES]);
	assert.ok(j.layers.every((l) => ["PASS", "FAIL", "SKIP"].includes(l.result)));
	noSecrets(JSON.stringify(j));
});

test("status prints no public DNS record when DNS-over-HTTPS has no answer", async (t) => {
	const h = harness(t, { dns: "ENOTFOUND", doh: "empty" });
	const r = await h.run(["status"]);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.match(r.stdout, /no public DNS record/);
	assert.match(r.stdout, /Workers → Settings → Domains/);
	assert.match(r.stdout, /^Pairing: /m);
	assert.match(r.stdout, /^tunnel: /m);
	noSecrets(r.stdout + r.stderr);
});

test("a failed card and a down tunnel still print the pairing row in the same run", async (t) => {
	const h = harness(t, { cardStatus: 404, conns: "0", passwordSet: false });
	const r = await h.run(["status"]);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.match(r.stdout, /^agent card: +FAILED: HTTP 404/m);
	assert.match(r.stdout, /^Worker: +FAIL {2}Likely missing: deployed Worker/m);
	assert.match(r.stdout, /^tunnel: .*0 connector connection/m);
	assert.match(r.stdout, /^Connector: +FAIL {2}Likely missing: cloudflared connector/m);
	assert.match(r.stdout, /^pairing: +human approval; approval password NOT SET/m);
	assert.match(r.stdout, /^Pairing: +FAIL {2}Likely missing: approval password/m);
	assert.match(r.stdout, /pair set-password --web/);
	noSecrets(r.stdout + r.stderr);
	const j = JSON.parse((await h.run(["status", "--json"])).stdout);
	assert.equal(j.layers.length, 8);
	assert.equal(j.ok, false);
	noSecrets(JSON.stringify(j));
	assert.ok(h.fetches().every((f) => f.method === "GET"));
	assert.match(h.calls(), /tunnels get tun1/);
	assert.ok(!/create|delete|secrets/i.test(h.calls()));
});

test("status tells an Access 403 from an origin 401 and from an unclear refusal", async (t) => {
	const aud = "aud-should-not-print";
	const pageToken = "page-secret-token";
	const accessByHeader = harness(t, {
		wakeAuthed: {
			status: 403, body: "denied",
			headers: { "content-type": "text/plain", "cf-access-domain": "wake-test.example.com", "cf-access-aud": aud },
		},
	});
	const headerRun = await accessByHeader.run(["status"]);
	assert.equal(headerRun.status, 1, headerRun.stdout + headerRun.stderr);
	assert.match(headerRun.stdout, /^Local webhook: +FAIL {2}Likely mismatched: Access service token or Access policy/m);
	assert.match(headerRun.stdout, /HTTP 403 from Cloudflare Access/);
	assert.match(headerRun.stdout, /tunnel status/);
	assert.equal(headerRun.stdout.includes(aud), false);
	assert.equal(headerRun.stdout.includes("cf-access-aud"), false);
	noSecrets(headerRun.stdout + headerRun.stderr);
	const headerFetches = accessByHeader.fetches().filter((f) => f.url.startsWith(WAKE));
	assert.equal(headerFetches.length, 2);
	assert.ok(headerFetches.every((f) => f.method === "GET"));
	const authed = headerFetches.find((f) => f.headers["cf-access-client-id"]);
	assert.ok(authed);
	assert.deepEqual(Object.keys(authed.headers).sort(), ["cf-access-client-id", "cf-access-client-secret", "user-agent"]);
	assert.equal(authed.headers.authorization, undefined);
	const accessByBody = harness(t, {
		wakeAuthed: {
			status: 403,
			body: `<html>Cloudflare Access ${pageToken}</html>`,
			headers: { "content-type": "text/html" },
		},
	});
	const bodyRun = await accessByBody.run(["status", "--json"]);
	assert.equal(bodyRun.status, 1, bodyRun.stdout + bodyRun.stderr);
	const bodyJson = JSON.parse(bodyRun.stdout);
	const bodyHook = bodyJson.layers.find((l) => l.name === "Local webhook");
	assert.equal(bodyHook.result, "FAIL");
	assert.match(bodyHook.detail, /HTTP 403 from Cloudflare Access/);
	assert.equal(bodyRun.stdout.includes(pageToken), false);
	noSecrets(bodyRun.stdout + bodyRun.stderr);
	assert.ok(accessByBody.fetches().every((f) => f.method === "GET"));
	const origin = harness(t, {
		wakeAuthed: {
			status: 401, body: "{\"error\":\"missing bearer\"}",
			headers: { "www-authenticate": "Bearer realm=\"webhook\"", "content-type": "application/json" },
		},
	});
	const originRun = await origin.run(["status"]);
	assert.equal(originRun.status, 0, originRun.stdout + originRun.stderr);
	assert.match(originRun.stdout, /^Local webhook: +PASS {2}wake endpoint HTTP 401/m);
	assert.match(originRun.stdout, /^Access: +PASS/m);
	assert.doesNotMatch(originRun.stdout, /Cloudflare Access|Access service token or Access policy/);
	assert.equal(originRun.stdout.includes("missing bearer"), false);
	noSecrets(originRun.stdout + originRun.stderr);
	const originAuthed = origin.fetches().filter((f) => f.url.startsWith(WAKE)).find((f) => f.headers["cf-access-client-id"]);
	assert.deepEqual(Object.keys(originAuthed.headers).sort(), ["cf-access-client-id", "cf-access-client-secret", "user-agent"]);
	assert.ok(origin.fetches().every((f) => f.method === "GET"));
	const unclear = harness(t, {
		wakeAuthed: { status: 403, body: "Forbidden", headers: { "content-type": "text/plain" } },
	});
	const unclearRun = await unclear.run(["status", "--json"]);
	assert.equal(unclearRun.status, 0, unclearRun.stdout + unclearRun.stderr);
	const unclearJson = JSON.parse(unclearRun.stdout);
	const unclearHook = unclearJson.layers.find((l) => l.name === "Local webhook");
	assert.equal(unclearHook.result, "PASS");
	assert.equal(unclearHook.fix, "");
	assert.match(unclearHook.detail, /wake endpoint HTTP 403/);
	assert.doesNotMatch(unclearHook.detail, /Cloudflare Access|Access service token or Access policy/);
	assert.equal(unclearJson.ok, true);
	assert.equal(unclearRun.stdout.includes("Forbidden"), false);
	noSecrets(unclearRun.stdout + unclearRun.stderr);
	assert.ok(unclear.fetches().every((f) => f.method === "GET"));
	assert.ok(!/create|delete|secrets/i.test(unclear.calls()));
});

test("status --json reports eight layers when nothing is deployed", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-layers-empty-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(A2A_|PEER_|CLOUDFLARE_|CF_|WAKE_)/.test(k)));
	env.A2A_CONFIG_DIR = dir;
	env.A2A_NO_UPDATE_CHECK = "1";
	const r = await run(["status", "--json"], env);
	assert.equal(r.status, 1);
	const j = JSON.parse(r.stdout);
	assert.equal(j.layers.length, 8);
	assert.deepEqual(j.layers.map((l) => l.name), [...LAYER_NAMES]);
	assert.ok(j.layers.every((l) => l.result === "SKIP"));
});
