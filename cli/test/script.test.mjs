import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawnScript, stopScript } from "../lib/script.mjs";
import { deployWithRegistration } from "../lib/workersdev.mjs";

const args = (command, rest = []) => process.platform === "darwin"
	? ["-q", "/dev/null", "/bin/sh", "-c", command, "test-command", ...rest]
	: ["-qec", command, "/dev/null"];

test("script accepts interactive answers and exits without waiting for the caller to close stdin", { skip: process.platform === "win32", timeout: 5000 }, async (t) => {
	const child = spawnScript(args('printf "ready\\n"; IFS= read -r answer; [ "$answer" = dummy ] || exit 8; printf "done\\n"; exit 7'));
	t.after(() => stopScript(child, "SIGKILL"));
	let out = "", sent = false;
	child.stdout.on("data", (data) => {
		out += data;
		if (!sent && out.includes("ready")) { sent = true; child.stdin.write("dummy\n"); }
	});
	let error = ""; child.stderr.on("data", (data) => { error += data; });
	const [code] = await once(child, "close");
	assert.equal(code, 7, error);
	assert.match(out, /done/);
	assert.equal(error, "");
});

test("macOS relay preserves argument boundaries without shell evaluation", { skip: process.platform !== "darwin", timeout: 5000 }, async (t) => {
	const literal = 'spaces; $(printf should-not-run) "quoted"';
	const child = spawnScript(args('printf "%s" "$1"', [literal]));
	t.after(() => stopScript(child, "SIGKILL"));
	let out = ""; child.stdout.on("data", (data) => { out += data; });
	const [code] = await once(child, "close");
	assert.equal(code, 0);
	assert.equal(out, literal);
});

test("stopping the relay closes the terminal job too", { skip: process.platform === "win32", timeout: 5000 }, async (t) => {
	const child = spawnScript(args('printf "job:%s\\n" "$$"; exec /bin/sleep 30'));
	t.after(() => stopScript(child, "SIGKILL"));
	let out = "", job;
	child.stdout.on("data", (data) => {
		out += data;
		const match = /job:(\d+)/.exec(out);
		if (!job && match) { job = Number(match[1]); stopScript(child); }
	});
	await once(child, "close");
	assert.ok(job);
	// Kernel hangup of the PTY job can finish just after the relay closes.
	const deadline = Date.now() + 1000;
	while (true) {
		try { process.kill(job, 0); }
		catch (error) { assert.equal(error.code, "ESRCH"); break; }
		assert.ok(Date.now() < deadline, "terminal job survived relay shutdown");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
});

test("an unexpected registration prompt times out instead of leaving the relay open", { skip: process.platform === "win32", timeout: 5000 }, async () => {
	await assert.rejects(deployWithRegistration("/bin/sh", ["-c", 'printf "unexpected prompt\\n"; exec /bin/sleep 30'], "example", {
		env: { PATH: "/usr/bin:/bin" }, idleMs: 150,
	}), /stopped responding/);
});
