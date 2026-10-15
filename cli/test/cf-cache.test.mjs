// `cf` outside a Node project tries to mkdir `<ancestor>/node_modules/.cache/cloudflare`.
// A writable `.cloudflare/cache` in the current directory, or a local `node_modules`, is the working invocation.
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

test("cf delete commands need a writable cache: the worker project, or .cloudflare/cache", async (t) => {
	assert.ok(CF, `cf binary missing (expected worker/node_modules/.bin/cf after npm ci in worker/)`);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-cf-cache-"));
	const blocked = path.join(root, "node_modules");
	const outside = path.join(root, "outside");
	const project = path.join(root, "project");
	fs.mkdirSync(blocked);
	fs.mkdirSync(outside);
	fs.mkdirSync(path.join(project, "node_modules"), { recursive: true });
	fs.chmodSync(blocked, 0o555);
	t.after(() => { fs.chmodSync(blocked, 0o755); fs.rmSync(root, { recursive: true, force: true }); });

	const api = await mockApi();
	t.after(() => api.server.close());
	const base = `http://127.0.0.1:${api.port}/client/v4`;
	const home = path.join(root, "home");
	fs.mkdirSync(home);
	const env = { HOME: home, CLOUDFLARE_API_BASE_URL: base };

	const bare = await runCf(outside, ["d1", "list"], env);
	assert.equal(bare.status, 1, bare.stderr);
	assert.match(bare.stderr, /EACCES:[\s\S]*node_modules\/\.cache\/cloudflare/);

	fs.mkdirSync(path.join(outside, ".cloudflare", "cache"), { recursive: true });
	const cached = await runCf(outside, ["d1", "list"], env);
	assert.equal(cached.status, 0, cached.stderr);
	assert.ok(fs.existsSync(path.join(outside, ".cloudflare", "cache", "cloudflare-account.json")));

	const fromProject = await runCf(project, ["workers", "delete", "some-worker", "--force"], env);
	assert.equal(fromProject.status, 0, fromProject.stderr);
	assert.ok(fs.existsSync(path.join(project, "node_modules", ".cache", "cloudflare", "cloudflare-account.json")));
});
