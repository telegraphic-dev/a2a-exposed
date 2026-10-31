import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { finishLink } from "../lib/link-finish.mjs";
import { writeTokenFile, readSigningSecret, startConnector, connectorArgs } from "../lib/local-link.mjs";
import { EventEmitter } from "node:events";

const link = { agent: "example", hostname: "wake.example.com", origin: "http://127.0.0.1:8644", path: "/webhooks/inbox", preset: "hermes" };
const o = { agent: "example", "control-url": "https://control.example", "secret-env": "TEST_SIGNING_SECRET" };
const sensitive = ["private-grant", "private-connector", "private-signing-secret"];

function harness(overrides = {}) {
	const calls = [], lines = [], writes = [], runs = [], sleeps = [];
	let challenge, clock = 0;
	const responses = {
		requests: () => Response.json({ request_id: "request-id", user_code: "ABCD-1234", approve_url: "https://control.example/approve", expires_in: 600, interval: 5 }, { status: 201 }),
		token: (body) => {
			assert.equal(crypto.createHash("sha256").update(body.verifier).digest("base64url"), challenge);
			assert.equal(Buffer.from(body.verifier, "base64url").length, 32);
			return Response.json({ grant: sensitive[0], expires_in: 600, link });
		},
		connector: () => Response.json({ connector_token: sensitive[1] }),
		status: () => Response.json({ connector: "connected", connections: 1, checked_at: "2026-01-01T00:00:00Z" }),
		"wake-test": () => Response.json({ result: "ok", saved: true }),
		...overrides,
	};
	const deps = {
		fetchImpl: async (url, init) => {
			const endpoint = new URL(url).pathname.split("/").at(-1);
			calls.push(endpoint);
			assert.equal(init.redirect, "error");
			assert.equal(url.includes(sensitive[0]), false);
			const body = init.body ? JSON.parse(init.body) : undefined;
			if (endpoint === "requests") { challenge = body.challenge; assert.equal(body.agent, "example"); }
			if (["connector", "status", "wake-test"].includes(endpoint)) assert.equal(init.headers.authorization, `Grant ${sensitive[0]}`);
			if (endpoint === "wake-test") assert.deepEqual(body, { signing_secret: sensitive[2], preset: "hermes" });
			return responses[endpoint](body, init);
		},
		sleep: async (ms) => { sleeps.push(ms); clock += ms; }, now: () => clock,
		write: (line) => lines.push(line), saveToken: (...args) => writes.push(args),
		readSecret: () => sensitive[2], runConnector: async (file) => runs.push(file),
	};
	return { deps, calls, lines, writes, runs, sleeps };
}

test("finish binds PKCE, saves token, starts connector, checks status then tests/saves wake without printing secrets", async () => {
	const h = harness();
	assert.deepEqual(await finishLink(o, h.deps), { saved: true, connectorStarted: true });
	assert.deepEqual(h.calls, ["requests", "token", "connector", "status", "wake-test"]);
	assert.equal(h.writes[0][1], sensitive[1]);
	assert.equal(h.runs[0], h.writes[0][0]);
	for (const secret of sensitive) assert.equal(h.lines.join("\n").includes(secret), false);
});

test("pending and slow down delay polling; unknown and disconnected status wait three seconds", async () => {
	let polls = 0, statuses = 0;
	const h = harness({
		token: () => ++polls < 3 ? Response.json({ error: polls === 1 ? "authorization_pending" : "slow_down" }, { status: polls === 1 ? 428 : 429 }) : Response.json({ grant: sensitive[0], link }),
		status: () => Response.json(++statuses < 3 ? { connector: statuses === 1 ? "unknown" : "not_connected", connections: 0 } : { connector: "connected", connections: 2 }),
	});
	await finishLink(o, h.deps);
	assert.deepEqual(h.sleeps, [5000, 5000, 10000, 3000, 3000]);
});

for (const [status, error] of [[403, "access_denied"], [410, "expired_token"], [409, "link_not_ready"]]) {
	test(`approval ${error} never fetches the connector`, async () => {
		const h = harness({ token: () => Response.json({ error, message: sensitive.join(" ") }, { status }) });
		await assert.rejects(finishLink(o, h.deps), new RegExp(error));
		assert.equal(h.calls.includes("connector"), false);
	});
}

test("malicious error text and thrown transport errors never reach diagnostics", async () => {
	for (const response of [() => Response.json({ error: sensitive[0], message: sensitive[1] }, { status: 500 }), () => { throw new Error(sensitive[2]); }]) {
		const h = harness({ connector: response });
		await assert.rejects(finishLink(o, h.deps), (error) => sensitive.every((s) => !error.message.includes(s)));
	}
});

test("no-run prints token-file command and never starts connector or tests/saves wake", async () => {
	const h = harness();
	assert.deepEqual(await finishLink({ ...o, "no-run": true, "token-file": "/tmp/example token" }, h.deps), { saved: false, connectorStarted: false });
	assert.equal(h.runs.length, 0);
	assert.equal(h.calls.includes("status"), false);
	assert.equal(h.calls.includes("wake-test"), false);
	assert.match(h.lines.at(-1), /^cloudflared .*--token-file.*example token/);
});

test("failed source validation does not spend connector delivery; write failure never starts child", async () => {
	const h = harness();
	h.deps.readSecret = () => { throw new Error("bad source"); };
	await assert.rejects(finishLink(o, h.deps), /bad source/);
	assert.equal(h.calls.includes("connector"), false);
	const w = harness();
	w.deps.saveToken = () => { throw new Error("write failed"); };
	await assert.rejects(finishLink(o, w.deps), /write failed/);
	assert.equal(w.runs.length, 0);
});

test("connector timeout is bounded and never sends the secret; wake errors never report success", async () => {
	const h = harness({ status: () => Response.json({ connector: "not_connected", connections: 0 }) });
	await assert.rejects(finishLink(o, h.deps), /60 seconds/);
	assert.equal(h.calls.filter((c) => c === "status").length, 20);
	assert.equal(h.calls.includes("wake-test"), false);
	for (const result of ["timeout", "access-401", "dns-missing"]) {
		const w = harness({ "wake-test": () => Response.json({ result, saved: false }) });
		await assert.rejects(finishLink(o, w.deps), new RegExp(result));
	}
	for (const error of ["invalid_grant", "connector_not_connected", "already_delivered"]) {
		const w = harness({ "wake-test": () => Response.json({ error }, { status: 409 }) });
		await assert.rejects(finishLink(o, w.deps), new RegExp(error));
	}
});

test("refuses invalid options and cross-origin approval before secret transfer", async () => {
	for (const options of [{ ...o, agent: "../bad" }, { ...o, "control-url": "http://control.example" }, { ...o, "secret-file": "file" }]) {
		const h = harness(); await assert.rejects(finishLink(options, h.deps)); assert.equal(h.calls.length, 0);
	}
	const h = harness({ requests: () => Response.json({ request_id: "id", user_code: "ABCD-1234", approve_url: "https://evil.example/approve" }, { status: 201 }) });
	await assert.rejects(finishLink(o, h.deps), /invalid approval/);
	assert.equal(h.lines.length, 0);
});

test("a status response arriving after the connection deadline cannot submit the secret", async () => {
	const h = harness();
	const original = h.deps.fetchImpl;
	h.deps.fetchImpl = async (url, init) => {
		const response = await original(url, init);
		if (url.endsWith("/status")) await h.deps.sleep(60000);
		return response;
	};
	await assert.rejects(finishLink(o, h.deps), /60 seconds/);
	assert.equal(h.calls.includes("wake-test"), false);
});

test("atomic write replaces a public destination with mode 600 and does not follow its symlink", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-finish-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, "token"), victim = path.join(dir, "victim");
	fs.writeFileSync(victim, "old"); fs.symlinkSync(victim, file);
	writeTokenFile(file, sensitive[1]);
	assert.equal(fs.readFileSync(victim, "utf8"), "old");
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.equal(fs.readFileSync(file, "utf8"), sensitive[1] + "\n");
	assert.deepEqual(fs.readdirSync(dir).sort(), ["token", "victim"]);
	fs.mkdirSync(path.join(dir, "blocked"));
	assert.throws(() => writeTokenFile(path.join(dir, "blocked"), sensitive[1]), /fresh approval/);
	assert.equal(fs.readdirSync(dir).some((f) => f.startsWith(".a2a-token")), false);
});

test("private secret files and Hermes exact route adapter fail closed", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-hermes-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, "secret");
	fs.writeFileSync(file, sensitive[2] + "\n", { mode: 0o644 });
	assert.throws(() => readSigningSecret({ "secret-file": file }, link), /mode 600/);
	fs.chmodSync(file, 0o600);
	assert.equal(readSigningSecret({ "secret-file": file }, link), sensitive[2]);
	fs.symlinkSync(file, path.join(dir, "sym"));
	assert.throws(() => readSigningSecret({ "secret-file": path.join(dir, "sym") }, link), /no symlinks/);
	fs.writeFileSync(path.join(dir, "webhook_subscriptions.json"), JSON.stringify({ inbox: { secret: sensitive[2] }, other: { secret: "other" } }), { mode: 0o600 });
	const hermes = { "secret-from": "hermes", "hermes-home": dir };
	assert.equal(readSigningSecret(hermes, link), sensitive[2]);
	assert.throws(() => readSigningSecret({ ...hermes, route: "other" }, link), /does not match/);
	assert.throws(() => readSigningSecret(hermes, { ...link, path: "/p/profile/webhooks/inbox" }), /does not match/);
	fs.writeFileSync(path.join(dir, "config.yaml"), "platforms:\n  webhook:\n    extra:\n      routes: {}\n");
	assert.throws(() => readSigningSecret(hermes, link), /override/);
});

test("connector spawn passes only the token filename, detaches and suppresses output", async () => {
	const child = new EventEmitter(); child.unref = () => {};
	await startConnector("/tmp/example.token", (cmd, args, options) => {
		assert.equal(cmd, "cloudflared"); assert.deepEqual(args, connectorArgs("/tmp/example.token"));
		assert.equal(options.detached, true); assert.equal(options.stdio, "ignore");
		assert.equal(Object.keys(options.env).some((k) => /TOKEN|SECRET|PASSWORD|KEY/i.test(k)), false);
		queueMicrotask(() => child.emit("spawn")); return child;
	});
});
