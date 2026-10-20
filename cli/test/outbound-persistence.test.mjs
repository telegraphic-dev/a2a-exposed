// Peer delivery must not depend on the sender owning a Worker (#105).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/a2a-exposed.mjs", import.meta.url));
const task = { id: "peer-task", contextId: "peer-context", status: { state: "submitted" } };
const message = { kind: "message", messageId: "peer-message", contextId: "peer-context", role: "agent", parts: [{ kind: "text", text: "delivered reply" }] };

async function setup(t, { result = task, owner = "none", fail = "", peerFailure = false } = {}) {
	const requests = [];
	const srv = http.createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = raw ? JSON.parse(raw) : undefined;
		requests.push({ method: req.method, path: req.url, body, auth: req.headers.authorization });
		res.setHeader("content-type", "application/json");
		const reply = (status, obj) => { res.writeHead(status); res.end(JSON.stringify(obj)); };
		if (req.url.startsWith("/owner/")) {
			if (fail === req.url) return reply(503, { error: "storage unavailable" });
			if (fail === "network" || fail === `${req.method}-network`) return req.socket.destroy();
			if (fail === req.method || fail === "all") return reply(503, { error: "storage unavailable" });
			if (req.method === "GET") return reply(200, { endpoint: `${url}/rpc`, protocol: "0.3", contextId: "peer-context" });
			return reply(200, { ok: true });
		}
		if (req.url.startsWith("/.well-known/")) return reply(200, { url: `${url}/rpc`, protocolVersion: "0.3" });
		if (peerFailure) return reply(401, { error: "unauthorized" });
		return reply(200, { jsonrpc: "2.0", id: body.id, result });
	});
	await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${srv.address().port}`;
	t.after(() => srv.close());
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-outbound-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const cfg = { PEER_PAIRED_TOKEN: "paired-test-token" };
	if (owner === "full" || owner === "base-only") cfg.A2A_BASE_URL = url;
	if (owner === "full" || owner === "token-only") cfg.A2A_OWNER_TOKEN = "owner-test-token";
	fs.writeFileSync(path.join(dir, "config.env"), Object.entries(cfg).map(([k, v]) => `${k}=${v}`).join("\n"));
	fs.writeFileSync(path.join(dir, "peers.json"), JSON.stringify({ paired: { url, token_env: "PEER_PAIRED_TOKEN", token_stored: true } }));
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(A2A_|PEER_|CF_|CLOUDFLARE_|WAKE_|STORAGE_BACKEND$)/.test(k)));
	Object.assign(env, { A2A_CONFIG_DIR: dir, A2A_NO_UPDATE_CHECK: "1" });
	const cli = (args) => new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.on("data", (d) => { stdout += d; });
		child.stderr.on("data", (d) => { stderr += d; });
		child.on("error", reject);
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	});
	return { cli, requests };
}

for (const owner of ["none", "base-only", "token-only"]) {
	for (const [kind, result] of [["task", task], ["message", message], ["wrapped task", { task }], ["wrapped message", { message }]]) {
		test(`paired send returns ${kind} with ${owner} owner config`, async (t) => {
			const s = await setup(t, { owner, result });
			const r = await s.cli(["send", "--to", "paired", "--text", "hello"]);
			assert.equal(r.status, 0, r.stderr);
			assert.deepEqual(JSON.parse(r.stdout), kind.includes("message") ? message : task);
			assert.doesNotMatch(r.stderr, /warning:|missing/);
			assert.equal(s.requests.filter((r) => r.path.startsWith("/owner/")).length, 0);
			assert.equal(s.requests.find((r) => r.path === "/rpc").auth, "Bearer paired-test-token");
		});
	}
	test(`poll fetches peer task with ${owner} owner config`, async (t) => {
		const s = await setup(t, { owner });
		const r = await s.cli(["poll", "--to", "paired", task.id]);
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(JSON.parse(r.stdout), task);
		assert.doesNotMatch(r.stderr, /warning:|missing/);
		assert.equal(s.requests.filter((r) => r.path.startsWith("/owner/")).length, 0);
	});
}

for (const owner of ["none", "base-only", "token-only"]) {
	test(`push send rejects ${owner} owner config before contacting peer`, async (t) => {
		const s = await setup(t, { owner });
		const r = await s.cli(["send", "--to", "paired", "--text", "hello", "--push"]);
		assert.equal(r.status, 1);
		assert.equal(r.stdout, "");
		assert.match(r.stderr, /--push needs A2A_BASE_URL and A2A_OWNER_TOKEN/);
		assert.equal(s.requests.length, 0, "reject before peer discovery or delivery");
	});
}

for (const fail of ["all", "network", "/owner/outbound"]) {
	test(`push send preserves delivery and warns authentication is unavailable (${fail})`, async (t) => {
		const s = await setup(t, { owner: "full", fail });
		const r = await s.cli(["send", "--to", "paired", "--text", "hello", "--push"]);
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(JSON.parse(r.stdout), task);
		assert.match(r.stderr, /push updates cannot authenticate/);
		assert.match(r.stderr, /poll --to paired peer-task/);
		assert.match(r.stderr, /do not resend/);
		assert.doesNotMatch(r.stderr, /owner-test-token|paired-test-token/);
		const sends = s.requests.filter((r) => r.path === "/rpc");
		assert.equal(sends.length, 1);
		assert.doesNotMatch(r.stderr, new RegExp(sends[0].body.params.configuration.pushNotificationConfig.token));
	});
}

test("configured push send registers callback and persists its matching token", async (t) => {
	const s = await setup(t, { owner: "full" });
	const r = await s.cli(["send", "--to", "paired", "--text", "hello", "--push"]);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(JSON.parse(r.stdout), task);
	assert.doesNotMatch(r.stderr, /warning:/);
	const push = s.requests.find((r) => r.path === "/rpc").body.params.configuration.pushNotificationConfig;
	assert.ok(push.token);
	const saved = s.requests.find((r) => r.path === "/owner/outbound");
	assert.equal(saved.auth, "Bearer owner-test-token");
	assert.equal(saved.body.pushToken, push.token);
	assert.deepEqual(saved.body.task, task);
	assert.equal(push.url, new URL("/push", saved.body.endpoint).href);
});

test("push send can authenticate updates when only history persistence fails", async (t) => {
	const s = await setup(t, { owner: "full", fail: "/owner/history" });
	const r = await s.cli(["send", "--to", "paired", "--text", "hello", "--push"]);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(JSON.parse(r.stdout), task);
	assert.match(r.stderr, /warning: could not log history/);
	assert.doesNotMatch(r.stderr, /push updates cannot authenticate/);
	assert.ok(s.requests.find((r) => r.path === "/owner/outbound").body.pushToken);
});

for (const fail of ["all", "network"]) {
	for (const [kind, result] of [["task", task], ["message", message]]) {
		test(`send preserves delivered ${kind} when owner persistence fails (${fail})`, async (t) => {
			const s = await setup(t, { owner: "full", fail, result });
			const r = await s.cli(["send", "--to", "paired", "--text", "hello"]);
			assert.equal(r.status, 0, r.stderr);
			assert.deepEqual(JSON.parse(r.stdout), result);
			assert.match(r.stderr, /warning: could not/);
			assert.equal(s.requests.filter((r) => r.path === "/rpc").length, 1, "do not retry delivered messages");
		});
	}
	test(`poll falls back to peer card when stored record lookup fails (${fail})`, async (t) => {
		const s = await setup(t, { owner: "full", fail });
		const r = await s.cli(["poll", "--to", "paired", task.id]);
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(JSON.parse(r.stdout), task);
	});
}

for (const fail of ["PUT", "PUT-network", "POST"]) {
	test(`poll preserves fetched task when owner persistence fails (${fail})`, async (t) => {
		const s = await setup(t, { owner: "full", fail });
		const r = await s.cli(["poll", "--to", "paired", task.id]);
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(JSON.parse(r.stdout), task);
		assert.match(r.stderr, /warning: could not/);
		assert.ok(s.requests.some((r) => r.method === "POST" && r.path === "/owner/history"));
	});
}

test("configured send and poll still persist history and outbound state", async (t) => {
	const s = await setup(t, { owner: "full" });
	for (const args of [["send", "--to", "paired", "--text", "hello"], ["poll", "--to", "paired", task.id]]) {
		const r = await s.cli(args);
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(JSON.parse(r.stdout), task);
		assert.doesNotMatch(r.stderr, /warning:/);
	}
	const writes = s.requests.filter((r) => ["POST", "PUT"].includes(r.method) && r.path.startsWith("/owner/"));
	assert.deepEqual(writes.map((r) => [r.method, r.path]), [["POST", "/owner/history"], ["POST", "/owner/outbound"], ["PUT", `/owner/outbound/${task.id}`], ["POST", "/owner/history"]]);
	assert.deepEqual(writes[1].body.task, task);
	assert.deepEqual(writes[2].body.task, task);
	assert.ok(writes.every((r) => r.auth === "Bearer owner-test-token"));
});

test("peer failures remain fatal and do not persist a send", async (t) => {
	const s = await setup(t, { owner: "full", peerFailure: true });
	const r = await s.cli(["send", "--to", "paired", "--text", "hello"]);
	assert.equal(r.status, 1);
	assert.equal(r.stdout, "");
	assert.match(r.stderr, /rejected our token/);
	assert.equal(s.requests.filter((r) => r.path.startsWith("/owner/")).length, 0);
});
