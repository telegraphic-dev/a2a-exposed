import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as U from "../lib/update.mjs";

const expected = ["0001_init.sql", "0002_wake_budget.sql"];
test("CLI and Worker reminders are independent, exact, safe and self-host-only", () => {
 const args = { selfHosted: true, expected };
 const current = { version: "0.8.58", management: "self-hosted", schema: { status: "known", applied: expected } };
 assert.deepEqual(U.updates("0.8.58", { latest: "0.8.58" }, current, args), []);
 const cli = U.updates("0.8.57", { latest: "0.8.58" }, current, { ...args, selfHosted: false });
 assert.equal(cli.length, 1); assert.equal(cli[0].component, "cli"); assert.equal(cli[0].command, "npx -y a2a-exposed@latest");
 const worker = U.updates("0.8.58", null, { ...current, version: "0.8.20", schema: { status: "unknown" } }, args);
 assert.equal(worker.length, 1); assert.equal(worker[0].pendingMigrations, null); assert.match(worker[0].message, /migration status unknown.*Ask the owner/);
 const schema = U.updates("0.8.58", null, { ...current, schema: { status: "known", applied: expected.slice(0, 1) } }, args);
 assert.deepEqual(schema[0].pendingMigrations, [expected[1]]);
 assert.match(schema[0].message, /1 pending D1 migration/);
 assert.deepEqual(U.updates("0.8.58", null, { ...current, version: "0.8.20", management: "platform" }, args), []);
 assert.deepEqual(U.updates("0.8.58", null, null, args), []);
 assert.match(U.updates("0.8.58", null, { versionReported: false, schema: { status: "unknown" } }, args)[0].message, /predates version reporting/);
 assert.deepEqual(U.updates("0.8.58", { latest: "9.0.0; echo PRIVATE" }, current, args), []);
 assert.deepEqual(U.updates("0.8.58", null, { version: "PRIVATE", command: "bad", schema: { status: "unknown" } }, args), []);
 assert.equal(U.newer("nonsense", "0.8.58"), false);
});

test("cached reminders are once per day, suppressed by opt-outs, and require no foreground network", t => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-reminders-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 const env = { XDG_CACHE_HOME: dir }, here = "/usr/lib/node_modules/a2a-exposed/lib/update.mjs";
 const file = U.cacheFile(env); fs.mkdirSync(path.dirname(file), { recursive: true });
 fs.writeFileSync(file, JSON.stringify({ latest: "9.9.9", checkedAt: Date.now() }));
 const opts = { env, here };
 assert.equal(U.cachedUpdates("0.8.58", opts).length, 1);
 assert.equal(U.cachedUpdates("0.8.58", opts).length, 0);
 assert.equal(U.cachedUpdates("0.8.58", { ...opts, all: true }).length, 1);
 const cache = JSON.parse(fs.readFileSync(file)); cache.notifiedAt = Date.now() - U.CHECK_INTERVAL_MS - 1; fs.writeFileSync(file, JSON.stringify(cache));
 assert.equal(U.cachedUpdates("0.8.58", opts).length, 1);
 for (const opt of ["A2A_NO_UPDATE_CHECK", "DO_NOT_TRACK", "NO_UPDATE_NOTIFIER", "CI"]) assert.deepEqual(U.cachedUpdates("0.8.58", { env: { ...env, [opt]: "1" }, here, all: true }), []);
 assert.deepEqual(U.cachedUpdates("0.8.58", { env, here: "/source/cli/lib/update.mjs" }), []);
 fs.writeFileSync(file, "invalid-json"); assert.deepEqual(U.cachedUpdates("0.8.58", opts), []);
 assert.ok(U.expectedMigrations().includes("0017_wake_routing.sql"));
});

test("background Worker refresh uses protected config and safe legacy fallback; offline never fails a command", t => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-refresh-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 const routes = path.join(dir, "routes.json"), cache = path.join(dir, "worker.json"), log = path.join(dir, "fetch.log");
 const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(A2A_|WAKE_|PEER_|CF_|CLOUDFLARE_)/.test(k)));
 Object.assign(env, { A2A_CONFIG_DIR: dir, A2A_WORKER_NAME: "fixture-worker", A2A_BASE_URL: "https://agent.example.com", A2A_OWNER_TOKEN: "fixture-owner", A2A_TEST_FETCH_ROUTES: routes, A2A_TEST_FETCH_LOG: log });
 const run = body => {
  fs.writeFileSync(routes, JSON.stringify(body));
  return spawnSync(process.execPath, ["--import", fileURLToPath(new URL("./fetch-stub.mjs", import.meta.url)), fileURLToPath(new URL("../lib/update.mjs", import.meta.url)), "--refresh-worker", cache], { env, encoding: "utf8" });
 };
 const prefix = "https://agent.example.com";
 assert.equal(run({ [prefix + "/owner/upgrade-status"]: { status: 200, body: { version: "0.8.20", management: "self-hosted", schema: { status: "known", applied: expected } } } }).status, 0);
 assert.deepEqual(JSON.parse(fs.readFileSync(cache)).schema.applied, expected);
 assert.equal(fs.statSync(cache).mode & 0o777, 0o600);
 assert.equal(fs.readFileSync(cache, "utf8").includes("fixture-owner"), false);
 assert.equal(run({ [prefix + "/owner/upgrade-status"]: { status: 404, body: {} }, [prefix + "/health"]: { status: 200, body: { ok: true, version: "0.8.19" } } }).status, 0);
 assert.equal(JSON.parse(fs.readFileSync(cache)).schema.status, "unknown");
 const before = fs.readFileSync(cache, "utf8");
 assert.equal(run({ [prefix]: { status: 0 } }).status, 0);
 assert.equal(fs.readFileSync(cache, "utf8"), before);
 assert.equal(run({ [prefix]: { status: 401, body: { error: "PRIVATE" } } }).stdout, "");
 assert.equal(fs.readFileSync(cache, "utf8"), before);
 const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
 assert.equal(calls.find(c => c.url.endsWith("/owner/upgrade-status")).headers.authorization, "Bearer fixture-owner");
 assert.equal(calls.find(c => c.url.endsWith("/health")).headers.authorization, undefined);
});

test("installed local MCP exposes one cached update field without foreground fetch or deployment", t => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-mcp-update-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 const installed = path.join(dir, "node_modules", "a2a-exposed"); fs.mkdirSync(installed, { recursive: true });
 fs.cpSync(fileURLToPath(new URL("../lib", import.meta.url)), path.join(installed, "lib"), { recursive: true });
 fs.copyFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), path.join(installed, "package.json"));
 const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(A2A_|WAKE_|PEER_|CF_|CLOUDFLARE_|CI$|DO_NOT_TRACK$|NO_UPDATE_NOTIFIER$)/.test(k)));
 Object.assign(env, { A2A_CONFIG_DIR: dir, XDG_CACHE_HOME: dir });
 const file = U.cacheFile(env); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ checkedAt: Date.now(), latest: "9.9.9" }));
 const url = pathToFileURL(path.join(installed, "lib", "local-mcp.mjs")).href;
 const script = `import {session} from ${JSON.stringify(url)}; const h=session({}, async()=>({rows:[]})); await h({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture'}}});await h({jsonrpc:'2.0',method:'notifications/initialized'});for(let i=0;i<2;i++)console.log(JSON.stringify(await h({jsonrpc:'2.0',id:i+2,method:'tools/call',params:{name:'list_peers',arguments:{}}})));`;
 const p = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { env, encoding: "utf8" });
 assert.equal(p.status, 0, p.stderr);
 const results = p.stdout.trim().split("\n").map(JSON.parse);
 assert.equal(results[0].result.structuredContent.update[0].component, "cli");
 assert.equal(results[1].result.structuredContent.update, undefined);
});
