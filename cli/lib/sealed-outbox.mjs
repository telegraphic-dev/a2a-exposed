// Local send records for encrypted sends. A record holds the signed envelope (ciphertext)
// and public routing only, never opened content. It exists before the first network byte,
// so an uncertain outcome can be reconciled by re-submitting the same bytes and message ID.
import fs from "node:fs";
import path from "node:path";
import * as C from "./config.mjs";
import { CliError } from "./a2a.mjs";
const MAX_RECORD = 4 * 1024 * 1024, MAX_LIST = 200;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
export const STATES = ["transmitting", "unknown", "refused", "delivered"];
const KEYS = ["v", "alias", "endpoint", "protocol", "localId", "pinDigest", "contextId", "messageId", "requestedTaskId", "taskId", "state", "createdMs", "updatedMs", "recoveries", "envelope"].sort().join();
const fail = (message, code) => { const error = new CliError(message); error.code = code; throw error; };
export const damaged = id => `The local send record for message ${id} is damaged or unreadable. It was left unchanged for inspection and cannot be recovered or resent. Ask the recipient's owner to check their inbox history for message ${id}. Do not send a new message until they confirm it did not arrive.`;
const root = () => path.join(C.CONFIG_DIR, "sealed-outbox");
function folder(create) {
 const dir = root();
 let stat;
 try { stat = fs.lstatSync(dir); }
 catch (error) {
  if (error.code !== "ENOENT" || !create) return null;
  fs.mkdirSync(dir, { mode: 0o700 }); stat = fs.lstatSync(dir);
 }
 // A symlink or loosened folder could redirect or expose records; refuse instead of following it.
 if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) fail("The local send-record folder is not a private directory. It was left unchanged. Nothing was sent; inspect the config directory before any encrypted send.", "outbox_unsafe");
 return dir;
}
function fileFor(id) {
 if (typeof id !== "string" || !ID.test(id)) fail("Select a message ID from keys outbox --json.", "outbox_id");
 return id + ".json";
}
function syncDir(dir) { try { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch {} }
function writeExclusive(file, record) {
 const fd = fs.openSync(file, "wx", 0o600);
 try { fs.writeFileSync(fd, JSON.stringify(record) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function valid(record, id) {
 return record && typeof record === "object" && !Array.isArray(record) && Object.keys(record).sort().join() === KEYS && record.v === 1 && record.messageId === id
  && STATES.includes(record.state) && ["0.3", "1.0"].includes(record.protocol) && typeof record.alias === "string" && typeof record.endpoint === "string"
  && typeof record.localId === "string" && typeof record.pinDigest === "string" && typeof record.contextId === "string" && ID.test(record.contextId)
  && (record.requestedTaskId === null || (typeof record.requestedTaskId === "string" && ID.test(record.requestedTaskId)))
  && (record.taskId === null || (typeof record.taskId === "string" && ID.test(record.taskId))) && (record.state !== "delivered" || record.taskId !== null)
  && [record.createdMs, record.updatedMs].every(ms => Number.isSafeInteger(ms) && ms >= 0 && Number.isFinite(new Date(ms).getTime())) && Number.isSafeInteger(record.recoveries) && record.recoveries >= 0
  && record.envelope && typeof record.envelope === "object" && !Array.isArray(record.envelope)
  // Public binding only; send --recover also authenticates the envelope before release.
  && record.envelope.header?.messageId === id && record.envelope.header.contextId === record.contextId && record.envelope.header.taskId === record.requestedTaskId;
}
// Written before transmission. Failure here means nothing was sent.
export function create({ alias, endpoint, protocol, localId, pinDigest, contextId, messageId, requestedTaskId, envelope }) {
 const now = Date.now();
 const record = { v: 1, alias, endpoint, protocol, localId, pinDigest, contextId, messageId, requestedTaskId, taskId: null, state: "transmitting", createdMs: now, updatedMs: now, recoveries: 0, envelope };
 try {
  const dir = folder(true);
  writeExclusive(path.join(dir, fileFor(messageId)), record); syncDir(dir);
 } catch (error) {
  if (error instanceof CliError && error.code === "outbox_unsafe") throw error;
  fail("Could not save the local send record before sending. Nothing was sent; check free space and permissions in the config directory.", "outbox_write_failed");
 }
 return record;
}
export function read(id) {
 const dir = folder(false), name = fileFor(id);
 if (!dir) fail(`No local send record exists for message ${id}. Select a message ID from keys outbox --json; never send a new message to replace an unknown one.`, "outbox_unknown");
 let record;
 try {
  const file = path.join(dir, name), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_RECORD) throw Error("shape");
  record = JSON.parse(fs.readFileSync(file, "utf8"));
 } catch (error) {
  if (error?.code === "ENOENT") fail(`No local send record exists for message ${id}. Select a message ID from keys outbox --json; never send a new message to replace an unknown one.`, "outbox_unknown");
  fail(damaged(id), "outbox_damaged");
 }
 if (!valid(record, id)) fail(damaged(id), "outbox_damaged");
 return record;
}
// Replace a record atomically; a failure keeps the earlier record, which stays safe to reconcile.
export function update(record, changes) {
 const next = { ...record, ...changes, updatedMs: Date.now() };
 const dir = folder(false), file = path.join(dir, fileFor(record.messageId)), tmp = file + ".next-" + process.pid + "-" + Date.now();
 try { writeExclusive(tmp, next); fs.renameSync(tmp, file); syncDir(dir); }
 catch { try { fs.rmSync(tmp, { force: true }); } catch {} return null; }
 return next;
}
const nextStep = record => ({
 transmitting: `Delivery is not confirmed. Do not send a new message. Run send --to ${record.alias} --recover ${record.messageId}; it re-submits the same encrypted message and ID, which the recipient inbox stores at most once.`,
 unknown: `Delivery is not confirmed. Do not send a new message. Run send --to ${record.alias} --recover ${record.messageId}; it re-submits the same encrypted message and ID, which the recipient inbox stores at most once.`,
 refused: "The recipient refused this message before storing it; nothing was delivered. Fix the reason it gave, then send a new message.",
 delivered: "Delivery was confirmed. Do not resend.",
})[record.state];
export function summary(record) {
 return { messageId: record.messageId, alias: record.alias, contextId: record.contextId, taskId: record.taskId, state: record.state, recoveries: record.recoveries, created: new Date(record.createdMs).toISOString(), updated: new Date(record.updatedMs).toISOString(), next: nextStep(record) };
}
// Lists public fields only, newest first. Damaged entries stay listed and untouched.
export function list() {
 const dir = folder(false);
 if (!dir) return { records: [], truncated: false };
 const names = fs.readdirSync(dir).filter(name => name.endsWith(".json") && ID.test(name.slice(0, -5)));
 const rows = names.map(name => {
  const id = name.slice(0, -5);
  try { return summary(read(id)); }
  catch (error) { if (error?.code !== "outbox_damaged") throw error; return { messageId: id, state: "damaged", next: damaged(id) }; }
 }).sort((a, b) => String(b.updated ?? "").localeCompare(String(a.updated ?? "")));
 return { records: rows.slice(0, MAX_LIST), truncated: rows.length > MAX_LIST };
}
