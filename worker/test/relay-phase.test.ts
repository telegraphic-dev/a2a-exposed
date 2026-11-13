import { test } from "node:test";
import assert from "node:assert/strict";
import { relayPhase } from "./relay-phase.ts";

test("a stalled SDK iterator fails at its phase instead of blocking fixture cleanup", async () => {
	const phases: string[] = [];
	await assert.rejects(async () => {
		try {
			await relayPhase("abort: SDK iterator settlement", new Promise(() => {}), 10, () => "completed=2, aborted=1");
		} finally {
			await relayPhase("fixture shutdown", Promise.resolve().then(() => { phases.push("closed"); }), 1000);
		}
	}, /abort: SDK iterator settlement timed out after 10ms; completed=2, aborted=1/);
	assert.deepEqual(phases, ["closed"]);
});

test("phase bounds preserve application failures and successful results", async () => {
	const error = new Error("application event missing");
	await assert.rejects(relayPhase("first event", Promise.reject(error), 1000), e => e === error);
	assert.equal(await relayPhase("completion", Promise.resolve(42), 1000), 42);
});
