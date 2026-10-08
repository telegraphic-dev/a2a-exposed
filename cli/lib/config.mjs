// Config storage: ~/.config/a2a-over-webhook/config.env (chmod 600) + peers.json.
// Environment variables always override values from config.env.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_DIR =
	process.env.A2A_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "a2a-over-webhook");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.env");
export const PEERS_FILE = path.join(CONFIG_DIR, "peers.json");

export function parseEnv(text) {
	const out = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
		if (!m) continue;
		let v = m[2];
		if (v.startsWith('"')) {
			try { v = JSON.parse(v); } catch { v = v.slice(1, -1); }
		} else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
		out[m[1]] = v;
	}
	return out;
}

export function serializeEnv(obj) {
	const lines = ["# a2a-over-webhook config (contains secrets: keep chmod 600, never commit)"];
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null) continue;
		const s = String(v);
		lines.push(`${k}=${/^[A-Za-z0-9_./:@+,-]*$/.test(s) ? s : JSON.stringify(s)}`);
	}
	return lines.join("\n") + "\n";
}

let cache = null;
export function fileConfig() {
	if (cache) return cache;
	try { cache = parseEnv(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { cache = {}; }
	return cache;
}

/** Value from the environment, else config.env, else default. */
export function get(key, dflt = "") {
	const e = process.env[key];
	if (e !== undefined && e !== "") return e;
	const f = fileConfig()[key];
	return f !== undefined && f !== "" ? f : dflt;
}

function ensureDir() {
	fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

function writePrivate(file, data) {
	ensureDir();
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, data, { mode: 0o600 });
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, file);
}

/** Merge updates into config.env (undefined values are left alone, null removes the key). */
export function saveConfig(updates) {
	const cur = { ...fileConfig() };
	for (const [k, v] of Object.entries(updates)) {
		if (v === undefined) continue;
		if (v === null) delete cur[k];
		else cur[k] = String(v);
	}
	writePrivate(CONFIG_FILE, serializeEnv(cur));
	cache = cur;
}

export function loadPeers() {
	try { return JSON.parse(fs.readFileSync(PEERS_FILE, "utf8")) || {}; } catch { return {}; }
}

export function savePeers(peers) {
	writePrivate(PEERS_FILE, JSON.stringify(peers, null, 2) + "\n");
}

/** Set (non-empty) both in the environment and in config.env, with different values: get() returns the environment's. */
export function envOverridesFile(key) {
	const e = process.env[key], f = fileConfig()[key];
	return !!e && !!f && e !== f;
}

export const peerTokenVar = (alias) => `PEER_${alias.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`;
