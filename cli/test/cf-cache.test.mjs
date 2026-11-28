// `cf` account commands must work from the fallback directory used after
// the local Worker checkout was removed, as well as from the checkout itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CF = [path.join(REPO, "worker/node_modules/.bin/cf"), path.join(REPO, "cli/node_modules/.bin/cf")]
	.find((p) => fs.existsSync(p));

const ok = (result) => JSON.stringify({ success: true, errors: [], messages: [], result });

function mockApi() {
	const hits = [];
	const server = http.createServer((req, res) => {
		hits.push(`${req.method} ${req.url}`);
		const url = req.url || "/";
		let result = [];
		if (url.includes("/memberships")) result = [{ id: "mem1", account: { id: "acct1", name: "Test" }, status: "accepted" }];
		else if (/\/accounts\/?(\?|$)/.test(url)) result = [{ id: "acct1", name: "Test" }];
		else if (url.includes("/d1/database") && req.method === "GET") result = [];
		else if (req.method === "DELETE") result = { id: "gone" };
		res.writeHead(200, { "content-type": "application/json" });
		res.end(ok(result));
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve({
			server, hits, port: server.address().port,
		}));
	});
}

function runCf(cwd, args, extra = {}) {
	return new Promise((resolve) => {
		const ch = spawn(CF, args, {
			cwd,
			env: {
				...extra,
				PATH: process.env.PATH,
				HOME: extra.HOME,
				CI: "1",
				DO_NOT_TRACK: "1",
				CLOUDFLARE_API_TOKEN: "test-token-not-a-secret",
				CLOUDFLARE_API_BASE_URL: extra.CLOUDFLARE_API_BASE_URL,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "", stderr = "";
		ch.stdout.on("data", (d) => (stdout += d));
		ch.stderr.on("data", (d) => (stderr += d));
		ch.on("close", (status) => resolve({ status, stdout, stderr }));
	});
}

test("cf account commands work in a checkout and with a read-only ancestor node_modules", async (t) => {
	assert.ok(CF, `cf binary missing (expected worker/node_modules/.bin/cf after npm ci in worker/)`);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-cf-cache-"));
	const blocked = path.join(root, "node_modules");
	const outside = path.join(root, "outside");
	const project = path.join(root, "project");
	fs.mkdirSync(blocked);
	fs.mkdirSync(outside);
	fs.mkdirSync(path.join(project, "node_modules"), { recursive: true });
	// cf searches ancestors for config even for account-level commands. Shadow
	// any developer config without changing the cache layout under test.
	fs.writeFileSync(path.join(root, "cloudflare.config.ts"), 'throw new Error("parent config must not load");\n');
	for (const cwd of [outside, project]) {
		fs.writeFileSync(path.join(cwd, "cloudflare.config.ts"), "export default {};\n");
	}
	fs.chmodSync(blocked, 0o555);
	t.after(() => { fs.chmodSync(blocked, 0o755); fs.rmSync(root, { recursive: true, force: true }); });

	const api = await mockApi();
	t.after(() => api.server.close());
	const base = `http://127.0.0.1:${api.port}/client/v4`;
	const home = path.join(root, "home");
	fs.mkdirSync(home);
	const env = { HOME: home, CLOUDFLARE_API_BASE_URL: base };

	const bare = await runCf(outside, ["d1", "list"], env);
	assert.equal(bare.status, 0, bare.stderr);
	assert.ok(api.hits.some((hit) => /^GET .*\/d1\/database\b/.test(hit)));
	assert.ok(!fs.existsSync(path.join(blocked, ".cache")));

	fs.mkdirSync(path.join(outside, ".cloudflare", "cache"), { recursive: true });
	for (const cwd of [outside, project]) {
		api.hits.length = 0;
		const result = await runCf(cwd, ["workers", "delete", "some-worker", "--force"], env);
		assert.equal(result.status, 0, result.stderr);
		assert.ok(api.hits.includes("DELETE /client/v4/accounts/acct1/workers/workers/some-worker"), api.hits.join("\n"));
	}
});
