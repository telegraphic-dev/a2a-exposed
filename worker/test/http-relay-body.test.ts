import { test } from "node:test";
import assert from "node:assert/strict";
import { readHttpRelayBody } from "../src/http-relay-body.ts";

test("upload timeout wins native cancellation EOF and never returns a valid-looking prefix", async () => {
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"valid":"but upload unfinished"}')); }, cancel() { cancelled = true; } });
	const request = new Request("https://relay.example.com/forward", { method: "POST", body, duplex: "half" } as RequestInit);
	await assert.rejects(readHttpRelayBody(request, { requestBytes: 256, headerMs: 20 }), /^Error: timeout$/);
	assert.equal(cancelled, true);
});

test("bounded reader preserves completed bytes and rejects oversize or failed uploads", async () => {
	const bytes = new Uint8Array([0, 255, 128, 13, 10]);
	assert.deepEqual(await readHttpRelayBody(new Request("https://relay.example.com", { method: "POST", body: bytes }), { requestBytes: 5, headerMs: 50 }), bytes);
	await assert.rejects(readHttpRelayBody(new Request("https://relay.example.com", { method: "POST", body: bytes }), { requestBytes: 4, headerMs: 50 }), /^Error: size$/);
	const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); }, pull(c) { c.error(new Error("failed upload")); } });
	await assert.rejects(readHttpRelayBody(new Request("https://relay.example.com", { method: "POST", body, duplex: "half" } as RequestInit), { requestBytes: 5, headerMs: 50 }), /failed upload/);
});
