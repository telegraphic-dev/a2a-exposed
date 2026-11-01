// workers.dev support: pure helpers plus init against a stub `cf` (no network, no Cloudflare account).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "../lib/config.mjs";
import { baseUrlFor, compactPrompt, needsSubdomain, noSubdomainHelp, parseWorkersDevSubdomain, LABEL_RE, REGISTRATION_STEPS, UNAVAILABLE_RE } from "../lib/workersdev.mjs";
import { deployArgs, VERSION, migrationStderr, withoutWranglerConfigMention } from "../lib/deploy.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "a2a-exposed.mjs");

test("baseUrlFor: custom domain wins, else <worker>.<subdomain>.workers.dev, else unknown", () => {
	assert.equal(baseUrlFor({ hostname: "agent.example.com", worker: "w", subdomain: "s" }), "https://agent.example.com");
	assert.equal(baseUrlFor({ worker: "my-agent", subdomain: "acme" }), "https://my-agent.acme.workers.dev");
	assert.equal(baseUrlFor({ worker: "my-agent" }), "");
});

test("parseWorkersDevSubdomain reads cf deploy targets (with ANSI colours)", () => {
	const out = "Deployed my-agent triggers\n  \x1b[36mhttps://my-agent.acme-01.workers.dev\x1b[39m\n  schedule: * * * * *\n";
	assert.equal(parseWorkersDevSubdomain(out, "my-agent"), "acme-01");
	assert.equal(parseWorkersDevSubdomain("  my-agent.acme.workers.dev", "my-agent"), "acme");
	assert.equal(parseWorkersDevSubdomain("other-agent.acme.workers.dev", "my-agent"), "", "only the deployed worker counts");
	assert.equal(parseWorkersDevSubdomain("xmy-agent.acme.workers.dev", "my-agent"), "");
	assert.equal(parseWorkersDevSubdomain("agent.example.com (custom domain)", "my-agent"), "");
});

test("needsSubdomain / help text", () => {
	assert.ok(needsSubdomain("✘ You need to register a workers.dev subdomain before publishing to workers.dev"));
	assert.ok(!needsSubdomain("Deployed"));
	const h = noSubdomainHelp("acc123");
	assert.match(h, /--workers-dev-subdomain/);
	assert.match(h, /dash\.cloudflare\.com\/acc123\/workers\/onboarding/);
	assert.match(h, /PUT \/accounts\/<account-id>\/workers\/subdomain/);
	assert.ok(LABEL_RE.test("my-agent-2") && !LABEL_RE.test("My_Agent") && !LABEL_RE.test("-x"));
});

test("registration prompts match even when the prompt library wraps one character per line", () => {
	// as captured from cf on a 0-column pseudo-terminal
	const q = "Would you like to register a workers.dev subdomain now?";
	const wrapped = "\x1b[?25l\r\n│\r\n\r\n◆\r\n" + [...q].map((c) => `\r\n│\r\n \r\n \r\n${c}`).join("") + "\r\n○\r\n \r\nYes / ● No\r\n";
	const [ask, name, ok] = REGISTRATION_STEPS("acme");
	assert.ok(ask[0].test(compactPrompt(wrapped)));
	assert.ok(name[0].test(compactPrompt("◆  What would you like your workers.dev subdomain to be? It will be accessible at https://<subdomain>.workers.dev\n│  _")));
	assert.equal(name[1], "acme\r");
	assert.ok(ok[0].test(compactPrompt("Creating a workers.dev subdomain for your account at \x1b[34m\x1b[4mhttps://acme.workers.dev\x1b[24m\x1b[39m. Ok to proceed?")));
	assert.ok(UNAVAILABLE_RE.test(compactPrompt("▲  Subdomain is unavailable, please try a different subdomain")));
});

// ------------------------------------------------------------------ init against a stub cf
// The stub emulates the cf commands init uses. `deploy` behaves like cf on an account whose subdomain is
// $STUB_SUBDOMAIN (empty = none registered): non-interactive -> registration error; interactive (a TTY,
// no CI) -> cf's prompts, then the target URL.
const STUB = `#!/bin/bash
log=$STUB_DIR/calls.log
prof=""; for a in "$@"; do [ "$prev" = --profile ] && prof=$a; prev=$a; done
echo "$1 $2 profile=$prof sub=\${A2A_WORKERS_DEV_SUBDOMAIN:-} host=\${A2A_HOSTNAME:-} retired=\${A2A_RETIRED_HOSTNAMES:-}" >> "$log"
[ -n "\${STUB_CWD_LOG:-}" ] && printf '%s %s %s\\n' "$1" "$2" "$(pwd)" >> "$STUB_CWD_LOG"
[ "$1" = deploy ] && printf '%s\\n' "$@" >> "$STUB_DIR/deploy-args.log"
[ "$1" = deploy ] && echo "public=\${A2A_PUBLIC_URL:-}\${PUBLIC_URL:-}" >> "$STUB_DIR/deploy-env.log"
case "$1 $2" in
  "auth whoami")
    if [ -n "\${STUB_WHOAMI_FAIL:-}" ]; then printf '%s\\n' "$STUB_WHOAMI_FAIL" >&2; exit 1; fi
    if [ -n "$prof" ] && [ -n "\${STUB_PROFILE_WHOAMI:-}" ]; then printf '%s\\n' "$STUB_PROFILE_WHOAMI"
    else echo '{"authenticated":true,"accounts":[{"id":"acc123","name":"Test"}]}'; fi
    ;;
  "accounts list")
    if [ -n "\${STUB_ACCOUNTS_FAIL:-}" ]; then printf '%s\\n' "$STUB_ACCOUNTS_FAIL" >&2; exit 1; fi
    printf '%s\\n' "\${STUB_ACCOUNTS_LIST:-[]}"
    ;;
  "d1 list") echo '[{"name":"wdtest","uuid":"d1-uuid"}]';;
  "d1 migrations")
    echo '[]'
    printf '%s\n' '? About to apply 1 migration(s)' 'Your database may not be available to serve requests during the migration, continue?' '  Using fallback value in non-interactive context: yes' >&2
    ;;
  "workers secrets")
    name=""; prev=""
    for a in "$@"; do [ "$prev" = delete ] && name=$a; prev=$a; done
    echo "workers secrets delete $name" >> "$log"
    if [ "$name" = "WAKE_WEBHOOK_URL" ]; then exit 0; fi
    printf "APIError: [10056] Binding '%s' not found\n" "$name" >&2
    exit 1
    ;;
  "deploy --message")
    sub=$(cat "$STUB_DIR/subdomain" 2>/dev/null)
    if [ -z "$sub" ]; then
      if [ -t 0 ] && [ -z "$CI" ]; then
        q='Would you like to register a workers.dev subdomain now?'
        cols=$(stty size 2>/dev/null | cut -d' ' -f2)
        printf '? You need to register a workers.dev subdomain before publishing to workers.dev\\n'
        # like cf's prompt library on a 0-column pty: one character per line between box glyphs
        if [ "\${cols:-0}" -lt 20 ]; then for ((i=0; i<\${#q}; i++)); do printf '\\r\\n\\u2502\\r\\n \\r\\n%s' "\${q:i:1}"; done; printf '\\r\\n\\u25cb Yes / \\u25cf No\\r\\n'
        else printf '\\u25c6  %s \\u25cb Yes / \\u25cf No ' "$q"; fi
        read -r -n1 a; echo; [ "$a" = y ] || exit 1
        printf '? What would you like your workers.dev subdomain to be? It will be accessible at https://<subdomain>.workers.dev\\n> '
        read -r name
        if [ "$name" = taken ]; then printf 'Subdomain is unavailable, please try a different subdomain\\n? What would you like your workers.dev subdomain to be?\\n> '; read -r name; exit 1; fi
        printf '? Creating a workers.dev subdomain for your account at https://%s.workers.dev. Ok to proceed? (Y/n) ' "$name"
        read -r -n1 a; echo; [ "$a" = y ] || exit 1
        echo "$name" > "$STUB_DIR/subdomain"; sub=$name
        echo "Success! It may take a few minutes for DNS records to update."
      else
        echo "✘ [ERROR] You need to register a workers.dev subdomain before publishing to workers.dev" >&2; exit 1
      fi
    fi
    if [ -n "\${A2A_RETIRED_HOSTNAMES:-}" ]; then printf '%s\n' "Because 'preview_urls' is not in your Wrangler config file, Preview URLs will be enabled." >&2; fi
    printf 'Uploaded %s\\nDeployed %s triggers\\n  \\033[36mhttps://%s.%s.workers.dev\\033[0m\\n' "$A2A_WORKER_NAME" "$A2A_WORKER_NAME" "$A2A_WORKER_NAME" "$sub";;
esac
`;

function stubEnv(t, { subdomain = "" } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-wd-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const bin = path.join(dir, "worker", "node_modules", ".bin");
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(bin, "cf"), STUB, { mode: 0o755 });
	if (subdomain) fs.writeFileSync(path.join(dir, "subdomain"), subdomain + "\n");
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(A2A_|PEER_|CLOUDFLARE_)|WAKE_/.test(k)));
	Object.assign(env, { A2A_CONFIG_DIR: path.join(dir, "cfg"), STUB_DIR: dir, A2A_VERIFY_TRIES: "0", A2A_NO_UPDATE_CHECK: "1" });
	const routes = path.join(dir, "fetch-routes.json");
	fs.writeFileSync(routes, JSON.stringify({ "https://wdtest.acme.workers.dev/owner/pairing": { status: 200, body: { mode: "human", passwordSet: false } } }));
	Object.assign(env, { NODE_OPTIONS: `--import=${fileURLToPath(new URL("./fetch-stub.mjs", import.meta.url))}`, A2A_TEST_FETCH_ROUTES: routes });
	const cli = (args, extraEnv = {}) => new Promise((resolve) => {
		const ch = spawn(process.execPath, [BIN, ...args], { env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		ch.stdout.on("data", (d) => (stdout += d));
		ch.stderr.on("data", (d) => (stderr += d));
		ch.on("close", (status) => resolve({ status, stdout, stderr }));
	});
	const config = () => parseEnv(fs.readFileSync(path.join(dir, "cfg", "config.env"), "utf8"));
	const calls = () => fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n");
	const init = (...extra) => cli(["init", "--worker-name", "wdtest", "--skip-install", "--dir", path.join(dir, "worker"), ...extra]);
	return { dir, cli, config, calls, init, routes };
}

test("init without --hostname: learns the existing subdomain from cf, saves the URL, redeploys once", async (t) => {
	const s = stubEnv(t, { subdomain: "acme" });
	const r = await s.init();
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout.trim(), "https://wdtest.acme.workers.dev");
	assert.match(r.stderr, /Approval password: not set[^\n]*pair set-password --web/);
	assert.match(r.stderr, /Like it\? Star us: https:\/\/github\.com\/telegraphic-dev\/a2a-exposed/);
	assert.ok(!/Using fallback value in non-interactive context/.test(r.stderr), r.stderr);
	assert.equal(r.stdout.includes("Like it?"), false);
	const args = fs.readFileSync(path.join(s.dir, "deploy-args.log"), "utf8");
	assert.match(args, new RegExp(`--tag\\na2a-exposed-${VERSION.replaceAll(".", "\\.")}`));
	assert.match(args, new RegExp(`--message\\na2a-exposed ${VERSION.replaceAll(".", "\\.")} \\d{4}-\\d{2}-\\d{2}T`));
	const c = s.config();
	assert.equal(c.A2A_BASE_URL, "https://wdtest.acme.workers.dev");
	assert.equal(c.A2A_WORKERS_DEV_SUBDOMAIN, "acme");
	assert.ok(!c.A2A_HOSTNAME);
	const deploys = s.calls().filter((l) => l.startsWith("deploy"));
	assert.deepEqual(deploys, ["deploy --message profile= sub= host= retired=", "deploy --message profile= sub=acme host= retired="]);
	// a later deploy knows the URL up front: no second round
	const r2 = await s.cli(["deploy", "--skip-install"]);
	assert.equal(r2.status, 0, r2.stderr);
	assert.equal(s.calls().filter((l) => l.startsWith("deploy")).length, 3);
});

test("init: a local URL in the environment never reaches the agent card; the deployment's URL is printed and saved", async (t) => {
	const s = stubEnv(t, { subdomain: "acme" });
	// e.g. an agent that exported its own (Tailnet) webhook URL under these names
	const local = { A2A_PUBLIC_URL: "http://hermes.example.ts.net:8644", PUBLIC_URL: "http://100.101.102.103:8644", A2A_BASE_URL: "http://hermes.example.ts.net:8644" };
	const r = await s.cli(["init", "--worker-name", "wdtest", "--skip-install", "--dir", path.join(s.dir, "worker")], local);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout.trim(), "https://wdtest.acme.workers.dev");
	assert.equal(s.config().A2A_BASE_URL, "https://wdtest.acme.workers.dev");
	assert.deepEqual(fs.readFileSync(path.join(s.dir, "deploy-env.log"), "utf8").trim().split("\n"), ["public=", "public="], "not passed to cloudflare.config.ts");
	assert.match(r.stderr, /warning: A2A_BASE_URL is exported as http:\/\/hermes\.example\.ts\.net:8644, but this deployment is https:\/\/wdtest\.acme\.workers\.dev[^\n]*unset A2A_BASE_URL/);
});

test("init without a subdomain on the account explains how to create one", async (t) => {
	const s = stubEnv(t);
	const r = await s.init("--workers-dev");
	assert.equal(r.status, 1);
	assert.match(r.stderr, /no workers\.dev subdomain yet/);
	assert.equal(r.stderr.includes("Like it? Star us:"), false);
	assert.match(r.stderr, /--workers-dev-subdomain <name>/);
	assert.match(r.stderr, /dash\.cloudflare\.com\/acc123\/workers\/onboarding/);
	assert.ok(!s.config().A2A_BASE_URL);
});

test("--workers-dev-subdomain registers it through cf's prompt (pseudo-terminal) and deploys once", { skip: process.platform === "win32" }, async (t) => {
	const s = stubEnv(t);
	const r = await s.init("--workers-dev-subdomain", "newsub");
	assert.equal(r.status, 0, r.stderr);
	assert.equal(fs.readFileSync(path.join(s.dir, "subdomain"), "utf8").trim(), "newsub");
	assert.equal(s.config().A2A_BASE_URL, "https://wdtest.newsub.workers.dev");
	const deploys = s.calls().filter((l) => l.startsWith("deploy"));
	assert.deepEqual(deploys, ["deploy --message profile= sub= host= retired=", "deploy --message profile= sub=newsub host= retired="], "failed attempt, then the registering deploy");
});

test("--workers-dev-subdomain with a taken name fails cleanly", { skip: process.platform === "win32" }, async (t) => {
	const s = stubEnv(t);
	const r = await s.init("--workers-dev-subdomain", "taken");
	assert.equal(r.status, 1);
	assert.match(r.stderr, /"taken" is unavailable/);
	assert.ok(!s.config().A2A_WORKERS_DEV_SUBDOMAIN);
});

test("custom-domain init is unchanged: no workers.dev, base from the hostname, single deploy", async (t) => {
	const s = stubEnv(t, { subdomain: "acme" });
	const r = await s.init("--hostname", "agent.example.com");
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout.trim(), "https://agent.example.com");
	assert.equal(s.config().A2A_BASE_URL, "https://agent.example.com");
	assert.deepEqual(s.calls().filter((l) => l.startsWith("deploy")), ["deploy --message profile= sub= host=agent.example.com retired="]);
});

test("invalid worker name for workers.dev is rejected before anything is created", async (t) => {
	const s = stubEnv(t);
	const r = await s.cli(["init", "--worker-name", "Bad_Name", "--skip-install", "--dir", path.join(s.dir, "worker")]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /DNS label/);
	assert.ok(!fs.existsSync(path.join(s.dir, "calls.log")));
});

test("--cf-profile is saved and passed as --profile to every cf call", async (t) => {
	const s = stubEnv(t, { subdomain: "acme" });
	const r = await s.init("--cf-profile", "bot-acct");
	assert.equal(r.status, 0, r.stderr);
	assert.equal(s.config().CF_PROFILE, "bot-acct");
	assert.match(r.stderr, /cf profile bot-acct/);
	const lines = s.calls();
	assert.ok(lines.every((l) => l.includes("profile=bot-acct")), lines.join("\n"));
	assert.ok(lines.some((l) => l.startsWith("auth whoami")));
	assert.ok(!lines.some((l) => l.startsWith("accounts list")), "whoami already listed the account");
	assert.ok(lines.some((l) => l.startsWith("d1 list")));
	assert.ok(lines.some((l) => l.startsWith("deploy")));
	// a later deploy without the flag still uses the saved profile
	const r2 = await s.cli(["deploy", "--skip-install"]);
	assert.equal(r2.status, 0, r2.stderr);
	assert.ok(s.calls().filter((l) => l.startsWith("deploy")).every((l) => l.includes("profile=bot-acct")));
});

function recordedCwds(file, command) {
	return fs.readFileSync(file, "utf8").trim().split("\n")
		.filter((l) => l.startsWith(command + " "))
		.map((l) => l.slice(command.length + 1));
}

function samePath(a, b) {
	return fs.realpathSync(a) === fs.realpathSync(b);
}

test("init --cf-profile reads cf accounts list when whoami lists none", async (t) => {
	const s = stubEnv(t, { subdomain: "acme" });
	const cwdLog = path.join(s.dir, "cwd.log");
	const worker = path.join(s.dir, "worker");
	const r = await s.cli(
		["init", "--worker-name", "wdtest", "--skip-install", "--dir", worker, "--cf-profile", "bot-acct"],
		{ STUB_PROFILE_WHOAMI: '{"authenticated":true,"accounts":[]}', STUB_ACCOUNTS_LIST: '{"result":[{"id":"acc999","name":"Bot Co"}]}', STUB_CWD_LOG: cwdLog },
	);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(s.config().CLOUDFLARE_ACCOUNT_ID, "acc999");
	assert.ok(s.calls().some((l) => l.startsWith("accounts list") && l.includes("profile=bot-acct")), s.calls().join("\n"));
	assert.doesNotMatch(r.stderr, /0 accounts/);
	assert.match(r.stderr, /Bot Co/);
	for (const cwd of [...recordedCwds(cwdLog, "auth whoami"), ...recordedCwds(cwdLog, "accounts list")]) {
		assert.equal(samePath(cwd, worker), false, cwd);
		assert.equal(fs.existsSync(path.join(cwd, "cloudflare.config.ts")), false, cwd);
	}
	for (const cwd of recordedCwds(cwdLog, "deploy --message")) assert.equal(samePath(cwd, worker), true, cwd);
});

test("init --cf-profile with several accounts from cf accounts list still requires --account-id", async (t) => {
	const s = stubEnv(t, { subdomain: "acme" });
	const r = await s.cli(
		["init", "--worker-name", "wdtest", "--skip-install", "--dir", path.join(s.dir, "worker"), "--cf-profile", "bot-acct"],
		{ STUB_PROFILE_WHOAMI: '{"authenticated":true,"accounts":[]}', STUB_ACCOUNTS_LIST: '[{"id":"acc1","name":"One"},{"id":"acc2","name":"Two"}]' },
	);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /2 accounts available/);
	assert.match(r.stderr, /acc1/);
	assert.match(r.stderr, /acc2/);
	assert.doesNotMatch(r.stderr, /could not list Cloudflare accounts/);
	assert.ok(!s.config().CLOUDFLARE_ACCOUNT_ID);
});

test("init --cf-profile with an empty accounts list reports 0 accounts", async (t) => {
	const s = stubEnv(t, { subdomain: "acme" });
	const r = await s.cli(
		["init", "--worker-name", "wdtest", "--skip-install", "--dir", path.join(s.dir, "worker"), "--cf-profile", "bot-acct"],
		{ STUB_PROFILE_WHOAMI: '{"authenticated":true,"accounts":[]}', STUB_ACCOUNTS_LIST: "[]" },
	);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /0 accounts available/);
	assert.doesNotMatch(r.stderr, /could not list Cloudflare accounts/);
	assert.ok(s.calls().some((l) => l.startsWith("accounts list")));
});

test("init --cf-profile reports a failed accounts list instead of 0 accounts", async (t) => {
	const s = stubEnv(t, { subdomain: "acme" });
	const err = "Cannot find package 'cf' imported from /tmp/worker/cloudflare.config.ts";
	const r = await s.cli(
		["init", "--worker-name", "wdtest", "--skip-install", "--dir", path.join(s.dir, "worker"), "--cf-profile", "bot-acct"],
		{ STUB_PROFILE_WHOAMI: '{"authenticated":true,"accounts":[]}', STUB_ACCOUNTS_FAIL: err },
	);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /could not list Cloudflare accounts for profile "bot-acct": Cannot find package 'cf'/);
	assert.match(r.stderr, /cf accounts list failed \(exit 1\)/);
	assert.match(r.stderr, /Check: npx --yes cf accounts list --profile bot-acct {3}\(run it outside the project directory\)/);
	assert.match(r.stderr, /Or pass --account-id <id>/);
	assert.doesNotMatch(r.stderr, /0 accounts available/);
	assert.equal(s.config().CLOUDFLARE_ACCOUNT_ID, undefined);
});

test("init --cf-profile with --account-id continues when accounts list fails", async (t) => {
	const s = stubEnv(t, { subdomain: "acme" });
	const r = await s.cli(
		["init", "--worker-name", "wdtest", "--skip-install", "--dir", path.join(s.dir, "worker"), "--cf-profile", "bot-acct", "--account-id", "acc999"],
		{ STUB_PROFILE_WHOAMI: '{"authenticated":true,"accounts":[]}', STUB_ACCOUNTS_FAIL: "Cannot find package 'cf' imported from /tmp/worker/cloudflare.config.ts" },
	);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(s.config().CLOUDFLARE_ACCOUNT_ID, "acc999");
	assert.ok(s.calls().some((l) => l.startsWith("accounts list")), s.calls().join("\n"));
	assert.ok(s.calls().some((l) => l.startsWith("deploy")), s.calls().join("\n"));
	assert.doesNotMatch(r.stderr, /could not list Cloudflare accounts/);
	assert.doesNotMatch(r.stderr, /0 accounts available/);
});

test("init --cf-profile keeps CLOUDFLARE_ACCOUNT_ID when accounts list fails", async (t) => {
	const s = stubEnv(t, { subdomain: "acme" });
	const r = await s.cli(
		["init", "--worker-name", "wdtest", "--skip-install", "--dir", path.join(s.dir, "worker"), "--cf-profile", "bot-acct"],
		{ STUB_PROFILE_WHOAMI: '{"authenticated":true,"accounts":[]}', STUB_ACCOUNTS_FAIL: "Cannot find package 'cf'", CLOUDFLARE_ACCOUNT_ID: "accenv" },
	);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stderr, /Cloudflare account: accenv/);
	assert.ok(s.calls().some((l) => l.startsWith("deploy")), s.calls().join("\n"));
	assert.doesNotMatch(r.stderr, /could not list Cloudflare accounts|0 accounts available/);
});

test("init surfaces a failing cf auth whoami with its stderr and exit code", async (t) => {
	const s = stubEnv(t, { subdomain: "acme" });
	const r = await s.cli(
		["init", "--worker-name", "wdtest", "--skip-install", "--dir", path.join(s.dir, "worker"), "--cf-profile", "bot-acct"],
		{ STUB_WHOAMI_FAIL: "Cannot find package 'cf' imported from /tmp/worker/cloudflare.config.ts" },
	);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /cf auth whoami failed \(exit 1\): Cannot find package 'cf'/);
	assert.match(r.stderr, /Check: npx --yes cf auth whoami --profile bot-acct {3}\(run it outside the project directory\)/);
	assert.doesNotMatch(r.stderr, /0 accounts available/);
	assert.doesNotMatch(r.stderr, /could not list Cloudflare accounts/);
});

test("init --cf-profile reaches deploy when cf fails inside the Worker directory before install", async (t) => {
	const s = stubEnv(t, { subdomain: "acme" });
	const worker = path.join(s.dir, "worker");
	const bin = path.join(s.dir, "bin");
	fs.rmSync(path.join(worker, "node_modules"), { recursive: true, force: true });
	fs.mkdirSync(bin);
	const cf = path.join(bin, "cf");
	const body = STUB.replace(/^#!\/bin\/bash\n/, "");
	const script = `#!/bin/bash
here=$(pwd)
printf '%s %s %s\\n' "$1" "$2" "$here" >> "$STUB_DIR/login-cwd.log"
if [ -f "$here/cloudflare.config.ts" ] && [ ! -e "$here/node_modules/cf" ]; then
  printf '%s\\n' "Cannot find package 'cf' imported from $here/cloudflare.config.ts" >&2
  exit 1
fi
${body}`;
	fs.writeFileSync(cf, script, { mode: 0o755 });
	fs.writeFileSync(path.join(bin, "npx"), `#!/bin/bash
if [ "$1" = "--yes" ] && [ "$2" = "cf" ]; then
  shift 2
  exec ${JSON.stringify(cf)} "$@"
fi
echo "unexpected npx $*" >&2
exit 1
`, { mode: 0o755 });
	fs.writeFileSync(path.join(bin, "npm"), `#!/bin/bash
if [ "$1" = install ]; then
  mkdir -p node_modules/cf node_modules/.bin
  cp ${JSON.stringify(cf)} node_modules/.bin/cf
  chmod +x node_modules/.bin/cf
  exit 0
fi
echo "unexpected npm $*" >&2
exit 1
`, { mode: 0o755 });
	const r = await s.cli(
		["init", "--worker-name", "wdtest", "--dir", worker, "--cf-profile", "bot-acct"],
		{
			PATH: `${bin}:${process.env.PATH}`,
			STUB_PROFILE_WHOAMI: '{"authenticated":true,"accounts":[]}',
			STUB_ACCOUNTS_LIST: '{"result":[{"id":"acc999","name":"Bot Co"}]}',
		},
	);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(s.config().CLOUDFLARE_ACCOUNT_ID, "acc999");
	assert.ok(s.calls().some((l) => l.startsWith("deploy")), s.calls().join("\n"));
	assert.doesNotMatch(r.stderr, /Cannot find package 'cf'|0 accounts available|could not list Cloudflare accounts/);
	assert.equal(fs.existsSync(path.join(worker, "node_modules", "cf")), true);
	const log = path.join(s.dir, "login-cwd.log");
	for (const cwd of [...recordedCwds(log, "auth whoami"), ...recordedCwds(log, "accounts list")]) {
		assert.equal(samePath(cwd, worker), false, cwd);
		assert.equal(fs.existsSync(path.join(cwd, "cloudflare.config.ts")), false, cwd);
	}
	assert.ok(recordedCwds(log, "deploy --message").length > 0);
	for (const cwd of recordedCwds(log, "deploy --message")) assert.equal(samePath(cwd, worker), true, cwd);
});

// ------------------------------------------------------------------ switching between a custom domain and workers.dev
test("deploy --workers-dev moves a custom-domain deployment to workers.dev; the old hostname is retired", async (t) => {
	const s = stubEnv(t, { subdomain: "acme" });
	assert.equal((await s.init("--hostname", "agent.example.com")).status, 0);
	fs.appendFileSync(path.join(s.dir, "cfg", "config.env"), "A2A_TUNNEL_ID=tun1\nA2A_TUNNEL_HOSTNAME=wake-x.example.com\n");
	const r = await s.cli(["deploy", "--skip-install", "--workers-dev"]);
	assert.equal(r.status, 0, r.stderr);
	const c = s.config();
	assert.ok(!c.A2A_HOSTNAME, "hostname cleared");
	assert.equal(c.A2A_BASE_URL, "https://wdtest.acme.workers.dev");
	assert.equal(c.A2A_RETIRED_HOSTNAMES, "agent.example.com");
	assert.equal(c.A2A_TUNNEL_ID, "tun1", "tunnel settings untouched");
	assert.equal(r.stdout.trim(), "https://wdtest.acme.workers.dev");
	assert.match(r.stderr, /moved from https:\/\/agent\.example\.com to https:\/\/wdtest\.acme\.workers\.dev/);
	assert.match(r.stderr, /agent\.example\.com no longer serves this agent.*410 Gone/s);
	assert.match(r.stderr, /Peers must update their URL for this agent: https:\/\/wdtest\.acme\.workers\.dev\/\.well-known\/agent-card\.json/);
	assert.match(r.stderr, /wake tunnel is unaffected/);
	assert.equal(withoutWranglerConfigMention(r.stderr), r.stderr);
	assert.ok(!/Wrangler config file|Wrangler file/i.test(r.stderr), r.stderr);
	// deploys after the switch: workers.dev (no custom domain), retired hostname passed to the Worker; the
	// subdomain was learned on the first one and baked in by one more deploy
	const deploys = s.calls().filter((l) => l.startsWith("deploy")).slice(1);
	assert.deepEqual(deploys, [
		"deploy --message profile= sub= host= retired=agent.example.com",
		"deploy --message profile= sub=acme host= retired=agent.example.com",
	]);
	assert.equal((await s.cli(["url"])).stdout.trim(), "https://wdtest.acme.workers.dev");
});

test("deploy --hostname moves a workers.dev deployment back to a custom domain", async (t) => {
	const s = stubEnv(t, { subdomain: "acme" });
	assert.equal((await s.init()).status, 0);
	const r = await s.cli(["deploy", "--skip-install", "--hostname", "https://Agent.Example.com/"]);
	assert.equal(r.status, 0, r.stderr);
	const c = s.config();
	assert.equal(c.A2A_HOSTNAME, "agent.example.com");
	assert.equal(c.A2A_BASE_URL, "https://agent.example.com");
	assert.ok(!c.A2A_RETIRED_HOSTNAMES);
	assert.equal(r.stdout.trim(), "https://agent.example.com");
	assert.match(r.stderr, /moved from https:\/\/wdtest\.acme\.workers\.dev to https:\/\/agent\.example\.com/);
	assert.match(r.stderr, /workers\.dev URL is switched off/);
	assert.equal(s.calls().filter((l) => l.startsWith("deploy")).at(-1), "deploy --message profile= sub=acme host=agent.example.com retired=");
	// and to workers.dev again, then back to the same hostname: it is un-retired
	assert.equal((await s.cli(["deploy", "--skip-install", "--workers-dev"])).status, 0);
	assert.equal(s.config().A2A_RETIRED_HOSTNAMES, "agent.example.com");
	assert.equal((await s.cli(["deploy", "--skip-install", "--hostname", "agent.example.com"])).status, 0);
	assert.ok(!s.config().A2A_RETIRED_HOSTNAMES);
});

test("migrationStderr drops the non-interactive confirm line", () => {
	const raw = "? About to apply 1 migration(s)\nYour database may not be available to serve requests during the migration, continue?\n  Using fallback value in non-interactive context: yes\n[1000] real failure\n";
	assert.equal(migrationStderr(raw), "[1000] real failure");
	assert.equal(withoutWranglerConfigMention("keep\nedit your Wrangler config file\n"), "keep\n");
});

test("wake unset treats a missing secret as already unset and prints one line", async (t) => {
	const s = stubEnv(t, { subdomain: "acme" });
	assert.equal((await s.init()).status, 0);
	const r = await s.cli(["wake", "unset"]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stderr, /wake secrets removed \(wake is now a no-op; use polling\)/);
	assert.ok(!/APIError|not found|10056/.test(r.stderr), r.stderr);
	assert.equal(r.stderr.trim().split("\n").filter((l) => /wake secrets|APIError|not found/.test(l)).length, 1);
});

test("init --rotate-owner-token says what to update next", async (t) => {
	const s = stubEnv(t, { subdomain: "acme" });
	assert.equal((await s.init()).status, 0);
	const old = s.config().A2A_OWNER_TOKEN;
	const r = await s.cli(["init", "--skip-install", "--rotate-owner-token", "--dir", path.join(s.dir, "worker")]);
	assert.equal(r.status, 0, r.stderr);
	assert.ok(s.config().A2A_OWNER_TOKEN && s.config().A2A_OWNER_TOKEN !== old);
	assert.match(r.stderr, /owner token replaced\. Update A2A_OWNER_TOKEN wherever this A2A endpoint is called, then run `npx -y a2a-exposed@latest peers sync`/);
	assert.ok(!r.stderr.includes(old) && !r.stderr.includes(s.config().A2A_OWNER_TOKEN));
});

test("--workers-dev and --hostname together are rejected", async (t) => {
	const s = stubEnv(t, { subdomain: "acme" });
	const r = await s.init("--workers-dev", "--hostname", "agent.example.com");
	assert.equal(r.status, 1);
	assert.match(r.stderr, /mutually exclusive/);
});


test("wake set accepts openbot and rejects unknown presets without exposing secrets", async (t) => {
	const s = stubEnv(t, { subdomain: "acme" });
	assert.equal((await s.init()).status, 0);
	const args = ["wake", "set", "--skip-install", "--dir", path.join(s.dir, "worker"), "--preset"];
	const result = await s.cli([...args, "openbot"], { WAKE_HMAC_SECRET: "dummy-openbot-secret" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(s.config().WAKE_PRESET, "openbot");
	assert.ok(!fs.readFileSync(path.join(s.dir, "cfg", "config.env"), "utf8").includes("dummy-openbot-secret"));
	assert.ok(!(result.stdout + result.stderr).includes("dummy-openbot-secret"));
	const invalid = await s.cli([...args, "unknown-preset"]);
	assert.notEqual(invalid.status, 0);
	assert.match(invalid.stderr, /unknown preset/);
});

test("deploy arguments carry the package version tag and dated message", () => {
	const date = "2026-10-28T12:00:00.000Z";
	assert.deepEqual(deployArgs(VERSION, date), ["deploy", "--message", `a2a-exposed ${VERSION} ${date}`, "--tag", `a2a-exposed-${VERSION}`]);
	assert.match(deployArgs(VERSION, date)[4], /^[A-Za-z0-9._-]+$/);
	assert.throws(() => deployArgs("bad+tag", date), /invalid Worker version tag/);
});

for (const [name, response, expected] of [
	["existing password", { status: 200, body: { mode: "human", passwordSet: true } }, /Approval password: set\./],
	["unavailable owner API", { status: 503, body: { error: "unavailable" } }, /Approval password: could not check[^\n]*pair list --json/],
	["invalid response", { status: 200, body: { mode: "human" } }, /Approval password: could not check[^\n]*pair list --json/],
]) test(`init readiness: ${name}`, async (t) => {
	const s = stubEnv(t, { subdomain: "acme" });
	fs.writeFileSync(s.routes, JSON.stringify({ "https://wdtest.acme.workers.dev/owner/pairing": response }));
	const r = await s.init();
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stderr, expected);
	assert.doesNotMatch(r.stderr, /Approval password: not set/);
});

test("init readiness: pairing disabled does not report missing password", async (t) => {
	const s = stubEnv(t, { subdomain: "acme" });
	fs.writeFileSync(s.routes, JSON.stringify({ "https://wdtest.acme.workers.dev/owner/pairing": { status: 200, body: { mode: "off", passwordSet: false } } }));
	const r = await s.init("--pairing-approval", "off");
	assert.equal(r.status, 0, r.stderr);
	assert.doesNotMatch(r.stderr, /Approval password:/);
});

for (const methods of [["oidc"], ["password", "oidc"], ["password"]]) test(`init readiness respects approval methods: ${methods}`, async (t) => {
	const s = stubEnv(t, { subdomain: "acme" });
	fs.writeFileSync(s.routes, JSON.stringify({ "https://wdtest.acme.workers.dev/owner/pairing": { status: 200, body: { mode: "human", passwordSet: false, approvalMethods: methods } } }));
	const r = await s.init();
	assert.equal(r.status, 0, r.stderr);
	if (methods.includes("password")) assert.match(r.stderr, /Approval password: not set[^\n]*pair set-password --web/);
	else assert.doesNotMatch(r.stderr, /Approval password:|pair set-password --web/);
});
