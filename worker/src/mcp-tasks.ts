// Durable read-only observation. No delivery, inbox acknowledgement, or peer mutation.
import { CreateTaskResultV2Schema, GetTaskResultV2Schema, GetTaskRequestV2Schema, UpdateTaskRequestV2Schema, CancelTaskRequestV2Schema, hasTaskClientCapabilityV2 } from "@modelcontextprotocol/ext-tasks/core/v2";
import type { SqlDb } from "./tenancy.ts";
import { completedToolResult, withCompletedResult } from "./task-result.ts";
export const EXTENSION = "io.modelcontextprotocol/tasks";
export const negotiated = (caps: unknown) => hasTaskClientCapabilityV2({ _meta: { "io.modelcontextprotocol/clientCapabilities": caps } });
const TTL = 86_400_000;
const terminal = new Set(["completed", "failed", "cancelled"]);
export class TaskError extends Error {}
async function source(db: SqlDb, id: string) {
 const row: any = await db.prepare("SELECT id, state, status_json, artifacts_json FROM tasks WHERE id = ?").bind(id).first();
 if (!row) throw new TaskError("Unknown inbound task; list available tasks with inbox first.");
 return row;
}
function finished(row: any) {
 return !["submitted", "working", "input-required"].includes(row.state);
}
function complete(snapshot: any, row: any) {
 return { ...snapshot, status: "completed", lastUpdatedAt: new Date().toISOString(), result: completedToolResult(JSON.stringify({ taskId: row.id, state: row.state, status: JSON.parse(row.status_json), artifacts: JSON.parse(row.artifacts_json) })) };
}
export async function create(db: SqlDb, grant: string, id: unknown) {
 if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(id)) throw new TaskError("taskId must be an inbound id from inbox.");
 const row = await source(db, id);
 const now = Date.now();
 await db.prepare("DELETE FROM mcp_tasks WHERE expires_ms <= ?").bind(now).run();

 let snapshot: any = { taskId: crypto.randomUUID(), status: "working", createdAt: new Date(now).toISOString(), lastUpdatedAt: new Date(now).toISOString(), ttlMs: TTL, pollIntervalMs: 5000 };
 if (finished(row)) snapshot = complete(snapshot, row);
 const result = CreateTaskResultV2Schema.parse({ ...snapshot, resultType: "task" });
 const inserted = await db.prepare("INSERT INTO mcp_tasks (id, grant_label, source_id, created_at, expires_ms, snapshot_json) SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM mcp_tasks WHERE grant_label = ?) < 100 AND EXISTS (SELECT 1 FROM tasks WHERE id = ?)").bind(snapshot.taskId, grant, id, snapshot.createdAt, now + TTL, JSON.stringify(snapshot), grant, id).run();
 if (inserted.meta.changes !== 1) throw new TaskError("Source unavailable or observation limit reached; list inbox or wait for handles to expire (24 hours).");
 return result;
}
export async function request(db: SqlDb, grant: string, msg: any) {
 const schema = msg.method === "tasks/get" ? GetTaskRequestV2Schema : msg.method === "tasks/update" ? UpdateTaskRequestV2Schema : CancelTaskRequestV2Schema;
 if (!schema.safeParse(msg).success) throw new TaskError("Invalid task request parameters.");
 const row: any = await db.prepare("SELECT m.* FROM mcp_tasks m JOIN tasks t ON t.id = m.source_id WHERE m.id = ? AND m.grant_label = ? AND m.expires_ms > ?").bind(msg.params.taskId, grant, Date.now()).first();
 if (!row) throw new TaskError("Unknown or expired observation task.");
 let snapshot = JSON.parse(row.snapshot_json);
 if (!terminal.has(snapshot.status)) {
  // Prefer an already observable completion. CAS makes the first terminal transition immutable.
  const current = await source(db, row.source_id);
  if (finished(current)) snapshot = complete(snapshot, current);
  else if (msg.method === "tasks/cancel") snapshot = { ...snapshot, status: "cancelled", lastUpdatedAt: new Date().toISOString(), statusMessage: "Observation stopped. A2A delivery and the source task are unchanged." };
  if (terminal.has(snapshot.status)) {
   await db.prepare("UPDATE mcp_tasks SET snapshot_json = ? WHERE id = ? AND grant_label = ? AND snapshot_json = ?").bind(JSON.stringify(snapshot), row.id, grant, row.snapshot_json).run();
   const saved: any = await db.prepare("SELECT snapshot_json FROM mcp_tasks WHERE id = ? AND grant_label = ?").bind(row.id, grant).first();
   if (!saved) throw new TaskError("Unknown or expired observation task.");
   snapshot = JSON.parse(saved.snapshot_json);
  }
 }
 // This observer issues no input requests; unknown or already fulfilled response keys are ignored.
 return msg.method === "tasks/get" ? GetTaskResultV2Schema.parse({ ...withCompletedResult(snapshot, (m) => new TaskError(m)), resultType: "complete" }) : { resultType: "complete" };
}
