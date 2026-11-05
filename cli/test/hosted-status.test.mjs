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
function harness(t, { preview = 200, owner = 200, card = 200, health = true, configured = false } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-hosted-status-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const config = `A2A_BASE_URL=${base}\nA2A_OWNER_TOKEN=${secret}\n`;
	fs.writeFileSync(path.join(dir, "config.env"), config, { mode: 0o600 });
	const routes = path.join(dir, "routes.json");
	fs.writeFileSync(routes, JSON.stringify({
		[`${base}/.well-known/agent-card.json`]: { status: card, body: { name: "Hosted", supportedInterfaces: [{ url: base, protocolVersion: "1.0" }] } },
		[`${base}/health`]: { status: 200, body: { ok: health } },
		[`${base}/owner/wake/preview`]: { status: preview === 200 ? owner : preview, body: { configured, preset: "openclaw-wake" } },
		[`${base}/owner/summary`]: { status: owner, body: { tasks: {} } },
	}));
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(A2A_|WAKE_|CF_|CLOUDFLARE_|CONTROL_|HOSTED_|UPSTREAM_|PEER_)/.test(k)));
	Object.assign(env, { A2A_CONFIG_DIR: dir, A2A_TEST_FETCH_ROUTES: routes, A2A_TEST_FETCH_LOG: path.join(dir, "requests"), DO_NOT_TRACK: "1" });
	return { dir, config, run: (args, extraEnv = {}) => new Promise((resolve) => {
		const child = spawn(process.execPath, ["--import", path.join(here, "fetch-stub.mjs"), path.join(here, "../bin/a2a-exposed.mjs"), ...args], { env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
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

test("plain hosted wake set gives dashboard and MCP guidance without calls, writes or secret disclosure", async (t) => {
	for (const source of ["saved", "environment"]) {
		const h = harness(t);
		const configFile = path.join(h.dir, "config.env");
		if (source === "environment") fs.unlinkSync(configFile);
		const credentials = source === "environment" ? { A2A_BASE_URL: base, A2A_OWNER_TOKEN: secret } : {};
		for (const json of [false, true]) {
			for (const withSecrets of [false, true]) {
				const r = await h.run(["wake", "set", ...(withSecrets ? ["--preset", "grok-bot"] : []), ...(json ? ["--json"] : [])], {
					...credentials,
					...(withSecrets ? { WAKE_WEBHOOK_URL: "https://receiver.example/private-hook?key=private-query", WAKE_WEBHOOK_KEY: "private-wake-key", WAKE_HMAC_SECRET: "private-signing-secret" } : {}),
				});
				assert.equal(r.code, 1, r.stdout + r.stderr);
				const next = json ? JSON.parse(r.stdout).next : r.stdout;
				if (json) { assert.equal(JSON.parse(r.stdout).ok, false); assert.equal(JSON.parse(r.stdout).code, "hosted_config"); }
				assert.match(next, /hosted config.*dashboard Wake settings or hosted MCP set_wake/);
				assert.match(next, /human enters wake secrets on the confirmation page/);
				assert.match(next, /hosted capabilities --json.*hosted list --json.*--agent NAME/);
				assert.doesNotMatch(r.stdout + r.stderr, /no saved deployment|\binit\b|\bdeploy\b|hosted-owner-test-secret|private-hook|private-query|private-wake-key|private-signing-secret/);
			}
		}
		if (source === "saved") assert.equal(fs.readFileSync(configFile, "utf8"), h.config);
		else assert.equal(fs.existsSync(configFile), false);
		assert.equal(fs.existsSync(path.join(h.dir, "requests")), false);
		assert.equal(fs.existsSync(path.join(h.dir, "worker")), false);
	}
});

test("hosted status tolerates unavailable wake preview and uses the read-only owner summary", async (t) => {
	const h = harness(t, { preview: 404 });
	const r = await h.run(["status", "--json"]);
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.match(JSON.parse(r.stdout).nextStep, /Wake preview is unavailable/);
	assert.match(JSON.parse(r.stdout).nextStep, /delivery is unverified.*hosted capabilities --json/);
	assert.match(JSON.parse(r.stdout).also.join(" "), /dashboard Wake settings or MCP set_wake/);
	const plain = await h.run(["status"]);
	assert.equal(plain.code, 0, plain.stdout + plain.stderr);
	assert.match(plain.stdout, /unknown \(hosted wake preview unavailable\)/);
	assert.doesNotMatch(plain.stdout, /owner API not reachable/);
	const requests = fs.readFileSync(path.join(h.dir, "requests"), "utf8");
	assert.match(requests, /owner\/summary/); assert.doesNotMatch(requests, /owner\/inbox/);
});

test("hosted status distinguishes delivery choice and saved settings from verification without testing or writing", async (t) => {
	for (const configured of [false, true]) {
		const h = harness(t, { configured });
		for (const json of [false, true]) {
			const r = await h.run(["status", ...(json ? ["--json"] : [])]);
			assert.equal(r.code, 0, r.stdout + r.stderr);
			const data = json ? JSON.parse(r.stdout) : null;
			const next = json ? [data.nextStep, ...data.also].join(" ") : r.stdout;
			assert.match(next, /hosted capabilities --json/);
			if (configured) {
				assert.match(next, /wake settings are saved; status does not test delivery/);
				assert.match(next, /wake preview --json.*authorized draft test.*inbox-and-reply run/);
			} else {
				assert.match(next, /no webhook is configured/);
				assert.match(next, /hook support and hosted route compatibility.*offer webhook or polling with its interval and cost before configuring either/);
			}
			assert.doesNotMatch(next, /none:|expected to poll|nothing is deployed|rotate-owner-token|hosted-owner-test-secret/);
		}
		assert.equal(fs.readFileSync(path.join(h.dir, "config.env"), "utf8"), h.config);
		const calls = fs.readFileSync(path.join(h.dir, "requests"), "utf8").trim().split("\n").map(JSON.parse);
		assert.ok(calls.every(call => call.method === "GET" || call.method === "HEAD"));
		assert.ok(calls.every(call => !/\/test|\/inbox|\/setup\//.test(new URL(call.url).pathname)));
	}
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
