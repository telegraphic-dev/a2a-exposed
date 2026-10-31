import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
	await waitForTermination(job);

});

test("an unexpected registration prompt times out instead of leaving the relay open", { skip: process.platform === "win32", timeout: 5000 }, async () => {
	await assert.rejects(deployWithRegistration("/bin/sh", ["-c", 'printf "unexpected prompt\\n"; exec /bin/sleep 30'], "example", {
		env: { PATH: "/usr/bin:/bin" }, idleMs: 150,
	}), /stopped responding/);
});

async function waitForTermination(pid) {
	const deadline = Date.now() + 2000;
	while (true) {
		try { process.kill(pid, 0); }
		catch (error) { assert.equal(error.code, "ESRCH"); return; }
		// Orphaned jobs can remain defunct under a container PID 1 that does
		// not reap. A zombie has terminated and cannot continue deployment.
		const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
		assert.ifError(state.error);
		if (state.stdout.trim().startsWith("Z")) return;
		assert.ok(Date.now() < deadline, "terminal job survived relay shutdown");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	test(`parent ${signal} shuts down the detached terminal job`, { skip: process.platform === "win32", timeout: 8000 }, async (t) => {
		const fixture = `
			import { spawnScript } from ${JSON.stringify(new URL("../lib/script.mjs", import.meta.url).href)};
			const child = spawnScript(${JSON.stringify(args('printf "job:%s\\n" "$$"; exec /bin/sleep 30'))});
			console.log("relay:" + child.pid);
			child.stdout.pipe(process.stdout);
			child.stderr.pipe(process.stderr);
		`;
		const parent = spawn(process.execPath, ["--input-type=module", "-e", fixture], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "", relay, job;
		t.after(() => {
			parent.kill("SIGKILL");
			if (relay) { try { process.kill(-relay, "SIGKILL"); } catch {} }
		});
		parent.stdout.on("data", (data) => {
			out += data;
			relay = Number(/relay:(\d+)/.exec(out)?.[1]) || relay;
			const match = /job:(\d+)/.exec(out);
			if (!job && match) { job = Number(match[1]); parent.kill(signal); }
		});
		parent.stderr.resume();
		const [code, receivedSignal] = await once(parent, "close");
		assert.equal(code, null);
		assert.equal(receivedSignal, signal);
		assert.ok(job);
		await waitForTermination(job);
	});
}

test("terminal completion removes parent shutdown listeners", { skip: process.platform === "win32", timeout: 5000 }, async () => {
	const signals = ["SIGINT", "SIGTERM", "SIGHUP", "exit"];
	const before = signals.map((signal) => process.listenerCount(signal));
	const child = spawnScript(args("exit 0"));
	child.stdout.resume(); child.stderr.resume();
	await once(child, "close");
	assert.deepEqual(signals.map((signal) => process.listenerCount(signal)), before);
});
