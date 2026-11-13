import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { session, serve, projectRow, TOOLS } from "../lib/local-mcp.mjs";

const request = (method, params, id = 1) => ({ jsonrpc: "2.0", id, method, params });
const initialize = request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
async function ready(execute) {
 const handle = session({}, execute);
 assert.equal((await handle(initialize)).result.protocolVersion, "2025-11-25");
 assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
 return handle;
}
test("stdio MCP negotiates lifecycle, lists only bounded local send/read tools", async () => {
 const handle = session();
 assert.equal((await handle(request("tools/list"))).error.code, -32000);
 assert.deepEqual((await handle(request("ping"))).result, {});
 assert.equal((await handle({ ...initialize, params: { ...initialize.params, protocolVersion: "future" } })).result.protocolVersion, "2025-11-25");
 await handle({ jsonrpc: "2.0", method: "notifications/initialized" });
 const names = (await handle(request("tools/list"))).result.tools.map(t => t.name);
 assert.deepEqual(names, ["list_peers", "send", "inbox", "history"]);
 assert.equal(TOOLS.find(t => t.name === "inbox").annotations.readOnlyHint, false);
 assert.equal((await handle(initialize)).error.code, -32602);
 assert.equal((await handle(request("tools/list", { cursor: "bad" }))).error.code, -32602);
 assert.equal((await handle([])).error.code, -32600);
 assert.equal((await handle(request("resources/list"))).error.code, -32601);
});
test("tool input rejects hidden admin/config/consent choices before execution", async () => {
 const calls = [];
 const handle = await ready(async (...args) => { calls.push(args); return { delivered: true }; });
 for (const [name, args] of [["send", {}], ["send", { to: "bob", text: "x", protocol: "2" }], ["send", { to: "bob", text: "x", token: "secret" }], ["send", { to: "bob", text: "x", "allow-os-consent": true }], ["history", { contextId: "a", limit: 201 }], ["history", { contextId: "a", limit: 1.5 }], ["inbox", { all: "true" }], ["reply", { text: "x" }], ["pair_approve", {}]]) {
  assert.equal((await handle(request("tools/call", { name, arguments: args }))).error.code, -32602);
 }
 assert.equal(calls.length, 0);
 assert.equal(await handle({ jsonrpc: "2.0", method: "tools/call", params: { name: "send", arguments: { to: "bob", text: "not sent" } } }), null);
 const result = await handle(request("tools/call", { name: "send", arguments: { to: "bob", text: "valid", protocol: "1.0" } }));
 assert.deepEqual(result.result.structuredContent, { delivered: true });
 assert.equal(calls.length, 1);
});
test("unexpected exceptions never expose private keys or provider text", async () => {
 const handle = await ready(async () => { throw Error("privateKey=secret-fixture-credential"); });
 const result = await handle(request("tools/call", { name: "list_peers" }));
 assert.equal(result.result.isError, true);
 assert.equal(JSON.stringify(result).includes("secret-fixture"), false);
});
test("projection strips ciphertext, server structures and refused plaintext", () => {
 const raw = { task_id: "task", context_id: "context", peer: "bob", text: "plaintext downgrade", data: { sealed: "ciphertext" }, sealed: "ciphertext", artifacts: ["secret"], status: { text: "secret" } };
 const hidden = projectRow(raw);
 assert.equal(hidden.taskId, "task"); assert.equal(hidden.contextId, "context");
 assert.equal(hidden.reason, "server_readable_content_withheld");
 for (const value of ["plaintext downgrade", "ciphertext", "secret"]) assert.equal(JSON.stringify(hidden).includes(value), false);
 const opened = projectRow({ ...raw, text: "verified", locallyOpened: true, encrypted: true, historical: true });
 assert.equal(opened.text, "verified");assert.equal(opened.encryption, "e2e");assert.equal(opened.historical, true);
 assert.equal(JSON.stringify(opened).includes("ciphertext"), false);
});
async function wire(chunks) {
 let out = "";
 const output = new Writable({ write(chunk, _enc, cb) { out += chunk.toString(); cb(); } });
 await serve({}, Readable.from(chunks), output);
 return out.trim().split("\n").map(s => JSON.parse(s));
}
test("framing accepts split UTF-8 and multiple lines; stdout is only JSON-RPC", async () => {
 const bytes = Buffer.from(JSON.stringify(initialize) + "\n" + JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n" + JSON.stringify(request("tools/list", {}, "é")) + "\n");
 const split = bytes.indexOf(Buffer.from("é")) + 1;
 const lines = await wire([bytes.subarray(0, split), bytes.subarray(split)]);
 assert.equal(lines.length, 2);assert.equal(lines[1].id, "é");
 assert.equal((await wire([Buffer.from([0xff, 10])]))[0].error.code, -32700);
 assert.equal((await wire([Buffer.from('{"jsonrpc":')]))[0].error.code, -32700);
 assert.equal((await wire([Buffer.from('[]\n')]))[0].error.code, -32600);
 await assert.rejects(wire([Buffer.alloc(1024 * 1024 + 1, 32)]), /1 MiB/);
});

test("real CLI preserves stdout framing, blocks disabled sends and creates no config", t => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-mcp-"));
 t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 const config = path.join(dir, "new-config");
 const frames = [initialize, { jsonrpc: "2.0", method: "notifications/initialized" }, request("tools/call", { name: "send", arguments: { to: "bob", text: "never sent" } }, 2), request("tools/call", { name: "list_peers" }, 3)];
 const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(A2A_|WAKE_|PEER_|CF_|CLOUDFLARE_|NODE_OPTIONS$)/.test(k)));
 const bin = fileURLToPath(new URL("../bin/a2a-exposed.mjs", import.meta.url));
 const result = spawnSync(process.execPath, [bin, "--config-dir", config, "mcp"], { env, input: frames.map(f => JSON.stringify(f)).join("\n") + "\n", encoding: "utf8", timeout: 10000 });
 assert.equal(result.status, 0, result.stderr);
 const lines = result.stdout.trim().split("\n").map(s => JSON.parse(s));
 assert.equal(lines.length, 3); assert.equal(lines[1].result.isError, true);
 assert.match(lines[1].result.content[0].text, /disabled/);
 assert.deepEqual(lines[2].result.structuredContent, { peers: [], encryptionEnabled: false });
 assert.equal(fs.existsSync(config), false);
 const invalid = spawnSync(process.execPath, [bin, "--config-dir", config, "mcp", "--token", "must-not-echo"], { env, encoding: "utf8", timeout: 10000 });
 assert.equal(invalid.status, 1);assert.equal(invalid.stdout, "");assert.equal(invalid.stderr.includes("must-not-echo"), false);
});
