import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { finishLink, createLink, savedLinkSession } from "../lib/link-finish.mjs";
import { writeTokenFile, readSigningSecret, startConnector, connectorArgs } from "../lib/local-link.mjs";
import { controlSession } from "../lib/config.mjs";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";

const link = { agent: "example", hostname: "wake.example.com", origin: "http://127.0.0.1:8644", path: "/webhooks/inbox", preset: "hermes" };
const o = { agent: "example", "control-url": "https://control.example", "secret-env": "TEST_SIGNING_SECRET" };
const sensitive = ["private-grant", "private-connector", "private-signing-secret", "private-session"];

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
			if (endpoint === "requests") { challenge = body.challenge; assert.equal(body.agent, "example"); assert.equal(init.headers.authorization, `Bearer ${sensitive[3]}`); }
			if (endpoint === "token") assert.equal(init.headers.authorization, undefined);
			if (["connector", "status", "wake-test"].includes(endpoint)) assert.equal(init.headers.authorization, `Grant ${sensitive[0]}`);
			if (endpoint === "wake-test") assert.deepEqual(body, { signing_secret: sensitive[2], preset: "hermes" });
			return responses[endpoint](body, init);
		},
		sleep: async (ms) => { sleeps.push(ms); clock += ms; }, now: () => clock,
		write: (line) => lines.push(line), saveToken: (...args) => writes.push(args),
		readSecret: () => sensitive[2], runConnector: async (file) => runs.push(file),
		sessionToken: () => sensitive[3],
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

const plan = { hostname: link.hostname, origin: link.origin, path: link.path, preset: link.preset };

test("create sends only the exact plan before approval, then connects, tests and saves on the same bot", async () => {
	let sent;
	const h = harness({ requests: (body) => {
		sent = body;
		return Response.json({ request_id: "request-id", user_code: "ABCD-1234", approve_url: "https://control.example/approve", expires_in: 600 }, { status: 201 });
	} });
	assert.deepEqual(await createLink({ ...o, ...plan }, h.deps), { saved: true, connectorStarted: true });
	assert.deepEqual(sent.create, plan);
	assert.deepEqual(Object.keys(sent).sort(), ["agent", "challenge", "create"]);
	for (const value of sensitive) {
		assert.equal(JSON.stringify(sent).includes(value), false);
		assert.equal(h.lines.join("\n").includes(value), false);
	}
	assert.deepEqual(h.calls, ["requests", "token", "connector", "status", "wake-test"]);
});

test("creation normalizes hostname and origin and refuses malformed plans before network calls", async () => {
	const h = harness({ requests: (body) => {
		assert.deepEqual(body.create, plan);
		return Response.json({ error: "access_denied" }, { status: 403 });
	} });
	await assert.rejects(createLink({ ...o, ...plan, hostname: " WAKE.EXAMPLE.COM ", origin: link.origin + "/" }, h.deps), /access_denied/);
	for (const invalid of [
		{ hostname: "https://wake.example.com" }, { hostname: "bad..example.com" },
		{ origin: "http://user:password@localhost" }, { origin: "file:///tmp/local" },
		{ origin: "http://127.0.0.1:8644/path" }, { origin: "http://localhost?key=value" },
		{ path: "" }, { path: "//other/path" }, { path: "/webhooks/inbox?key=value" },
		{ path: "/bad\\path" }, { preset: "" }, { preset: "not a preset" },
	]) {
		const w = harness();
		await assert.rejects(async () => createLink({ ...o, ...plan, ...invalid }, w.deps));
		assert.deepEqual(w.calls, []);
	}
	for (const field of Object.keys(plan)) {
		const options = { ...o, ...plan }; delete options[field];
		assert.throws(() => createLink(options, harness().deps), new RegExp(`--${field}`));
	}
});

test("creation refuses wrong Hermes route or changed approved metadata before secret access", async () => {
	for (const options of [{ route: "other" }, { preset: "openbot" }, { path: "/p/profile/webhooks/inbox" }]) {
		const h = harness();
		assert.throws(() => createLink({ ...o, ...plan, "secret-env": undefined, "secret-from": "hermes", ...options }, h.deps), /Hermes route/);
		assert.deepEqual(h.calls, []);
	}
	for (const key of Object.keys(plan)) {
		const h = harness({ token: () => Response.json({ grant: sensitive[0], link: { ...link, [key]: key === "path" ? "/other" : "different" } }) });
		h.deps.readSecret = () => assert.fail("must not read the signing secret");
		await assert.rejects(createLink({ ...o, ...plan }, h.deps), /differs/);
		assert.equal(h.calls.includes("connector"), false);
	}
});

test("creation failures never deliver a connector, read secrets, or retry provisioning automatically", async () => {
	for (const [status, error] of [[409, "link_exists"], [502, "provision_failed"], [403, "access_denied"], [410, "expired_token"]]) {
		const h = harness({ token: () => Response.json({ error, phase: sensitive[1], message: sensitive[2] }, { status }) });
		h.deps.readSecret = () => assert.fail("must not read the signing secret");
		await assert.rejects(createLink({ ...o, ...plan }, h.deps), (err) => err.message.includes(error) && sensitive.every((s) => !err.message.includes(s)));
		assert.deepEqual(h.calls, ["requests", "token"]);
	}
});

test("the saved account session is bound to the service and never falls back to an owner token", () => {
	const config = { CONTROL_URL: "https://control.example/", CONTROL_TOKEN: sensitive[3], A2A_OWNER_TOKEN: "owner" };
	assert.equal(savedLinkSession("https://control.example", controlSession({}, config)), sensitive[3]);
	assert.throws(() => savedLinkSession("https://other.example", controlSession({}, config)), /sign in/);
	delete config.CONTROL_TOKEN;
	assert.throws(() => savedLinkSession("https://control.example", controlSession({}, config)), /sign in/);
});

test("control sessions keep origin and token together across environment overrides", async () => {
	const saved = { CONTROL_URL: "https://control.example/", CONTROL_TOKEN: sensitive[3] };
	assert.equal(savedLinkSession("https://control.example", controlSession({}, saved)), sensitive[3]);
	assert.equal(savedLinkSession("https://other.example", controlSession({ CONTROL_URL: "https://other.example", CONTROL_TOKEN: "other-session" }, saved)), "other-session");
	for (const env of [{ CONTROL_URL: "https://other.example" }, { CONTROL_URL: "https://control.example" }, { CONTROL_TOKEN: "other-session" }]) {
		const h = harness();
		h.deps.sessionToken = (origin) => savedLinkSession(origin, controlSession(env, saved));
		await assert.rejects(finishLink({ ...o, "control-url": env.CONTROL_URL || o["control-url"] }, h.deps), /sign in/);
		assert.deepEqual(h.calls, []);
	}
	assert.throws(() => savedLinkSession("https://control.example", controlSession({ CONTROL_URL: "https://other.example", CONTROL_TOKEN: "other-session" }, saved)), /sign in/);
});

test("default session resolution rejects a saved token with only CONTROL_URL overridden before fetch", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-session-origin-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(dir, "config.env"), "CONTROL_URL=https://control.example\nCONTROL_TOKEN=dummy-saved-session\n");
	const script = `
		import assert from 'node:assert/strict';
		import { finishLink } from ${JSON.stringify(new URL("../lib/link-finish.mjs", import.meta.url).href)};
		let fetched = false;
		await assert.rejects(finishLink({ agent: 'example', 'control-url': 'https://other.example', 'secret-env': 'DUMMY' }, { fetchImpl: () => { fetched = true; throw new Error('unexpected fetch'); } }), /sign in/);
		assert.equal(fetched, false);
	`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
		encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, A2A_CONFIG_DIR: dir, CONTROL_URL: "https://other.example", DO_NOT_TRACK: "1" },
	});
	assert.equal(result.status, 0, result.stderr);
});

test("missing login refuses locally and finish cannot silently ignore create options", async (t) => {
	const h = harness();
	h.deps.sessionToken = () => { throw new Error("sign in first"); };
	await assert.rejects(createLink({ ...o, ...plan }, h.deps), /sign in first/);
	assert.deepEqual(h.calls, []);
	assert.throws(() => finishLink({ ...o, ...plan }, harness().deps), /creation options/);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-create-options-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const result = spawnSync(process.execPath, [new URL("../bin/a2a-exposed.mjs", import.meta.url).pathname, "hosted", "link", "create", "--agent", "example", "--secret-env", "DUMMY"], {
		encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, A2A_CONFIG_DIR: dir, DO_NOT_TRACK: "1" },
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /requires --hostname/);
});

test("finish authenticates a real HTTP requests endpoint with the saved Bearer session", async (t) => {
	const { createServer } = await import("node:http");
	let accepted = 0;
	const server = createServer((req, res) => {
		assert.equal(req.url, "/api/link-finish/requests");
		const authorized = req.headers.authorization === `Bearer ${sensitive[3]}`;
		if (authorized) accepted++;
		res.writeHead(authorized ? 201 : 401, { "content-type": "application/json" });
		res.end(JSON.stringify(authorized ? { request_id: "id", user_code: "ABCD-1234", approve_url: "https://control.example/approve" } : { error: "unauthorized" }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
	const base = `http://127.0.0.1:${server.address().port}`;
	assert.equal((await fetch(`${base}/api/link-finish/requests`, { method: "POST" })).status, 401);
	const h = harness(), original = h.deps.fetchImpl;
	h.deps.fetchImpl = (url, init) => url.endsWith("/requests") ? fetch(base + new URL(url).pathname, init) : original(url, init);
	// The harness normally records the challenge; this endpoint checks auth instead.
	h.deps.fetchImpl = ((fetchRequest) => (url, init) => {
		if (url.endsWith("/token")) return Response.json({ grant: sensitive[0], link });
		return fetchRequest(url, init);
	})(h.deps.fetchImpl);
	await finishLink(o, h.deps);
	assert.equal(accepted, 1);
});

test("finish validates preset before network and uses it for a link without a preset", async () => {
	for (const preset of ["", "bad preset", "../bad"]) {
		const h = harness();
		await assert.rejects(finishLink({ ...o, preset }, h.deps), /--preset/);
		assert.deepEqual(h.calls, []);
	}
	const h = harness({ token: () => Response.json({ grant: sensitive[0], link: { ...link, preset: "" } }) });
	h.deps.readSecret = (_options, approved) => { assert.equal(approved.preset, "hermes"); return sensitive[2]; };
	await finishLink({ ...o, preset: "hermes" }, h.deps);
	const missing = harness({ token: () => Response.json({ grant: sensitive[0], link: { ...link, preset: "" } }) });
	await assert.rejects(finishLink(o, missing.deps), /--preset/);
	assert.equal(missing.calls.includes("connector"), false);
});

test("known errors give fixed local recovery and origin status codes remain visible", async () => {
	for (const [error, message] of Object.entries({ unauthorized: "login", invalid_request: "options", link_exists: "approval page", provision_failed: "cleanup", preset: "--preset", signing_secret: "signing-secret", unreadable: "Remove the secure link", unavailable: "retry later" })) {
		const h = harness({ requests: () => Response.json({ error, message: sensitive[0] }, { status: 400 }) });
		await assert.rejects(finishLink(o, h.deps), (err) => err.message.includes(message) && !err.message.includes(sensitive[0]));
	}
	for (const result of ["origin-404", "origin-500", "none", "tls", "private", "dns", "connection", "unreadable", "failed"]) {
		const h = harness({ "wake-test": () => Response.json({ result, saved: false }) });
		await assert.rejects(finishLink(o, h.deps), new RegExp(result));
	}
});


test("wake result diagnostics never echo arbitrary server text", async () => {
 const h = harness({ "wake-test": () => Response.json({ result: sensitive[0], saved: false }) });
 await assert.rejects(finishLink(o, h.deps), err => err.message.includes('(unknown)') && !err.message.includes(sensitive[0]));
});


test("create shows the public server apex guidance and requested hostname without requesting approval", async () => {
	const hostname = "example.com";
	const message = `Use a hostname under ${hostname}, such as wake.${hostname}. The domain itself is not a secure link.`;
	const h = harness({ requests: () => Response.json({ error: "invalid_request", message }, { status: 400 }) });
	h.deps.readSecret = () => assert.fail("must not read secrets on refusal");
	await assert.rejects(createLink({ ...o, ...plan, hostname }, h.deps), (err) => {
		assert.match(err.message, /^link create failed for example\.com \(invalid_request\)/);
		assert.ok(err.message.includes(message));
		assert.doesNotMatch(err.message, /setup|try again|run finish/);
		return true;
	});
	assert.deepEqual(h.calls, ["requests"]);
	assert.deepEqual(h.lines, []);
});

for (const [code, cause] of Object.entries({ apex_hostname: "domain itself", outside_zone: "not on a domain", existing_dns: "DNS record", existing_tunnel: "another tunnel" })) {
	for (const command of ["create", "finish"]) test(`${command} explains ${code} without leaking server text or transferring secrets`, async () => {
		const h = harness({ token: () => Response.json({ error: code, message: sensitive.join(" "), phase: sensitive[0] }, { status: 409 }) });
		h.deps.readSecret = () => assert.fail("must not read secrets on refusal");
		await assert.rejects((command === "create" ? createLink : finishLink)({ ...o, ...(command === "create" ? plan : {}) }, h.deps), (err) => {
			assert.ok(err.message.includes(code));
			assert.ok(err.message.includes(cause));
			assert.ok(err.message.startsWith(`link ${command} failed`));
			assert.doesNotMatch(err.message, /different link|try again|retry/);
			for (const secret of sensitive) assert.ok(!err.message.includes(secret));
			return true;
		});
		assert.deepEqual(h.calls, ["requests", "token"]);
		assert.deepEqual(h.writes, []);
		assert.deepEqual(h.runs, []);
	});
}

test("create refuses arbitrary validation text, terminal escapes, foreign apex domains and appended secrets", async () => {
	const apex = "Use a hostname under example.com, such as wake.example.com. The domain itself is not a secure link.";
	for (const message of [sensitive.join(" "), apex + sensitive[0], apex + "\n\x1b[2J", apex.replaceAll("example.com", "other.example"), { text: apex }]) {
		const h = harness({ requests: () => Response.json({ error: "invalid_request", message }, { status: 400 }) });
		await assert.rejects(createLink({ ...o, ...plan, hostname: "example.com" }, h.deps), (err) => {
			assert.match(err.message, /link create failed for example\.com/);
			assert.doesNotMatch(err.message, /other\.example|\x1b|domain itself/);
			return sensitive.every((secret) => !err.message.includes(secret));
		});
		assert.deepEqual(h.calls, ["requests"]);
	}
});

test("legacy ambiguous link_exists gives approval-page guidance without guessing its cause", async () => {
	const h = harness({ token: () => Response.json({ error: "link_exists", message: "A DNS record exists, then try again." }, { status: 409 }) });
	await assert.rejects(createLink({ ...o, ...plan }, h.deps), (err) => {
		assert.match(err.message, /approval page/);
		assert.doesNotMatch(err.message, /different link|try again|retry/);
		return true;
	});
	assert.deepEqual(h.calls, ["requests", "token"]);
});

for (const command of ["create", "finish"]) {
	for (const phase of ["requests", "token", "deadline"]) test(`${command} explains expired link requests at ${phase} with fixed recovery and no secret transfer`, async () => {
		const expired = () => Response.json({ error: "expired_token", message: sensitive.join(" "), secret: sensitive[0] }, { status: 410 });
		const h = harness(phase === "deadline" ? {
			token: () => Response.json({ error: "authorization_pending" }, { status: 428 }),
		} : { [phase]: expired });
		h.deps.readSecret = () => assert.fail("must not read secrets after expiry");
		await assert.rejects((command === "create" ? createLink : finishLink)({ ...o, ...(command === "create" ? plan : {}) }, h.deps), (err) => {
			assert.equal(err.message, `link ${command} failed${command === "create" ? " for wake.example.com" : ""} (expired_token); The link request expired. Start a new one with hosted link create.`);
			for (const secret of sensitive) assert.ok(!err.message.includes(secret));
			return true;
		});
		assert.ok(h.calls.every((endpoint) => ["requests", "token"].includes(endpoint)));
		assert.deepEqual(h.writes, []);
		assert.deepEqual(h.runs, []);
		for (const secret of sensitive) assert.ok(!h.lines.join("\n").includes(secret));
	});
}

// Response shapes from site a125621 (#415); all diagnostics remain local templates.
const siteRefusals = [
	[400, { error: "invalid_request", field: "hostname", reason: "outside_zone", message: "That hostname is not on a domain in your Cloudflare account. Use a hostname under example.net or example.org." }, /\(outside_zone\).*under example\.net or example\.org\./],
	[400, { error: "invalid_request", reason: "outside_zone", message: "That hostname is not on a domain in your Cloudflare account. Add a domain to Cloudflare, then run create again." }, /Add a domain to Cloudflare/],
	[400, { error: "invalid_request", reason: "apex_hostname", message: "Use a hostname under example.com, such as wake.example.com. The domain itself is not a secure link." }, /\(apex_hostname\).*domain itself/],
	[429, { error: "slow_down", message: "Too many pending requests for this agent. Deny an earlier request or wait for it to expire, then run create again." }, /\(slow_down\).*Deny an earlier request.*wait for it to expire/],
	[403, { error: "access_denied" }, /request was denied/],
	[410, { error: "expired_token" }, /link request expired.*Start a new one with hosted link create/],
	[409, { error: "link_not_ready" }, /Finish creating it in Wake settings/],
	[401, { error: "invalid_grant" }, /grant is not valid.*Run create again and approve/],
	[409, { error: "already_delivered" }, /already delivered.*fresh approval/],
	[409, { error: "connector_not_connected" }, /Start cloudflared with the saved token file/],
	[404, { error: "not_found" }, /not found.*Check --agent/],
	[503, { error: "cloudflare_unavailable" }, /Reconnect Cloudflare in Wake settings/],
	[409, { error: "unreadable" }, /access key could not be read.*Remove the secure link.*run create again/],
];
for (const [status, body, expected] of siteRefusals) {
	test(`site refusal ${body.reason || body.error} (${status}) gives specific recovery before any secret access`, async () => {
		const h = harness({ requests: () => Response.json(body, { status }) });
		h.deps.readSecret = () => assert.fail("must not read the signing secret");
		await assert.rejects(createLink({ ...o, ...plan, ...(body.reason === "apex_hostname" ? { hostname: "example.com" } : {}) }, h.deps), expected);
		assert.deepEqual(h.calls, ["requests"]);
		assert.deepEqual(h.writes, []);
		assert.deepEqual(h.lines, []);
	});
}

for (const [phase, status, expected] of [
	["tunnel", 401, /Reconnect Cloudflare.*run create again/],
	["access", 403, /Reconnect Cloudflare.*run create again/],
	["dns", 429, /Run create again in a few minutes/],
	["tunnel", 500, /Run create again in a few minutes/],
	["access", 503, /Run create again in a few minutes/],
	["unknown", 599, /Run create again in a few minutes/],
	["cleanup", 403, /Remove the unfinished secure link/],
	...["hostname", "zone", "existing_dns", "existing_tunnel"].map((phase) => [phase, null, /Choose another hostname/]),
	["unknown", null, /approval page.*cleanup state/],
	["unknown", "401", /approval page.*cleanup state/],
	["unknown", 600, /approval page.*cleanup state/],
]) test(`site provisioning phase ${phase}, status ${status} maps recovery without trusting message text`, async () => {
	const h = harness({ token: () => Response.json({ error: "provision_failed", phase, status, message: sensitive.join(" "), cleanup: sensitive[0] }, { status: 502 }) });
	h.deps.readSecret = () => assert.fail("must not read the signing secret");
	await assert.rejects(createLink({ ...o, ...plan }, h.deps), (err) => {
		assert.match(err.message, expected);
		assert.ok(sensitive.every((secret) => !err.message.includes(secret)));
		return true;
	});
	assert.deepEqual(h.calls, ["requests", "token"]);
	assert.deepEqual(h.writes, []);
	assert.deepEqual(h.runs, []);
});

test("outside-zone template rejects appended secrets, malformed domains and terminal escapes", async () => {
	const prefix = "That hostname is not on a domain in your Cloudflare account. Use a hostname under ";
	for (const suffix of ["example.net. " + sensitive[0], "example.net\n\x1b[2J.", "https://example.net.", "example.net or .", "example.net or private-grant."]) {
		const h = harness({ requests: () => Response.json({ error: "invalid_request", reason: "outside_zone", message: prefix + suffix }, { status: 400 }) });
		await assert.rejects(createLink({ ...o, ...plan }, h.deps), (err) => {
			assert.match(err.message, /\(outside_zone\).*Choose a hostname on your domain/);
			assert.doesNotMatch(err.message, /example\.net|\x1b|private-grant/);
			return true;
		});
	}
});

test("unknown or malformed reason falls back to the known error without echoing fields", async () => {
	for (const reason of [sensitive[0], ["outside_zone"], { value: "outside_zone" }, "toString", null]) {
		const h = harness({ requests: () => Response.json({ reason, error: "access_denied", message: sensitive[1] }, { status: 403 }) });
		await assert.rejects(finishLink(o, h.deps), (err) => {
			assert.match(err.message, /\(access_denied\).*request was denied.*Run finish again/);
			assert.ok(sensitive.every((secret) => !err.message.includes(secret)));
			return true;
		});
	}
});

for (const [raw, code, next] of [
	["none", "none", "Update the hosted Worker"],
	["dns-missing", "dns-missing", "Wait for DNS propagation"],
	["access-401", "access-401", "Check the signing secret and Access service-token pair"],
	["access-403", "access-403", "Check the signing secret and Access service-token pair"],
	["timeout", "timeout", "Retry later"],
	["origin-429", "origin-429", "Retry later"],
	["origin-500", "origin-500", "Retry later"],
	["origin-503", "origin-503", "Retry later"],
	["origin-404", "origin-404", "Check the receiver's HTTP response"],
	["301", "origin-301", "Check the receiver's HTTP response"],
	["103", "origin-103", "Check the receiver's HTTP response"],
	["tls", "tls", "Fix the receiver's TLS certificate"],
	["private", "private", "Use a public HTTPS wake URL"],
	["dns", "dns", "Check the wake hostname's DNS records"],
	["connection", "connection", "Check that the receiver is reachable"],
	["unreadable", "unreadable", "Remove the secure link on the website"],
	["failed", "failed", "Check the receiver configuration"],
	["unknown", "unknown", "Update the CLI (npx a2a-exposed@latest) and send feedback"],
	["ok", "unknown", "Update the CLI"],
	[null, "unknown", "Update the CLI"],
	[{}, "unknown", "Update the CLI"],
]) {
	test(`wake failure ${JSON.stringify(raw)} gives safe recovery and a machine-readable code`, async () => {
		const h = harness({ "wake-test": () => Response.json({ result: raw, saved: false, message: sensitive[0] }) });
		await assert.rejects(finishLink(o, h.deps), err => {
			assert.ok(err.message.startsWith(`wake test of the new secure link failed (${code}); saved wake settings were not changed. `));
			assert.ok(err.message.includes(next));
			assert.ok(!err.message.includes(sensitive[0]));
			return true;
		});
		assert.equal(h.lines.filter(line => line.startsWith("wake_result=")).join("\n"), `wake_result=${code}`);
		assert.ok(!h.lines.join("\n").includes(sensitive[0]));
	});
}

test("successful wake test emits a stable result", async () => {
	const h = harness();
	await finishLink(o, h.deps);
	assert.ok(h.lines.includes("wake_result=ok"));
});
