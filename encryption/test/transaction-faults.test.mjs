// #384: SQLite faults inside a running local-state transaction. Each fault must roll back the
// whole transaction, leave a store that still validates, and refuse with fixed guidance.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LocalState } from "../local-state.mjs";

const child = fileURLToPath(new URL("./fixtures/transaction-fault-process.mjs", import.meta.url));
const init = state => state.initialize({ store: "file", cardUrl: "https://local.example.com/card" });
const canary = state => state.db.prepare("SELECT value FROM meta WHERE key='fault_canary_384'").get();
const internals = /\n\s+at |SQLITE_|sqlite3|\/tmp\/|\/var\//i;

function fixture(t) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-tx-fault-"));
 t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 const state = new LocalState(dir, { create: true }); state.close();
 return dir;
}
function holdTransaction(t, dir, mode) {
 const proc = spawn(process.execPath, [child, dir, mode], { stdio: ["ignore", "pipe", "pipe"] });
 t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL"); });
 return new Promise((resolve, reject) => {
  let out = "", err = "";
  proc.stdout.on("data", chunk => { out += chunk; if (out.includes("IN_TX")) resolve(proc); });
  proc.stderr.on("data", chunk => { err += chunk; });
  proc.on("exit", code => reject(new Error(`fault process exited ${code} before its transaction: ${err}`)));
 });
}
const killed = proc => new Promise(resolve => { proc.once("exit", resolve); proc.kill("SIGKILL"); });

test("a process killed inside a write transaction leaves no partial row and no stale lock", { timeout: 30000 }, async t => {
 const dir = fixture(t);
 const proc = await holdTransaction(t, dir, "locked");
 await killed(proc);
 // A read-only open (status, history) works on the crashed store before any writer recovers it.
 const reader = new LocalState(dir); t.after(() => reader.close());
 assert.equal(reader.status().configured, false);
 assert.equal(canary(reader), undefined, "the uncommitted canary is not visible");
 const writer = new LocalState(dir, { write: true }); t.after(() => writer.close());
 assert.equal(canary(writer), undefined);
 assert.equal(writer.db.prepare("PRAGMA quick_check(1)").get().quick_check, "ok");
 const created = await init(writer);
 assert.equal(writer.status().identities[0].id, created.id, "the next write commits normally");
});

test("another process holding the write lock refuses with state_busy and changes nothing", { timeout: 30000 }, async t => {
 const dir = fixture(t);
 const proc = await holdTransaction(t, dir, "raw");
 const state = new LocalState(dir, { write: true }); t.after(() => state.close());
 const started = Date.now();
 await assert.rejects(init(state), error => error.code === "state_busy" && /Another local process holds the store.*no automatic retry or replacement/.test(error.message) && !internals.test(error.message));
 assert.ok(Date.now() - started >= 4000, "the busy timeout was honoured before refusing");
 assert.equal(state.status().configured, false, "no identity was created");
 assert.deepEqual(fs.readdirSync(path.join(dir, "encryption")).filter(f => f.endsWith(".key")), [], "no key file was left behind");
 await killed(proc);
 await init(state);
 assert.equal(state.status().identities.length, 1, "the same call succeeds once the lock is released");
});

test("a full disk inside a transaction rolls back every earlier write", async t => {
 const dir = fixture(t);
 const state = new LocalState(dir, { write: true }); t.after(() => state.close());
 const pages = state.db.prepare("PRAGMA page_count").get().page_count;
 await assert.rejects(state.locked(async () => {
  state.db.prepare("INSERT INTO meta VALUES('fault_canary_384','uncommitted')").run();
  // SQLITE_FULL: the store may not grow past its current size, as on a full disk.
  state.db.exec(`PRAGMA max_page_count=${pages}`);
  state.db.prepare("INSERT INTO meta VALUES('fault_filler_384',?)").run("x".repeat(256 * 1024));
 }), error => error.code === "state_unavailable" && !internals.test(error.message));
 state.db.exec("PRAGMA max_page_count=1073741823");
 assert.equal(canary(state), undefined, "the earlier write in the same transaction was rolled back");
 assert.equal(state.db.prepare("PRAGMA quick_check(1)").get().quick_check, "ok");
 await init(state);
 assert.equal(state.status().identities.length, 1);
});

test("an action that fails after partial writes rolls back and hides internals", async t => {
 const dir = fixture(t);
 const state = new LocalState(dir, { write: true }); t.after(() => state.close());
 await assert.rejects(state.locked(async () => {
  state.db.prepare("INSERT INTO meta VALUES('fault_canary_384','uncommitted')").run();
  throw new Error(`internal failure at ${dir}`);
 }), error => error.code === "state_unavailable" && !error.message.includes(dir) && !internals.test(error.message));
 assert.equal(canary(state), undefined);
 assert.equal(state.db.isTransaction, false, "no transaction is left open");
 await init(state);
 assert.equal(state.status().identities.length, 1);
});
