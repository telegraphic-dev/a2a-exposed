// Bundle the self-host inbox (worker/src/index.ts) so the control plane can upload it
// with the user's OAuth token. The output is a static asset, not part of the control
// Worker bundle. Run from `npm run build`. Do not commit the output.
//
// The Worker imports tunnelfetch the same way `cf build` in worker/ does: from
// worker/node_modules, locked by worker/package-lock.json. The control CI job does not
// install that package, so install production dependencies when it is missing.
import { spawnSync } from "node:child_process";
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerRoot = path.resolve(root, "../worker");
const outfile = path.join(root, "public/inbox-worker.js.txt");
const tunnelfetch = path.join(workerRoot, "node_modules/tunnelfetch/package.json");

if (!fs.existsSync(tunnelfetch)) {
	const installed = spawnSync(
		"npm",
		["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
		{ cwd: workerRoot, stdio: "inherit", env: process.env },
	);
	if (installed.status !== 0 || !fs.existsSync(tunnelfetch)) {
		console.error("bundle-inbox: worker/node_modules/tunnelfetch is missing. From worker/, run npm ci.");
		process.exit(installed.status || 1);
	}
}

await esbuild.build({
	absWorkingDir: workerRoot,
	entryPoints: ["src/index.ts"],
	bundle: true,
	format: "esm",
	platform: "neutral",
	target: "es2024",
	outfile,
	conditions: ["workerd", "worker", "browser"],
	mainFields: ["module", "main"],
	nodePaths: [path.join(workerRoot, "node_modules")],
	external: ["cloudflare:*"],
	legalComments: "none",
	logLevel: "warning",
	banner: { js: "/* a2a-exposed inbox */" },
});

const migrationsDir = path.join(workerRoot, "migrations");
const migrations = fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort().map((name) => ({
	name,
	sql: fs.readFileSync(path.join(migrationsDir, name), "utf8"),
}));
fs.writeFileSync(path.join(root, "public/inbox-migrations.json"), JSON.stringify(migrations));
