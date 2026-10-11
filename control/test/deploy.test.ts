import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDeploy, secretsFileHasCloudflareSecret } from "../scripts/deploy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts/deploy.mjs");
const secret = "test-cloudflare-secret";

test("a secrets file counts only when the Cloudflare client secret is non-empty", () => {
	assert.equal(secretsFileHasCloudflareSecret(""), false);
	assert.equal(secretsFileHasCloudflareSecret("# comment\nOTHER=1\n"), false);
	assert.equal(secretsFileHasCloudflareSecret("CLOUDFLARE_OAUTH_CLIENT_SECRET=\n"), false);
	assert.equal(secretsFileHasCloudflareSecret("CLOUDFLARE_OAUTH_CLIENT_SECRET=\"\"\n"), false);
	assert.equal(secretsFileHasCloudflareSecret("CLOUDFLARE_OAUTH_CLIENT_SECRET='   '\n"), false);
	assert.equal(secretsFileHasCloudflareSecret(`CLOUDFLARE_OAUTH_CLIENT_SECRET=\nCLOUDFLARE_OAUTH_CLIENT_SECRET=${secret}\n`), true);
	assert.equal(secretsFileHasCloudflareSecret(`CLOUDFLARE_OAUTH_CLIENT_SECRET=${secret}\nCLOUDFLARE_OAUTH_CLIENT_SECRET=\n`), false);
	assert.equal(secretsFileHasCloudflareSecret(`export CLOUDFLARE_OAUTH_CLIENT_SECRET="${secret}"\n`), true);
	assert.equal(secretsFileHasCloudflareSecret(`{ "CLOUDFLARE_OAUTH_CLIENT_SECRET": "${secret}" }\n`), true);
	assert.equal(secretsFileHasCloudflareSecret("{}\n"), false);
	assert.equal(secretsFileHasCloudflareSecret("{ not json"), false);
});

function stubCf(log: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-deploy-"));
	const file = path.join(dir, "cf");
	fs.writeFileSync(file, `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
exit "\${CF_STATUS:-0}"
`);
	fs.chmodSync(file, 0o755);
	return dir;
}

function deployRoot(contents?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-secrets-"));
	if (contents !== undefined) fs.writeFileSync(path.join(dir, "secrets.env"), contents);
	return dir;
}

function run(env: Record<string, string>, contents?: string) {
	const log = path.join(os.tmpdir(), `cf-deploy-log-${process.pid}-${Math.random().toString(16).slice(2)}`);
	const pathDir = stubCf(log);
	const notes: string[] = [];
	const status = runDeploy(
		{ ...env, PATH: pathDir, CF_STATUS: env.CF_STATUS ?? "" },
		{ rootDir: deployRoot(contents), warn: (line: string) => notes.push(String(line)) },
	);
	const lines = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
	const spoken = notes.join("\n");
	assert.equal(spoken.includes(secret), false);
	assert.equal(lines.join("\n").includes(secret), false);
	return { status, lines, spoken };
}

test("deploy uploads the Cloudflare client secret from secrets.env", () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: { deploy: string } };
	assert.match(pkg.scripts.deploy, /node scripts\/deploy\.mjs$/);

	const plain = run({});
	assert.equal(plain.status, 0);
	assert.deepEqual(plain.lines, ["deploy"]);
	assert.equal(plain.spoken, "");

	const blankId = run({ CLOUDFLARE_OAUTH_CLIENT_ID: "  " });
	assert.equal(blankId.status, 0);
	assert.deepEqual(blankId.lines, ["deploy"]);

	const missing = run({ CLOUDFLARE_OAUTH_CLIENT_ID: "cf-client" });
	assert.equal(missing.status, 1);
	assert.deepEqual(missing.lines, []);
	assert.match(missing.spoken, /secrets\.env was not found/);
	assert.match(missing.spoken, /did not upload/);

	const empty = run({ CLOUDFLARE_OAUTH_CLIENT_ID: "cf-client" }, "GITHUB_CLIENT_SECRET=other\n");
	assert.equal(empty.status, 1);
	assert.deepEqual(empty.lines, []);
	assert.match(empty.spoken, /does not set CLOUDFLARE_OAUTH_CLIENT_SECRET/);

	const blank = run({ CLOUDFLARE_OAUTH_CLIENT_ID: "cf-client" }, "CLOUDFLARE_OAUTH_CLIENT_SECRET=\n");
	assert.equal(blank.status, 1);
	assert.deepEqual(blank.lines, []);

	const uploaded = run({ CLOUDFLARE_OAUTH_CLIENT_ID: "cf-client" }, `CLOUDFLARE_OAUTH_CLIENT_SECRET=${secret}\n`);
	assert.equal(uploaded.status, 0);
	assert.deepEqual(uploaded.lines, ["deploy --secrets-file secrets.env"]);
	assert.equal(uploaded.spoken, "");

	const quoted = run({ CLOUDFLARE_OAUTH_CLIENT_ID: "cf-client" }, `export CLOUDFLARE_OAUTH_CLIENT_SECRET="${secret}"\n`);
	assert.equal(quoted.status, 0);
	assert.deepEqual(quoted.lines, ["deploy --secrets-file secrets.env"]);

	const failed = run({ CLOUDFLARE_OAUTH_CLIENT_ID: "cf-client", CF_STATUS: "1" }, `CLOUDFLARE_OAUTH_CLIENT_SECRET=${secret}\n`);
	assert.equal(failed.status, 1);
	assert.deepEqual(failed.lines, ["deploy --secrets-file secrets.env"]);
});

test("the deploy script passes secrets.env only when the Cloudflare client id is set", () => {
	const log = path.join(os.tmpdir(), `cf-deploy-entry-${process.pid}-${Math.random().toString(16).slice(2)}`);
	const pathDir = stubCf(log);
	const skipped = spawnSync(process.execPath, [script], {
		cwd: root,
		env: { PATH: pathDir },
		encoding: "utf8",
	});
	const skippedLines = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
	assert.equal(skipped.status, 0);
	assert.deepEqual(skippedLines, ["deploy"]);
	assert.equal((skipped.stderr ?? "").includes(secret), false);

	fs.writeFileSync(log, "");
	const refused = spawnSync(process.execPath, [script], {
		cwd: root,
		env: { PATH: pathDir, CLOUDFLARE_OAUTH_CLIENT_ID: "cf-client" },
		encoding: "utf8",
	});
	const refusedLines = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
	assert.equal((refused.stderr ?? "").includes(secret), false);
	assert.equal(refusedLines.join("\n").includes(secret), false);
	if (!fs.existsSync(path.join(root, "secrets.env"))) {
		assert.equal(refused.status, 1);
		assert.deepEqual(refusedLines, []);
		assert.match(refused.stderr ?? "", /secrets\.env was not found/);
		assert.match(refused.stderr ?? "", /did not upload/);
	}
});
