// `export` against a stub owner API. No network beyond 127.0.0.1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "a2a-exposed.mjs");

function sandbox(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-export-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(dir, "config.env"), "A2A_BASE_URL=http://127.0.0.1:9\nA2A_OWNER_TOKEN=owner-secret\n", { mode: 0o600 });
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(A2A_|PEER_)|WAKE_/.test(k)));
	env.A2A_CONFIG_DIR = dir;
	env.A2A_NO_UPDATE_CHECK = "1";
	const cli = (args, { input = "" } = {}) => new Promise((resolve) => {
		const ch = spawn(process.execPath, [BIN, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		ch.stdout.on("data", (d) => (stdout += d));
		ch.stderr.on("data", (d) => (stderr += d));
		ch.on("close", (status) => resolve({ status, stdout, stderr }));
		ch.stdin.end(input);
	});
	return { cli, env };
}

test("export prints JSON and SQL, and help lists export", async (t) => {
	const seen = [];
	const file = { format: "a2a-exposed-export", version: 1, exportedAt: "2026-10-09T03:00:00.000Z", tables: { peers: [{ label: "ada", token_hash: "abc" }] } };
	const srv = http.createServer(async (req, res) => {
		seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
		if (req.url === "/owner/export") {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify(file));
		}
		if (req.url === "/owner/export?format=sql") {
			res.writeHead(200, { "content-type": "text/plain" });
			return res.end("-- a2a-exposed-export 1\nDELETE FROM \"peers\";\n");
		}
		res.writeHead(404);
		res.end("{}");
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	t.after(() => srv.close());
	const base = `http://127.0.0.1:${srv.address().port}`;
	const s = sandbox(t);
	fs.writeFileSync(path.join(s.env.A2A_CONFIG_DIR, "config.env"), `A2A_BASE_URL=${base}\nA2A_OWNER_TOKEN=owner-secret\n`, { mode: 0o600 });

	const dumped = await s.cli(["export"]);
	assert.equal(dumped.status, 0);
	assert.deepEqual(JSON.parse(dumped.stdout), file);
	assert.equal(dumped.stdout.includes("owner-secret"), false);
	assert.equal(seen[0].auth, "Bearer owner-secret");
	assert.equal(seen[0].url, "/owner/export");

	const sql = await s.cli(["export", "--sql"]);
	assert.equal(sql.status, 0);
	assert.match(sql.stdout, /DELETE FROM "peers"/);

	const help = await s.cli(["--help"]);
	assert.match(help.stdout, /export \[--sql\]/);
	assert.equal(help.stdout.includes("import --yes"), false);
	const unknown = await s.cli(["import", "--yes"], { input: JSON.stringify(file) });
	assert.equal(unknown.status, 1);
	assert.equal(seen.some((r) => r.url === "/owner/import"), false);
});
