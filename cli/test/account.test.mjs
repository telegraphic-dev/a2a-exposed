import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnv } from "../lib/config.mjs";
import { CLI_CLIENT_ID, DEVICE_GRANT, controlOrigin, deviceLogin } from "../lib/account.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "a2a-exposed.mjs");

test("control origin is an https origin with no path", () => {
	assert.equal(controlOrigin("https://control.example"), "https://control.example");
	assert.equal(controlOrigin("https://control.example/"), "https://control.example");
	assert.equal(controlOrigin("http://control.example"), "");
	assert.equal(controlOrigin("https://user:secret@control.example"), "");
	assert.equal(controlOrigin("https://control.example/app"), "");
});

test("login stores the session and does not print it", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-account-"));
	const lines = [];
	let polls = 0;
	const token = "session-token-value";
	const fetchImpl = async (url, init = {}) => {
		const pathName = new URL(url).pathname;
		if (pathName.endsWith("/device/code")) {
			assert.equal(JSON.parse(init.body).client_id, CLI_CLIENT_ID);
			return Response.json({
				device_code: "device", user_code: "ABCD2345",
				verification_uri: "https://control.example/app/device",
				verification_uri_complete: "https://control.example/app/device?user_code=ABCD2345",
				expires_in: 60, interval: 1,
			});
		}
		if (pathName.endsWith("/device/token")) {
			const body = JSON.parse(init.body);
			assert.equal(body.grant_type, DEVICE_GRANT);
			assert.equal(body.client_id, CLI_CLIENT_ID);
			polls += 1;
			if (polls === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
			return Response.json({ access_token: token, token_type: "Bearer", expires_in: 3600, scope: "" });
		}
		assert.equal(pathName.endsWith("/get-session"), true);
		assert.equal(init.headers.authorization, `Bearer ${token}`);
		return Response.json({ user: { email: "person@example.com" } });
	};
	process.env.A2A_POLL_SCALE = "0.001";
	try {
		const result = await deviceLogin({
			controlUrl: "https://control.example",
			intent: "signup",
			fetchImpl,
			sleep: async () => {},
			write: (line) => lines.push(line),
			save: (updates) => {
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(path.join(dir, "config.env"), Object.entries(updates).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { mode: 0o600 });
			},
		});
		assert.equal(result.email, "person@example.com");
		const saved = parseEnv(fs.readFileSync(path.join(dir, "config.env"), "utf8"));
		assert.equal(saved.CONTROL_URL, "https://control.example");
		assert.equal(saved.CONTROL_TOKEN, token);
		assert.equal(lines.join("\n").includes(token), false);
		assert.match(lines.join("\n"), /ABCD2345/);
		assert.match(lines.join("\n"), /Create an account/);
	} finally {
		delete process.env.A2A_POLL_SCALE;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("login help names the callback error", async () => {
	const child = spawn(process.execPath, [BIN, "--help"], {
		env: { ...process.env, A2A_NO_UPDATE_CHECK: "1" },
	});
	let stdout = "";
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	const status = await new Promise((resolve) => child.on("close", resolve));
	assert.equal(status, 0);
	assert.match(stdout, /\/app\?error=<code>/);
	assert.match(stdout, /oauth_callback_failed/);
});

test("login refuses a control URL that is not https", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-account-"));
	const env = { ...process.env, A2A_CONFIG_DIR: dir, A2A_NO_UPDATE_CHECK: "1" };
	const child = spawn(process.execPath, [BIN, "login", "--control-url", "http://control.example"], { env });
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const status = await new Promise((resolve) => child.on("close", resolve));
	assert.notEqual(status, 0);
	assert.match(stderr, /https origin/);
	fs.rmSync(dir, { recursive: true, force: true });
});
