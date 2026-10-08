// Non-interactive deploy helper around the Cloudflare `cf` CLI: init, deploy, wake set|unset|test|preview|fingerprint.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as C from "./config.mjs";
import { cardUrlProblem, die, fingerprint, httpJson, randomToken } from "./a2a.mjs";
import { owner } from "./commands.mjs";
import * as WD from "./workersdev.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRESETS = ["grok-bot", "claude-code", "openclaw-wake", "openclaw-agent", "hermes", "generic"];
// WAKE_ACCESS_*: Cloudflare Access service token for a wake URL behind Access (set by `tunnel create`, or exported
// by hand for your own Access-protected endpoint)
export const WAKE_SECRETS = ["WAKE_WEBHOOK_URL", "WAKE_WEBHOOK_KEY", "WAKE_HMAC_SECRET", "WAKE_ACCESS_CLIENT_ID", "WAKE_ACCESS_CLIENT_SECRET"];

// Non-secret deploy settings persisted in config.env and passed to cloudflare.config.ts as env vars.
const DEPLOY_KEYS = [
	"CLOUDFLARE_ACCOUNT_ID", "A2A_WORKER_NAME", "A2A_HOSTNAME", "A2A_D1_ID", "A2A_D1_NAME",
	"A2A_AGENT_NAME", "A2A_AGENT_DESCRIPTION", "A2A_AGENT_VERSION", "A2A_AGENT_SKILLS",
	"A2A_PROVIDER_ORGANIZATION", "A2A_PROVIDER_URL", "A2A_DOCUMENTATION_URL",
	"WAKE_PRESET", "WAKE_AGENT_ID", "WAKE_KEY_HEADER", "WAKE_KEY_PREFIX", "WAKE_BODY_TEMPLATE", "WAKE_CLI_COMMAND",
	"WAKE_DEBOUNCE_SECONDS", "WAKE_MAX_PER_HOUR", "A2A_MAX_BODY", "A2A_RATE_PER_MIN", "A2A_ENABLE_CRON",
	"A2A_WORKERS_DEV_SUBDOMAIN", "A2A_RETIRED_HOSTNAMES", "PAIRING_APPROVAL",
];
// init/deploy flag -> config key
const FLAG_KEYS = {
	"account-id": "CLOUDFLARE_ACCOUNT_ID", "cf-profile": "CF_PROFILE", "worker-name": "A2A_WORKER_NAME", hostname: "A2A_HOSTNAME", "d1-name": "A2A_D1_NAME",
	"agent-name": "A2A_AGENT_NAME", "agent-description": "A2A_AGENT_DESCRIPTION", "agent-skills": "A2A_AGENT_SKILLS",
	"provider-organization": "A2A_PROVIDER_ORGANIZATION", "provider-url": "A2A_PROVIDER_URL",
	preset: "WAKE_PRESET", "agent-id": "WAKE_AGENT_ID", "key-header": "WAKE_KEY_HEADER", "key-prefix": "WAKE_KEY_PREFIX",
	"body-template": "WAKE_BODY_TEMPLATE", "cli-command": "WAKE_CLI_COMMAND", debounce: "WAKE_DEBOUNCE_SECONDS", "max-per-hour": "WAKE_MAX_PER_HOUR",
	"pairing-approval": "PAIRING_APPROVAL",
};
export const PAIRING_MODES = ["human", "agent", "off"];
export const DEPLOY_FLAGS = Object.keys(FLAG_KEYS);

const step = (s) => console.error(`==> ${s}`);
export const workerName = () => C.get("A2A_WORKER_NAME", "a2a-over-webhook");
/** No custom hostname: the Worker is served on <worker>.<account subdomain>.workers.dev (and only there). */
const workersDevMode = () => !C.get("A2A_HOSTNAME");
export const publicBase = () =>
	WD.baseUrlFor({ hostname: C.get("A2A_HOSTNAME"), worker: workerName(), subdomain: C.get("A2A_WORKERS_DEV_SUBDOMAIN") });
export const workerDir = (o) => path.resolve(o.dir || C.get("A2A_WORKER_DIR") || path.join(C.CONFIG_DIR, "worker"));

export function checkNode() {
	const [maj, min] = process.versions.node.split(".").map(Number);
	if (maj < 22 || (maj === 22 && min < 18)) die(`Node ${process.versions.node} found; Node 22.18+ is required (cf CLI requirement)`);
}

function templateDir() {
	for (const d of [path.join(PKG_ROOT, "worker"), path.join(PKG_ROOT, "..", "worker")])
		if (fs.existsSync(path.join(d, "cloudflare.config.ts"))) return d;
	die("worker template not found next to the CLI (reinstall the package or run from a repo checkout)");
}

function syncTemplate(dir) {
	const src = templateDir();
	if (path.resolve(src) === dir) return;
	const skip = new Set(["node_modules", ".cloudflare", ".wrangler", "deploy.env"]);
	fs.mkdirSync(dir, { recursive: true });
	fs.cpSync(src, dir, { recursive: true, force: true, filter: (p) => !skip.has(path.basename(p)) });
}

function run(cmd, args, { cwd, env, capture = false, allowFail = false } = {}) {
	const r = spawnSync(cmd, args, { cwd, env: env || process.env, stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"], encoding: "utf8" });
	if (r.error) die(`${cmd}: ${r.error.message}`);
	if (r.status !== 0 && !allowFail) die(`${cmd} ${args[0] || ""} ${args[1] || ""} failed (exit ${r.status})`);
	return r;
}

export function cfBin(dir) {
	const local = path.join(dir, "node_modules", ".bin", "cf");
	return fs.existsSync(local) ? local : "cf";
}

/** cf auth profile (--cf-profile / CF_PROFILE): appended as `--profile <name>` to every cf call. Empty = cf's own
 *  resolution (a profile bound to the directory with `cf auth activate`, else `default`). */
export const cfProfile = () => C.get("CF_PROFILE");
export const cfArgs = (args) => (cfProfile() ? [...args, "--profile", cfProfile()] : args);
const runCf = (dir, args, opts) => run(cfBin(dir), cfArgs(args), { cwd: dir, ...opts });

function cfJson(dir, args, env) {
	const r = runCf(dir, args, { env, capture: true });
	try { return JSON.parse(r.stdout); } catch { die(`unexpected output from cf ${args.join(" ")}`); }
}

function deployEnv() {
	const env = { ...process.env, CI: "1" };
	for (const k of DEPLOY_KEYS) {
		const v = C.get(k);
		if (v !== "") env[k] = v;
		else if (k !== "WAKE_KEY_PREFIX") delete env[k];
	}
	if ("WAKE_KEY_PREFIX" in C.fileConfig()) env.WAKE_KEY_PREFIX = C.fileConfig().WAKE_KEY_PREFIX;
	for (const k of WAKE_SECRETS) delete env[k]; // secrets only travel via the secrets file
	// the agent card URL comes from A2A_HOSTNAME / the workers.dev subdomain only (older templates read these)
	delete env.A2A_PUBLIC_URL; delete env.PUBLIC_URL;
	return env;
}

/** Environment for cf calls other than deploy: account pinned, wake secrets stripped. */
export function cfEnv() {
	const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: C.get("CLOUDFLARE_ACCOUNT_ID") };
	for (const k of WAKE_SECRETS) delete env[k];
	return env;
}

export async function withSecretsFile(secrets, fn) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-secrets-"));
	const file = path.join(tmp, "secrets.json");
	try {
		fs.writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
		return await fn(file);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

export function wakeSecretsFromEnv() {
	const s = {};
	for (const k of WAKE_SECRETS) if (process.env[k]) s[k] = process.env[k];
	return s;
}

const csv = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

/** Save init/deploy flags. Returns { from, to } when the public URL switches between a custom domain and
 *  workers.dev (or to another custom domain), so the caller can tell the user what changed. */
function applyFlags(o) {
	const upd = {};
	for (const [flag, key] of Object.entries(FLAG_KEYS)) if (o[flag] !== undefined) upd[key] = o[flag];
	if (o.cron) upd.A2A_ENABLE_CRON = "1";
	if (o["workers-dev"] && o.hostname) die("--workers-dev and --hostname are mutually exclusive (--workers-dev moves the Worker to workers.dev)");
	if (upd.A2A_HOSTNAME) upd.A2A_HOSTNAME = upd.A2A_HOSTNAME.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
	if (o["workers-dev"]) upd.A2A_HOSTNAME = null;
	upd.A2A_WORKERS_DEV = null; // pre-release key ("also serve on workers.dev"); --workers-dev now switches
	// cf deploys never detach a custom domain, so a hostname we move away from is retired in the Worker
	// (RETIRED_HOSTNAMES: 301 for the agent card, 410 for everything else) instead of silently serving on
	const oldHost = C.fileConfig().A2A_HOSTNAME || "";
	const newHost = upd.A2A_HOSTNAME === null ? "" : upd.A2A_HOSTNAME ?? oldHost;
	let switched = null;
	if (newHost !== oldHost && C.fileConfig().A2A_D1_ID) {
		const retired = new Set(csv(C.fileConfig().A2A_RETIRED_HOSTNAMES));
		if (oldHost) retired.add(oldHost);
		retired.delete(newHost);
		upd.A2A_RETIRED_HOSTNAMES = [...retired].join(",") || null;
		const sub = C.get("A2A_WORKERS_DEV_SUBDOMAIN");
		upd.A2A_BASE_URL = WD.baseUrlFor({ hostname: newHost, worker: upd.A2A_WORKER_NAME || workerName(), subdomain: sub }) || null;
		switched = { from: C.fileConfig().A2A_BASE_URL || (oldHost ? `https://${oldHost}` : ""), fromHost: oldHost, toHost: newHost };
	} else if (newHost && csv(C.fileConfig().A2A_RETIRED_HOSTNAMES).includes(newHost)) {
		upd.A2A_RETIRED_HOSTNAMES = csv(C.fileConfig().A2A_RETIRED_HOSTNAMES).filter((h) => h !== newHost).join(",") || null;
	}
	if (upd.CF_PROFILE !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(upd.CF_PROFILE)) die("--cf-profile must be a cf auth profile name");
	if (o["workers-dev-subdomain"] !== undefined && !WD.LABEL_RE.test(o["workers-dev-subdomain"]))
		die("--workers-dev-subdomain must be lowercase letters, digits and hyphens (a DNS label)");
	if (upd.PAIRING_APPROVAL !== undefined && !PAIRING_MODES.includes(upd.PAIRING_APPROVAL))
		die(`--pairing-approval must be one of ${PAIRING_MODES.join(" | ")} (human: approval password on the /device page; agent: also \`pair approve\`; off: no device-flow pairing)`);
	if (upd.WAKE_PRESET && !PRESETS.includes(upd.WAKE_PRESET)) die(`unknown preset ${upd.WAKE_PRESET} (${PRESETS.join(" | ")})`);
	if (upd.A2A_AGENT_SKILLS) {
		try { if (!Array.isArray(JSON.parse(upd.A2A_AGENT_SKILLS))) throw 0; } catch { die("--agent-skills must be a JSON array of A2A AgentSkill objects"); }
	}
	C.saveConfig(upd);
	return switched;
}

/** After a deploy that moved the public URL: what stops serving and what peers must update. */
function reportSwitch(sw) {
	if (!sw) return;
	const to = C.fileConfig().A2A_BASE_URL || publicBase();
	const card = to ? `${to}/.well-known/agent-card.json` : "(see `a2a-over-webhook url`)";
	console.error(`\nnote: the public URL moved${sw.from ? ` from ${sw.from}` : ""} to ${to || "workers.dev"}.`);
	if (sw.fromHost) {
		console.error(`  ${sw.fromHost} no longer serves this agent: its agent card redirects (301) to the new one and every other request gets 410 Gone.`);
		console.error(`  Cloudflare keeps the old custom domain attached to the Worker; to detach it completely, remove ${sw.fromHost} under Workers & Pages -> ${workerName()} -> Settings -> Domains & Routes.`);
	} else console.error("  The workers.dev URL is switched off by this deploy.");
	console.error(`  Peers must update their URL for this agent: ${card} (A2A_BASE_URL in ${C.CONFIG_FILE} is updated).`);
	if (C.get("A2A_TUNNEL_ID")) console.error("  The wake tunnel is unaffected (it has its own hostname and zone).");
}

let justRegistered = false; // a workers.dev subdomain registered in this run: its DNS takes a few minutes

async function verifyCard(base) {
	// 0 skips the check (tests); a brand-new workers.dev subdomain usually resolves within ~3 minutes
	const tries = Number(process.env.A2A_VERIFY_TRIES ?? (justRegistered ? 60 : 12));
	if (justRegistered && tries) step("waiting for the new workers.dev subdomain to resolve (usually 1-5 minutes)");
	for (let i = 0; i < tries; i++) {
		try {
			const { status, data } = await httpJson(base + "/.well-known/agent-card.json", { timeout: 10000 });
			if (status === 200 && data && data.name) {
				const wrong = cardUrlProblem(data, base);
				if (wrong) return console.error(`warning: the agent card at ${base}/.well-known/agent-card.json does not point peers at this deployment: ${wrong}. Check with: a2a-over-webhook status`);
				return console.error(`agent card OK: ${data.name} (${base}/.well-known/agent-card.json)`);
			}
		} catch { /* DNS / certificate may still be provisioning */ }
		await new Promise((r) => setTimeout(r, 5000));
	}
	console.error(`warning: agent card not reachable yet at ${base}; ${C.get("A2A_HOSTNAME") ? "a new custom domain" : "a new workers.dev subdomain"} can take a few minutes. Check again with: a2a-over-webhook status`);
}

/** Apply D1 migrations quietly: cf prints a bare JSON array (often `[]`) when stdout is not a TTY. */
function applyMigrations(dir, env) {
	step("applying D1 migrations");
	const r = runCf(dir, ["d1", "migrations", "apply", C.get("A2A_D1_ID"), "--dir", "migrations"], { env, capture: true });
	let applied = null;
	try { applied = JSON.parse(r.stdout); } catch { /* not JSON: show as is */ }
	if (Array.isArray(applied)) console.error(applied.length ? `    applied: ${applied.map((m) => m.name || m.id || JSON.stringify(m)).join(", ")}` : "    (none pending)");
	else if (r.stdout.trim()) console.error(r.stdout.trim());
}

/** Run a command, streaming its output to stderr while collecting it. */
function runTee(cmd, args, { cwd, env }) {
	return new Promise((resolve, reject) => {
		const ch = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		const on = (d) => { process.stderr.write(d); out += d; };
		ch.stdout.on("data", on);
		ch.stderr.on("data", on);
		ch.on("error", reject);
		ch.on("close", (code) => resolve({ status: code ?? 1, out }));
	});
}

/** cf deploy (secrets via a temporary chmod-600 file). If the account has no workers.dev subdomain yet and
 *  `register` names one, retry through cf's own registration prompt. Returns cf's output. */
async function cfDeploy(dir, secrets, { register } = {}) {
	const base = ["deploy", "--message", `a2a-over-webhook ${new Date().toISOString()}`];
	const go = async (file) => {
		const args = cfArgs(file ? [...base, "--secrets-file", file] : base);
		let r = await runTee(cfBin(dir), args, { cwd: dir, env: deployEnv() });
		if (r.status !== 0 && WD.needsSubdomain(r.out)) {
			if (!register) die(WD.noSubdomainHelp(C.get("CLOUDFLARE_ACCOUNT_ID")));
			step(`registering the account's workers.dev subdomain "${register}" (answering cf's prompt)`);
			C.saveConfig({ A2A_WORKERS_DEV_SUBDOMAIN: register }); // so this deploy already carries the final URL
			r = await WD.deployWithRegistration(cfBin(dir), args, register, { cwd: dir, env: deployEnv() })
				.catch((e) => { C.saveConfig({ A2A_WORKERS_DEV_SUBDOMAIN: null }); throw e; });
			if (r.status !== 0) C.saveConfig({ A2A_WORKERS_DEV_SUBDOMAIN: null });
			else justRegistered = true;
		}
		if (r.status !== 0) die(`cf deploy failed (exit ${r.status})`);
		return r.out;
	};
	return secrets && Object.keys(secrets).length ? withSecretsFile(secrets, go) : go(null);
}

/** Deploy, then learn the workers.dev URL from cf's output (saved as A2A_BASE_URL). If the agent card
 *  could not carry that URL yet (first deploy on an account whose subdomain we did not know), redeploy once. */
async function deployAndLearn(dir, secrets, o) {
	const baked = () => C.get("A2A_WORKERS_DEV_SUBDOMAIN");
	const out = await cfDeploy(dir, secrets, { register: o["workers-dev-subdomain"] });
	const deployedWith = baked();
	if (!workersDevMode()) return;
	const sub = WD.parseWorkersDevSubdomain(out, workerName());
	if (sub && o["workers-dev-subdomain"] && sub !== o["workers-dev-subdomain"])
		console.error(`note: the account already has the workers.dev subdomain "${sub}"; using it (--workers-dev-subdomain ignored)`);
	if (sub && sub !== baked()) C.saveConfig({ A2A_WORKERS_DEV_SUBDOMAIN: sub });
	if (!baked()) return console.error("warning: could not find the workers.dev URL in cf's output; the Worker uses the request origin meanwhile. Check the URL in the dashboard and re-run `a2a-over-webhook deploy`.");
	C.saveConfig({ A2A_BASE_URL: publicBase() });
	if (baked() !== deployedWith) {
		step(`redeploying once so the agent card advertises ${publicBase()}`);
		await cfDeploy(dir, null);
	}
}

/** The deployment's public URL as saved by init/deploy (an exported A2A_BASE_URL does not change it; warned about). */
function deployedBase() {
	const base = (C.fileConfig().A2A_BASE_URL || publicBase()).replace(/\/$/, "");
	const env = (process.env.A2A_BASE_URL || "").replace(/\/$/, "");
	if (env && base && env !== base)
		console.error(`warning: A2A_BASE_URL is exported as ${env}, but this deployment is ${base}; CLI commands (and push URLs sent to peers) would use the exported value: unset A2A_BASE_URL`);
	return base;
}

export async function init(o) {
	checkNode();
	const switched = applyFlags(o);
	const dir = workerDir(o);
	C.saveConfig({ A2A_WORKER_DIR: dir, A2A_WORKER_NAME: workerName() });
	if (workersDevMode()) {
		if (!WD.LABEL_RE.test(workerName())) die("on workers.dev the --worker-name must be a DNS label (lowercase letters, digits, hyphens)");
		if (!C.get("A2A_HOSTNAME")) console.error(`note: no --hostname, deploying to https://${workerName()}.<account subdomain>.workers.dev (${WD.DOCS})`);
	}

	step(`worker project -> ${dir}`);
	syncTemplate(dir);
	if (!o["skip-install"]) run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir });

	const prof = cfProfile();
	step(`checking Cloudflare login (cf auth whoami${prof ? ` --profile ${prof}` : ""})`);
	const who = cfJson(dir, ["auth", "whoami"]);
	if (!who.authenticated) die(prof
		? `cf profile "${prof}" is not logged in: run \`npx cf auth create ${prof} --no-browser\`, open the printed URL, enter the code, then re-run init`
		: "not logged in to Cloudflare: run `cf auth login --no-browser`, open the printed URL, enter the code, then re-run init");
	const accts = who.accounts || [];
	if (!C.get("CLOUDFLARE_ACCOUNT_ID")) {
		if (accts.length !== 1) die(`${accts.length} accounts available; pass --account-id <id>:\n` + accts.map((a) => `  ${a.id}  ${a.name}`).join("\n"));
		C.saveConfig({ CLOUDFLARE_ACCOUNT_ID: accts[0].id });
	} else if (accts.length && !accts.some((a) => a.id === C.get("CLOUDFLARE_ACCOUNT_ID"))) {
		die(`account ${C.get("CLOUDFLARE_ACCOUNT_ID")} is not visible to the cf login${prof ? ` (profile "${prof}")` : ""}; pass --cf-profile for the right login or --account-id for one of:\n` + accts.map((a) => `  ${a.id}  ${a.name}`).join("\n"));
	}
	step(`Cloudflare account: ${accts.find((a) => a.id === C.get("CLOUDFLARE_ACCOUNT_ID"))?.name || C.get("CLOUDFLARE_ACCOUNT_ID")}${prof ? ` (cf profile ${prof})` : ""}`);
	const env = cfEnv();

	const dbName = C.get("A2A_D1_NAME") || C.get("A2A_WORKER_NAME");
	if (!C.get("A2A_D1_ID")) {
		step(`D1 database "${dbName}"`);
		let db = (cfJson(dir, ["d1", "list"], env) || []).find((d) => d.name === dbName);
		if (!db) {
			runCf(dir, ["d1", "create", "--name", dbName], { env, capture: true });
			db = (cfJson(dir, ["d1", "list"], env) || []).find((d) => d.name === dbName);
		}
		if (!db || !db.uuid) die("could not create or find the D1 database");
		C.saveConfig({ A2A_D1_ID: db.uuid, A2A_D1_NAME: dbName });
	}
	applyMigrations(dir, env);

	let ownerToken = C.fileConfig().A2A_OWNER_TOKEN;
	if (!ownerToken || o["rotate-owner-token"]) ownerToken = randomToken(32);
	C.saveConfig({ A2A_OWNER_TOKEN: ownerToken, A2A_BASE_URL: publicBase() || undefined });

	const secrets = { OWNER_TOKEN: ownerToken, ...wakeSecretsFromEnv() };
	step(`deploying (secrets uploaded: ${Object.keys(secrets).join(", ")})`);
	await deployAndLearn(dir, secrets, o);
	const base = deployedBase();
	if (base) await verifyCard(base);
	console.log(base);
	reportSwitch(switched);
	console.error(`config saved to ${C.CONFIG_FILE} (chmod 600). Next: a2a-over-webhook status (shows the next setup step)`);
}

export async function deploy(o) {
	checkNode();
	if (!C.get("A2A_D1_ID")) die("no saved deployment; run `a2a-over-webhook init` first");
	const switched = applyFlags(o);
	const dir = workerDir(o);
	if (workersDevMode() && !WD.LABEL_RE.test(workerName())) die("on workers.dev the worker name must be a DNS label (lowercase letters, digits, hyphens)");
	guardTunnelUrl();
	step(`worker project -> ${dir}${cfProfile() ? ` (cf profile ${cfProfile()})` : ""}`);
	syncTemplate(dir);
	if (!o["skip-install"]) run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir });
	const env = cfEnv();
	applyMigrations(dir, env);
	const secrets = wakeSecretsFromEnv();
	if (Object.keys(secrets).length && C.get("A2A_OWNER_TOKEN")) secrets.OWNER_TOKEN = C.get("A2A_OWNER_TOKEN");
	step(Object.keys(secrets).length ? `deploying (secrets uploaded: ${Object.keys(secrets).join(", ")})` : "deploying (existing secrets kept)");
	await deployAndLearn(dir, secrets, o);
	const base = deployedBase();
	if (base) await verifyCard(base);
	if (switched) { console.log(base); reportSwitch(switched); }
}

/** Fingerprints of the wake secrets in the local environment (what `wake set` would upload). */
const localFingerprints = () => ({
	url: fingerprint(process.env.WAKE_WEBHOOK_URL), key: fingerprint(process.env.WAKE_WEBHOOK_KEY), hmacSecret: fingerprint(process.env.WAKE_HMAC_SECRET),
	accessClientId: fingerprint(process.env.WAKE_ACCESS_CLIENT_ID), accessClientSecret: fingerprint(process.env.WAKE_ACCESS_CLIENT_SECRET),
});

/** A tunnel created by `tunnel create` owns WAKE_WEBHOOK_URL: refuse to overwrite it with a different host. */
function guardTunnelUrl() {
	const th = C.get("A2A_TUNNEL_HOSTNAME"), url = process.env.WAKE_WEBHOOK_URL;
	if (!th || !url) return;
	let host = "";
	try { host = new URL(url).host; } catch { /* invalid URL: reported elsewhere */ }
	if (host !== th) die(`this deployment wakes through the tunnel https://${th} (tunnel create); unset WAKE_WEBHOOK_URL, or run \`a2a-over-webhook tunnel rm\` first`);
}

export async function wake(sub, o) {
	if (sub === "fingerprint") {
		const fp = localFingerprints();
		if (!Object.values(fp).some(Boolean)) die(`no ${WAKE_SECRETS.join(" / ")} in the environment`);
		return console.log(JSON.stringify(fp, null, 2));
	}
	if (sub === "preview") {
		const r = await owner("GET", "/owner/wake/preview");
		console.log(JSON.stringify(r, null, 2));
		// compare with the local environment, if the secrets are exported here
		const local = localFingerprints(), remote = r.fingerprints || {};
		for (const [k, v] of Object.entries(local)) {
			if (!v) continue;
			if (!r.fingerprints) { console.error("# this Worker predates fingerprints; redeploy (a2a-over-webhook deploy) to compare"); break; }
			console.error(`# ${k}: local ${v} vs uploaded ${remote[k] || "(unset)"} -> ${v === remote[k] ? "match" : "DIFFERENT"}`);
		}
		return;
	}
	if (sub === "test") {
		const r = await owner("POST", "/owner/wake/test", {});
		if (r.configured === false || r.info === "WAKE_WEBHOOK_URL unset")
			die("no wake webhook configured on the Worker: export WAKE_WEBHOOK_URL (and WAKE_WEBHOOK_KEY or WAKE_HMAC_SECRET), then run `a2a-over-webhook wake set` first (or use polling)");
		console.log(JSON.stringify(r, null, 2));
		if (!(r.status >= 200 && r.status < 300)) process.exitCode = 1;
		return;
	}
	if (sub === "set") {
		// non-secret settings via flags; secrets only from the environment (never argv)
		const secrets = wakeSecretsFromEnv();
		if (!Object.keys(secrets).length && !DEPLOY_FLAGS.some((f) => o[f] !== undefined))
			die("nothing to set: export WAKE_WEBHOOK_URL / WAKE_WEBHOOK_KEY / WAKE_HMAC_SECRET and/or pass --preset etc.");
		await deploy(o); // wake set = save settings + upload secrets + redeploy, in one step
		return console.error("wake settings deployed. Next: a2a-over-webhook wake preview, then a2a-over-webhook wake test");
	}
	if (sub === "unset") {
		const dir = workerDir(o), name = C.get("A2A_WORKER_NAME", "a2a-over-webhook");
		const env = cfEnv();
		for (const k of WAKE_SECRETS) runCf(dir, ["workers", "secrets", "delete", k, "--worker", name, "--force"], { env, allowFail: true });
		return console.error("wake secrets removed (wake is now a no-op; use polling)");
	}
	die("usage: wake set|unset|test|preview|fingerprint");
}
