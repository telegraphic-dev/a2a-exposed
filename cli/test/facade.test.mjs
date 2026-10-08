// Proxy / expose mode in the CLI: --upstream validation and secrets handling against a stub `cf`, the status next
// step, and the --card-url choice for `connect` (Tailnet agents pairing out). No network, no Cloudflare account.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "../lib/config.mjs";
import { isPrivateHost, upstreamUrlProblem } from "../lib/a2a.mjs";
import { cardUrlToSend } from "../lib/pair.mjs";
import { nextStep } from "../lib/status.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "a2a-exposed.mjs");

test("upstream URLs: https on a public (tunnel) hostname only", () => {
	assert.equal(upstreamUrlProblem("https://agent-upstream.example.com/a2a"), "");
	assert.equal(upstreamUrlProblem("http://agent-upstream.example.com/a2a"), "must be https");
	assert.match(upstreamUrlProblem("https://user:pw@agent-upstream.example.com/"), /credentials/);
	for (const u of ["https://jean.tail1234.ts.net/a2a", "https://100.101.102.103/", "https://localhost:8443/", "https://nas.local/", "https://myhost/"])
		assert.match(upstreamUrlProblem(u), /private-network address/, u);
	assert.match(upstreamUrlProblem("not a url"), /not a URL/);
	assert.equal(isPrivateHost("agent.example.com"), false);
	assert.equal(isPrivateHost("100.64.0.1"), true);
	assert.equal(isPrivateHost("100.128.0.1"), false);
	for (const h of ["[::1]", "::", "fe80::1", "::ffff:7f00:1", "::ffff:192.168.1.1", "64:ff9b::a00:1"]) assert.equal(isPrivateHost(h), true, h);
	assert.equal(isPrivateHost("::ffff:808:808"), false);
});

test("connect --card-url: https sent (a Tailnet card as informational), anything else left out", () => {
	const own = "https://inbox.example.com";
	assert.equal(cardUrlToSend(undefined, own, true), "https://inbox.example.com/.well-known/agent-card.json");
	assert.equal(cardUrlToSend(undefined, "http://127.0.0.1:8787", true), "");
	assert.equal(cardUrlToSend("https://jean.tail1234.ts.net/.well-known/agent-card.json", own, true), "https://jean.tail1234.ts.net/.well-known/agent-card.json");
	assert.equal(cardUrlToSend("http://100.101.102.103:8080/.well-known/agent-card.json", own, true), "");
	assert.equal(cardUrlToSend("https://agent.example.org/" + "x".repeat(300), own, true), "");
	assert.throws(() => cardUrlToSend("nope", own, true), /--card-url must be a URL/);
});

const base = { configFile: "/x/config.env", deployed: true, baseUrl: "https://agent.example.com", hasOwnerToken: true, baseUrlEnv: "",
	card: { ok: true, name: "Jean", versions: ["1.0"], urls: ["https://agent.example.com/"], urlProblem: "" }, ownerApi: { ok: true },
	wake: { preset: "generic", configured: false }, tunnel: null, zones: null, pairing: { mode: "human", passwordSet: true, pending: 0 }, upstream: "https://up.example.com/a2a" };

test("status next step in proxy mode", () => {
	const ok = { mode: "proxy", upstreamCard: "ok", upstreamVersions: ["1.0"], hasUpstreamToken: true, hasUpstreamAccessServiceToken: true, publicCardLeaks: [] };
	let n = nextStep({ ...base, facade: ok });
	assert.equal(n.ok, true);
	assert.match(n.text, /façade is up/);
	assert.deepEqual(n.also, []);
	n = nextStep({ ...base, facade: { ...ok, hasUpstreamAccessServiceToken: false } });
	assert.equal(n.ok, true);
	assert.match(n.also[0], /Access service token/);
	n = nextStep({ ...base, facade: { ...ok, upstreamCard: "HTTP 530 (tunnel connector down)" } });
	assert.equal(n.ok, false);
	assert.match(n.text, /can't fetch the upstream's agent card \(HTTP 530/);
	n = nextStep({ ...base, facade: { ...ok, publicCardLeaks: ["description: http://localhost/"] } });
	assert.equal(n.ok, false);
	assert.match(n.text, /private URL/);
	n = nextStep({ ...base, facade: { mode: "inbox" } });
	assert.match(n.text, /not in proxy mode/);
	n = nextStep({ ...base, facade: { ...ok, upstreamProblem: "UPSTREAM_URL must be https" } });
	assert.match(n.text, /upstream URL is unusable/);
});

// stub cf: records what a deploy sees (plain vars in the environment, secret names in the secrets file)
const STUB = `#!/bin/bash
for a in "$@"; do [ "$prev" = --secrets-file ] && sf=$a; prev=$a; done
case "$1 $2" in
  "auth whoami") echo '{"authenticated":true,"accounts":[{"id":"acc123","name":"Test"}]}';;
  "d1 list") echo '[{"name":"uptest","uuid":"d1-uuid"}]';;
  "d1 migrations") echo '[]';;
  "deploy --message")
    echo "upstream=\${A2A_UPSTREAM_URL:-} card=\${A2A_UPSTREAM_CARD_URL:-} token_env=\${UPSTREAM_TOKEN:+LEAKED} secrets=$( [ -n "$sf" ] && node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))).sort().join(","))' "$sf")" >> "$STUB_DIR/deploys.log"
    printf 'Deployed\\n  https://%s.acme.workers.dev\\n' "$A2A_WORKER_NAME";;
esac
`;

function stubEnv(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-up-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const bin = path.join(dir, "worker", "node_modules", ".bin");
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(bin, "cf"), STUB, { mode: 0o755 });
	fs.writeFileSync(path.join(dir, "subdomain"), "acme\n");
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(A2A_|PEER_|CLOUDFLARE_|UPSTREAM_)|WAKE_/.test(k)));
	Object.assign(env, { A2A_CONFIG_DIR: path.join(dir, "cfg"), STUB_DIR: dir, A2A_VERIFY_TRIES: "0", A2A_NO_UPDATE_CHECK: "1", A2A_WORKERS_DEV_SUBDOMAIN: "acme" });
	const cli = (args, extraEnv = {}) => new Promise((resolve) => {
		const ch = spawn(process.execPath, [BIN, ...args], { env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		ch.stdout.on("data", (d) => (stdout += d));
		ch.stderr.on("data", (d) => (stderr += d));
		ch.on("close", (status) => resolve({ status, stdout, stderr }));
	});
	const config = () => parseEnv(fs.readFileSync(path.join(dir, "cfg", "config.env"), "utf8"));
	const deploys = () => fs.readFileSync(path.join(dir, "deploys.log"), "utf8").trim().split("\n");
	const w = ["--skip-install", "--dir", path.join(dir, "worker")];
	return { dir, cli, config, deploys, w };
}

test("init/deploy --upstream: saved as a plain var, credentials only via the secrets file, Tailnet URLs refused", async (t) => {
	const s = stubEnv(t);
	const bad = await s.cli(["init", "--worker-name", "uptest", ...s.w, "--upstream", "https://jean.tail1234.ts.net/a2a"]);
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /--upstream is a private-network address \(jean\.tail1234\.ts\.net\)[^\n]*Cloudflare Tunnel hostname behind Access/);

	const secrets = { UPSTREAM_TOKEN: "up-secret-value", UPSTREAM_ACCESS_CLIENT_ID: "cid.access", UPSTREAM_ACCESS_CLIENT_SECRET: "csecret-value" };
	const r = await s.cli(["init", "--worker-name", "uptest", ...s.w, "--upstream", "https://agent-upstream.example.com/a2a"], secrets);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(s.config().A2A_UPSTREAM_URL, "https://agent-upstream.example.com/a2a");
	assert.ok(!fs.readFileSync(path.join(s.dir, "cfg", "config.env"), "utf8").includes("up-secret-value"), "secrets are not saved in config.env");
	const last = s.deploys().at(-1);
	assert.match(last, /^upstream=https:\/\/agent-upstream\.example\.com\/a2a card= token_env= secrets=OWNER_TOKEN,UPSTREAM_ACCESS_CLIENT_ID,UPSTREAM_ACCESS_CLIENT_SECRET,UPSTREAM_TOKEN$/);
	assert.match(r.stderr, /proxy mode: authenticated A2A calls are forwarded to https:\/\/agent-upstream\.example\.com\/a2a/);
	assert.ok(!(r.stdout + r.stderr).includes("up-secret-value") && !(r.stdout + r.stderr).includes("csecret-value"), "secret values never printed");

	const r2 = await s.cli(["deploy", ...s.w, "--upstream-card-url", "https://agent-upstream.example.com/card.json"]);
	assert.equal(r2.status, 0, r2.stderr);
	assert.match(s.deploys().at(-1), /card=https:\/\/agent-upstream\.example\.com\/card\.json token_env= secrets=$/);
	assert.match(r2.stderr, /none \(existing ones kept\)/);

	const r3 = await s.cli(["deploy", ...s.w, "--upstream", "none", "--upstream-card-url", "none"]);
	assert.equal(r3.status, 0, r3.stderr);
	assert.equal(s.config().A2A_UPSTREAM_URL, undefined);
	assert.match(s.deploys().at(-1), /^upstream= card= /);
	assert.ok(!/proxy mode/.test(r3.stderr));
});
