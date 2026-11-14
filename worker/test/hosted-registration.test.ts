// Hosted registration discovery never grants access or changes the tenant pairing authority.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../src/index.ts";
import { hostedTenantContext, resolveTenant, type WorkerBindings } from "../src/tenancy.ts";
import { d1 } from "./d1.ts";

const origin = "https://platform.example";
const target = "https://alpha.platform.example";
const execution = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const namespace = { idFromName: () => "unused", get() { throw new Error("no network calls"); } };

test("hosted auth.md advertises only the platform read-one-agent contract on both aliases", async () => {
 const DB = d1(new URL("../migrations/", import.meta.url));
 const env: WorkerBindings = { DB, TENANCY: "host", TENANT_DO: namespace, SITE_ENV: "staging", AGENT_REGISTRATION_ENABLED: "1", FEEDBACK_URL: origin };
 const ctx = hostedTenantContext(env, { id: "tenant-alpha", db: DB, publicUrl: target, config: { AGENT_NAME: "Alpha", DISCOVERY_DOCS_ORIGIN: "https://docs.example", AGENT_REGISTRATION_ENABLED: "0", FEEDBACK_URL: "https://tenant-override.example" } });
 for (const path of ["/auth.md", "/.well-known/auth.md"]) {
  const res = await dispatch(new Request(target + path), ctx, execution);
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(text, /POST https:\/\/platform\.example\/oauth\/agent\/identity/);
  assert.ok(text.includes(`target_agent=${target}`));
  assert.ok(text.includes("scope=agents:read"));
  assert.match(text, /owner must claim and approve/);
  assert.match(text, /cannot list other agents, send messages, manage the agent, or access tenant MCP/);
  assert.ok(text.includes(`${origin}/api/v1/tenants`));
  assert.ok(text.includes(`${target}/oauth/device_authorization`));
  assert.ok(!text.includes(`${target}/oauth/agent/identity`) && !text.includes("tenant-override.example"));
  const head = await dispatch(new Request(target + path, { method: "HEAD" }), ctx, execution);
  assert.equal(head.status, 200); assert.equal(await head.text(), "");
 }
 const metadata = await dispatch(new Request(target + "/.well-known/oauth-authorization-server"), ctx, execution);
 assert.equal((await metadata.json() as Record<string, unknown>).agent_auth, undefined);
});

test("production, flag-off, malformed origin, tenant override and self-host cannot enable registration discovery", async () => {
 const DB = d1(new URL("../migrations/", import.meta.url));
 const enabled: WorkerBindings = { DB, TENANCY: "host", TENANT_DO: namespace, SITE_ENV: "staging", AGENT_REGISTRATION_ENABLED: "1", FEEDBACK_URL: origin };
 const overlays = [
  { SITE_ENV: "production" }, { SITE_ENV: undefined }, { AGENT_REGISTRATION_ENABLED: undefined },
  { AGENT_REGISTRATION_ENABLED: "true" }, { AGENT_REGISTRATION_ENABLED: " 1" }, { FEEDBACK_URL: "http://platform.example" },
  { FEEDBACK_URL: "https://u:p@platform.example" }, { FEEDBACK_URL: origin + "/path" }, { FEEDBACK_URL: origin + "?x=1" },
  { FEEDBACK_URL: undefined }, { TENANCY: undefined }, { TENANT_DO: undefined },
 ];
 for (const over of overlays) {
  const ctx = hostedTenantContext({ ...enabled, ...over }, { id: "tenant-alpha", db: DB, publicUrl: target, config: { AGENT_REGISTRATION_ENABLED: "1", SITE_ENV: "staging", FEEDBACK_URL: origin } });
  for (const path of ["/auth.md", "/.well-known/auth.md"]) {
   const text = await (await dispatch(new Request(target + path), ctx, execution)).text();
   assert.ok(!text.includes("/oauth/agent/identity"), JSON.stringify(over));
   assert.ok(text.includes(`${target}/oauth/device_authorization`));
  }
 }
 // Even all platform-looking bindings must not opt the self-hosted handler into registration.
 const ctx = resolveTenant({ ...enabled, PUBLIC_URL: target });
 const res = await dispatch(new Request(target + "/auth.md"), ctx, execution);
 assert.ok(!(await res.text()).includes("/oauth/agent/identity"));
});
