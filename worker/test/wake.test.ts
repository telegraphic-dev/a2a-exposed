// Run: npm test   (node --test, Node >= 22.18 native TypeScript type stripping)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { renderWake, renderTemplate, wakeSummary, redact, PRESETS, type WakeEvent } from "../src/wake.ts";

const ev: WakeEvent = {
	contextId: "ctx-1", taskId: "t-2", taskIds: ["t-1", "t-2"], from: "peer-a",
	preview: 'Please "do" X\nnow', kind: "inbound", publicUrl: "https://agent.example.com",
};

test("unconfigured wake is a no-op", async () => {
	assert.equal(await renderWake({ preset: "grok-bot" }, ev), null);
});

test("grok-bot: bearer + JSON payload", async () => {
	const r = (await renderWake({ preset: "grok-bot", url: "https://hook.example/x", key: "k1" }, ev))!;
	assert.equal(r.headers["authorization"], "Bearer k1");
	const b = JSON.parse(r.body);
	assert.deepEqual([b.contextId, b.taskId, b.from, b.kind], ["ctx-1", "t-2", "peer-a", "inbound"]);
	assert.deepEqual(b.taskIds, ["t-1", "t-2"]);
	assert.match(b.hint, /inbox --context ctx-1/);
});

test("claude-code: anthropic-version + text body", async () => {
	const r = (await renderWake({ preset: "claude-code", url: "https://api.anthropic.com/v1/claude_code/routines/trig_x/fire", key: "rt" }, ev))!;
	assert.equal(r.headers["anthropic-version"], "2023-06-01");
	assert.equal(r.headers["authorization"], "Bearer rt");
	const b = JSON.parse(r.body);
	assert.deepEqual(Object.keys(b), ["text"]);
	assert.match(b.text, /2 new messages from peer "peer-a"/);
	assert.match(b.text, /untrusted/);
});

test("openclaw-wake: no peer text, mode now, agentId", async () => {
	const r = (await renderWake({ preset: "openclaw-wake", url: "https://gw/hooks/wake", key: "h", agentId: "ops" }, ev))!;
	const b = JSON.parse(r.body);
	assert.equal(b.mode, "now"); assert.equal(b.agentId, "ops");
	assert.ok(!b.text.includes("Please"), "preview must not be included");
});

test("openclaw-agent: isolated, deliver false, idempotency key", async () => {
	const r = (await renderWake({ preset: "openclaw-agent", url: "https://gw/hooks/agent", key: "h" }, ev, { requestId: "rid-1" }))!;
	const b = JSON.parse(r.body);
	assert.equal(b.sessionMode, "isolated"); assert.equal(b.deliver, false); assert.equal(b.agentId, "main");
	assert.equal(r.headers["idempotency-key"], "rid-1");
	assert.ok(b.message.includes("peer-a"));
});

test("hermes: HMAC V2 over '<ts>.<body>' matches node:crypto", async () => {
	const now = 1_760_000_000_000;
	const r = (await renderWake({ preset: "hermes", url: "https://h:8644/webhooks/a2a", hmacSecret: "s3cret" }, ev, { nowMs: now, requestId: "r" }))!;
	const ts = r.headers["X-Webhook-Timestamp"];
	assert.equal(ts, String(now / 1000));
	const expect = createHmac("sha256", "s3cret").update(`${ts}.${r.body}`).digest("hex");
	assert.equal(r.headers["X-Webhook-Signature-V2"], expect);
	assert.equal(r.headers["x-request-id"], "r");
	assert.equal(JSON.parse(r.body).event_type, "a2a_wake");
	assert.equal(r.headers["authorization"], undefined);
});

test("generic: custom header/prefix + template with escaping", async () => {
	const tpl = '{"text":"{{from}}: {{preview}}","ids":{{taskIdsJson}},"raw":{{payload}}}';
	const r = (await renderWake({ preset: "generic", url: "https://n8n/webhook/x", key: "abc", keyHeader: "X-Api-Key", keyPrefix: "" , bodyTemplate: tpl }, ev))!;
	assert.equal(r.headers["x-api-key"], "abc");
	const b = JSON.parse(r.body);
	assert.equal(b.text, 'peer-a: Please "do" X\nnow');
	assert.deepEqual(b.ids, ["t-1", "t-2"]);
	assert.equal(b.raw.contextId, "ctx-1");
});

test("generic: invalid template throws", () => {
	assert.throws(() => renderTemplate('{"a": {{from}} }', ev, "cli"));
});

test("every preset renders valid JSON", async () => {
	for (const p of PRESETS) {
		const r = (await renderWake({ preset: p, url: "https://x/y", key: "k", hmacSecret: "s" }, ev))!;
		JSON.parse(r.body);
	}
});

test("redact masks credentials", async () => {
	const r = (await renderWake({ preset: "grok-bot", url: "https://hook/x", key: "supersecretkey" }, ev))!;
	assert.ok(!JSON.stringify(redact(r)).includes("supersecretkey"));
});

test("summary for outbound updates points at history", () => {
	assert.match(wakeSummary({ ...ev, kind: "outbound_update" }, "a2a"), /a2a history ctx-1/);
});

test("generic custom key header is rendered with prefix and redacted in previews", async () => {
	const ev: WakeEvent = { contextId: "c1", taskId: "t1", taskIds: ["t1"], from: "bob", preview: "hi", kind: "inbound", publicUrl: "https://agent.example.com" };
	const req = await renderWake({ preset: "generic", url: "https://hooks.example.com/abc", key: "supersecretvalue", keyHeader: "X-Api-Key", keyPrefix: "" }, ev);
	assert.ok(req);
	assert.equal(req.headers["x-api-key"], "supersecretvalue");
	const red = redact(req);
	assert.ok(!JSON.stringify(red).includes("supersecretvalue"));
});
