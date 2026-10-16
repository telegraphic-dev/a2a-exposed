import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_REPLAY_WINDOW_S, pairingEventConfig, verifyEventSignature } from "../src/tenants/events.ts";

test("verifyEventSignature checks the timestamp window in constant time on the signature", async () => {
	const secret = "event-secret";
	const body = "{\"type\":\"pairing_requested\"}";
	const now = 1_700_000_000_000;
	const timestamp = String(Math.floor(now / 1000));
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
	const signature = `sha256=${[...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
	const headers = { "X-A2A-Timestamp": timestamp, "X-A2A-Signature": signature };
	assert.equal(await verifyEventSignature(body, headers, secret, now), true);
	assert.equal(await verifyEventSignature(body, headers, secret, now - EVENT_REPLAY_WINDOW_S * 1000), true);
	assert.equal(await verifyEventSignature(body, headers, secret, now - (EVENT_REPLAY_WINDOW_S + 1) * 1000), false);
	assert.equal(await verifyEventSignature(body, { ...headers, "X-A2A-Signature": signature.slice(0, -1) + (signature.endsWith("0") ? "1" : "0") }, secret, now), false);
	assert.equal(await verifyEventSignature(body, headers, "", now), false);
	assert.equal(EVENT_REPLAY_WINDOW_S, 300);
});

test("pairingEventConfig keeps an https URL and a secret, and drops a partial pair", () => {
	const page = "https://example.com/api/agent-events";
	assert.deepEqual(pairingEventConfig(`  ${page}  `, "  secret  "), { EVENT_URL: page, EVENT_SECRET: "secret" });
	assert.equal(pairingEventConfig("http://example.com/api", "secret"), null);
	assert.equal(pairingEventConfig(page, ""), null);
	assert.equal(pairingEventConfig(page, "bad\nsecret"), null);
	assert.equal(pairingEventConfig("https://user:pw@example.com/api", "secret"), null);
});
