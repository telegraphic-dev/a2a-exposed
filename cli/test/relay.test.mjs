import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { localDestination, relayEndpoint, protectedToken, runConnector } from "../lib/relay.mjs";

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-config-"));
after(() => fs.rmSync(configDir, { recursive: true, force: true }));
const bin = new URL("../bin/a2a-exposed.mjs", import.meta.url);

test("relay has noninteractive help and refuses secret argv and missing choices", () => {
	const run = args => spawnSync(process.execPath, [bin.pathname, ...args], { encoding: "utf8", env: { ...process.env, A2A_CONFIG_DIR: configDir, DO_NOT_TRACK: "1" } });
	const help = run(["relay", "--help"]); assert.equal(help.status, 0); assert.match(help.stdout, /relay create --token-file/); assert.match(help.stdout, /relay run --local-url/);
	for (const args of [["relay", "run"], ["relay", "create"], ["relay", "run", "--token", "do-not-print-this"], ["relay", "unexpected"]]) {
		const result = run(args); assert.equal(result.status, 1); assert.equal((result.stdout + result.stderr).includes("do-not-print-this"), false);
	}
});

test("connector fixes authority to a loopback origin/path and excludes credential-bearing URLs", () => {
	assert.equal(localDestination("http://127.0.0.1:8644/fixed"), "http://127.0.0.1:8644/fixed");
	assert.equal(localDestination("http://[::1]:8644/fixed"), "http://[::1]:8644/fixed");
	for (const value of ["http://example.com/hook", "http://user:secret@127.0.0.1/hook", "http://127.0.0.1/hook?secret=x", "file:///etc/passwd", "http://127.0.0.1/hook#x"]) assert.throws(() => localDestination(value));
	assert.equal(relayEndpoint("wss://agent.example.com/relay/connect"), "wss://agent.example.com/relay/connect");
	for (const value of ["ws://agent.example.com/relay/connect", "wss://agent.example.com/relay/connect?token=secret", "wss://secret@agent.example.com/relay/connect", "wss://agent.example.com/owner"]) assert.throws(() => relayEndpoint(value));
});

test("connector credentials require protected regular files and refuse symlinks", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-"));
	try {
		const file = path.join(dir, "credential"); fs.writeFileSync(file, "dummy-token\n", { mode: 0o600 }); assert.equal(protectedToken(file), "dummy-token");
		fs.chmodSync(file, 0o644); assert.throws(() => protectedToken(file)); fs.chmodSync(file, 0o600);
		const link = path.join(dir, "symlink"); fs.symlinkSync(file, link); assert.throws(() => protectedToken(link));
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test("relay setup diagnostics never echo invalid URL values or filesystem paths", () => {
	const secret = "do-not-print-this";
	const base = ["relay", "run", "--token-env", "TEST_RELAY_TOKEN", "--local-url", "http://127.0.0.1/fixed"];
	for (const args of [[...base, "--url", secret.repeat(1000)], [...base, "--local-url", secret], ["relay", "run", "--local-url", "http://127.0.0.1/fixed", "--token-file", path.join(configDir, secret)], ["relay", "create", "--token-file", path.join(configDir, secret, "missing")]]) {
		const r = spawnSync(process.execPath, [bin.pathname, ...args], { encoding: "utf8", env: { ...process.env, A2A_CONFIG_DIR: configDir, DO_NOT_TRACK: "1", TEST_RELAY_TOKEN: "a2ar_" + "x".repeat(43) } });
		assert.equal(r.status, 1); assert.doesNotMatch(r.stdout + r.stderr, /do-not-print-this|a2ar_|network error/i);
		assert.ok(r.stderr.length < 500); assert.match(r.stderr, /URL|token file/);
	}
});

test("expired/skewed frames and a cancelled request clearing at capacity do not kill the connector", async () => {
	const Native = globalThis.WebSocket, originalFetch = globalThis.fetch;
	let ws, posts = 0; const results = [], releases = [];
	class Fake extends EventTarget {
		static OPEN = 1; readyState = 1;
		constructor() { super(); ws = this; }
		send(value) { results.push(JSON.parse(value)); }
		close() {}
		message(value) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
	}
	globalThis.WebSocket = Fake;
	globalThis.fetch = async () => { posts++; return await new Promise(resolve => releases.push(() => resolve(new Response(null, { status: 204 })))); };
	const stop = new AbortController();
	try {
		const running = runConnector({ url: "ws://127.0.0.1/relay/connect", localUrl: "http://127.0.0.1/fixed", token: "a2ar_" + "x".repeat(43), signal: stop.signal });
		ws.message({ v: 1, type: "hello", generation: 1 });
		const wake = (n, deadline) => ({ v: 1, type: "wake", generation: 1, id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, deadline, headers: {}, body: "{}" });
		ws.message(wake(0, Date.now() - 11000));
		assert.equal(results[0].status, 0); assert.equal(posts, 0);
		for (let n = 1; n <= 4; n++) ws.message(wake(n, Date.now() + 60000)); // clock behind: still bounded locally
		ws.message({ v: 1, type: "cancel", generation: 1, id: wake(1, 0).id });
		ws.message(wake(5, Date.now() + 10000)); // abort not yet settled
		assert.equal(posts, 4); assert.equal(results[1].status, 0);
		for (const release of releases) release(); await new Promise(resolve => setImmediate(resolve));
		ws.message(wake(6, Date.now() + 10000)); assert.equal(posts, 5);
		releases.at(-1)(); await new Promise(resolve => setImmediate(resolve));
		stop.abort(); await running;
	} finally { stop.abort(); globalThis.WebSocket = Native; globalThis.fetch = originalFetch; }
});

test("wake unset in relay mode refuses before deleting application credentials", () => {
	const result = spawnSync(process.execPath, [bin.pathname, "wake", "unset"], { encoding: "utf8", env: { ...process.env, A2A_CONFIG_DIR: configDir, DO_NOT_TRACK: "1", WAKE_TRANSPORT: "relay" } });
	assert.equal(result.status, 1); assert.match(result.stderr, /relay mode: use relay revoke/);
});
