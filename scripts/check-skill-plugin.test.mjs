import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { statusLabels } from "./check-skill-plugin.mjs";

test("status label scan ignores ordinary prose", () => {
	assert.deepEqual(statusLabels("Leave existing settings as they are."), []);
	assert.deepEqual(statusLabels("an optional tested configuration version"), []);
	assert.deepEqual(statusLabels("in testing the login, wait for the code"), []);
});

test("status label scan catches product badges", () => {
	for (const sample of [
		"This flow is tested end to end.",
		"(in testing)",
		"staging-only",
		"awaiting staging verification",
		"awaiting staging testing",
		"untested",
		"(not tested)",
		"pending verification",
		"experimental",
		"(beta)",
		"awaiting staging end-to-end verification",
		"awaiting end-to-end testing",
		"staging end-to-end verification is pending",
		"mocked tests do not establish client support",
		"`hosted link finish` (untested)",
		"mark the client `in testing`",
		"mark the client `untested`",
		"Other clients are untested on this address.",
		"Codex remain untested.",
		"| OpenClaw | untested | install |",
	]) assert.ok(statusLabels(sample).length, sample);
});

test("the repository check passes", () => {
	const script = path.join(import.meta.dirname, "check-skill-plugin.mjs");
	const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr || result.stdout);
});
