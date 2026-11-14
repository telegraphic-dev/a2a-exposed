// Hosted registration discovery never grants access or changes the tenant pairing authority.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../src/index.ts";
import { hostedTenantContext, resolveTenant } from "../src/tenancy.ts";
import { d1 } from "./d1.ts";

const origin = "https://platform.example";
const target = "https://alpha.platform.example";
const execution = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const namespace = { idFromName: () => "unused", get() { throw new Error("no network calls"); } };

test("hosted auth.md advertises the full platform read-one-agent contract on both aliases with exact opt-in in any environment", async () => {
 const DB = d1(new URL("../migrations/", import.meta.url));
 for (const SITE_ENV of [undefined, "staging", "production", "Production", " production "]) {
  const env = { DB, TENANCY: "host", TENANT_DO: namespace, SITE_ENV, AGENT_REGISTRATION_ENABLED: "1", FEEDBACK_URL: origin };
  const ctx = hostedTenantContext(env, { id: "tenant-alpha", db: DB, publicUrl: target + "/", config: { AGENT_NAME: "Alpha", DISCOVERY_DOCS_ORIGIN: "https://docs.example", AGENT_REGISTRATION_ENABLED: "0", FEEDBACK_URL: "https://tenant-override.example" } });
  for (const path of ["/auth.md", "/.well-known/auth.md"]) {
   const res = await dispatch(new Request(target + path), ctx, execution);
   const text = await res.text();
   assert.equal(res.status, 200);
   assert.equal(res.headers.get("cache-control"), "no-store");
   assert.match(text, /POST https:\/\/platform\.example\/oauth\/agent\/identity/);
   const example = /```json\n([\s\S]+?)\n```/.exec(text);
   assert.ok(example, "the complete example body can be parsed");
   assert.deepEqual(JSON.parse(example[1]), { type: "service_auth", login_hint: "<person-supplied email>", client_name: "<your agent name>", target_agent: target, scope: "agents:read" });
   assert.match(text, /owner must sign in, enter the code, claim and approve/);
   assert.match(text, /Show only the returned claim.verification_uri and claim.user_code/);
   assert.match(text, /Keep claim_token in a protected file, never a URL, log or chat/);
   assert.ok(text.includes(`Poll POST ${origin}/oauth/token`));
   assert.ok(text.includes("grant_type=urn:workos:agent-auth:grant-type:claim&claim_token=<returned claim_token>"));
   assert.match(text, /Honor claim.interval; authorization_pending means wait, slow_down means add five seconds/);
   assert.ok(text.includes(`POST ${origin}/oauth/revoke`));
   assert.ok(text.includes("body token=<access_token>"));
   assert.match(text, /cannot list other agents, send messages, manage the agent, or access tenant MCP/);
   assert.ok(text.includes(`${origin}/api/v1/tenants`));
   assert.ok(text.includes(`${target}/oauth/device_authorization`));
   assert.ok(!text.includes(`${target}/oauth/agent/identity`) && !text.includes("tenant-override.example"));
   const head = await dispatch(new Request(target + path, { method: "HEAD" }), ctx, execution);
   assert.equal(head.status, 200); assert.equal(await head.text(), "");
   assert.equal(head.headers.get("cache-control"), "no-store");
  }
  const metadata = await dispatch(new Request(target + "/.well-known/oauth-authorization-server"), ctx, execution);
  assert.equal((await metadata.json() as Record<string, unknown>).agent_auth, undefined);
 }
});

test("flag-off, whitespace/case variants, malformed origin, tenant override and self-host cannot enable registration discovery", async () => {
 const DB = d1(new URL("../migrations/", import.meta.url));
 const enabled = { DB, TENANCY: "host", TENANT_DO: namespace, AGENT_REGISTRATION_ENABLED: "1", FEEDBACK_URL: origin };
 const overlays = [
  { AGENT_REGISTRATION_ENABLED: undefined }, { SITE_ENV: "production", AGENT_REGISTRATION_ENABLED: undefined },
  ...["", "0", "true", "True", "TRUE", "on", "ON", " 1", "1 ", "\t1", "1\n", "01"].map(AGENT_REGISTRATION_ENABLED => ({ AGENT_REGISTRATION_ENABLED })),
  ...[undefined, "Host", "HOST", " host", "host "].map(TENANCY => ({ TENANCY })),
  { FEEDBACK_URL: "http://platform.example" }, { FEEDBACK_URL: "https://u:p@platform.example" },
  { FEEDBACK_URL: origin + "/path" }, { FEEDBACK_URL: origin + "?x=1" }, { FEEDBACK_URL: undefined },
 ];
 for (const over of overlays) {
  const ctx = hostedTenantContext({ ...enabled, ...over }, { id: "tenant-alpha", db: DB, publicUrl: target, config: { AGENT_REGISTRATION_ENABLED: "1", SITE_ENV: "production", FEEDBACK_URL: origin } });
  for (const path of ["/auth.md", "/.well-known/auth.md"]) {
   const res = await dispatch(new Request(target + path), ctx, execution);
   const text = await res.text();
   assert.equal(res.headers.get("cache-control"), "no-store");
   assert.ok(!text.includes("/oauth/agent/identity"), JSON.stringify(over));
   assert.ok(text.includes(`${target}/oauth/device_authorization`));
  }
 }
 // Even all platform-looking bindings must not opt the self-hosted handler into registration.
 for (const TENANT_DO of [namespace, undefined]) {
  const ctx = resolveTenant({ ...enabled, PUBLIC_URL: target, TENANT_DO });
  const res = await dispatch(new Request(target + "/auth.md"), ctx, execution);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.ok(!(await res.text()).includes("/oauth/agent/identity"));
 }
});
