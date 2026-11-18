import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { LANDING_WEBMCP_SCRIPT } from "../src/landing-webmcp.ts";
import { landingPage, landingHeaders, pageHeaders } from "../src/pairing.ts";
import worker, { dispatch } from "../src/index.ts";
import { hostedTenantContext, type WorkerBindings } from "../src/tenancy.ts";
import { d1 } from "./d1.ts";

const BASE = "https://agent.example";
const model = { name: "Agent", base: BASE, versions: ["1.0"], skills: [], pairing: true, proxy: false };
const card = { name: 'Operator </script><script>alert("x")</script>', skills: [{ name: "Untrusted skill" }] };
function run(pairing = true, api = "document") {
 const tools: any[] = [];
 const context = { registerTool: (tool: unknown) => tools.push(tool) };
 const document = { currentScript: { dataset: { agentCard: JSON.stringify(card), agentBase: BASE, pairing: pairing ? "1" : "0" } }, ...(api === "document" ? { modelContext: context } : {}) };
 const sandbox = { document, navigator: api === "navigator" ? { modelContext: context } : {} };
 vm.runInNewContext(LANDING_WEBMCP_SCRIPT, sandbox);
 return tools;
}

test("landing WebMCP registers exactly two read-only tools; handlers have no network or privileged capabilities", async () => {
 for (const api of ["document", "navigator"]) {
  const tools = run(true, api);
  assert.deepEqual(tools.map(t => t.name), ["get_agent_card", "get_connection_instructions"]);
  assert.ok(tools.every(t => t.annotations.readOnlyHint === true));
  assert.equal(tools[0].annotations.untrustedContentHint, true);
  assert.deepEqual(JSON.parse(JSON.stringify(await tools[0].execute({}))), card);
  const copy = await tools[0].execute({}); copy.name = "changed";
  assert.equal((await tools[0].execute({})).name, card.name);
  const result = await tools[1].execute({});
  assert.equal(result.command, "npx -y a2a-exposed@latest connect " + BASE);
  assert.equal(result.pairingAvailable, true);
  assert.equal(result.deviceAuthorizationEndpoint, BASE + "/oauth/device_authorization");
  assert.match(result.instruction, /owner must approve/);
  for (const tool of tools) for (const bad of [{message:"send"}, {approve:true}, [], null]) await assert.rejects(tool.execute(bad), /empty object/);
 }
 const off = await run(false)[1].execute({});
 assert.equal(off.pairingAvailable, false); assert.equal(off.command, undefined); assert.equal(off.approvalPage, undefined);
 assert.match(off.instruction, /Pairing is turned off/);
 assert.deepEqual(run(true, "unsupported"), []);
 vm.runInNewContext(LANDING_WEBMCP_SCRIPT, { document: {}, navigator: {} });
});

test("landing CSP authorizes only the nonce script, keeps default/form restrictions, and safely encodes untrusted card data", () => {
 const html = landingPage({ ...model, card }, "test-nonce");
 assert.equal((html.match(/<script /g) || []).length, 1);
 assert.match(html, /<script defer nonce="test-nonce" src="\/landing-webmcp\.js"/);
 assert.ok(!html.includes('</script><script>alert'));
 assert.ok(html.includes('&lt;/script&gt;'));
 const csp = landingHeaders("test-nonce")["content-security-policy"];
 assert.equal(csp, "default-src 'none'; style-src 'nonce-test-nonce'; script-src 'nonce-test-nonce'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
 assert.ok(!pageHeaders("test-nonce")["content-security-policy"].includes("script-src"), "approval pages do not gain scripts");
});

test("hosted and self-hosted handlers serve the script with correct MIME and HEAD, and a fresh nonce for each HTML request", async () => {
 const DB = d1(new URL("../migrations/", import.meta.url));
 const env: WorkerBindings = { DB, PUBLIC_URL: BASE, AGENT_NAME: "Agent" };
 const execution = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
 const hosted = hostedTenantContext(env, { id: "tenant-one", publicUrl: BASE, db: DB });
 for (const call of [ (req: Request) => worker.fetch(req, env, execution), (req: Request) => dispatch(req, hosted, execution)]) {
  const res = await call(new Request(BASE + "/landing-webmcp.js"));
  assert.equal(res.status, 200); assert.match(res.headers.get("content-type")!, /^text\/javascript/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff"); assert.equal(await res.text(), LANDING_WEBMCP_SCRIPT);
  const head = await call(new Request(BASE + "/landing-webmcp.js", {method:"HEAD"}));
  assert.equal(head.status, 200); assert.equal(await head.text(), "");
  const get = () => call(new Request(BASE + "/", {headers:{accept:"text/html"}}));
  const first = await get(), second = await get();
  assert.notEqual(first.headers.get("content-security-policy"), second.headers.get("content-security-policy"));
  const html = await first.text();
  assert.match(html, /data-agent-card="/);
  assert.equal((await call(new Request(BASE + "/landing-webmcp.js", {method:"POST"}))).status, 404);
 }
});


test("copy prompt is local, user-triggered, and works without WebMCP", async () => {
 for (const fails of [false, true]) {
  let click: (() => Promise<void>) | undefined;
  const written: string[] = [];
  const button = {hidden:true,dataset:{copy:"Connect to your-agent.agent-to-agent.party"} as Record<string,string>,setAttribute() {},addEventListener(_event: string, fn: () => Promise<void>) { click=fn; }};
  const status = {textContent:"",dataset:{} as Record<string,string>};
  vm.runInNewContext(LANDING_WEBMCP_SCRIPT,{document:{getElementById:(id: string)=>id==="copy-connect"?button:id==="copy-status"?status:null},navigator:{clipboard:{async writeText(text: string) { if(fails) throw new Error("denied");written.push(text); }}},setTimeout() {}});
  assert.equal(button.hidden,false);
  assert.equal(written.length,0,"copy never runs on page load");
  await click!();
  if(fails) {assert.match(status.textContent,/Copy failed. Select the prompt and copy it/);assert.deepEqual(written,[]);}
  else {assert.deepEqual(written,[button.dataset.copy]);assert.equal(button.dataset.state,"copied");assert.match(status.textContent,/Copied/);}
 }
});

test("human landing keeps technical instructions in Markdown and supports manual copy", () => {
 const html=landingPage({...model,base:"https://your-agent.agent-to-agent.party",description:"Helpful <agent>"},"nonce");
 assert.match(html,/data-copy="Connect to your-agent.agent-to-agent.party"/);
 assert.match(html,/id="copy-connect"[^>]* hidden/);
 assert.match(html,/Helpful &lt;agent&gt;/);
 assert.doesNotMatch(html,/npx|JSON-RPC|Bearer token|<table>/);
 assert.match(html,/href="\/index.md"/);
 const off=landingPage({...model,pairing:false},"nonce");
 assert.match(off,/connection requests are turned off/);
 assert.doesNotMatch(off,/owner approves the request/);
});
