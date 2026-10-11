// Runs before `cf deploy`. The Cloudflare connect insert uses
// ON CONFLICT ("providerId", "accountId"), which SQLite rejects until
// 0008_account_provider.sql is applied. A failed apply must not deploy.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function value(env, key) {
	return (env[key] ?? "").trim();
}

/** Which D1 database this deploy should migrate. No id and no name means login is off. */
export function migrationDatabase(env) {
	const id = value(env, "CONTROL_D1_ID");
	const name = value(env, "CONTROL_D1_NAME");
	if (id) return { id };
	if (name) return { name };
	return { skip: true };
}

function runCf(args, env) {
	const result = spawnSync("cf", args, { cwd: root, env, encoding: "utf8" });
	if (result.error) return { status: 1, stdout: "", stderr: `${result.error.message}\n` };
	return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Resolve a name-only binding to the database id `cf d1 migrations apply` requires. */
export function resolveDatabaseId(target, env, run = runCf) {
	if (target.skip) return { skip: true };
	if (target.id) return { id: target.id };
	const listed = run(["d1", "list"], env);
	if (listed.status !== 0) return { error: "could not list D1 databases" };
	let rows;
	try {
		rows = JSON.parse(listed.stdout);
	} catch {
		return { error: "could not read the D1 list" };
	}
	if (!Array.isArray(rows)) return { error: "could not read the D1 list" };
	const found = rows.find((row) => row && row.name === target.name && typeof row.uuid === "string" && row.uuid);
	if (!found) return { error: "the control D1 database was not found" };
	return { id: found.uuid };
}

function main() {
	const target = migrationDatabase(process.env);
	if (target.skip) {
		console.error("D1 is unset; skipping control migrations");
		return 0;
	}
	const resolved = resolveDatabaseId(target, process.env);
	if (!resolved.id) {
		console.error(resolved.error || "the control D1 database was not found");
		return 1;
	}
	console.error("applying control D1 migrations");
	const applied = runCf(["d1", "migrations", "apply", resolved.id, "--dir", "migrations"], process.env);
	if (applied.stdout) process.stdout.write(applied.stdout);
	if (applied.stderr) process.stderr.write(applied.stderr);
	return applied.status === 0 ? 0 : (applied.status || 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
