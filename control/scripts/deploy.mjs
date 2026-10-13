// The `cf deploy` step of `npm run deploy`, after migrations.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function runDeploy(env = process.env, { rootDir = root, spawn = spawnSync, warn = console.error } = {}) {
	const result = spawn("cf", ["deploy"], { cwd: rootDir, env, stdio: "inherit" });
	if (result.error) {
		warn(result.error.message);
		return 1;
	}
	return result.status === 0 ? 0 : (result.status || 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(runDeploy());
