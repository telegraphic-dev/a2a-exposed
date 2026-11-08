import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HTTP_RELAY_PROTOCOL_VERSION, HTTP_RELAY_CAPABILITIES } from "../src/core/http-relay-metadata.ts";

test("HTTP relay core metadata is explicit and class export uses a Worker-only subpath", () => {
	assert.equal(HTTP_RELAY_PROTOCOL_VERSION, 2);
	assert.deepEqual(HTTP_RELAY_CAPABILITIES, ["http-response-v1", "response-stream-v1"]);
	assert.equal(Object.isFrozen(HTTP_RELAY_CAPABILITIES), true);
	const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
	assert.equal(pkg.exports["./http-relay"].import, "./dist/http-relay.js");
	assert.equal(pkg.exports["./http-relay"].types, "./dist/types/control/src/core/http-relay.d.ts");
	const main = readFileSync(new URL("../src/core/index.ts", import.meta.url), "utf8");
	assert.match(main, /HTTP_RELAY_PROTOCOL_VERSION, HTTP_RELAY_CAPABILITIES/);
	assert.doesNotMatch(main, /export.*\bHttpRelay\b/);
	const subpath = readFileSync(new URL("../src/core/http-relay.ts", import.meta.url), "utf8");
	assert.match(subpath, /export \{ HttpRelay,/);
});
