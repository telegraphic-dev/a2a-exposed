// Every a2a-exposed flag named in skills/ must appear in --help.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEPLOY_FLAGS } from "../lib/deploy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "..", "bin", "a2a-exposed.mjs");
const repo = path.resolve(here, "../..");

function walk(dir, out = []) {
	for (const name of fs.readdirSync(dir)) {
		const p = path.join(dir, name);
		if (fs.statSync(p).isDirectory()) walk(p, out);
		else if (name.endsWith(".md")) out.push(p);
	}
	return out;
}

function flagsIn(text) {
	return [...text.matchAll(/(?:^|[\s\[,`"'(])--([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
}

function parserFlags() {
	const known = new Set(DEPLOY_FLAGS);
	const sources = [
		fs.readFileSync(path.join(here, "../lib/main.mjs"), "utf8"),
		fs.readFileSync(BIN, "utf8"),
	];
	for (const src of sources) {
		for (const m of src.matchAll(/--([a-z][a-z0-9-]*)/g)) known.add(m[1]);
		// Option keys in the parseArgs spec. Skip `case "command":`.
		for (const m of src.matchAll(/(?<!case )["']([a-z][a-z0-9-]*)["']\s*:/g)) known.add(m[1]);
	}
	known.add("help");
	known.add("version");
	return known;
}

test("every a2a-exposed flag named in skills/ is in --help", () => {
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(A2A_|WAKE_|CF_|CLOUDFLARE_)/.test(k)));
	env.A2A_NO_UPDATE_CHECK = "1";
	env.A2A_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-help-flags-"));
	const help = spawnSync(process.execPath, [BIN, "--help"], { env, encoding: "utf8" });
	fs.rmSync(env.A2A_CONFIG_DIR, { recursive: true, force: true });
	assert.equal(help.status, 0, help.stderr);
	const helpFlags = new Set(flagsIn(help.stdout));
	const accepted = parserFlags();
	// cloudflared uses --token-file; it is not a public CLI flag.
	accepted.delete("token-file");
	const skillText = walk(path.join(repo, "skills")).map((p) => fs.readFileSync(p, "utf8")).join("\n");
	const missing = [...new Set(flagsIn(skillText))].filter((f) => accepted.has(f) && !helpFlags.has(f)).sort();
	assert.deepEqual(missing, [], `skills name flags missing from --help: ${missing.join(", ")}`);
	assert.ok(helpFlags.has("rotate-owner-token"));
	assert.ok(helpFlags.has("skip-install"));
	assert.doesNotMatch(help.stdout, /hosted link (?:create|finish)|CONTROL_URL|CONTROL_TOKEN/);
	assert.match(help.stdout, /claude mcp add --transport http a2a-exposed/);
});
