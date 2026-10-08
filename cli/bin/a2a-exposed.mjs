#!/usr/bin/env node
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
