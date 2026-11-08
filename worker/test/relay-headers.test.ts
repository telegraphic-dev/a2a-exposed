import { test } from "node:test";
import assert from "node:assert/strict";
import { relayHeadersValid } from "../src/wake.ts";

// Node's native connector uses WebIDL ByteString for HTTP header values.
// Reject values here before a trusted configuration can kill that connector.
test("relay forwarding headers match native ByteString constraints", () => {
	for (const value of ["Bearer \u0100", "Bearer \ud83d\udd12", "Bearer \ud800"]) {
		assert.throws(() => new Headers({ authorization: value }), TypeError);
		assert.equal(relayHeadersValid({ authorization: value }), false);
	}
	for (const value of ["Bearer ascii", "Bearer \u00ff"]) {
		assert.doesNotThrow(() => new Headers({ authorization: value }));
		assert.equal(relayHeadersValid({ authorization: value }), true);
	}
});
