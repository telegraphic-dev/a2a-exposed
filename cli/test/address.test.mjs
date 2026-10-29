import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "a2a-exposed.mjs");

function sandbox(t, cfg = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-addr-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	if (Object.keys(cfg).length) fs.writeFileSync(path.join(dir, "config.env"), Object.entries(cfg).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(A2A_|PEER_|WAKE_|CF_|CLOUDFLARE_)/.test(k)));
	Object.assign(env, { A2A_CONFIG_DIR: dir, A2A_NO_UPDATE_CHECK: "1", DO_NOT_TRACK: "1" });
	const cli = (args) => new Promise((resolve) => {
		const ch = spawn(process.execPath, [BIN, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		ch.stdout.on("data", (d) => (stdout += d));
		ch.stderr.on("data", (d) => (stderr += d));
		ch.on("close", (status) => resolve({ status, stdout, stderr }));
		ch.stdin.end();
	});
	return { dir, cli };
}

test("peer announce and peer forward are in the help and reject a mixed invocation", async (t) => {
	const s = sandbox(t);
	const help = await s.cli(["--help"]);
	assert.match(help.stdout, /peer announce \(--to <alias> \| --all\)/);
	assert.match(help.stdout, /peer forward --to <card-url>/);
	const both = await s.cli(["peer", "announce", "--to", "ada", "--all"]);
	assert.equal(both.status, 1);
	assert.match(both.stderr, /usage: .*peer announce/);
});

test("connect stores a mode-600 pairing identity and does not print it; announce refuses a non-https inbox", async (t) => {
	const { default: worker } = await import("../../worker/src/index.ts");
	const { d1 } = await import("../../worker/test/d1.ts");
	const env = { DB: d1(new URL("../../worker/migrations/", import.meta.url)), OWNER_TOKEN: "owner-tok", AGENT_NAME: "Inbox", PUBLIC_URL: "http://127.0.0.1" };
	const srv = http.createServer(async (req, res) => {
		let body = "";
		for await (const c of req) body += c;
		const r = await worker.fetch(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: body || undefined }), env, { waitUntil() {}, passThroughOnException() {} });
		res.writeHead(r.status, Object.fromEntries(r.headers));
		res.end(Buffer.from(await r.arrayBuffer()));
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	t.after(() => srv.close());
	const url = `http://127.0.0.1:${srv.address().port}`;
	env.PUBLIC_URL = url;
	const owner = sandbox(t, { A2A_BASE_URL: url, A2A_OWNER_TOKEN: "owner-tok", A2A_AGENT_NAME: "Inbox" });
	const started = await owner.cli(["connect", url, "--alias", "self", "--no-wait", "--json"]);
	assert.equal(started.status, 0, started.stderr);
	const identPath = path.join(owner.dir, "peer-identity.json");
	const ident = JSON.parse(fs.readFileSync(identPath, "utf8"));
	assert.equal(fs.statSync(identPath).mode & 0o777, 0o600);
	assert.equal(started.stdout.includes(ident.privateKey), false);
	assert.equal(started.stderr.includes(ident.privateKey), false);
	const announced = await owner.cli(["peer", "announce", "--all", "--json"]);
	assert.equal(announced.status, 1);
	assert.match(announced.stderr, /public https address/);
	assert.equal(announced.stdout.includes(ident.privateKey) || announced.stderr.includes(ident.privateKey), false);
});
