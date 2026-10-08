// Run: npm test   (node --test, Node >= 22.18 native TypeScript type stripping)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { renderWake, renderTemplate, wakeSummary, redact, addAccessHeaders, cloudflareErrorHint, PRESETS, type WakeEvent } from "../src/wake.ts";

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

// ---------------------------------------------------------------- Cloudflare Access service token (tunnel wakes)
const ACCESS = { accessClientId: "abc123.access", accessClientSecret: "s3cr3t-value-0123456789" };

test("Access service-token headers are added for every preset, next to the preset's own auth", async () => {
	for (const preset of PRESETS) {
		const r = (await renderWake({ preset, url: "https://wake-x.example.com/hooks/wake", key: "k1", hmacSecret: "h1", ...ACCESS }, ev))!;
		assert.equal(r.headers["CF-Access-Client-Id"], "abc123.access", preset);
		assert.equal(r.headers["CF-Access-Client-Secret"], "s3cr3t-value-0123456789", preset);
		if (preset === "hermes") assert.ok(r.headers["X-Webhook-Signature-V2"], "hermes keeps its HMAC");
		else assert.ok(r.headers["authorization"], `${preset} keeps its bearer`);
	}
});

test("Access headers need both halves; none without them", async () => {
	const none = (await renderWake({ preset: "generic", url: "https://h.example/x" }, ev))!;
	assert.ok(!("CF-Access-Client-Id" in none.headers) && !("CF-Access-Client-Secret" in none.headers));
	assert.deepEqual(addAccessHeaders({}, { accessClientId: "only-id" }), {});
	assert.deepEqual(addAccessHeaders({}, { accessClientSecret: "only-secret" }), {});
});

test("hermes HMAC is computed over the body only, unaffected by Access headers", async () => {
	const a = (await renderWake({ preset: "hermes", url: "https://h.example/webhooks/a2a", hmacSecret: "h1" }, ev, { nowMs: 1e12, requestId: "r" }))!;
	const b = (await renderWake({ preset: "hermes", url: "https://h.example/webhooks/a2a", hmacSecret: "h1", ...ACCESS }, ev, { nowMs: 1e12, requestId: "r" }))!;
	assert.equal(a.headers["X-Webhook-Signature-V2"], b.headers["X-Webhook-Signature-V2"]);
});

test("redact masks both Access headers", async () => {
	const r = redact((await renderWake({ preset: "openclaw-wake", url: "https://wake-x.example.com/hooks/wake", key: "hooks-token", ...ACCESS }, ev))!);
	assert.equal(r.headers["CF-Access-Client-Id"], "abc1…");
	assert.equal(r.headers["CF-Access-Client-Secret"], "s3cr…");
	assert.ok(!JSON.stringify(r).includes("s3cr3t-value"));
});

test("cloudflareErrorHint explains tunnel / Access failures", () => {
	assert.match(cloudflareErrorHint(530, "<html>... error code: 1033 ...</html>"), /1033.*no running connector/);
	assert.match(cloudflareErrorHint(530, "<title>Error 1033</title>"), /1033/);
	assert.match(cloudflareErrorHint(530, '<script>a={event:"feedback clicked",properties:{errorCode: 1033 }}</script>'), /1033/);
	assert.match(cloudflareErrorHint(403, "Forbidden. You don't have access. cloudflareaccess.com"), /Cloudflare Access/);
	assert.equal(cloudflareErrorHint(500, "boom"), "");
});

