import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { localDestination, relayEndpoint, protectedToken } from "../lib/relay.mjs";

const bin = new URL("../bin/a2a-exposed.mjs", import.meta.url);

test("relay has noninteractive help and refuses secret argv and missing choices", () => {
	const run = args => spawnSync(process.execPath, [bin.pathname, ...args], { encoding: "utf8", env: { ...process.env, DO_NOT_TRACK: "1" } });
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
