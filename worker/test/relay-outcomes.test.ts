import { test } from "node:test";
import assert from "node:assert/strict";
import { relayTestOutcome } from "../src/relay-routing.ts";

test("relay distinguishes backpressure and uncertain execution from service incompatibility", () => {
	for (const [wire, error] of [["connector_busy", "busy"], ["delivery_uncertain", "uncertain"]]) {
		assert.deepEqual(relayTestOutcome(new Response(null, { status: 502 }), { error: wire }), { status: null, error });
	}
	for (const error of ["unknown-private-details", "__proto__", "constructor", "toString"]) {
		assert.deepEqual(relayTestOutcome(new Response(null, { status: 502 }), { error }), { status: null, error: "unavailable" });
	}
	assert.deepEqual(relayTestOutcome(new Response(), { status: 204 }), { status: 204 });
});
