import { test } from "node:test";
import assert from "node:assert/strict";
import { checkWake } from "../lib/deploy.mjs";

test("wake check requires auth refusal before signed delivery and does not claim execution", async t => {
	const old = process.env.WAKE_PRESET;
	process.env.WAKE_PRESET = "hermes";
	t.after(() => { if (old === undefined) delete process.env.WAKE_PRESET; else process.env.WAKE_PRESET = old; process.exitCode = 0; });
	let calls = 0;
	const callOwner = async (method, path) => { calls++; assert.equal(method, "POST"); assert.equal(path, "/owner/wake/test"); return { status: 202 }; };
	for (const status of [200, 302, 404, 500, 401, 403]) {
		calls = 0; process.exitCode = 0;
		await checkWake({ "local-url": "http://127.0.0.1:8644/webhooks/a2a-wake" }, {
			request: async (url, init) => {
				assert.equal(init.redirect, "manual");
				assert.equal(new Headers(init.headers).get("X-Webhook-Signature-V2"), null);
				assert.equal(JSON.parse(init.body).kind, "test");
				return new Response("private body must never be printed", { status });
			}, callOwner,
		});
		assert.equal(calls, [401, 403].includes(status) ? 1 : 0);
		assert.equal(process.exitCode, [401, 403].includes(status) ? 0 : 1);
	}
	process.exitCode = 0;
	await checkWake({ "local-url": "http://localhost/webhooks/x" }, { request: async () => new Response(null, { status: 401 }), callOwner: async () => ({ status: 503 }) });
	assert.equal(process.exitCode, 1);
	process.exitCode = 0;
	for (const url of ["https://example.com/x", "http://127.0.0.1/x?secret=oops", "http://u:p@localhost/x"]) {
		await assert.rejects(checkWake({ "local-url": url }, { request: () => assert.fail("no network") }), /loopback/);
	}
	await assert.rejects(checkWake({}, { request: async () => { throw new Error("private failure"); } }), /could not reach/);
});
