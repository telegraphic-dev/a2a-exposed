// The `cf deploy` step of `npm run deploy`, after migrations.
// When CLOUDFLARE_OAUTH_CLIENT_ID is set, the production config requires
// CLOUDFLARE_OAUTH_CLIENT_SECRET. That value comes from secrets.env, passed
// as `cf deploy --secrets-file secrets.env`. A missing file or secret does
// not upload. The value is not printed. With the id unset, the file is not
// required and deploy does not pass it.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET_KEY = "CLOUDFLARE_OAUTH_CLIENT_SECRET";
const SECRETS_FILE = "secrets.env";

function value(env, key) {
	return (env[key] ?? "").trim();
}

function dotenvHasSecret(text) {
	let found = false;
	for (const raw of text.split("\n")) {
		let line = raw.trim();
		if (line.endsWith("\r")) line = line.slice(0, -1).trim();
		if (!line || line.startsWith("#")) continue;
		if (line.startsWith("export ")) line = line.slice(7).trim();
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		if (line.slice(0, eq).trim() !== SECRET_KEY) continue;
		let assigned = line.slice(eq + 1).trim();
		if (assigned.length >= 2) {
			const quote = assigned[0];
			if ((quote === "\"" || quote === "'") && assigned.endsWith(quote)) assigned = assigned.slice(1, -1);
		}
		found = assigned.trim().length > 0;
	}
	return found;
}

/**
 * True when the file assigns a non-empty Cloudflare client secret.
 * Accepts dotenv or a JSON object, the two formats `cf deploy --secrets-file` reads.
 * The value is not returned.
 */
export function secretsFileHasCloudflareSecret(text) {
	const body = String(text).replace(/^\uFEFF/, "").trim();
	if (body.startsWith("{")) {
		try {
			const parsed = JSON.parse(body);
			const assigned = parsed?.[SECRET_KEY];
			return typeof assigned === "string" && assigned.trim().length > 0;
		} catch {
			return false;
		}
	}
	return dotenvHasSecret(body);
}

export function runDeploy(env = process.env, { rootDir = root, spawn = spawnSync, warn = console.error } = {}) {
	const args = ["deploy"];
	if (value(env, "CLOUDFLARE_OAUTH_CLIENT_ID")) {
		const file = path.join(rootDir, SECRETS_FILE);
		let text;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch (error) {
			warn(error?.code === "ENOENT"
				? "CLOUDFLARE_OAUTH_CLIENT_ID is set, but secrets.env was not found. Deploy did not upload."
				: "secrets.env could not be read. Deploy did not upload.");
			return 1;
		}
		if (!secretsFileHasCloudflareSecret(text)) {
			warn("CLOUDFLARE_OAUTH_CLIENT_ID is set, but secrets.env does not set CLOUDFLARE_OAUTH_CLIENT_SECRET. Deploy did not upload.");
			return 1;
		}
		args.push("--secrets-file", SECRETS_FILE);
	}
	const result = spawn("cf", args, { cwd: rootDir, env, stdio: "inherit" });
	if (result.error) {
		warn(result.error.message);
		return 1;
	}
	return result.status === 0 ? 0 : (result.status || 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(runDeploy());
