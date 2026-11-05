// Offline document-contract scenarios: verify what a fresh agent reads before it configures delivery.
// These are not live OpenClaw/Hermes exchanges or model-behaviour evaluations.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const operate = read("skills/a2a-exposed/SKILL.md");
const setup = read("skills/a2a-exposed-setup/SKILL.md");
const wake = read("skills/a2a-exposed-setup/references/wake.md");

test("fresh hosted OpenClaw: companion and both delivery options precede any polling recipe", () => {
	assert.match(operate, /required_skills:\n    - a2a-exposed-setup/);
	assert.match(operate, /If it is missing locally, install both skills/);
	assert.match(operate, /before creating handlers or polling jobs/);
	const workflow = setup.split("## Workflow")[1].split("## When")[0];
	const first = workflow.split("\n2.")[0];
	for (const requirement of [/hosted vs self-hosted/, /webhook vs polling/, /before creating a handler/, /Recommend webhook for OpenClaw and Hermes/, /let the human choose/]) assert.match(first, requirement);
	const preflight = wake.split("## Delivery preflight")[1].split("## Self-hosted wake commands")[0];
	assert.match(preflight, /Webhook \(recommended for OpenClaw and Hermes\)/);
	assert.match(preflight, /Polling \(fallback\)/);
	assert.match(preflight, /interval.*consume time or quota/s);
	assert.match(preflight, /Production a2a.exposed cannot currently deliver wakes to Cloudflare Tunnel/);
	assert.match(preflight, /Offer polling or an explicitly authorized self-hosted endpoint/);
	assert.ok(wake.indexOf("## Delivery preflight") < wake.indexOf("hermes cron create"));
	assert.ok(wake.indexOf("## Delivery preflight") < wake.indexOf("openclaw cron add"));
});

test("compatibility and human handoffs prevent self-host-only commands and pasted secrets", () => {
	for (const row of [/`inbox`, `show`, `history`, `reply`/, /`init`, `deploy`, `tunnel create\/status\/rm`, `uninstall`/, /CLI `wake set\/test\/preview\/unset`/, /Hosted MCP `list_agents`, `create_agent`, `agent_status`, `set_wake`/]) assert.match(wake, row);
	assert.match(wake, /Use `--agent NAME` when the service advertises hosted setup/);
	assert.match(wake, /Run `hosted capabilities --json` before requesting setup access/);
	assert.doesNotMatch(wake, /Self-hosted only in the current release|Hosted CLI\/API integration may add supported commands later/);
	assert.match(wake, /If setup is unavailable, stop the CLI setup path and offer dashboard Wake settings/);
	assert.match(wake, /Prefer a supported device-code grant over asking for pasted tokens/);
	assert.match(wake, /config.env` \(mode 600\)/);
	assert.match(wake, /human handles sign-in\/consent and device-code approval, pairing approval/);
});

test("local OpenClaw cloudflared attribution retains loopback and dedicated hook auth", () => {
	const section = wake.split("### OpenClaw")[1].split("### Hermes")[0];
	assert.match(section, /only the local connector address `127.0.0.1` to `gateway.trustedProxies`/);
	assert.match(section, /403 proxy_attribution_required/);
	assert.match(section, /keep the gateway bound to loopback and keep the dedicated hooks bearer token/);
	assert.match(section, /Do not broaden this to all proxies or change gateway authentication/);
});
