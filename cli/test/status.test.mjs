// `status`: the next-step logic (pure, no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextStep, wakeLine } from "../lib/status.mjs";
import { cardUrlProblem } from "../lib/a2a.mjs";

const healthy = (over = {}) => ({
	configFile: "/cfg/config.env", deployed: true, baseUrl: "https://agent.example.com", hasOwnerToken: true,
	card: { ok: true, name: "A", versions: ["1.0", "0.3"] }, ownerApi: { ok: true },
	wake: { preset: "grok-bot", configured: true, hasKey: true, hasHmacSecret: false, hasAccessServiceToken: false, urlFingerprint: "abc" },
	tunnel: null, zones: null, ...over,
});

test("nextStep: the first missing piece, in setup order", () => {
	const step = (over) => nextStep(healthy(over));
	assert.equal(step({ deployed: false }).ok, false);
	assert.match(step({ deployed: false }).text, /nothing is deployed from \/cfg\/config\.env: run `a2a-exposed init/);
	assert.match(step({ baseUrl: "" }).text, /no base URL saved\): re-run `a2a-exposed init` with the same flags \(safe/);
	assert.match(step({ hasOwnerToken: false }).text, /no owner token saved/);
	assert.match(step({ card: { ok: false, error: "HTTP 404" } }).text, /agent card is not reachable \(HTTP 404\)/);
	assert.match(step({ ownerApi: { ok: false, error: "worker GET /owner/wake/preview -> HTTP 401: {}" } }).text, /init --rotate-owner-token/);
	assert.match(step({ ownerApi: { ok: false, error: "request failed" } }).text, /owner API failed \(request failed\): run `a2a-exposed deploy`/);
	assert.equal(step({}).ok, true);
	assert.match(step({}).text, /^none: setup is complete/);
});

test("cardUrlProblem: every endpoint in the card must be the base URL", () => {
	const card = (...urls) => ({ supportedInterfaces: urls.map((url, i) => ({ url, protocolBinding: "JSONRPC", protocolVersion: i ? "0.3" : "1.0" })) });
	assert.equal(cardUrlProblem(card("https://agent.example.com/", "https://agent.example.com"), "https://agent.example.com"), "");
	assert.equal(cardUrlProblem(card("https://agent.example.com/"), "https://agent.example.com/"), "");
	assert.equal(cardUrlProblem(card("https://agent.example.com/", "http://hermes.example.ts.net:8644/"), "https://agent.example.com"),
		"it advertises http://hermes.example.ts.net:8644/ instead of https://agent.example.com/");
	assert.match(cardUrlProblem({ url: "http://127.0.0.1:8644/", ...card("https://agent.example.com/") }, "https://agent.example.com"), /advertises http:\/\/127\.0\.0\.1:8644\//);
	assert.match(cardUrlProblem({ name: "x" }, "https://agent.example.com"), /no endpoint URL/);
});

test("nextStep: a card URL other than the base URL, and an exported A2A_BASE_URL, are flagged", () => {
	const wrong = nextStep(healthy({ card: { ok: true, name: "A", versions: [], urlProblem: "it advertises http://100.101.102.103:8644/ instead of https://agent.example.com/" } }));
	assert.equal(wrong.ok, false);
	assert.match(wrong.text, /does not point peers at this deployment: it advertises http:\/\/100\.101\.102\.103:8644\/ .*Run `a2a-exposed deploy`/);
	const env = nextStep(healthy({ baseUrlEnv: "http://hermes.example.ts.net:8644", baseUrlSaved: "https://agent.example.com" }));
	assert.equal(env.ok, false);
	assert.match(env.text, /^A2A_BASE_URL is exported as http:\/\/hermes\.example\.ts\.net:8644, but \/cfg\/config\.env has https:\/\/agent\.example\.com/);
});

test("nextStep: tunnel states", () => {
	const t = { hostname: "wake-a.example.com", complete: true, tokenFileOk: true, workerUrlMatches: true, connections: 1, tokenFile: "/cfg/tunnel-token" };
	const wake = { preset: "hermes", configured: true, hasHmacSecret: true, hasAccessServiceToken: true, urlFingerprint: "f" };
	const step = (tun, w = wake) => nextStep(healthy({ tunnel: { ...t, ...tun }, wake: w }));
	assert.match(step({ complete: false }).text, /did not finish: run `a2a-exposed tunnel rm`, then `a2a-exposed tunnel create`/);
	assert.match(step({ tokenFileOk: false }).text, /connector token file \(\/cfg\/tunnel-token\) is missing or empty: run `a2a-exposed tunnel create` again/);
	assert.equal(step({ tokenFileOk: false }).ok, false);
	assert.match(step({ workerUrlMatches: false }).text, /re-uploads them/);
	assert.match(step({ workerUrlMatches: false }, { ...wake, hasHmacSecret: false }).text, /export WAKE_HMAC_SECRET and run `a2a-exposed tunnel create` again/);
	assert.match(step({}, { ...wake, hasAccessServiceToken: false }).text, /re-uploads them/);
	assert.equal(step({ connections: 0 }).ok, false);
	assert.match(step({ connections: 0 }).text, /cloudflared tunnel run --token-file \/cfg\/tunnel-token.*7844/);
	assert.match(step({ connections: null }).text, /setup is complete/, "unknown connector state is not an error");
	assert.match(step({}).text, /setup is complete/);
	// a local preset needs its own webhook auth next to the Access token
	assert.match(step({}, { ...wake, hasHmacSecret: false }).text, /sends no webhook auth, so the hermes webhook will reject wakes: export WAKE_HMAC_SECRET.*`a2a-exposed tunnel create`/);
	const oc = nextStep(healthy({ wake: { preset: "openclaw-wake", configured: true, hasKey: false } }));
	assert.equal(oc.ok, false);
	assert.match(oc.text, /export WAKE_WEBHOOK_KEY \(the hooks token\), then run `a2a-exposed wake set`/);
});

test("nextStep: no wake webhook means polling, with the tunnel offered when the account has a zone", () => {
	const noWake = (preset, zones) => nextStep(healthy({ wake: { preset, configured: false }, zones }));
	const full = (r) => [r.text, ...r.also].join(" | "); // optional hints are separate "also" lines
	for (const p of ["hermes", "openclaw-wake", "openclaw-agent"]) assert.equal(noWake(p, ["example.com"]).ok, true);
	assert.match(full(noWake("hermes", ["example.com"])), /check the inbox on a schedule.*`a2a-exposed tunnel create` \(it uses the account's zone example\.com; no redeploy needed\)/);
	assert.match(full(noWake("hermes", ["a.com", "b.org"])), /--tunnel-zone <zone>` with one of: a\.com, b\.org/);
	assert.match(full(noWake("hermes", [])), /no domain \(zone\), so the secure tunnel is not available/);
	assert.match(full(noWake("hermes", null)), /needs a zone on the account/);
	assert.match(full(noWake("grok-bot", null)), /export WAKE_WEBHOOK_URL and WAKE_WEBHOOK_KEY, then run `a2a-exposed wake set --preset grok-bot`/);
	assert.match(full(noWake("generic", ["a.com"])), /tunnel create.*a public webhook: export WAKE_WEBHOOK_URL/);
});

test("wakeLine: mode and auth, never secret values", () => {
	assert.match(wakeLine({ wake: null }), /unknown/);
	assert.match(wakeLine({ wake: { preset: "hermes", configured: false } }), /^none: .*poll the inbox$/);
	assert.doesNotMatch(wakeLine({ wake: { preset: "generic", configured: false } }), /preset/, "no wake: no preset to talk about");
	assert.equal(wakeLine({ wake: { preset: "hermes", configured: true, hasHmacSecret: true, hasAccessServiceToken: true, urlFingerprint: "abc123" }, tunnel: {} }),
		"webhook (preset hermes, through the tunnel); auth: HMAC signature + Access service token; URL fingerprint abc123");
});
