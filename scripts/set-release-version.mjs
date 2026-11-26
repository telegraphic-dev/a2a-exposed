#!/usr/bin/env node
// Keep the dependency-free version editor usable by tooling fixtures, while the
// public release command also regenerates the official-SDK portable edition.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
for (const [script, args] of [["scripts/set-version.mjs", process.argv.slice(2)], ["worker/scripts/mcp-portable-skills-catalog.mjs", []]]) {
	const result = spawnSync(process.execPath, [root + script, ...args], { stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status || 1);
}
