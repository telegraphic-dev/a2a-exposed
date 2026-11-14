import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { d1 } from "./d1.ts";
import { MIGRATIONS } from "../src/migrations.ts";
import { upgradeStatus } from "../src/upgrade-status.ts";

test("upgrade status reads ledger without applying missing migrations and tolerates a missing ledger", async () => {
 assert.deepEqual((await import("../src/version.ts")).MIGRATION_NAMES, MIGRATIONS.map(m => m.name));
 const DB = d1(new URL("../migrations/", import.meta.url));
 await DB.prepare("DROP TABLE IF EXISTS d1_migrations").run();
 assert.equal((await upgradeStatus(DB, "0.8.58", false)).schema.status, "unknown");
 await DB.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT NOT NULL)").run();
 for (const [i,m] of MIGRATIONS.entries()) if (m.name !== "0017_wake_routing.sql") await DB.prepare("INSERT INTO d1_migrations(id,name) VALUES(?,?)").bind(i, m.name).run();
 const result = await upgradeStatus(DB, "0.8.58", false);
 assert.equal(result.management, "self-hosted"); assert.deepEqual(result.schema.pending, ["0017_wake_routing.sql"]);
 assert.equal((await upgradeStatus(DB, "0.8.58", true)).management, "platform");
 const rows = (await DB.prepare("SELECT name FROM d1_migrations").all()).results; assert.equal(rows.length, MIGRATIONS.length-1);
});

test("HTTP upgrade facts are owner-only; HEAD and reads never flush pending work", async () => {
 const env: any = { DB: d1(new URL("../migrations/", import.meta.url)), PUBLIC_URL: "https://agent.example.com", OWNER_TOKEN: "fixture-owner" };
 await env.DB.prepare("INSERT INTO wakes(context_id,peer,last_sent_ms,pending_json) VALUES('context','ada',0,'{}')").run();
 for (const method of ["GET", "HEAD"]) {
  const pending: Promise<unknown>[] = [];
  const response = await worker.fetch(new Request(env.PUBLIC_URL+"/owner/upgrade-status", { method, headers: { authorization: "Bearer fixture-owner" } }), env, { waitUntil: (p: Promise<unknown>) => pending.push(p) } as any);
  assert.equal(response.status, 200); assert.equal(pending.length, 0);
  if (method === "HEAD") assert.equal(await response.text(), "");
  else { const data: any = await response.json(); assert.equal(data.management, "self-hosted"); assert.ok(data.schema.expected.includes("0017_wake_routing.sql")); }
 }
 const response = await worker.fetch(new Request(env.PUBLIC_URL+"/owner/upgrade-status"), env, { waitUntil() {} } as any);
 assert.equal(response.status, 401);
});
