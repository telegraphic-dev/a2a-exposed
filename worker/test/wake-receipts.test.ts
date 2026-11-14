import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { d1 } from "./d1.ts";
import { hmacSha256Hex } from "../src/wake.ts";
import { sha256, publicTask } from "../src/a2a.ts";
import { beginReceipt, RECEIPT_META, RECEIPT_TTL, reportReceipt } from "../src/wake-receipts.ts";

const BASE = "https://agent.example.com";
async function fixture(t: any, httpStatus = 202) {
 const env: any = { DB: d1(new URL("../migrations/", import.meta.url)), PUBLIC_URL: BASE, OWNER_TOKEN: "test-owner", WAKE_PRESET: "openbot", WAKE_HMAC_SECRET: "test-hmac", WAKE_WEBHOOK_URL: "https://hook.example.net/wake", WAKE_DEBOUNCE_SECONDS: "0", WAKE_BUSY_SECONDS: "0" };
 for (const label of ["ada", "bob"]) await env.DB.prepare("INSERT INTO peers(label,token_hash,created_at) VALUES (?,?,?)").bind(label, await sha256(label), new Date().toISOString()).run();
 const sent: any[] = [];
 const original = globalThis.fetch;
 globalThis.fetch = (async (_url: any, init: any) => { sent.push(init); return new Response(null, { status: httpStatus }); }) as typeof fetch;
 t.after(() => { globalThis.fetch = original; });
 const call = async (method: string, path: string, body?: any, token = "test-owner") => {
  const pending: Promise<unknown>[] = [];
  const res = await worker.fetch(new Request(BASE + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env,
   { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as any);
  await Promise.all(pending);
  return { status: res.status, data: method === "HEAD" ? null : await res.json() as any };
 };
 const rpc = async (method: string, params: any, token = "ada") => (await call("POST", "/", { jsonrpc: "2.0", id: 1, method, params }, token)).data;
 const send = async (messageId: string, taskId?: string, metadata?: any) => {
  const r = await rpc("message/send", { message: { kind: "message", role: "user", messageId, contextId: "same-context", ...(taskId ? { taskId } : {}), parts: [{ kind: "text", text: "PRIVATE-CONTENT" }] }, ...(metadata ? { metadata } : {}) });
  assert.ok(r.result?.id, JSON.stringify(r)); return r.result.id;
 };
 return { env, call, rpc, send, sent };
}

test("2xx stays acceptance only; owner reports independent stages, peer access stays isolated", async t => {
 const f = await fixture(t), task = await f.send("message-1", undefined, { [RECEIPT_META]: { reports: { ownerNotifiedAt: "forged" } } });
 const req = f.sent[0], id = req.headers["x-a2a-wake-receipt-id"];
 assert.match(id, /^[a-f0-9-]{36}$/);
 assert.equal(JSON.parse(req.body).data.receipt.id, id);
 const list = await f.call("GET", "/owner/wake/receipts");
 assert.equal(list.status, 200);
 const receipt = list.data.receipts[0];
 assert.equal(receipt.httpAccepted, true);
 assert.deepEqual(receipt.reports, { signatureVerifiedAt: null, handlerRanAt: null, ownerNotifiedAt: null });
 assert.doesNotMatch(JSON.stringify(list.data), /PRIVATE-CONTENT|test-hmac|hook.example.net/);
 for (const token of ["wrong", "ada", "bob"]) {
  assert.equal((await f.call("GET", "/owner/wake/receipts", undefined, token)).status, 401);
  assert.equal((await f.call("POST", `/owner/wake/receipts/${id}`, { stage: "handler-ran" }, token)).status, 401);
 }
 assert.equal((await f.call("POST", `/owner/wake/receipts/${id}`, { stage: "handler-ran" })).status, 200);
 const read = (await f.rpc("GetTask", { id: task })).result;
 const report = read.metadata[RECEIPT_META];
 assert.equal(report.reports.signatureVerifiedAt, null);
 assert.ok(report.reports.handlerRanAt);
 assert.equal(report.reports.ownerNotifiedAt, null);
 assert.equal(report.authentication, "inbox-owner");
 assert.equal((await f.rpc("tasks/get", { id: task }, "bob")).error.code, -32001);
 assert.equal((await f.call("GET", "/owner/inbox")).data[0].wakeReceipt.id, id);
 // Idempotence preserves the first timestamp and history row.
 await f.call("POST", `/owner/wake/receipts/${id}`, { stage: "handler-ran" });
 const again = (await f.rpc("tasks/get", { id: task })).result.metadata[RECEIPT_META];
 assert.deepEqual(again.reports, report.reports);
 const history = (await f.call("GET", "/owner/history/same-context?from=ada")).data;
 assert.equal(history.filter((r: any) => r.event === "wake-receipt").length, 1);
 assert.equal(history.find((r: any) => r.event === "wake-receipt").data.wakeReceipt.stage, "handler-ran");
});

test("expired/unknown receipts and extra fields fail; late reports cannot certify a continuation", async t => {
 const f = await fixture(t), task = await f.send("first");
 const id = f.sent[0].headers["x-a2a-wake-receipt-id"];
 for (const body of [{ stage: "all" }, { stage: "owner-notified", note: "PRIVATE" }, { stage: "handler-ran", at: new Date().toISOString() }])
  assert.equal((await f.call("POST", `/owner/wake/receipts/${id}`, body)).status, 400);
 assert.equal((await f.call("POST", "/owner/wake/receipts/00000000-0000-0000-0000-000000000000", { stage: "handler-ran" })).status, 409);
 await f.env.DB.prepare("UPDATE wake_receipts SET expires_ms=0 WHERE delivery_id=?").bind(id).run();
 assert.equal((await f.call("POST", `/owner/wake/receipts/${id}`, { stage: "owner-notified" })).status, 409);
 assert.equal((await f.rpc("tasks/get", { id: task })).result.metadata[RECEIPT_META].expired, true);
 await f.send("second", task);
 const latest = (await f.rpc("tasks/get", { id: task })).result.metadata[RECEIPT_META];
 assert.equal(latest.messageId, "second");
 assert.notEqual(latest.id, id);
 assert.equal(latest.reports.ownerNotifiedAt, null);
});

test("listing and HEAD do not flush wakes; unavailable receipt storage leaves messaging usable", async t => {
 const f = await fixture(t);
 await f.env.DB.prepare("INSERT INTO wakes(context_id,peer,last_sent_ms,pending_json,pending_since_ms) VALUES (?,?,?,?,?)").bind("pending", "ada", 0, JSON.stringify({ kind: "inbound", from: "ada", contextId: "pending", taskIds: [], taskId: "none" }), 0).run();
 for (const method of ["GET", "HEAD"]) assert.equal((await f.call(method, "/owner/wake/receipts")).status, 200);
 assert.equal(f.sent.length, 0);
 assert.ok((await f.env.DB.prepare("SELECT pending_json FROM wakes WHERE context_id='pending'").first()).pending_json);
 // Receipt diagnostics are optional: storage failure must not prevent task reads or add sends.
 await f.env.DB.prepare("DELETE FROM wakes").run();
 await f.env.DB.prepare("DROP TABLE wake_receipts").run();
 const task = await f.send("storage-failure");
 assert.equal((await f.rpc("tasks/get", { id: task })).result.id, task);
 assert.equal(f.sent.length, 1);
 assert.equal(f.sent[0].headers["x-a2a-wake-receipt-id"], undefined);
 // No report for encrypted pairings, test wakes or another peer's task.
 assert.equal(await beginReceipt(f.env.DB, { kind: "test", taskIds: ["anything"] }), undefined);
});

test("batched receipts bind each task, expire after a day, and cleanup is lazy at seven days", async t => {
 const f = await fixture(t), a = await f.send("a"), b = await f.send("b");
 const now = Date.now();
 const ref = await beginReceipt(f.env.DB, { kind: "inbound", from: "ada", contextId: "same-context", taskIds: [a, b] }, now);
 assert.ok(ref);
 assert.equal(Date.parse(ref.expiresAt), now + RECEIPT_TTL);
 assert.equal(await reportReceipt(f.env.DB, ref.id, "owner-notified", now + RECEIPT_TTL), false);
 const saved = (await f.env.DB.prepare("SELECT * FROM wake_receipts WHERE delivery_id=?").bind(ref.id).all()).results;
 assert.equal(saved.length, 2);
 assert.equal(await beginReceipt(f.env.DB, { kind: "inbound", from: "bob", contextId: "same-context", taskIds: [a] }), undefined);
 await f.env.DB.prepare("UPDATE peers SET sealed_requester='{}' WHERE label='ada'").run();
 assert.equal(await beginReceipt(f.env.DB, { kind: "inbound", from: "ada", contextId: "same-context", taskIds: [a] }), undefined);
});


test("an HTTP failure can coexist with a receiver report; no old report binds a new message", async t => {
 const f = await fixture(t, 500), task = await f.send("old-message");
 const first = f.sent[0], id = first.headers["x-a2a-wake-receipt-id"];
 assert.equal(first.headers["x-openbot-signature"], `sha256=${await hmacSha256Hex("test-hmac", `${first.headers["x-openbot-timestamp"]}.${id}.${first.body}`)}`);
 await f.call("POST", `/owner/wake/receipts/${id}`, { stage: "signature-verified" });
 const before = (await f.rpc("tasks/get", { id: task })).result.metadata[RECEIPT_META];
 assert.equal(before.httpAccepted, false);
 assert.equal(before.httpStatus, 500);
 assert.ok(before.reports.signatureVerifiedAt);
 assert.equal(before.reports.handlerRanAt, null);
 await f.send("new-message", task);
 await f.call("POST", `/owner/wake/receipts/${id}`, { stage: "owner-notified" });
 const after = (await f.rpc("tasks/get", { id: task })).result.metadata[RECEIPT_META];
 assert.equal(after.messageId, "new-message");
 assert.equal(after.reports.ownerNotifiedAt, null);
 assert.equal(f.sent.length, 2);
 const forged = publicTask({ id: "task", metadata: { [RECEIPT_META]: { ownerNotified: true }, keep: "value" }, status: { state: "submitted" } }, "0.3");
 assert.deepEqual(forged.metadata, { keep: "value" });
});
