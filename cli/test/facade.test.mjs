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
import { isPrivateHost, upstreamAuth, upstreamCardUrlProblem, upstreamUrlProblem } from "../lib/a2a.mjs";
import { cardUrlToSend } from "../lib/pair.mjs";
import { nextStep, verifyLayers } from "../lib/status.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "a2a-exposed.mjs");
const FETCH_STUB = path.join(HERE, "fetch-stub.mjs");

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

test("upstream card URL: same origin as the upstream endpoint (credentials ride with the card fetch)", () => {
	const up = "https://agent-upstream.example.com/a2a";
	assert.equal(upstreamCardUrlProblem("https://agent-upstream.example.com/.well-known/agent-card.json", up), "");
	assert.equal(upstreamCardUrlProblem("https://agent-upstream.example.com:443/card.json", up), "");
	assert.match(upstreamCardUrlProblem("https://evil.example.com/card.json", up), /must be on the upstream's origin/);
	assert.match(upstreamCardUrlProblem("http://agent-upstream.example.com/card.json", up), /must be https/);
	assert.match(upstreamCardUrlProblem("https://jean.tail1234.ts.net/card.json", up), /private-network/);
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
	n = nextStep({ ...base, facade: { ...ok, upstreamCardProblem: "UPSTREAM_CARD_URL must be on the UPSTREAM_URL origin" } });
	assert.equal(n.ok, false);
	assert.match(n.text, /upstream card URL is refused/);
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
	Object.assign(env, { A2A_CONFIG_DIR: path.join(dir, "cfg"), STUB_DIR: dir, A2A_VERIFY_TRIES: "0", A2A_NO_UPDATE_CHECK: "1", A2A_WORKERS_DEV_SUBDOMAIN: "acme",
		A2A_TEST_FETCH_ROUTES: path.join(dir, "routes.json"), A2A_TEST_FETCH_LOG: path.join(dir, "fetch.log") });
	// every fetch goes through test/fetch-stub.mjs: no network, and the requests are logged
	const cli = (args, extraEnv = {}, input = null) => new Promise((resolve) => {
		const ch = spawn(process.execPath, ["--import", FETCH_STUB, BIN, ...args], { env: { ...env, ...extraEnv }, stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"] });
		if (input !== null) ch.stdin.end(input);
		let stdout = "", stderr = "";
		ch.stdout.on("data", (d) => (stdout += d));
		ch.stderr.on("data", (d) => (stderr += d));
		ch.on("close", (status) => resolve({ status, stdout, stderr }));
	});
	const config = () => parseEnv(fs.readFileSync(path.join(dir, "cfg", "config.env"), "utf8"));
	const deploys = () => fs.readFileSync(path.join(dir, "deploys.log"), "utf8").trim().split("\n");
	const w = ["--skip-install", "--dir", path.join(dir, "worker")];
	const routes = (r) => fs.writeFileSync(path.join(dir, "routes.json"), JSON.stringify(r));
	const fetches = () => { try { return fs.readFileSync(path.join(dir, "fetch.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
	const hasDeploys = () => fs.existsSync(path.join(dir, "deploys.log"));
	return { dir, cli, config, deploys, w, routes, fetches, hasDeploys };
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

	// redeploy without exported secrets: the Worker already holds UPSTREAM_TOKEN for this upstream, so no check from here
	s.routes({ "https://uptest.acme.workers.dev/owner/facade": { status: 200, body: { mode: "proxy", hasUpstreamToken: true, upstreamAuth: { bearer: true, schemes: ["bearer: bearer"], unsupported: [] } } } });
	const r2 = await s.cli(["deploy", ...s.w, "--upstream-card-url", "https://agent-upstream.example.com/card.json"]);
	assert.equal(r2.status, 0, r2.stderr);
	assert.match(s.deploys().at(-1), /card=https:\/\/agent-upstream\.example\.com\/card\.json token_env= secrets=$/);
	assert.match(r2.stderr, /none \(existing ones kept\)/);

	const cross = await s.cli(["deploy", ...s.w, "--upstream-card-url", "https://evil.example.com/card.json"]);
	assert.equal(cross.status, 1);
	assert.match(cross.stderr, /--upstream-card-url https:\/\/evil\.example\.com\/card\.json must be on the upstream's origin/);
	assert.equal(s.config().A2A_UPSTREAM_CARD_URL, "https://agent-upstream.example.com/card.json", "rejected card URL is not saved");

	const r3 = await s.cli(["deploy", ...s.w, "--upstream", "none", "--upstream-card-url", "none"]);
	assert.equal(r3.status, 0, r3.stderr);
	assert.equal(s.config().A2A_UPSTREAM_URL, undefined);
	assert.match(s.deploys().at(-1), /^upstream= card= /);
	assert.ok(!/proxy mode/.test(r3.stderr));
});

// ------------------------------------------------------------------ upstream bearer check, status, upstream verify

const UP = "https://agent-upstream.example.com/a2a";
const UP_CARD = "https://agent-upstream.example.com/.well-known/agent-card.json";
/** Hermes-like 0.3 card: bearer auth declared. */
const BEARER_CARD = { name: "Jean", protocolVersion: "0.3.0", url: "http://127.0.0.1:8080/", securitySchemes: { bearer: { type: "http", scheme: "bearer" } }, security: [{ bearer: [] }] };
const ACCESS = { UPSTREAM_ACCESS_CLIENT_ID: "cid.access", UPSTREAM_ACCESS_CLIENT_SECRET: "csecret-value" };

test("upstreamAuth (CLI copy): same answers as the Worker's", () => {
	assert.deepEqual(upstreamAuth(null), { bearer: null, schemes: [], unsupported: [] });
	assert.equal(upstreamAuth({ name: "x" }).bearer, false);
	assert.deepEqual(upstreamAuth(BEARER_CARD), { bearer: true, schemes: ["bearer: bearer"], unsupported: [] });
	assert.equal(upstreamAuth({ securitySchemes: { b: { httpAuthSecurityScheme: { scheme: "Bearer" } } }, securityRequirements: [{ schemes: { b: { list: [] } } }] }).bearer, true);
	assert.equal(upstreamAuth({ securitySchemes: { o: { oauth2SecurityScheme: {} } } }).bearer, true);
	assert.equal(upstreamAuth({ ...BEARER_CARD, security: [{ bearer: [] }, {}] }).bearer, false, "anonymous alternative");
	assert.deepEqual(upstreamAuth({ securitySchemes: { k: { type: "apiKey", in: "header", name: "x-key" } }, security: [{ k: [] }] }).unsupported, ["k: apiKey"]);
});

test("init --upstream: an Access-only setup is refused when the upstream card asks for a bearer (Jean's case)", async (t) => {
	const s = stubEnv(t);
	s.routes({ [UP_CARD]: { status: 200, body: BEARER_CARD } });
	const r = await s.cli(["init", "--worker-name", "uptest", ...s.w, "--upstream", UP], ACCESS);
	assert.equal(r.status, 1, r.stderr);
	assert.match(r.stderr, /the upstream's agent card asks for a bearer token \(bearer: bearer\), and no UPSTREAM_TOKEN is set/);
	assert.match(r.stderr, /Cloudflare Access \(UPSTREAM_ACCESS_CLIENT_ID \/ _SECRET\) only lets the Worker through the tunnel/);
	assert.match(r.stderr, /\| npx -y a2a-exposed@latest init \.\.\. --upstream-token-stdin/, "the recovery command runs through npx");
	assert.match(r.stderr, /--no-upstream-token/);
	assert.equal(s.hasDeploys(), false, "nothing deployed");
	const cardFetch = s.fetches().find((f) => f.url === UP_CARD);
	assert.equal(cardFetch.headers["cf-access-client-id"], "cid.access", "the card is fetched with the exported Access token");
	assert.equal(cardFetch.headers.authorization, undefined);
	assert.ok(!s.fetches().some((f) => !f.url.startsWith("https://agent-upstream.example.com/")), "nothing else is contacted");
	assert.ok(!(r.stdout + r.stderr).includes("csecret-value"));

	// the token from stdin (never argv): uploaded through the secrets file, never saved or printed
	const ok = await s.cli(["init", "--worker-name", "uptest", ...s.w, "--upstream", UP, "--upstream-token-stdin"], ACCESS, "hermes-bearer-value\n");
	assert.equal(ok.status, 0, ok.stderr);
	assert.match(s.deploys().at(-1), /secrets=OWNER_TOKEN,UPSTREAM_ACCESS_CLIENT_ID,UPSTREAM_ACCESS_CLIENT_SECRET,UPSTREAM_TOKEN$/);
	assert.match(ok.stderr, /Upstream secrets uploaded now: UPSTREAM_TOKEN, UPSTREAM_ACCESS_CLIENT_ID, UPSTREAM_ACCESS_CLIENT_SECRET/);
	assert.ok(!fs.readFileSync(path.join(s.dir, "cfg", "config.env"), "utf8").includes("hermes-bearer-value"));
	assert.ok(!(ok.stdout + ok.stderr).includes("hermes-bearer-value"));
	const empty = await s.cli(["deploy", ...s.w, "--upstream-token-stdin"], ACCESS, "\n");
	assert.equal(empty.status, 1);
	assert.match(empty.stderr, /no token on stdin/);
});

test("init --upstream: no bearer declared -> no token needed; card unreadable -> exit 1; --no-upstream-token is saved", async (t) => {
	const s = stubEnv(t);
	s.routes({ [UP_CARD]: { status: 200, body: { name: "Open agent", protocolVersion: "0.3.0" } } });
	const r = await s.cli(["init", "--worker-name", "uptest", ...s.w, "--upstream", UP], ACCESS);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stderr, /upstream card: no bearer auth declared, so no UPSTREAM_TOKEN is needed/);

	const t2 = stubEnv(t);
	t2.routes({ [UP_CARD]: { status: 302, body: "", headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/agent-upstream.example.com" } } });
	const blocked = await t2.cli(["init", "--worker-name", "uptest", ...t2.w, "--upstream", UP]);
	assert.equal(blocked.status, 1);
	assert.match(blocked.stderr, /could not be read from here \(HTTP 302: redirected to the Cloudflare Access login \(export UPSTREAM_ACCESS_CLIENT_ID/);
	const opt = await t2.cli(["init", "--worker-name", "uptest", ...t2.w, "--upstream", UP, "--no-upstream-token"]);
	assert.equal(opt.status, 0, opt.stderr);
	assert.equal(t2.config().A2A_UPSTREAM_NO_TOKEN, "1");
	const n = t2.fetches().length;
	const again = await t2.cli(["deploy", ...t2.w]);
	assert.equal(again.status, 0, again.stderr);
	assert.equal(t2.fetches().length, n, "the saved opt-out skips the check");
	const both = await t2.cli(["deploy", ...t2.w, "--no-upstream-token", "--upstream-token-stdin"], {}, "x");
	assert.equal(both.status, 1);
	assert.match(both.stderr, /mutually exclusive/);
	const off = await t2.cli(["deploy", ...t2.w, "--upstream", "none"]);
	assert.equal(off.status, 0, off.stderr);
	assert.equal(t2.config().A2A_UPSTREAM_NO_TOKEN, undefined, "--upstream none drops the opt-out");
});

test("deploy: a Worker without UPSTREAM_TOKEN whose card wants one is not treated as configured", async (t) => {
	const s = stubEnv(t);
	s.routes({ [UP_CARD]: { status: 200, body: { name: "x" } } });
	assert.equal((await s.cli(["init", "--worker-name", "uptest", ...s.w, "--upstream", UP], ACCESS)).status, 0);
	s.routes({
		"https://uptest.acme.workers.dev/owner/facade": { status: 200, body: { mode: "proxy", hasUpstreamToken: false, upstreamAuth: { bearer: true, schemes: ["bearer: bearer"], unsupported: [] } } },
		[UP_CARD]: { status: 200, body: BEARER_CARD },
	});
	const r = await s.cli(["deploy", ...s.w], ACCESS);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /asks for a bearer token/);
	const ok = await s.cli(["deploy", ...s.w], { ...ACCESS, UPSTREAM_TOKEN: "exported-bearer" });
	assert.equal(ok.status, 0, ok.stderr);
	assert.match(s.deploys().at(-1), /UPSTREAM_TOKEN$/);
});

const facadeOk = { mode: "proxy", upstreamCard: "ok", upstreamVersions: ["0.3"], hasUpstreamToken: true, hasUpstreamAccessServiceToken: true, publicCardLeaks: [],
	upstreamAuth: { bearer: true, schemes: ["bearer: bearer"], unsupported: [] }, fingerprints: { upstreamToken: "aaaaaaaaaaaa", upstreamAccessClientId: "bbbbbbbbbbbb" } };
const reachable = { ok: true, reason: "reachable", status: 200, rpcErrorCode: -32601, detail: "JSON-RPC error -32601 (HTTP 200)", sent: { bearer: true, accessServiceToken: true } };
const authMissing = { ok: false, reason: "upstream_auth_missing", status: 401, detail: "HTTP 401 from the agent: it wants a credential and the façade has no UPSTREAM_TOKEN", sent: { bearer: false, accessServiceToken: true } };

test("status next step: the live upstream check and the card's bearer requirement", () => {
	let n = nextStep({ ...base, facade: { ...facadeOk, hasUpstreamToken: false }, upstreamVerify: authMissing });
	assert.equal(n.ok, false);
	assert.match(n.text, /Access let the Worker through, but the agent refused the call \(HTTP 401[^)]*\)\. Export UPSTREAM_TOKEN/);
	for (const [reason, re] of [["access_credentials_missing", /Export UPSTREAM_ACCESS_CLIENT_ID/], ["access_rejected", /Service Auth policy/], ["upstream_auth_rejected", /wrong or rotated/],
		["tunnel_down", /cloudflared tunnel run/], ["upstream_unavailable", /agent's A2A server/], ["network", /could not connect/], ["unexpected_response", /JSON-RPC endpoint/]]) {
		n = nextStep({ ...base, facade: facadeOk, upstreamVerify: { ok: false, reason, detail: "d" } });
		assert.equal(n.ok, false, reason);
		assert.match(n.text, re, reason);
	}
	// no live check (older Worker): an Access-only setup still fails when the card asks for a bearer
	n = nextStep({ ...base, facade: { ...facadeOk, hasUpstreamToken: false }, upstreamVerify: null, upstreamVerifyError: "HTTP 404: not found" });
	assert.equal(n.ok, false);
	assert.match(n.text, /card asks for a bearer token \(bearer: bearer\) and the Worker has no UPSTREAM_TOKEN/);
	// opted out, and the agent accepts calls without one: OK with a warning
	n = nextStep({ ...base, facade: { ...facadeOk, hasUpstreamToken: false }, upstreamVerify: { ...reachable, sent: { bearer: false, accessServiceToken: true } }, upstreamNoToken: true });
	assert.equal(n.ok, true);
	assert.match(n.also.join("\n"), /asks for a bearer token but the Worker has none \(--no-upstream-token\); the agent accepts calls without it today/);
	n = nextStep({ ...base, facade: { ...facadeOk, lastFailure: { reason: "upstream_auth_missing", status: 401, at: "2026-10-08T10:00:00.000Z" } }, upstreamVerify: reachable, localUpstreamToken: "cccccccccccc" });
	assert.equal(n.ok, true);
	assert.match(n.also.join("\n"), /last failed peer call: upstream_auth_missing \(HTTP 401\) at 2026-10-08T10:00:00.000Z; the live check passes now/);
	assert.match(n.also.join("\n"), /UPSTREAM_TOKEN exported here \(fingerprint cccccccccccc\) differs from the Worker's \(aaaaaaaaaaaa\)/);
	n = nextStep({ ...base, facade: facadeOk, upstreamVerify: reachable, peerTokenShadowed: ["PEER_JEAN_TOKEN"] });
	assert.match(n.also.at(-1), /PEER_JEAN_TOKEN is set in the environment and overrides the different peer token saved/);
});

test("verifyLayers: façade peer auth, Access, the agent's bearer check, the app", () => {
	const rows = (v, fa) => Object.fromEntries(verifyLayers(v, fa));
	let r = rows(reachable, { status: 401 });
	assert.match(r["façade peer auth"], /^enforced/);
	assert.equal(r.Access, "passed");
	assert.equal(r["upstream bearer"], "accepted");
	assert.match(r["A2A app"], /^reachable \(JSON-RPC error -32601 \(HTTP 200\): method not found, as expected; no task created\)/);
	r = rows(authMissing, { status: 200 });
	assert.match(r["façade peer auth"], /UNEXPECTED: an unauthenticated call got HTTP 200/);
	assert.equal(r.Access, "passed");
	assert.match(r["upstream bearer"], /^FAILED: the agent wants a credential; the Worker has no UPSTREAM_TOKEN/);
	assert.equal(r["A2A app"], "not reached");
	r = rows({ reason: "access_credentials_missing", detail: "x", sent: { bearer: true, accessServiceToken: false } });
	assert.match(r.Access, /no Access service token/);
	assert.equal(r["upstream bearer"], "not reached");
	r = rows({ reason: "tunnel_down", detail: "HTTP 530, Cloudflare error 1033", sent: {} });
	assert.equal(r.Access, "not reached");
	assert.match(r["A2A app"], /^FAILED: HTTP 530/);
});

test("status and upstream verify against a façade (stubbed Worker): layers, separate credential rows, exit codes, shadowed peer tokens", async (t) => {
	const s = stubEnv(t);
	s.routes({ [UP_CARD]: { status: 200, body: { name: "x" } } });
	assert.equal((await s.cli(["init", "--worker-name", "uptest", ...s.w, "--upstream", UP], ACCESS)).status, 0);
	const W = "https://uptest.acme.workers.dev";
	const worker = (facade, verify) => s.routes({
		[`${W}/`]: { status: 401, body: { jsonrpc: "2.0", id: "a2a-exposed-verify", error: { code: -32000, message: "Missing bearer token." } } },
		[`${W}/.well-known/agent-card.json`]: { status: 200, body: { name: "Jean", supportedInterfaces: [{ url: `${W}/`, protocolBinding: "JSONRPC", protocolVersion: "0.3" }] } },
		[`${W}/owner/wake/preview`]: { status: 200, body: { preset: "generic", configured: false } },
		[`${W}/owner/pairing`]: { status: 200, body: { mode: "human", passwordSet: true, pending: [] } },
		[`${W}/owner/facade/verify`]: { status: 200, body: { mode: "proxy", ...verify } },
		[`${W}/owner/facade`]: { status: 200, body: facade },
	});
	worker({ ...facadeOk, hasUpstreamToken: false, fingerprints: { upstreamToken: null, upstreamAccessClientId: "bbbbbbbbbbbb" },
		lastFailure: { at: "2026-10-08T10:00:00.000Z", reason: "upstream_auth_missing", status: 401, method: "SendMessage", peer: "alice" } }, authMissing);
	const v = await s.cli(["upstream", "verify"]);
	assert.equal(v.status, 1, v.stderr);
	assert.match(v.stdout, /façade peer auth: +enforced/);
	assert.match(v.stdout, /Access: +passed/);
	assert.match(v.stdout, /upstream bearer: +FAILED: the agent wants a credential; the Worker has no UPSTREAM_TOKEN/);
	assert.match(v.stdout, /result: +upstream_auth_missing: Access let the Worker through, but the agent refused the call/);
	const probe = s.fetches().find((f) => f.url === `${W}/` && f.method === "POST");
	assert.equal(probe.headers.authorization, undefined, "the public probe is unauthenticated");
	assert.equal(JSON.parse(probe.body).method, "a2a-exposed/verify-unknown-method");
	const ownerProbe = s.fetches().find((f) => f.url === `${W}/owner/facade/verify`);
	assert.equal(ownerProbe.method, "POST");
	assert.match(ownerProbe.headers.authorization, /^Bearer /, "the upstream check is owner-authenticated");

	fs.writeFileSync(path.join(s.dir, "cfg", "peers.json"), JSON.stringify({ jean: { url: "https://jean.example.org", token_env: "PEER_JEAN_TOKEN", token_stored: true } }));
	fs.appendFileSync(path.join(s.dir, "cfg", "config.env"), "PEER_JEAN_TOKEN=fresh-paired-token\n");
	const st = await s.cli(["status"], { PEER_JEAN_TOKEN: "stale-env-token" });
	assert.equal(st.status, 1, st.stdout + st.stderr);
	assert.match(st.stdout, /upstream Access: +credential configured \(UPSTREAM_ACCESS_CLIENT_ID fingerprint bbbbbbbbbbbb\)/);
	assert.match(st.stdout, /upstream bearer: +NONE, but the upstream card asks for one \(bearer: bearer\)/);
	assert.match(st.stdout, /upstream check: +FAILED \(upstream_auth_missing\)/);
	assert.match(st.stdout, /last failure: +upstream_auth_missing \(HTTP 401\) on SendMessage from peer alice at 2026-10-08T10:00:00.000Z/);
	assert.match(st.stdout, /next step: +Access let the Worker through, but the agent refused the call/);
	assert.match(st.stdout, /also: +PEER_JEAN_TOKEN is set in the environment and overrides/);
	assert.ok(!(st.stdout + st.stderr).includes("stale-env-token") && !(st.stdout + st.stderr).includes("fresh-paired-token"));

	worker(facadeOk, reachable);
	const ok = await s.cli(["upstream", "verify", "--json"]);
	assert.equal(ok.status, 0, ok.stdout + ok.stderr);
	const j = JSON.parse(ok.stdout);
	assert.equal(j.ok, true);
	assert.equal(j.upstreamVerify.rpcErrorCode, -32601);
	assert.equal(j.facadePeerAuth.status, 401);
	const st2 = await s.cli(["status"]);
	assert.equal(st2.status, 0, st2.stdout + st2.stderr);
	assert.match(st2.stdout, /upstream check: +OK: Access passed; upstream bearer accepted; A2A app reachable/);
	assert.match(st2.stdout, /next step: +none: the façade is up/);

	const inbox = stubEnv(t);
	const no = await inbox.cli(["upstream", "verify"]);
	assert.equal(no.status, 1);
	assert.match(no.stderr, /not a façade/);
});

test("init: login blocked on a VPS (HTTP 403 before a code) and API tokens that can't list accounts get plain advice", async (t) => {
	const s = stubEnv(t);
	const cf = path.join(s.dir, "worker", "node_modules", ".bin", "cf");
	fs.writeFileSync(cf, `#!/bin/bash\ncase "$1 $2" in "auth whoami") echo "$WHOAMI";; esac\n`, { mode: 0o755 });
	const r = await s.cli(["init", "--worker-name", "uptest", ...s.w], { WHOAMI: '{"authenticated":false}' });
	assert.equal(r.status, 1);
	assert.match(r.stderr, /not logged in to Cloudflare: run `cf auth login --no-browser`/);
	assert.match(r.stderr, /"OAuth error: HTTP 403 Forbidden"[^\n]*BEFORE any code is shown, that is Cloudflare's bot mitigation for datacenter \/ VPS IPs[^\n]*don't retry[^\n]*CLOUDFLARE_API_TOKEN/);
	const tok = await s.cli(["init", "--worker-name", "uptest", ...s.w], { WHOAMI: '{"authenticated":false}', CLOUDFLARE_API_TOKEN: "cf-token-value" });
	assert.equal(tok.status, 1);
	assert.match(tok.stderr, /CLOUDFLARE_API_TOKEN is set but cf does not accept it[^\n]*IPv4 \/32 and IPv6 \/128/);
	const noAcc = await s.cli(["init", "--worker-name", "uptest", ...s.w], { WHOAMI: '{"authenticated":true,"accounts":[]}', CLOUDFLARE_API_TOKEN: "cf-token-value" });
	assert.equal(noAcc.status, 1);
	assert.match(noAcc.stderr, /the API token can't list accounts: add the permission User -> Memberships -> Read \(or pass --account-id/);
	assert.ok(!(r.stderr + tok.stderr + noAcc.stderr).includes("cf-token-value"));
});

test("connect --card-url: a non-public card points at proxy mode", (t) => {
	const lines = [];
	const orig = console.error;
	console.error = (m) => lines.push(String(m));
	t.after(() => { console.error = orig; });
	assert.equal(cardUrlToSend("http://100.101.102.103:8080/.well-known/agent-card.json", "https://inbox.example.com"), "");
	assert.match(lines.join("\n"), /inboxes accept only public https cards\)\. Peers can't call an agent there: to be reachable, expose it through a public façade/);
});
