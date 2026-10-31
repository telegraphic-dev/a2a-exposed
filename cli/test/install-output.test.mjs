import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("dependency install suppresses warnings and reports a private log on failure", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-install-"));
	try {
		fs.writeFileSync(path.join(dir, "npm"), '#!/bin/sh\necho "npm warning" >&2\nexit "${INSTALL_EXIT:-0}"\n', { mode: 0o700 });
		for (const status of [0, 1]) {
			const code = `import { installDependencies } from ${JSON.stringify(new URL("../lib/deploy.mjs", import.meta.url).href)}; installDependencies(${JSON.stringify(dir)}, { configDir: ${JSON.stringify(dir)} });`;
			const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH, INSTALL_EXIT: String(status) }, encoding: "utf8" });
			assert.equal(result.status, status);
			assert.doesNotMatch(result.stdout + result.stderr, /npm warning/);
			if (status) assert.ok(result.stderr.includes(path.join(dir, "npm-install.log")));
			else assert.equal(result.stderr, "");
			assert.match(fs.readFileSync(path.join(dir, "npm-install.log"), "utf8"), /npm warning/);
			assert.equal(fs.statSync(path.join(dir, "npm-install.log")).mode & 0o777, 0o600);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
