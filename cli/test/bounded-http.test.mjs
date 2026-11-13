import { test } from "node:test";
import assert from "node:assert/strict";
import { httpJson } from "../lib/a2a.mjs";

test("encrypted HTTP reads refuse redirects and cap dishonest or undeclared streamed bodies", async t => {
 const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
 let cancelled = false, delivered = 0;
 globalThis.fetch = async (_url, init) => {
  assert.equal(init.redirect, "error");
  return new Response(new ReadableStream({
   pull(controller) { delivered++; controller.enqueue(new Uint8Array(9)); },
   cancel() { cancelled = true; },
  }), { headers: { "content-length": "1" } });
 };
 await assert.rejects(httpJson("https://peer.example.com", { redirect: "error", maxResponseBytes: 16 }), /too large/);
 assert.equal(cancelled, true); assert.ok(delivered <= 4, "stop reading the oversized stream promptly");
 globalThis.fetch = async () => new Response("{}", { headers: { "content-length": "999" } });
 await assert.rejects(httpJson("https://peer.example.com", { maxResponseBytes: 16 }), /too large/);
 globalThis.fetch = async () => new Response('{"ok":true}');
 assert.deepEqual((await httpJson("https://peer.example.com", { maxResponseBytes: 16 })).data, { ok: true });
});
