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

test("hosted prepare capacity errors report the wait without retrying or writing a reference", () => {
	const f = fixture(); f.save("HOSTED_AGENT_NAME=sample-agent\n");
	const message = "This setup grant has 20 unused references. Wait 544 seconds before uploading another draft.";
	try {
		const cases = [
			{ header: "321", body: 544, expected: 321 },
			{ body: 544, expected: 544 },
			{ header: "0", body: 544, expected: 0 },
			{ header: new Date(Date.now() + 120_000).toUTCString(), body: 544, date: true },
			{ header: "Thu, 01 Jan 1970 00:00:00 GMT", body: 544, expected: 0 },
			{ header: "invalid", body: 544, expected: 544 },
			{ header: "999999999999999999999", body: 544, expected: 544 },
			{ header: "-1", body: 544, expected: 544 },
			{ header: "1.5", body: 544, expected: 544 },
			{ header: "invalid", body: -1 },
			{ body: "544" },
			{},
		];
		for (const [index, item] of cases.entries()) {
			const reference = path.join(f.dir, `reference-${index}`), log = path.join(f.dir, `requests-${index}`);
			const before = fs.readFileSync(f.config, "utf8");
			const r = f.run(["wake", "prepare", "--agent", "sample-agent", "--url", "https://receiver.example/wake", "--preset", "generic", "--reference-file", reference, "--json"], {
				"https://control.example/api/v1/setup/capabilities": { status: 200, body: { ...capabilities, wake: { ...capabilities.wake, secret_reference: true } } },
				"https://control.example/api/v1/agents/sample-agent/wake": { status: 200, body: { version: 1 } },
				"https://control.example/api/v1/agents/sample-agent/wake/reference": { status: 429, headers: item.header === undefined ? {} : { "Retry-After": item.header }, body: { error: "too_many_references", message, retry_after: item.body, token: grant, proof: owner } },
			}, { A2A_TEST_FETCH_LOG: log });
			assert.equal(r.status, 1, r.stdout + r.stderr);
			const result = JSON.parse(r.stdout);
			assert.equal(result.code, "too_many_references"); assert.equal(result.message, message);
			if (item.date) assert.ok(result.retry_after > 0 && result.retry_after <= 120);
			else assert.equal(result.retry_after, item.expected);
			assert.match(result.next, /wake prepare.*no automatic retry/);
			if (result.retry_after !== undefined) assert.ok(result.next.includes(`Wait ${result.retry_after} seconds`));
			else assert.match(result.next, /expire/);
			assert.equal(fs.existsSync(reference), false); assert.equal(fs.readFileSync(f.config, "utf8"), before);
			const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
			assert.deepEqual(calls.filter(c => c.method !== "GET").map(c => c.method), ["POST"]);
			for (const secret of [owner, grant]) assert.ok(!(r.stdout + r.stderr).includes(secret));
		}
		for (const [index, body] of [{ error: "too_many_references", message, retry_after: 544 }, { error: "too_many_references", message: owner + "\u001b[31m", retry_after: 544 }, { error: "unknown_code", message: owner }].entries()) {
			const r = f.run(["hosted", "list"], { "https://control.example/api/v1/tenants": { status: 429, body } });
			assert.equal(r.status, 1);
			if (index === 0) { assert.match(r.stdout, /too_many_references: Wait 544 seconds/); assert.ok(r.stdout.includes(message)); }
			else { assert.ok(!(r.stdout + r.stderr).includes(owner)); assert.doesNotMatch(r.stdout, /\u001b/); }
			if (index === 2) assert.match(r.stdout, /http_429/);
		}
	} finally { f.clean(); }
});

function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-setup-"));
	const configDir = path.join(dir, "config"); fs.mkdirSync(configDir);
	const config = path.join(configDir, "config.env"), routes = path.join(dir, "routes.json");
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(A2A_|CONTROL_|HOSTED_|WAKE_|UPSTREAM_|PEER_|EVENT_|APPROVAL_|FEEDBACK_|CF_|CLOUDFLARE_)/.test(key)));
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

test("missing capabilities stops discovery and scoped login before approval without changing config", () => {
	const f = fixture();
	try {
		for (const saved of [false, true]) {
			if (saved) f.save("UNRELATED=retained\n");
			const before = saved ? fs.readFileSync(f.config, "utf8") : undefined;
			for (const body of [{ error: "not_found", token: grant, message: owner }, "<html>Not found</html>", ""]) {
				for (const command of [["hosted", "capabilities"], ["login", "--machine", "workstation", "--scopes", capabilities.scopes.join(" ")]]) {
					for (const json of [false, true]) {
						const log = path.join(f.dir, "discovery-log"); fs.writeFileSync(log, "");
						const r = f.run([...command, "--control-url", "https://control.example", ...(json ? ["--json"] : [])], {
							"https://control.example/api/v1/setup/capabilities": { status: 404, body },
						}, { A2A_TEST_FETCH_LOG: log });
						assert.equal(r.status, 1, r.stdout + r.stderr);
						const next = json ? JSON.parse(r.stdout).next : r.stdout;
						if (json) assert.equal(JSON.parse(r.stdout).code, "unsupported");
						else assert.match(next, /unsupported:/);
						assert.match(next, /--control-url.*dashboard.*hosted MCP.*human confirmation/);
						assert.match(next, /no setup approval was requested/);
						assert.doesNotMatch(next, /Run hosted capabilities/);
						const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
						assert.equal(calls.length, 1); assert.equal(calls[0].method, "GET");
						assert.equal(calls[0].headers.authorization, undefined);
						assert.equal(fs.existsSync(f.config), saved);
						if (saved) assert.equal(fs.readFileSync(f.config, "utf8"), before);
						for (const secret of [owner, grant]) assert.ok(!(r.stdout + r.stderr).includes(secret));
					}
				}
			}
		}
	} finally { f.clean(); }
});

test("other discovery failures and agent not-found retain their distinct results", () => {
	const f = fixture(); f.save();
	try {
		for (const [status, body, code] of [[401, { error: "invalid_grant" }, "invalid_grant"], [403, { error: "insufficient_scope" }, "insufficient_scope"], [503, { error: "unavailable" }, "unavailable"], [200, {}, "unsupported"], [200, "not json", "unavailable"]]) {
			const r = f.run(["hosted", "capabilities", "--json"], { "https://control.example/api/v1/setup/capabilities": { status, body } });
			assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).code, code);
		}
		const r = f.run(["hosted", "list", "--json"], { "https://control.example/api/v1/tenants": { status: 404, body: { error: "not_found" } } });
		assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).code, "not_found");
	} finally { f.clean(); }
});

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
		assert.match(r.stderr, /Machine: test workstation/);
		assert.match(r.stderr, /Permissions: agents:create, agents:owner-token, wake:write, wake:test/);
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

test("hosted draft failures give fixed layer guidance without retries, saves or credential disclosure", () => {
	const cases = [
		["transport-socket", /socket transport.*route compatibility.*local checks/],
		["cloudflare-target-unsupported", /cannot deliver.*supported public HTTPS route, polling.*do not create another tunnel/],
		["dns", /resolve.*public DNS/],
		["dns-missing", /resolve.*public DNS/],
		["tls", /TLS.*certificate.*verification enabled/],
		["access-401", /Access refused.*service token and policy.*without disabling/],
		["access-403", /Access refused.*service token and policy.*without disabling/],
		["unexpected-private-detail", /Check the receiver, credentials and draft/],
	];
	for (const [code, guidance] of cases) {
		for (const sub of ["test", "set"]) {
			const f = fixture(); f.save("HOSTED_AGENT_NAME=sample-agent\n");
			try {
				const before = fs.readFileSync(f.config, "utf8"), log = path.join(f.dir, "requests");
				const endpoint = "https://control.example/api/v1/agents/sample-agent/wake";
				const r = f.run(["wake", sub, "--agent", "sample-agent", "--url", "https://receiver.example/private-path", "--preset", "openclaw-wake", "--key-env", "FIXTURE_KEY", "--json"], {
					"https://control.example/api/v1/setup/capabilities": { status: 200, body: { ...capabilities, wake: { ...capabilities.wake, presets: ["openclaw-wake"] } } },
					[endpoint]: { status: 200, body: { version: 7, preset: "generic", url: "", ok: false, saved: false, code, message: owner, proof: grant } },
					[`${endpoint}/test`]: { status: 200, body: { ok: false, code, message: owner, proof: grant } },
				}, { FIXTURE_KEY: "dummy-hook-secret", A2A_TEST_FETCH_LOG: log });
				assert.equal(r.status, 1, r.stdout + r.stderr);
				const result = JSON.parse(r.stdout);
				assert.equal(result.ok, false); assert.equal(result.saved, false);
				assert.equal(result.code, code === "unexpected-private-detail" ? "failed" : code);
				assert.match(result.next, /^Saved settings were not changed\./);
				assert.match(result.next, guidance);
				for (const secret of [owner, grant, "dummy-hook-secret", "private-path", "unexpected-private-detail"]) assert.ok(!(r.stdout + r.stderr).includes(secret));
				assert.equal(fs.readFileSync(f.config, "utf8"), before);
				const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
				assert.equal(calls.filter(call => call.method !== "GET").length, 1);
				assert.equal(calls.at(-1).method, sub === "test" ? "POST" : "PUT");
			} finally { f.clean(); }
		}
	}
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


test("saved owner token handles wake preview/test after setup grant revocation, without retrying a write", () => {
 const f=fixture();f.save(`HOSTED_AGENT_NAME=sample-agent\nA2A_BASE_URL=https://sample-agent.control.example\nA2A_OWNER_TOKEN=${owner}\n`);
 try {
  for (const command of ["preview","test"]) {
   const log=path.join(f.dir,command+".requests");
   const r=f.run(["wake",command,"--agent","sample-agent","--json"],{
    "https://control.example/api/v1/agents/sample-agent/wake":{status:200,body:{version:2,preset:"generic",url:"https://receiver.example/private-key?token=sensitive",keyHeader:"Authorization",ok:true,code:"204"}},
   },{A2A_TEST_FETCH_LOG:log});
   assert.equal(r.status,0,r.stdout+r.stderr);
   const calls=fs.readFileSync(log,"utf8").trim().split("\n").map(JSON.parse).filter(c=>c.headers.authorization);
   assert.ok(calls.length>0); assert.ok(calls.every(c=>c.headers.authorization===`Bearer ${owner}`));
   if(command==="preview") { assert.equal(JSON.parse(r.stdout).url,"https://receiver.example/…"); assert.equal(JSON.parse(r.stdout).key_header,"Authorization"); }
   for(const secret of [owner,grant,"private-key","sensitive"]) assert.ok(!(r.stdout+r.stderr).includes(secret));
  }
 }finally{f.clean();}
});

test("a refused reference gives fixed prepare guidance without reflecting server text", () => {
 const f=fixture();f.save("HOSTED_AGENT_NAME=sample-agent\n");
 const reference=path.join(f.dir,"reference");fs.writeFileSync(reference,"a2awr_"+"b".repeat(64),{mode:0o600});
 try {
  const r=f.run(["wake","set","--agent","sample-agent","--reference-file",reference,"--json"],{
   "https://control.example/api/v1/agents/sample-agent/wake":{status:400,body:{error:"invalid_reference",message:owner}},
  });
  assert.equal(r.status,1); assert.match(JSON.parse(r.stdout).next,/already used.*wake prepare/); assert.ok(!r.stdout.includes(owner));
 }finally{f.clean();}
});


test("hosted preview reports each preset's effective header without changing saved header inputs", () => {
 const f=fixture();f.save("HOSTED_AGENT_NAME=sample-agent\n");
 try {
  for (const [preset,keyHeader,expected] of [["generic","","Authorization"],["generic","X-Hook-Key","X-Hook-Key"],["openclaw-agent","X-Ignored","Authorization"],["grok-bot","","Authorization"],["claude-code","","Authorization"],["hermes","",""],["openbot","",""],["mausbot","X-Ignored","Authorization"]]) {
   const r=f.run(["wake","preview","--agent","sample-agent","--json"],{"https://control.example/api/v1/agents/sample-agent/wake":{status:200,body:{version:1,preset,keyHeader,url:"https://receiver.example/wake"}}});
   assert.equal(r.status,0,r.stdout+r.stderr); assert.equal(JSON.parse(r.stdout).key_header,expected,preset);
  }
 }finally{f.clean();}
});

test("empty and malformed references explain preparation before any network request", () => {
 const f = fixture(); f.save();
 try {
  const file = path.join(f.dir, "reference");
  for (const value of ["", "\n", "not-a-reference", "a2awr_" + "b".repeat(63), "private\u0000reference"]) {
   fs.writeFileSync(file, value, { mode: 0o600 });
   for (const source of [["--reference-file", file], ["--reference-env", "TEST_WAKE_REFERENCE"]]) {
    const log = path.join(f.dir, "requests");
    const r = f.run(["wake", "set", "--agent", "sample-agent", ...source, "--json"], {}, { TEST_WAKE_REFERENCE: value.includes("\u0000") ? "invalid" : value, A2A_TEST_FETCH_LOG: log });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.code, "invalid_reference");
    assert.match(result.next, /wake prepare --agent NAME/);
    assert.match(result.next, /new --reference-file/);
    assert.equal(fs.existsSync(log), false, "invalid local references must not contact the service");
   }
  }
 } finally { f.clean(); }
});

test("selected hosted status uses only GET, redacts destination secrets and leaves config intact", () => {
 const f = fixture(); f.save("HOSTED_AGENT_NAME=different-agent\n");
 try {
  const before = fs.readFileSync(f.config, "utf8");
  const log = path.join(f.dir, "requests");
  const replies = { "https://control.example/api/v1/agents/sample-agent/wake": { status: 200, body: { version: 8, preset: "hermes", url: "https://receiver.example/private-token?key=secret", history: [{ machine: "do-not-print" }] } } };
  const r = f.run(["status", "--agent", "sample-agent", "--json"], replies, { A2A_TEST_FETCH_LOG: log });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.code, "status"); assert.equal(result.agent, "sample-agent");
  assert.equal(result.configured, true); assert.equal(result.version, 8);
  assert.equal(result.preset, "hermes"); assert.equal(result.url, "https://receiver.example/…");
  assert.doesNotMatch(r.stdout + r.stderr, /private-token|key=secret|do-not-print|a2asg_/);
  assert.equal(fs.readFileSync(f.config, "utf8"), before);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.map(({ url, method }) => ({ url, method })), [{ url: "https://control.example/api/v1/agents/sample-agent/wake", method: "GET" }]);
  const text = f.run(["status", "--agent", "sample-agent"], replies);
  assert.equal(text.status, 0); assert.match(text.stdout, /agent: "sample-agent"/);
 } finally { f.clean(); }
});

test("selected status refuses foreign owner credentials and preserves service refusal exit codes", () => {
 const f = fixture();
 fs.writeFileSync(f.config, `A2A_BASE_URL=https://other-agent.control.example\nA2A_OWNER_TOKEN=${owner}\n`, { mode: 0o600 });
 try {
  const log = path.join(f.dir, "requests");
  const r = f.run(["status", "--agent", "sample-agent", "--control-url", "https://control.example", "--json"], {}, { A2A_TEST_FETCH_LOG: log });
  assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).code, "login_required");
  assert.equal(fs.existsSync(log), false);
  f.save();
  for (const json of [[], ["--json"]]) {
   const denied = f.run(["status", "--agent", "sample-agent", ...json], { "https://control.example/api/v1/agents/sample-agent/wake": { status: 403, body: { error: "insufficient_scope", message: owner } } });
   assert.equal(denied.status, 1); assert.match(denied.stdout, /insufficient_scope/);
   assert.ok(!denied.stdout.includes(owner));
  }
 } finally { f.clean(); }
});

test("selected status accepts only an explicit valid agent and supports its saved owner", () => {
 const f = fixture();
 fs.writeFileSync(f.config, `A2A_BASE_URL=https://sample-agent.control.example\nA2A_OWNER_TOKEN=${owner}\n`, { mode: 0o600 });
 try {
  const log = path.join(f.dir, "requests");
  for (const args of [["--agent", ""], ["--agent", "BAD"], ["--control-url", "https://control.example"]]) {
   const invalid = f.run(["status", ...args, "--json"], {}, { A2A_TEST_FETCH_LOG: log });
   assert.equal(invalid.status, 1); assert.equal(JSON.parse(invalid.stdout).code, "agent");
   assert.match(JSON.parse(invalid.stdout).next, /hosted list --json/);
   assert.equal(fs.existsSync(log), false);
  }
  const r = f.run(["status", "--agent", "sample-agent", "--control-url", "https://control.example", "--json"], { "https://control.example/api/v1/agents/sample-agent/wake": { status: 200, body: { version: 3, preset: "generic", url: "" } } }, { A2A_TEST_FETCH_LOG: log });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).configured, false);
  assert.match(JSON.parse(r.stdout).next, /polling/);
  assert.equal(JSON.parse(fs.readFileSync(log, "utf8").trim()).headers.authorization, `Bearer ${owner}`);
  assert.ok(!(r.stdout + r.stderr).includes(owner));
 } finally { f.clean(); }
});

test('hosted removal requires an explicit listed version before any network request',()=>{
 const f=fixture();f.save();
 try{
  for(const args of [[],['--version=-1'],['--version','1.5'],['--version','1','--url','https://receiver.example/hook']]){
   const log=path.join(f.dir,'requests');
   const result=f.run(['wake','remove','--agent','sample-agent',...args,'--json'],{}, {A2A_TEST_FETCH_LOG:log});
   assert.equal(result.status,1,result.stdout+result.stderr);assert.match(JSON.parse(result.stdout).next,/wake preview/);assert.equal(fs.existsSync(log),false);
  }
 }finally{f.clean();}
});
test('hosted remove and unset send only the selected version and show safe JSON outcomes',()=>{
 const f=fixture();f.save();
 try{
  for(const [sub,body] of [['remove',{ok:true,removed:true,already_removed:false,version:8}],['unset',{ok:true,removed:false,already_removed:true,version:7}]]){
   const log=path.join(f.dir,sub);
   // Stub chooses by HTTP method through a test-only preload.
   const preload=path.join(f.dir,'remove-fetch.mjs');
   fs.writeFileSync(preload,`import fs from 'node:fs';globalThis.fetch=async(url,init={})=>{fs.appendFileSync(process.env.REMOVE_LOG,JSON.stringify({url,method:init.method,body:init.body})+'\\n');return Response.json(String(url).endsWith('/capabilities')?{scopes:['wake:write'],wake:{presets:['generic'],removal:true}}:init.method==='DELETE'?${JSON.stringify({...body,token:grant,secret:owner})}:{version:7,url:'https://receiver.example/hook'});};`);
   const result=spawnSync(process.execPath,['--import',preload,path.join(root,'bin/a2a-exposed.mjs'),'wake',sub,'--agent','sample-agent','--version','7','--json'],{encoding:'utf8',env:{...f.env,REMOVE_LOG:log}});
   assert.equal(result.status,0,result.stdout+result.stderr);const outcome=JSON.parse(result.stdout);assert.equal(outcome.code,sub==='remove'?'removed':'already_removed');assert.doesNotMatch(result.stdout,/a2asg_|a2aot_|receiver/);
   const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(calls.map(c=>c.method),['GET','GET','DELETE']);assert.deepEqual(JSON.parse(calls[2].body),{version:7});
  }
  const log=path.join(f.dir,'stale');
  const stale=f.run(['wake','remove','--agent','sample-agent','--version','6','--json'],{'https://control.example/api/v1/agents/sample-agent/wake':{status:200,body:{version:7}}},{A2A_TEST_FETCH_LOG:log});assert.equal(stale.status,1);assert.equal(JSON.parse(stale.stdout).code,'conflict');assert.equal(fs.readFileSync(log,'utf8').trim().split('\n').length,1);
 }finally{f.clean();}
});
test('removal preparation uploads clear only and protects the single-use reference',()=>{
 const f=fixture();f.save();
 try{
  const file=path.join(f.dir,'reference'), log=path.join(f.dir,'requests'),reference='a2awr_'+'d'.repeat(64);
  const result=f.run(['wake','prepare','--agent','sample-agent','--clear','--version','7','--reference-file',file,'--json'],{
   'https://control.example/api/v1/setup/capabilities':{status:200,body:{...capabilities,wake:{...capabilities.wake,removal:true,secret_reference:true}}},
   'https://control.example/api/v1/agents/sample-agent/wake':{status:200,body:{version:7,url:'https://receiver.example/hook'}},
   'https://control.example/api/v1/agents/sample-agent/wake/reference':{status:200,body:{reference,version:7,clear:true}},
  },{A2A_TEST_FETCH_LOG:log});
  assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(fs.readFileSync(file,'utf8').trim(),reference);assert.ok(!result.stdout.includes(reference));
  const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(JSON.parse(calls.at(-1).body),{version:7,clear:true});
 }finally{f.clean();}
});

test('name preflight is anonymous, read-only and returns only supplied-name availability',()=>{
 const f=fixture();f.save();
 try{
  const log=path.join(f.dir,'names');
  const r=f.run(['hosted','names','--name','Windmill','--json'],{
   'https://control.example/api/v1/setup/capabilities':{status:200,body:{...capabilities,preflight:true}},
   'https://control.example/api/v1/setup/name?name=windmill':{status:200,body:{name:'windmill',available:true,reason:'available',owner_token:owner}},
  },{A2A_TEST_FETCH_LOG:log});
  assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(JSON.parse(r.stdout).available,true);assert.doesNotMatch(r.stdout,/a2asg_|a2aot_/);
  const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.ok(calls.every(c=>c.method==='GET'&&!c.headers.authorization));
  const badlog=path.join(f.dir,'invalid');
  for(const args of [[],['--name','bad name'],['--name','-wrong']]){
   const invalid=f.run(['hosted','names',...args,'--json'],{}, {A2A_TEST_FETCH_LOG:badlog});assert.equal(invalid.status,1);assert.equal(fs.existsSync(badlog),false);
  }
 }finally{f.clean();}
});
test('capacity preflight validates numbers, strips unexpected fields and leaves configuration intact',()=>{
 const f=fixture();f.save();
 try{
  const before=fs.readFileSync(f.config,'utf8'),log=path.join(f.dir,'capacity');
  const replies={
   'https://control.example/api/v1/setup/capabilities':{status:200,body:{...capabilities,preflight:true}},
   'https://control.example/api/v1/setup/capacity':{status:200,body:{limit:3,used:1,remaining:2,can_create:true,owner_token:owner,other_agents:['private-agent']}},
  };
  const r=f.run(['hosted','capacity','--json'],replies,{A2A_TEST_FETCH_LOG:log});assert.equal(r.status,0,r.stdout+r.stderr);const data=JSON.parse(r.stdout);assert.equal(data.remaining,2);assert.doesNotMatch(r.stdout,/a2aot_|private-agent/);assert.equal(fs.readFileSync(f.config,'utf8'),before);
  const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.ok(calls.every(c=>c.method==='GET'));assert.equal(calls[1].headers.authorization,`Bearer ${grant}`);
  replies['https://control.example/api/v1/setup/capacity'].body.remaining=99;
  const invalid=f.run(['hosted','capacity','--json'],replies);assert.equal(invalid.status,1);assert.equal(JSON.parse(invalid.stdout).code,'invalid_response');
 }finally{f.clean();}
});
test('create preflights advertised names and capacity before any POST',()=>{
 for(const scenario of ['taken','limit']){
  const f=fixture();f.save();
  try{
   const log=path.join(f.dir,'requests');
   const r=f.run(['hosted','create','--name','windmill','--json'],{
    'https://control.example/api/v1/setup/capabilities':{status:200,body:{...capabilities,preflight:true}},
    'https://control.example/api/v1/setup/name?name=windmill':{status:200,body:{name:'windmill',available:scenario!=='taken',reason:scenario==='taken'?'taken':'available'}},
    'https://control.example/api/v1/setup/capacity':{status:200,body:{limit:1,used:1,remaining:0,can_create:false}},
   },{A2A_TEST_FETCH_LOG:log});
   assert.equal(r.status,1,r.stdout+r.stderr);assert.equal(JSON.parse(r.stdout).code,scenario);
   assert.ok(fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).every(c=>c.method==='GET'));
  }finally{f.clean();}
 }
});

test("hosted upstream requires explicit versions, protects secret inputs, and prints only known results", () => {
 const f=fixture();f.save("HOSTED_AGENT_NAME=sample-agent\n");
 const base="https://control.example/api/v1/agents/sample-agent/upstream",log=path.join(f.dir,"upstream-log");
 const replies={"https://control.example/api/v1/setup/capabilities":{status:200,body:{...capabilities,upstream:{configuration:true,verify:true}}},[base]:{byHeader:{"content-type":{status:200,body:{ok:true,saved:true,removed:true,version:8,token:owner}}},default:{status:200,body:{version:7,configured:true,url:"private-secret",token:owner}}}};
 try {
  const preview=f.run(["hosted","upstream","preview","--agent","sample-agent","--json"],replies);assert.equal(preview.status,0,preview.stdout+preview.stderr);assert.equal(JSON.parse(preview.stdout).version,7);assert.ok(!preview.stdout.includes("private-secret"));
  for(const args of [["set","--url","https://agent.example.net/a2a"],["clear"],["verify"],["clear","--version","6"],["set","--version","7","--url","https://127.0.0.1/a2a"],["clear","--version","7","--url","https://agent.example.net/a2a"]]) {
   fs.writeFileSync(log,"");const r=f.run(["hosted","upstream",...args,"--agent","sample-agent","--json"],replies,{A2A_TEST_FETCH_LOG:log});assert.equal(r.status,1,r.stdout+r.stderr);assert.ok(fs.readFileSync(log,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse).every(c=>c.method==='GET'));
  }
  const missing=f.run(['hosted','upstream','clear','--agent','sample-agent','--json'],{'https://control.example/api/v1/setup/capabilities':{status:0}});assert.equal(JSON.parse(missing.stdout).code,'version');
  const tokenFile=path.join(f.dir,"bearer");fs.writeFileSync(tokenFile,"fixture-bearer\n",{mode:0o600});
  fs.writeFileSync(log,"");
  const result=f.run(["hosted","upstream","set","--agent","sample-agent","--url","https://agent.example.net/a2a","--version","7","--upstream-token-file",tokenFile,"--access-client-id-env","FIXTURE_ACCESS_ID","--access-client-secret-env","FIXTURE_ACCESS_SECRET","--json"],replies,{A2A_TEST_FETCH_LOG:log,FIXTURE_ACCESS_ID:"fixture-id",FIXTURE_ACCESS_SECRET:"fixture-access"});
  assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(JSON.parse(result.stdout).code,"saved");
  const calls=fs.readFileSync(log,"utf8").trim().split("\n").map(JSON.parse),save=calls.find(c=>c.method==='PUT');assert.ok(save);
  const body=JSON.parse(save.body);assert.equal(body.version,7);assert.equal(body.token,'fixture-bearer');assert.equal(body.accessClientSecret,'fixture-access');
  for(const value of ['fixture-bearer','fixture-id','fixture-access',owner,grant]) assert.ok(!(result.stdout+result.stderr).includes(value));
  const verified=f.run(['hosted','upstream','verify','--agent','sample-agent','--version','7','--json'],{...replies,[base+'/verify']:{status:200,body:{ok:false,reason:'access_rejected',detail:owner}}});assert.equal(verified.status,1);assert.equal(JSON.parse(verified.stdout).code,'access_rejected');assert.ok(!verified.stdout.includes(owner));
  const malformed=f.run(['hosted','upstream','verify','--agent','sample-agent','--version','7','--json'],{...replies,[base+'/verify']:{status:200,body:{ok:true,reason:'not-a-known-reason'}}});assert.equal(malformed.status,1);assert.equal(JSON.parse(malformed.stdout).code,'unexpected_response');
  const clear=f.run(['hosted','upstream','clear','--agent','sample-agent','--version','7','--json'],replies);assert.equal(clear.status,0);assert.equal(JSON.parse(clear.stdout).code,'removed');
  fs.chmodSync(tokenFile,0o644);
  const bad=f.run(['hosted','upstream','set','--agent','sample-agent','--url','https://agent.example.net/a2a','--version','7','--upstream-token-file',tokenFile,'--json'],replies);assert.equal(bad.status,1);assert.equal(JSON.parse(bad.stdout).code,'secret_file');
 } finally {f.clean();}
});


test("two-entry hosted config supports Grok preview, set and test without setup grant or explicit agent", () => {
 const f = fixture();
 try {
  for (const source of ["saved", "environment"]) {
   const config = `A2A_BASE_URL=https://example-agent.a2a.exposed\nA2A_OWNER_TOKEN=${owner}\n`;
   fs.writeFileSync(f.config, source === "saved" ? config : "", { mode: 0o600 });
   const credentials = source === "environment" ? { A2A_BASE_URL: "https://example-agent.a2a.exposed", A2A_OWNER_TOKEN: owner } : {};
   for (const command of ["preview", "set", "test"]) {
    const log = path.join(f.dir, `${source}-${command}.requests`);
    const r = f.run(["wake", command, ...(command === "set" ? ["--preset", "grok-bot"] : []), "--json"], {
     "https://a2a.exposed/api/v1/setup/capabilities": { status: 200, body: { ...capabilities, wake: { presets: ["grok-bot"], secret_reference: true } } },
     "https://a2a.exposed/api/v1/agents/example-agent/wake": { status: 200, body: { version: 3, preset: "grok-bot", url: "https://receiver.example/private-hook?key=hidden-query", ok: true, saved: true, code: "204" } },
    }, { ...credentials, WAKE_WEBHOOK_URL: "https://receiver.example/private-hook?key=hidden-query", WAKE_WEBHOOK_KEY: "hidden-wake-key", A2A_TEST_FETCH_LOG: log });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    const authenticated = calls.filter(c => c.headers.authorization);
    assert.ok(authenticated.length > 0);
    assert.ok(authenticated.every(c => c.headers.authorization === `Bearer ${owner}` && c.url.startsWith("https://a2a.exposed/api/v1/agents/example-agent/wake")));
    assert.ok(calls.every(c => !/reference|tenants/.test(c.url)));
    const writes = calls.filter(c => c.method !== "GET");
    assert.deepEqual(writes.map(c => c.method), command === "preview" ? [] : [command === "set" ? "PUT" : "POST"]);
    if (writes.length) {
     const draft = JSON.parse(writes[0].body);
     assert.equal(draft.version, 3); assert.equal(draft.preset, "grok-bot"); assert.equal(draft.key, "hidden-wake-key");
    }
    for (const secret of [owner, "private-hook", "hidden-query", "hidden-wake-key"]) assert.ok(!(r.stdout + r.stderr).includes(secret));
    assert.equal(fs.readFileSync(f.config, "utf8"), source === "saved" ? config : "");
    assert.equal(fs.existsSync(path.join(path.dirname(f.config), "worker")), false);
   }
  }
 } finally { f.clean(); }
});

test("hosted wake failures give hosted recovery and never write or reflect service secrets", () => {
 const f = fixture();
 fs.writeFileSync(f.config, `A2A_BASE_URL=https://example-agent.a2a.exposed\nA2A_OWNER_TOKEN=${owner}\n`, { mode: 0o600 });
 try {
  for (const [status, body] of [[200, { version: 1 }], [401, { error: "invalid_grant", message: owner }], [403, { error: "insufficient_scope", message: owner }], [404, { error: "not_found", message: owner }], [404, "<html>Not found</html>"]]) {
   for (const command of ["set", "test"]) {
    const log = path.join(f.dir, `${status}-${typeof body}-${command}.requests`);
    const r = f.run(["wake", command, "--json"], {
     "https://a2a.exposed/api/v1/agents/example-agent/wake": { status, body },
    }, { A2A_TEST_FETCH_LOG: log });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.code, status === 200 ? "wake_unconfigured" : status === 401 ? "invalid_grant" : status === 403 ? "insufficient_scope" : `http_${status}`);
    assert.match(result.next, /dashboard Wake settings or hosted MCP set_wake/);
    assert.doesNotMatch(r.stdout + r.stderr, /no saved deployment|run init|Worker.*wake set/);
    assert.ok(!(r.stdout + r.stderr).includes(owner));
    const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(calls.every(c => c.method === "GET"));
   }
  }
  const log = path.join(f.dir, "different-agent.requests");
  const r = f.run(["wake", "set", "--agent", "another-agent", "--json"], {}, { A2A_TEST_FETCH_LOG: log });
  assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).code, "login_required");
  assert.equal(fs.existsSync(log), false);
 } finally { f.clean(); }
});

test("verified-import recovery only accepts the exact selected-agent path and performs no retry", () => {
 const expectedPath = '/app/agents/sample-agent/secure-link?import=1';
 const cases = [
  [{code:'verified-import',path:expectedPath}, true],
  [{code:'verified-import',path:'https://evil.example'+expectedPath}, false],
  [{code:'verified-import',path:'//evil.example'+expectedPath}, false],
  [{code:'verified-import',path:'/app/agents/another-agent/secure-link?import=1'}, false],
  [{code:'verified-import',path:expectedPath+'&secret=private-response'}, false],
  [{code:'verified-import',path:expectedPath+'#private-response'}, false],
  [{code:'unknown',path:expectedPath}, false],
  [undefined,false],
 ];
 for (const [recovery,accepted] of cases) for (const sub of ['test','set']) {
  const f=fixture();f.save('HOSTED_AGENT_NAME=sample-agent\n');
  try {
   const log=path.join(f.dir,'requests'), before=fs.readFileSync(f.config,'utf8');
   const endpoint='https://control.example/api/v1/agents/sample-agent/wake';
   const refusal={ok:false,saved:false,code:'cloudflare-target-unsupported',recovery,message:'private-response',proof:grant};
   const r=f.run(['wake',sub,'--agent','sample-agent','--url','https://receiver.example/private-hook','--preset','hermes','--json'],{
    [endpoint]:{status:200,body:sub==='set'?{version:7,...refusal}:{version:7}},
    [endpoint+'/test']:{status:200,body:refusal},
   },{WAKE_HMAC_SECRET:'private-hmac',A2A_TEST_FETCH_LOG:log});
   assert.equal(r.status,1,r.stdout+r.stderr);
   const result=JSON.parse(r.stdout);assert.equal(result.saved,false);
   if(accepted){assert.equal(result.recovery_url,'https://control.example'+expectedPath);assert.match(result.next,/Import or manage your existing tunnel/);}
   else {assert.equal(result.recovery_url,undefined);assert.match(result.next,/supported public HTTPS route, polling/);}
   for(const hidden of ['evil.example','another-agent','private-response','private-hmac',grant,'private-hook']) assert.equal((r.stdout+r.stderr).includes(hidden),false);
   assert.equal(fs.readFileSync(f.config,'utf8'),before);
   const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
   assert.equal(calls.filter(c=>c.method!=='GET').length,1);
  } finally {f.clean();}
 }
});

test('capabilities exposes only a strict boolean verified-import switch', () => {
 for (const value of [true,false,undefined,'true']) {
  const f=fixture();f.save();
  try {
   const r=f.run(['hosted','capabilities','--json'],{'https://control.example/api/v1/setup/capabilities':{status:200,body:{...capabilities,wake:{...capabilities.wake,verified_import:value}}}});
   assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(JSON.parse(r.stdout).verified_import,value===true);
  } finally {f.clean();}
 }
});

test('hosted relay file test/save validates explicit choices and never renders secrets or receipts', () => {
 const f=fixture();f.save('HOSTED_AGENT_NAME=sample-agent\n');
 const endpoint='https://control.example/api/v1/agents/sample-agent/wake/relay';
 const receipt='a2arr_'+'c'.repeat(64), signing='fixture-signing-secret-do-not-print';
 const file=path.join(f.dir,'relay.receipt'), hmac=path.join(f.dir,'hmac');fs.writeFileSync(hmac,signing,{mode:0o600});
 const replies={'https://control.example/api/v1/setup/capabilities':{status:200,body:{...capabilities,wake:{...capabilities.wake,relay:true}}},[endpoint]:{status:200,body:{ok:true,protocolVersion:1,version:7,transport:'webhook',preset:'generic',connector:{connectorId:'default',generation:2,connected:true},token:owner}},[endpoint+'/test']:{status:200,body:{ok:true,version:7,expires_in:300,secretReference:receipt,secret:signing}}};
 const args=['relay','wake','test','--agent','sample-agent','--config-version','7','--generation','2','--connector-id','default','--preset','hermes','--hmac-secret-file',hmac,'--receipt-file',file,'--json'];
 try {
  const status=f.run(['relay','wake','status','--agent','sample-agent','--json'],replies);assert.equal(status.status,0,status.stdout+status.stderr);assert.equal(JSON.parse(status.stdout).connector.generation,2);assert.ok(!status.stdout.includes(owner));
  const log=path.join(f.dir,'relay.log');const tested=f.run(args,replies,{A2A_TEST_FETCH_LOG:log});assert.equal(tested.status,0,tested.stdout+tested.stderr);
  assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(fs.readFileSync(file,'utf8').trim(),receipt);
  for(const value of [receipt,signing,owner,grant]) assert.ok(!(tested.stdout+tested.stderr).includes(value));
  const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);const body=JSON.parse(calls.at(-1).body);assert.deepEqual(body,{version:7,generation:2,connectorId:'default',preset:'hermes',keyHeader:'',key:'',hmacSecret:signing});
  assert.equal(f.run(args,replies).status,1);assert.equal(fs.readFileSync(file,'utf8').trim(),receipt);
  const failedFile=path.join(f.dir,'failed-receipt');
  const refused=f.run(args.map(x=>x===file?failedFile:x),{...replies,[endpoint+'/test']:{status:409,body:{ok:false,code:'local_http',localStatus:401,secret:signing}}});
  assert.equal(refused.status,1);assert.equal(JSON.parse(refused.stdout).code,'local_http');assert.equal(JSON.parse(refused.stdout).localStatus,401);assert.equal(fs.existsSync(failedFile),false);assert.ok(!refused.stdout.includes(signing));assert.match(JSON.parse(refused.stdout).next,/relay wake status/);
  const save=['relay','wake','save','--agent','sample-agent','--config-version','7','--receipt-file',file,'--json'];
  const missing=f.run(save,replies);assert.equal(missing.status,1);assert.equal(JSON.parse(missing.stdout).code,'confirmation');
  const saved=f.run([...save,'--confirm'],{...replies,[endpoint]:{status:200,body:{ok:true,saved:true,version:8,secretReference:receipt}}});assert.equal(saved.status,0,saved.stdout);assert.equal(JSON.parse(saved.stdout).code,'saved');assert.ok(!saved.stdout.includes(receipt));
  fs.chmodSync(file,0o644);assert.equal(JSON.parse(f.run([...save,'--confirm'],replies).stdout).code,'receipt_file');fs.chmodSync(file,0o600);
  const link=path.join(f.dir,'receipt-link');fs.symlinkSync(file,link);assert.equal(JSON.parse(f.run([...save.map(x=>x===file?link:x),'--confirm'],replies).stdout).ok,false);
  for (const pair of [['--config-version','7'],['--generation','2'],['--connector-id','default'],['--preset','hermes']]) {
   const invalid=args.filter((value,index)=>index!==args.indexOf(pair[0])&&index!==args.indexOf(pair[0])+1);assert.equal(f.run(invalid,replies).status,1);
  }
 } finally { f.clean(); }
});

test('hosted relay removal and MCP removal receipt are distinct from connector revoke', () => {
 const f=fixture();f.save('HOSTED_AGENT_NAME=sample-agent\n');const endpoint='https://control.example/api/v1/agents/sample-agent/wake/relay';
 const replies={'https://control.example/api/v1/setup/capabilities':{status:200,body:{...capabilities,wake:{...capabilities.wake,relay:true}}},[endpoint]:{status:200,body:{ok:true,removed:true,version:8}},[endpoint+'/reference']:{status:200,body:{ok:true,secretReference:'a2arr_'+'e'.repeat(64),expires_in:300,version:7,clear:true}}};
 try {
  const result=f.run(['relay','wake','remove','--agent','sample-agent','--config-version','7','--confirm','--json'],replies);assert.equal(result.status,0,result.stdout);assert.match(JSON.parse(result.stdout).next,/Revoke.*separately/);
  const file=path.join(f.dir,'removal-receipt');const prepared=f.run(['relay','wake','prepare','--clear','--confirm','--agent','sample-agent','--config-version','7','--receipt-file',file,'--json'],replies);assert.equal(prepared.status,0,prepared.stdout);assert.match(fs.readFileSync(file,'utf8'),/^a2arr_/);assert.ok(!prepared.stdout.includes('a2arr_'));
  const unsupported=f.run(['relay','wake','status','--agent','sample-agent','--json']);assert.equal(unsupported.status,1);assert.equal(JSON.parse(unsupported.stdout).code,'unsupported');
 } finally { f.clean(); }
});
