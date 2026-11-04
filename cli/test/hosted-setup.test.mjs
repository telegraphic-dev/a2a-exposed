import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnv } from "../lib/config.mjs";
import { setupSession } from "../lib/hosted.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const grant = "a2asg_" + "a".repeat(64), owner = "a2aot_" + "x".repeat(43);
const capabilities = { scopes: ["agents:create", "agents:owner-token", "wake:write", "wake:test"], wake: { presets: ["generic", "hermes"], secure_link_create: false } };

function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-setup-"));
	const configDir = path.join(dir, "config"); fs.mkdirSync(configDir);
	const config = path.join(configDir, "config.env"), routes = path.join(dir, "routes.json");
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(A2A_|CONTROL_|HOSTED_|WAKE_|CF_|CLOUDFLARE_)/.test(key)));
	Object.assign(env, { A2A_CONFIG_DIR: configDir, A2A_NO_UPDATE_CHECK: "1", DO_NOT_TRACK: "1", A2A_TEST_FETCH_ROUTES: routes });
	return {
		dir, config, env,
		save(extra = "") { fs.writeFileSync(config, `HOSTED_SETUP_URL=https://control.example\nHOSTED_SETUP_TOKEN=${grant}\n${extra}`, { mode: 0o600 }); },
		run(args, replies = {}, extra = {}) {
			fs.writeFileSync(routes, JSON.stringify({ "https://control.example/api/v1/setup/capabilities": { status: 200, body: capabilities }, ...replies }));
			return spawnSync(process.execPath, ["--import", path.join(root, "test/fetch-stub.mjs"), path.join(root, "bin/a2a-exposed.mjs"), ...args], { encoding: "utf8", env: { ...env, ...extra } });
		},
		clean() { fs.rmSync(dir, { recursive: true, force: true }); },
	};
}

test("setup environment overrides never borrow saved credential halves", () => {
	const saved = { HOSTED_SETUP_URL: "https://control.example", HOSTED_SETUP_TOKEN: grant };
	assert.deepEqual(setupSession({ HOSTED_SETUP_URL: "https://other.example" }, saved), { origin: "https://other.example", token: "" });
	assert.deepEqual(setupSession({ HOSTED_SETUP_TOKEN: "override" }, saved), { origin: "", token: "override" });
});

test("scoped approval saves only the setup grant and never prints credentials", () => {
	const f = fixture();
	try {
		const r = f.run(["login", "--control-url", "https://control.example", "--machine", "test workstation", "--scopes", capabilities.scopes.join(" "), "--json"], {
			"https://control.example/api/auth/device/code": { status: 200, body: { device_code: "private-device", user_code: "ABCD2345", verification_uri_complete: "https://control.example/app/device?user_code=ABCD2345", expires_in: 10, interval: 1 } },
			"https://control.example/api/auth/device/token": { status: 200, body: { access_token: grant, scope: capabilities.scopes.join(" ") } },
		}, { A2A_POLL_SCALE: "0.001" });
		assert.equal(r.status, 0, r.stderr + r.stdout);
		assert.equal(JSON.parse(r.stdout).code, "approved");
		const saved = parseEnv(fs.readFileSync(f.config, "utf8"));
		assert.equal(saved.HOSTED_SETUP_TOKEN, grant);
		assert.equal(saved.CONTROL_TOKEN, undefined);
		assert.equal(fs.statSync(f.config).mode & 0o777, 0o600);
		assert.match(r.stderr, /ABCD2345/);
		assert.ok(!r.stdout.includes(grant) && !r.stderr.includes(grant));
		assert.ok(!r.stdout.includes("private-device") && !r.stderr.includes("private-device"));
	} finally { f.clean(); }
});

test("create lists first, atomically saves the owner token, and preserves other config", () => {
	const f = fixture(); f.save("UNRELATED=retained\n");
	try {
		const r = f.run(["hosted", "create", "--name", "sample-agent", "--json"], {
			"https://control.example/api/v1/tenants": { status: 201, body: { tenants: [], name: "sample-agent", base_url: "https://sample-agent.control.example", owner_token: owner } },
		});
		assert.equal(r.status, 0, r.stdout + r.stderr);
		const saved = parseEnv(fs.readFileSync(f.config, "utf8"));
		assert.equal(saved.A2A_OWNER_TOKEN, owner); assert.equal(saved.UNRELATED, "retained");
		assert.equal(fs.statSync(f.config).mode & 0o777, 0o600);
		assert.ok(!r.stdout.includes(owner) && !r.stderr.includes(owner));
		const again = f.run(["hosted", "create", "--name", "another-agent", "--json"]);
		assert.equal(JSON.parse(again.stdout).code, "config_in_use");
		assert.equal(again.status, 1);
	} finally { f.clean(); }
});

test("hosted draft failures preserve codes and redact arbitrary service fields", () => {
	const f = fixture(); f.save("HOSTED_AGENT_NAME=sample-agent\n");
	try {
		const r = f.run(["wake", "test", "--agent", "sample-agent", "--url", "https://receiver.example/wake", "--preset", "hermes", "--json"], {
			"https://control.example/api/v1/agents/sample-agent/wake/test": { status: 200, body: { ok: false, code: "cloudflare-target-unsupported", message: owner, proof: grant, key: "do-not-print" } },
			"https://control.example/api/v1/agents/sample-agent/wake": { status: 200, body: { version: 7, preset: "generic", url: "" } },
		}, { WAKE_HMAC_SECRET: "signing-secret" });
		assert.equal(r.status, 1);
		assert.equal(JSON.parse(r.stdout).code, "cloudflare-target-unsupported");
		for (const secret of [owner, grant, "signing-secret", "do-not-print"]) assert.ok(!(r.stdout + r.stderr).includes(secret));
	} finally { f.clean(); }
});

test("protected secret file validation fails before a test or save", () => {
	const f = fixture(); f.save(); const secretFile = path.join(f.dir, "key"); fs.writeFileSync(secretFile, "secret", { mode: 0o644 });
	try {
		const r = f.run(["wake", "set", "--agent", "sample-agent", "--url", "https://receiver.example/wake", "--key-file", secretFile, "--json"], {
			"https://control.example/api/v1/agents/sample-agent/wake": { status: 200, body: { version: 1, preset: "generic" } },
		});
		assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).code, "secret_file");
	} finally { f.clean(); }
});

test("cross-origin setup override never sends the saved owner credential", () => {
	const f = fixture(); f.save(`HOSTED_AGENT_NAME=sample-agent\nA2A_BASE_URL=https://sample-agent.control.example\nA2A_OWNER_TOKEN=${owner}\n`);
	try {
		const r = f.run(["wake", "preview", "--control-url", "https://other.example", "--json"]);
		assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).code, "login_required");
	} finally { f.clean(); }
});


test("prepare stores a mode-600 single-use reference, set consumes it without raw secret arguments", () => {
 const f=fixture();f.save("HOSTED_AGENT_NAME=sample-agent\n");
 const ref="a2awr_"+"b".repeat(64), target=path.join(f.dir,"reference"), state={status:200,body:{version:1,preset:"hermes",url:"https://receiver.example/wake"}};
 const routes={
  "https://control.example/api/v1/setup/capabilities":{status:200,body:{...capabilities,wake:{...capabilities.wake,secret_reference:true}}},
  "https://control.example/api/v1/agents/sample-agent/wake/reference":{status:200,body:{reference:ref,expires_in:600}},
  "https://control.example/api/v1/agents/sample-agent/wake":state,
 };
 try {
  const args=["wake","prepare","--agent","sample-agent","--url","https://receiver.example/wake","--preset","hermes","--hmac-secret-env","FIXTURE_SIGNING","--reference-file",target,"--json"];
  const r=f.run(args,routes,{FIXTURE_SIGNING:"dummy-signing-secret"});assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(JSON.parse(r.stdout).code,"prepared");assert.equal(fs.readFileSync(target,"utf8").trim(),ref);assert.equal(fs.statSync(target).mode&0o777,0o600);
  assert.ok(!(r.stdout+r.stderr).includes(ref));assert.ok(!(r.stdout+r.stderr).includes("dummy-signing-secret"));
  const again=f.run(args,routes,{FIXTURE_SIGNING:"dummy-signing-secret"});assert.equal(again.status,1);assert.equal(fs.readFileSync(target,"utf8").trim(),ref);
  const log=path.join(f.dir,"requests");
  const saved=f.run(["wake","set","--agent","sample-agent","--reference-file",target,"--json"],{"https://control.example/api/v1/agents/sample-agent/wake":{status:200,body:{version:1,ok:true,saved:true}}},{A2A_TEST_FETCH_LOG:log});
  assert.equal(saved.status,0,saved.stdout+saved.stderr);assert.equal(JSON.parse(saved.stdout).saved,true);assert.ok(!(saved.stdout+saved.stderr).includes(ref));
  const calls=fs.readFileSync(log,"utf8").trim().split("\n").map(JSON.parse);const body=JSON.parse(calls.find(c=>c.method==="PUT").body);assert.deepEqual(body,{version:1,secretReference:ref});
 } finally {f.clean();}
});


test("an agent owner token retains the direct test-and-save path when references require a setup grant", () => {
 const f=fixture();fs.writeFileSync(f.config,`A2A_BASE_URL=https://sample-agent.control.example\nA2A_OWNER_TOKEN=${owner}\n`,{mode:0o600});
 try {
  const log=path.join(f.dir,"requests");
  const result=f.run(["wake","set","--agent","sample-agent","--url","https://receiver.example/wake","--preset","generic","--control-url","https://control.example","--json"],{
   "https://control.example/api/v1/setup/capabilities":{status:200,body:{...capabilities,wake:{...capabilities.wake,secret_reference:true}}},
   "https://control.example/api/v1/agents/sample-agent/wake":{status:200,body:{version:1,ok:true,saved:true}},
  },{A2A_TEST_FETCH_LOG:log});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const calls=fs.readFileSync(log,"utf8").trim().split("\n").map(JSON.parse);assert.equal(calls.some(c=>c.url.endsWith("/reference")),false);assert.equal(JSON.parse(calls.find(c=>c.method==="PUT").body).preset,"generic");
  assert.ok(!(result.stdout+result.stderr).includes(owner));
 }finally{f.clean();}
});

test("partial setup or deployment environment overrides cannot borrow saved owner credentials", () => {
 const f=fixture();f.save(`HOSTED_AGENT_NAME=sample-agent\nA2A_BASE_URL=https://sample-agent.control.example\nA2A_OWNER_TOKEN=${owner}\n`);
 try {
  for (const env of [{HOSTED_SETUP_URL:"https://other.example"},{A2A_BASE_URL:"https://sample-agent.other.example",HOSTED_SETUP_URL:"https://other.example"},{A2A_OWNER_TOKEN:owner,HOSTED_SETUP_URL:"https://other.example"}]) {
   const log=path.join(f.dir,"requests");
   const r=f.run(["wake","preview","--json"],{}, {...env,A2A_TEST_FETCH_LOG:log});
   assert.equal(r.status,1,r.stdout+r.stderr);assert.equal(JSON.parse(r.stdout).code,"login_required");
   assert.equal(fs.existsSync(log),false,"must refuse before any authenticated fetch");
  }
 }finally{f.clean();}
});

test("human-readable listings and previews include the requested results", () => {
 const f=fixture();f.save("HOSTED_AGENT_NAME=sample-agent\n");
 try {
  const caps=f.run(["hosted","capabilities"]);assert.equal(caps.status,0,caps.stderr);assert.match(caps.stdout,/scopes:[\s\S]*wake:write/);assert.match(caps.stdout,/presets:[\s\S]*hermes/);
  const list=f.run(["hosted","list"],{"https://control.example/api/v1/tenants":{status:200,body:{tenants:[{name:"sample-agent",status:"active"}]}}});assert.equal(list.status,0,list.stderr);assert.match(list.stdout,/agents:[\s\S]*sample-agent[\s\S]*active/);
  const preview=f.run(["wake","preview","--agent","sample-agent"],{"https://control.example/api/v1/agents/sample-agent/wake":{status:200,body:{version:7,preset:"hermes",url:"https://receiver.example/wake"}}});assert.equal(preview.status,0,preview.stderr);assert.match(preview.stdout,/version: 7/);assert.match(preview.stdout,/preset: "hermes"/);assert.match(preview.stdout,/configured: true/);
  for (const r of [caps,list,preview]) assert.ok(!(r.stdout+r.stderr).includes(grant));
 }finally{f.clean();}
});
