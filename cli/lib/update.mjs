// Outdated-version notice. At most once per 24 h a detached child process asks the npm registry for the latest
// version and caches it; every run only reads that cache (no network call in the foreground). Off with
// A2A_NO_UPDATE_CHECK=1, DO_NOT_TRACK=1, NO_UPDATE_NOTIFIER, CI, and when running from a source checkout.
import fs from "node:fs";
import { createHash } from "node:crypto";
import * as C from "./config.mjs";
import { httpJson } from "./a2a.mjs";
import { CLI_COMMAND } from "./config.mjs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CHECK_INTERVAL_MS = 24 * 3600 * 1000;
export const REGISTRY_URL = "https://registry.npmjs.org/a2a-exposed/latest";
const truthy = (v) => v !== undefined && v !== "" && v !== "0" && v !== "false";

export const cacheFile = (env = process.env) =>
	path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "a2a-exposed", "update-check.json");

/** Is the notice switched off (by the user, CI, or because this is not an npm install)? */
export function disabled(env = process.env, here = fileURLToPath(import.meta.url)) {
	if (truthy(env.A2A_NO_UPDATE_CHECK) || truthy(env.DO_NOT_TRACK) || truthy(env.NO_UPDATE_NOTIFIER) || truthy(env.CI)) return true;
	return !here.split(path.sep).includes("node_modules"); // a repo checkout: the user builds what they have
}

/** a > b for x.y.z versions (pre-release tags sort before the release; good enough for a notice). */
export function newer(a, b) {
	if (!validVersion(a) || !validVersion(b)) return false;
	const parse = (v) => String(v || "").replace(/^v/, "").split("-")[0].split(".").map((n) => Number(n) || 0);
	const [x, y] = [parse(a), parse(b)];
	for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
	return String(b).includes("-") && !String(a).includes("-") && parse(a).join(".") === parse(b).join(".");
}

/** The notice for `current`, given the cache contents (or "" when up to date / unknown). */
export function notice(current, cache) {
	if (!validVersion(current) || !validVersion(cache?.latest) || !newer(cache.latest, current)) return "";
	return `a2a-exposed ${cache.latest} is available (you have ${current}): use npx -y a2a-exposed@latest. With a global install, npm i -g a2a-exposed@latest first. This does not update an existing Worker. Silence: A2A_NO_UPDATE_CHECK=1`;
}

export const due = (cache, now = Date.now()) => !cache || !(now - (cache.checkedAt || 0) < CHECK_INTERVAL_MS);

export function readCache(file) {
	try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

const versionPattern = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const validVersion = v => typeof v === "string" && v.length < 80 && versionPattern.test(v);
export const workerCacheFile = () => path.join(C.CONFIG_DIR, `worker-update-${createHash("sha256").update(C.get("A2A_BASE_URL").replace(/\/$/, "")).digest("hex").slice(0,16)}.json`);
export function expectedMigrations() {
 for (const dir of [new URL("../worker/migrations/", import.meta.url), new URL("../../worker/migrations/", import.meta.url)]) {
  try { return fs.readdirSync(dir).filter(n => /^\d{4}_[a-z0-9_]+\.sql$/.test(n)).sort(); } catch { /* installed package or source checkout */ }
 }
 return [];
}
/** Fixed local messages only; never echo strings or commands supplied by a remote server/cache. */
export function updates(current, registry, worker, { selfHosted = C.deploymentKind() === "self-hosted", expected = expectedMigrations() } = {}) {
 const result = [];
 if (validVersion(registry?.latest) && validVersion(current) && newer(registry.latest, current))
  result.push({ component: "cli", current, latest: registry.latest, command: "npx -y a2a-exposed@latest", message: notice(current, registry) });
 if (!selfHosted || worker?.management === "platform") return result;
 const target = validVersion(registry?.latest) && newer(registry.latest, current) ? registry.latest : current;
 const version = validVersion(worker?.version) ? worker.version : null;
 const pending = worker?.schema?.status === "known" && Array.isArray(worker.schema.applied)
  ? expected.filter(n => !worker.schema.applied.includes(n)) : null;
 if (worker?.versionReported === false && !version || version && validVersion(target) && newer(target, version) || pending?.length) {
  const message = `Last check: self-hosted Worker ${version || (worker?.versionReported === false ? "predates version reporting" : "version unknown")}${version && validVersion(target) && newer(target, version) ? ` is older than ${target}` : ""}; ${pending === null ? "migration status unknown; redeploy applies pending D1 migrations" : `${pending.length} pending D1 migration(s)`}. Ask the owner before running ${CLI_COMMAND} deploy. Nothing was updated.`;
  result.push({ component: "worker", current: version, target, pendingMigrations: pending, command: `${CLI_COMMAND} deploy`, message });
 }
 return result;
}
/** Cached facts only. No foreground network request; local MCP remains usable offline. */
export function cachedUpdates(current, { env = process.env, here = fileURLToPath(import.meta.url), all = false } = {}) {
 if (disabled(env, here)) return [];
 const registry = readCache(cacheFile(env)), worker = readCache(workerCacheFile());
 const rows = updates(current, registry, worker);
 if (all) return rows;
 const now = Date.now();
 return rows.filter(r => {
  const file = r.component === "cli" ? cacheFile(env) : workerCacheFile();
  try {
   fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
   const lock = file + ".notice-lock";
   let fd;
   try { fd = fs.openSync(lock, "wx", 0o600); } catch {
    // A crashed notifier must not silence hints forever; never wait on a busy process.
    try { if (now - fs.statSync(lock).mtimeMs < CHECK_INTERVAL_MS) return false; fs.unlinkSync(lock); fd = fs.openSync(lock, "wx", 0o600); } catch { return false; }
   }
   try {
    const cache = readCache(file);
    if (cache?.notifiedAt && now - cache.notifiedAt >= 0 && now - cache.notifiedAt < CHECK_INTERVAL_MS) return false;
    fs.writeFileSync(file, JSON.stringify({ ...cache, notifiedAt: now }), { mode: 0o600 });
   } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  } catch { return false; }
  return true;
 });
}
function spawnRefresh(file, worker = false) {
 const child = spawn(process.execPath, [fileURLToPath(import.meta.url), worker ? "--refresh-worker" : "--refresh", file], { env: { ...process.env, A2A_CONFIG_DIR: C.CONFIG_DIR }, detached: true, stdio: "ignore" });
 child.unref();
}

/** Print the notice (stderr) from the cache and refresh the cache in the background when it is older than 24 h. */
export function check(current, { env = process.env, here = fileURLToPath(import.meta.url), spawnCheck = true, write = (s) => process.stderr.write(s + "\n") } = {}) {
	try {
		if (disabled(env, here)) return;
		const file = cacheFile(env);
		const cache = readCache(file);
		for (const row of cachedUpdates(current, { env, here })) write(`note: ${row.message}`);
		if (C.deploymentKind() === "self-hosted") {
			const workerFile = workerCacheFile(), worker = readCache(workerFile);
			if (due(worker)) {
				fs.mkdirSync(path.dirname(workerFile), { recursive: true, mode: 0o700 });
				fs.writeFileSync(workerFile, JSON.stringify({ ...worker, checkedAt: Date.now() }), { mode: 0o600 });
				if (spawnCheck) spawnRefresh(workerFile, true);
			}
		}
		if (!due(cache)) return;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		// claim the slot first, so parallel runs don't all spawn a check
		fs.writeFileSync(file, JSON.stringify({ ...(readCache(file) || {}), checkedAt: Date.now() }));
		if (!spawnCheck) return;
		spawnRefresh(file);
	} catch { /* a notice must never break a command */ }
}

/** Child process: fetch the latest version and store it. */
async function refresh(file) {
	try {
		const r = await httpJson(REGISTRY_URL, { timeout: 5000, redirect: "error", maxResponseBytes: 65536 });
		if (r.status !== 200) return;
		const { version } = r.data;
		if (validVersion(version)) fs.writeFileSync(file, JSON.stringify({ ...readCache(file), latest: version, checkedAt: Date.now() }), { mode: 0o600 });
	} catch { /* offline: try again in 24 h */ }
}

/** Background read-only Worker probe. Credentials come only from existing protected config/env. */
async function refreshWorker(file) {
 try {
  if (C.deploymentKind() !== "self-hosted") return;
  const base = C.get("A2A_BASE_URL").replace(/\/$/, ""), token = C.get("A2A_OWNER_TOKEN");
  if (!base || !token) return;
  let response = await httpJson(base + "/owner/upgrade-status", { headers: { authorization: `Bearer ${token}` }, timeout: 3000, redirect: "error", maxResponseBytes: 65536 });
  let data;
  if (response.status === 404) {
   response = await httpJson(base + "/health", { timeout: 3000, redirect: "error", maxResponseBytes: 65536 });
   if (response.status !== 200) return;
   const health = response.data;
   if (health?.ok !== true || health.version != null && !validVersion(health.version)) return;
   data = { version: health.version || null, versionReported: !!health.version, management: "self-hosted", schema: { status: "unknown" } };
  } else {
   if (response.status !== 200) return;
   const raw = response.data;
   if (!validVersion(raw.version) || !["self-hosted", "platform"].includes(raw.management)) return;
   const applied = Array.isArray(raw.schema?.applied) ? raw.schema.applied.filter(n => typeof n === "string" && /^\d{4}_[a-z0-9_]+\.sql$/.test(n)).slice(0, 1000) : null;
   data = { version: raw.version, versionReported: true, management: raw.management, schema: { status: raw.schema?.status === "known" && applied ? "known" : "unknown", applied } };
  }
  fs.writeFileSync(file, JSON.stringify({ ...readCache(file), ...data, checkedAt: Date.now() }), { mode: 0o600 });
 } catch { /* offline/old endpoints: no error, deployment or retry */ }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--refresh") await refresh(process.argv[3]);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--refresh-worker") await refreshWorker(process.argv[3]);
