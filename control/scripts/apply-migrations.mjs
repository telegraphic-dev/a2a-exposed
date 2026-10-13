// Runs before `cf deploy`. The Cloudflare connect insert uses
// ON CONFLICT ("providerId", "accountId"), which SQLite rejects until
// 0008_account_provider.sql is applied. That file drops an existing duplicate
// first, keeping the earliest row, so the index can be created. A failed apply
// must not deploy.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function value(env, key) {
	return (env[key] ?? "").trim();
}

/**
 * The database argument for `cf d1 migrations apply`. An id is passed through.
 * A name-only binding is passed through as the name. `cf d1 list` is not used:
 * its stdout is not guaranteed JSON.
 * No id and no name means login is off.
 */
export function migrationDatabase(env) {
	const id = value(env, "CONTROL_D1_ID");
	const name = value(env, "CONTROL_D1_NAME");
	if (id) return { database: id };
	if (name) return { database: name };
	return { skip: true };
}

function runCf(args, env) {
	const result = spawnSync("cf", args, { cwd: root, env, encoding: "utf8" });
	if (result.error) return { status: 1, stdout: "", stderr: `${result.error.message}\n` };
	return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function main() {
	const target = migrationDatabase(process.env);
	if (target.skip) {
		console.error("D1 is unset; skipping control migrations");
		return 0;
	}
	console.error("applying control D1 migrations");
	const applied = runCf(["d1", "migrations", "apply", target.database, "--dir", "migrations"], process.env);
	if (applied.stdout) process.stdout.write(applied.stdout);
	if (applied.stderr) process.stderr.write(applied.stderr);
	return applied.status === 0 ? 0 : (applied.status || 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
