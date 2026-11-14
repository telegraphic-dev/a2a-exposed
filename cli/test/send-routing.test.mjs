// --wake and --intent become message metadata. Invalid values fail before a request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeFields, routingMetadata } from "../lib/commands.mjs";

test("routing metadata is omitted unless wake or intent is set", () => {
	assert.equal(routingMetadata(undefined, undefined), undefined);
	assert.equal(routingMetadata("", ""), undefined);
	assert.deepEqual(routingMetadata("never", undefined), { "a2a.exposed/wake": "never" });
	assert.deepEqual(routingMetadata(undefined, "ack"), { "a2a.exposed/intent": "ack" });
	assert.deepEqual(routingMetadata("auto", "status"), { "a2a.exposed/wake": "auto", "a2a.exposed/intent": "status" });
});

test("routing metadata rejects an unknown wake or intent", () => {
	assert.throws(() => routingMetadata("later", "question"), /--wake must be auto, always, never/);
	assert.throws(() => routingMetadata("always", "ping"), /--intent must be handoff, blocker, question, status, ack/);
});

test("reply route fields stay optional and use the same checks as send (#401)", () => {
	assert.deepEqual(routeFields(undefined, undefined), {});
	assert.deepEqual(routeFields("", ""), {});
	assert.deepEqual(routeFields("auto", "handoff"), { wake: "auto", intent: "handoff" });
	assert.throws(() => routeFields("later", undefined), /--wake must be auto, always, never/);
	assert.throws(() => routeFields(undefined, "ping"), /--intent must be handoff, blocker, question, status, ack/);
});
