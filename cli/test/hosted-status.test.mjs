import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = "https://hosted.example.com";
const secret = "hosted-owner-test-secret";
function harness(t, { preview = 200, owner = 200, card = 200, health = true } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-hosted-status-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const config = `A2A_BASE_URL=${base}\nA2A_OWNER_TOKEN=${secret}\n`;
	fs.writeFileSync(path.join(dir, "config.env"), config, { mode: 0o600 });
	const routes = path.join(dir, "routes.json");
	fs.writeFileSync(routes, JSON.stringify({
		[`${base}/.well-known/agent-card.json`]: { status: card, body: { name: "Hosted", supportedInterfaces: [{ url: base, protocolVersion: "1.0" }] } },
		[`${base}/health`]: { status: 200, body: { ok: health } },
		[`${base}/owner/wake/preview`]: { status: preview === 200 ? owner : preview, body: { configured: false } },
		[`${base}/owner/summary`]: { status: owner, body: { tasks: {} } },
	}));
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(A2A_|WAKE_|CF_|CLOUDFLARE_|CONTROL_|UPSTREAM_|PEER_)/.test(k)));
	Object.assign(env, { A2A_CONFIG_DIR: dir, A2A_TEST_FETCH_ROUTES: routes, A2A_TEST_FETCH_LOG: path.join(dir, "requests"), DO_NOT_TRACK: "1" });
	return { dir, config, run: (args) => new Promise((resolve) => {
		const child = spawn(process.execPath, ["--import", path.join(here, "fetch-stub.mjs"), path.join(here, "../bin/a2a-exposed.mjs"), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	}) };
}

test("hosted-only status checks the endpoint without requiring Worker metadata or matching CLI versions", async (t) => {
	const h = harness(t);
	const r = await h.run(["status", "--json"]);
	assert.equal(r.code, 0, r.stdout + r.stderr);
	const value = JSON.parse(r.stdout);
	assert.equal(value.deployment, "hosted"); assert.equal(value.ok, true);
	assert.equal(value.card.ok, true); assert.equal(value.health.ok, true); assert.equal(value.ownerApi.ok, true);
	assert.doesNotMatch(r.stdout + r.stderr, /\binit\b|\bdeploy\b|nothing is deployed|hosted-owner-test-secret/);
	const plain = await h.run(["status"]);
	assert.equal(plain.code, 0); assert.match(plain.stdout, /deployment:\s+hosted/);
});

test("hosted status tolerates unavailable wake preview and uses the read-only owner summary", async (t) => {
	const h = harness(t, { preview: 404 });
	const r = await h.run(["status", "--json"]);
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.match(JSON.parse(r.stdout).nextStep, /Wake preview is unavailable/);
	const requests = fs.readFileSync(path.join(h.dir, "requests"), "utf8");
	assert.match(requests, /owner\/summary/); assert.doesNotMatch(requests, /owner\/inbox/);
});

test("hosted failures keep recovery within the hosted service", async (t) => {
	for (const options of [{ owner: 401 }, { card: 404 }, { health: false }]) {
		const h = harness(t, options); const r = await h.run(["status", "--json"]);
		assert.equal(r.code, 1, r.stdout + r.stderr);
		assert.doesNotMatch(r.stdout + r.stderr, /\binit\b|\bdeploy\b|rotate-owner-token|hosted-owner-test-secret/);
	}
});

test("hosted tunnel commands and uninstall refuse without mutations or self-host setup advice", async (t) => {
	const h = harness(t);
	for (const args of [["tunnel", "create"], ["tunnel", "status"], ["tunnel", "rm"], ["uninstall", "--yes"], ["uninstall", "--dry-run"]]) {
		const r = await h.run(args);
		assert.equal(r.code, 1, r.stdout + r.stderr);
		assert.match(r.stderr, /hosted config/);
		assert.doesNotMatch(r.stdout + r.stderr, /nothing is deployed|\binit\b|hosted-owner-test-secret/);
	}
	assert.equal(fs.readFileSync(path.join(h.dir, "config.env"), "utf8"), h.config);
	assert.equal(fs.existsSync(path.join(h.dir, "requests")), false);
});
