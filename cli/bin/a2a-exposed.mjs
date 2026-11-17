#!/usr/bin/env node
// HTTPS_PROXY and friends: Node's fetch uses them only with NODE_USE_ENV_PROXY=1 at startup. Newer Node applies
// them in-process; Node 22.21+ and 24 restart once with that variable set. An explicit NODE_USE_ENV_PROXY wins.
import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import { prepareProxy } from "../lib/net.mjs";
if (prepareProxy(process.env) === "reexec") {
	const child = spawnSync(process.execPath, [...process.execArgv, "--disable-warning=UNDICI-EHPA", process.argv[1], ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
	if (child.error) { console.error(`error: could not restart Node with proxy support: ${child.error.code || child.error.message}`); process.exit(1); }
	process.exit(child.signal ? 128 + (constants.signals[child.signal] || 1) : child.status ?? 1);
}
// `--config-dir DIR` (anywhere on the command line) is the same as A2A_CONFIG_DIR=DIR; it must be set before the
// config module loads, so main is imported afterwards.
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === "--config-dir" || a.startsWith("--config-dir=")) {
		const v = a === "--config-dir" ? argv[i + 1] : a.slice("--config-dir=".length);
		if (!v || v.startsWith("--")) { console.error("error: --config-dir needs a directory"); process.exit(1); }
		process.env.A2A_CONFIG_DIR = v;
		argv.splice(i, a === "--config-dir" ? 2 : 1);
		break;
	}
}
const { main } = await import("../lib/main.mjs");

main(argv).catch((e) => {
	const known = e && (e.name === "CliError" || e.constructor?.name === "CliError" || e.code?.startsWith?.("ERR_PARSE_ARGS"));
	console.error(`error: ${known ? e.message : e?.stack || e}`);
	process.exit(1);
});
