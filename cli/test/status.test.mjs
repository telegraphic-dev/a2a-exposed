// `status`: the next-step logic (pure, no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextStep, wakeLine } from "../lib/status.mjs";

const healthy = (over = {}) => ({
	configFile: "/cfg/config.env", deployed: true, baseUrl: "https://agent.example.com", hasOwnerToken: true,
	card: { ok: true, name: "A", versions: ["1.0", "0.3"] }, ownerApi: { ok: true },
	wake: { preset: "grok-bot", configured: true, hasKey: true, hasHmacSecret: false, hasAccessServiceToken: false, urlFingerprint: "abc" },
	tunnel: null, zones: null, ...over,
});

test("nextStep: the first missing piece, in setup order", () => {
	const step = (over) => nextStep(healthy(over));
	assert.equal(step({ deployed: false }).ok, false);
	assert.match(step({ deployed: false }).text, /nothing is deployed from \/cfg\/config\.env: run `a2a-over-webhook init/);
	assert.match(step({ baseUrl: "" }).text, /no base URL saved\): re-run `a2a-over-webhook init` with the same flags \(safe/);
	assert.match(step({ hasOwnerToken: false }).text, /no owner token saved/);
	assert.match(step({ card: { ok: false, error: "HTTP 404" } }).text, /agent card is not reachable \(HTTP 404\)/);
	assert.match(step({ ownerApi: { ok: false, error: "worker GET /owner/wake/preview -> HTTP 401: {}" } }).text, /init --rotate-owner-token/);
	assert.match(step({ ownerApi: { ok: false, error: "request failed" } }).text, /owner API failed \(request failed\): run `a2a-over-webhook deploy`/);
	assert.equal(step({}).ok, true);
	assert.match(step({}).text, /^none: setup is complete/);
});

test("nextStep: tunnel states", () => {
	const t = { hostname: "wake-a.example.com", complete: true, workerUrlMatches: true, connections: 1, tokenFile: "/cfg/tunnel-token" };
	const wake = { preset: "hermes", configured: true, hasHmacSecret: true, hasAccessServiceToken: true, urlFingerprint: "f" };
	const step = (tun, w = wake) => nextStep(healthy({ tunnel: { ...t, ...tun }, wake: w }));
	assert.match(step({ complete: false }).text, /did not finish: run `a2a-over-webhook tunnel rm`, then `a2a-over-webhook tunnel create`/);
	assert.match(step({ workerUrlMatches: false }).text, /re-uploads them/);
	assert.match(step({ workerUrlMatches: false }, { ...wake, hasHmacSecret: false }).text, /export WAKE_HMAC_SECRET and run `a2a-over-webhook tunnel create` again/);
	assert.match(step({}, { ...wake, hasAccessServiceToken: false }).text, /re-uploads them/);
	assert.equal(step({ connections: 0 }).ok, false);
	assert.match(step({ connections: 0 }).text, /cloudflared tunnel run --token-file \/cfg\/tunnel-token.*7844/);
	assert.match(step({ connections: null }).text, /setup is complete/, "unknown connector state is not an error");
	assert.match(step({}).text, /setup is complete/);
	// a local preset needs its own webhook auth next to the Access token
	assert.match(step({}, { ...wake, hasHmacSecret: false }).text, /sends no webhook auth, so the hermes webhook will reject wakes: export WAKE_HMAC_SECRET.*`a2a-over-webhook tunnel create`/);
	const oc = nextStep(healthy({ wake: { preset: "openclaw-wake", configured: true, hasKey: false } }));
	assert.equal(oc.ok, false);
	assert.match(oc.text, /export WAKE_WEBHOOK_KEY \(the hooks token\), then run `a2a-over-webhook wake set`/);
});

test("nextStep: no wake webhook means polling, with the tunnel offered when the account has a zone", () => {
	const noWake = (preset, zones) => nextStep(healthy({ wake: { preset, configured: false }, zones }));
	for (const p of ["hermes", "openclaw-wake", "openclaw-agent"]) assert.equal(noWake(p, ["example.com"]).ok, true);
	assert.match(noWake("hermes", ["example.com"]).text, /check the inbox on a schedule.*`a2a-over-webhook tunnel create` \(it uses the account's zone example\.com; no redeploy needed\)/);
	assert.match(noWake("hermes", ["a.com", "b.org"]).text, /--tunnel-zone <zone>` with one of: a\.com, b\.org/);
	assert.match(noWake("hermes", []).text, /no domain \(zone\), so the secure tunnel is not available/);
	assert.match(noWake("hermes", null).text, /needs a zone on the account/);
	assert.match(noWake("grok-bot", null).text, /export WAKE_WEBHOOK_URL and WAKE_WEBHOOK_KEY, then run `a2a-over-webhook wake set --preset grok-bot`/);
	assert.match(noWake("generic", ["a.com"]).text, /tunnel create.*a public webhook: export WAKE_WEBHOOK_URL/);
});

test("wakeLine: mode and auth, never secret values", () => {
	assert.match(wakeLine({ wake: null }), /unknown/);
	assert.match(wakeLine({ wake: { preset: "hermes", configured: false } }), /^none: .*poll the inbox \(preset hermes\)/);
	assert.equal(wakeLine({ wake: { preset: "hermes", configured: true, hasHmacSecret: true, hasAccessServiceToken: true, urlFingerprint: "abc123" }, tunnel: {} }),
		"webhook (preset hermes, through the tunnel); auth: HMAC signature + Access service token; URL fingerprint abc123");
});
