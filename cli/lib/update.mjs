// Outdated-version notice. At most once per 24 h a detached child process asks the npm registry for the latest
// version and caches it; every run only reads that cache (no network call in the foreground). Off with
// A2A_NO_UPDATE_CHECK=1, DO_NOT_TRACK=1, NO_UPDATE_NOTIFIER, CI, and when running from a source checkout.
import fs from "node:fs";
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
	const parse = (v) => String(v || "").replace(/^v/, "").split("-")[0].split(".").map((n) => Number(n) || 0);
	const [x, y] = [parse(a), parse(b)];
	for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
	return String(b).includes("-") && !String(a).includes("-") && parse(a).join(".") === parse(b).join(".");
}

/** The notice for `current`, given the cache contents (or "" when up to date / unknown). */
export function notice(current, cache) {
	if (!cache || !cache.latest || !newer(cache.latest, current)) return "";
	return `a2a-exposed ${cache.latest} is available (you have ${current}): run npx -y a2a-exposed@latest deploy (updates the Worker; applies new D1 migrations). With a global install, npm i -g a2a-exposed@latest first. Silence: A2A_NO_UPDATE_CHECK=1`;
}

export const due = (cache, now = Date.now()) => !cache || !(now - (cache.checkedAt || 0) < CHECK_INTERVAL_MS);

function readCache(file) {
	try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** Print the notice (stderr) from the cache and refresh the cache in the background when it is older than 24 h. */
export function check(current, { env = process.env, here = fileURLToPath(import.meta.url), spawnCheck = true, write = (s) => process.stderr.write(s + "\n") } = {}) {
	try {
		if (disabled(env, here)) return;
		const file = cacheFile(env);
		const cache = readCache(file);
		const msg = notice(current, cache);
		if (msg) write(`note: ${msg}`);
		if (!due(cache)) return;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		// claim the slot first, so parallel runs don't all spawn a check
		fs.writeFileSync(file, JSON.stringify({ ...(cache || {}), checkedAt: Date.now() }));
		if (!spawnCheck) return;
		const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--refresh", file], { detached: true, stdio: "ignore" });
		child.unref();
	} catch { /* a notice must never break a command */ }
}

/** Child process: fetch the latest version and store it. */
async function refresh(file) {
	try {
		const r = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
		if (!r.ok) return;
		const { version } = await r.json();
		if (typeof version === "string" && /^\d+\.\d+\.\d+/.test(version)) fs.writeFileSync(file, JSON.stringify({ latest: version, checkedAt: Date.now() }));
	} catch { /* offline: try again in 24 h */ }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--refresh") await refresh(process.argv[3]);
