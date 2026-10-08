#!/usr/bin/env node
import { main } from "../lib/main.mjs";

main(process.argv.slice(2)).catch((e) => {
	const known = e && (e.name === "CliError" || e.constructor?.name === "CliError" || e.code?.startsWith?.("ERR_PARSE_ARGS"));
	console.error(`error: ${known ? e.message : e?.stack || e}`);
	process.exit(1);
});
