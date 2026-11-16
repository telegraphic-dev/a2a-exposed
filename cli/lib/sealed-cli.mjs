// Thin local CLI path. The Worker sees public routing and authenticated ciphertext only.
import fs from "node:fs";
import * as C from "./config.mjs";
import { CliError, checkId, fetchCard, httpJson, newId, pickEndpoint } from "./a2a.mjs";
import { owner, peerToken } from "./commands.mjs";
import { gate, sdk, openState, URI, encryptionDisabled, peerKeysChanged, archiveOnly, refuseArchiveOnly } from "./sealed-keys.mjs";
import * as outbox from "./sealed-outbox.mjs";
const fail = (message, code = "verification_failed") => { const error = new CliError(message); error.code = code; throw error; };
const binding = h => Object.fromEntries(["contextId", "messageId", "taskId", "role", "state", "kind"].map(k => [k, h[k]]));
const taskState = task => {
 const raw = task?.status?.state;
 if (typeof raw !== "string") return "unknown";
 const normalized = raw.replace(/^TASK_STATE_/, "").toLowerCase().replaceAll("_", "-");
 return ["submitted", "working", "input-required", "completed", "failed", "canceled", "rejected", "auth-required"].includes(normalized) ? normalized : "unknown";
};
const sealedFailure = "Encrypted operation refused. Preserve the original keys and pairing; inspect keys status --json and the original task/context IDs. Do not replace keys or change trust automatically. No plaintext fallback or automatic retry.";
const revoked = "This peer's local pin was revoked with keys revoke. Encrypted sends, reads and send recovery for it stay held; its history and send records are kept unchanged. Using this peer again needs a new human-approved pairing under a new alias. No plaintext fallback.";
const keysRotated = (id, peer) => `Keys rotated: this pairing with ${peer} uses local key ${id}, which keys rotate retired. The old key still opens old history and never signs again. To talk to this peer again, re-pair with the new key: select the current ID with keys status --json, run connect URL --sealed-key-id NEW_ID --alias NEW_ALIAS (its owner approves), then keys verify with the other owner, or hold the old pin with keys revoke --peer ${peer}. Nothing was sent or read from the live inbox.`;
// archive:true only for historical reads (a restored copy, or a key retired by keys rotate); it never authorizes live work.
async function paired(peer, o, action, { archive = false } = {}) {
 gate();
 const api = await sdk(), store = openState(api);
 let expectedLocalId = "unknown";
 try {
  const pin = store.inspect(peer), record = pin.current;
  if (record?.state === "revoked" || pin.live_state === "revoked") fail(revoked, "pin_revoked");
  const archived = archive === true && pin.live_state === "archive-only" && record?.policy === "required";
  if (pin.live_state === "archive-only" && !archived) fail(archiveOnly, "archive_only");
  // A pin on a key retired by keys rotate opens old history only; it never signs again.
  // Checked before the active-pin test, which reports such a pin as change-pending.
  const rotated = !archived && record?.policy === "required" && ["tofu-pinned", "independently-verified"].includes(record.state) && store.row(record.localId).live_state === "retired";
  if (rotated && archive !== true) fail(keysRotated(record.localId, peer), "keys_rotated");
  if (!record || record.policy !== "required" || (!archived && !rotated && !["tofu-pinned", "independently-verified"].includes(pin.live_state))) fail("No active local pin for this peer. Run keys status --json and keys pairings --json; complete the existing human-approved pairing first. No plaintext was sent.", "no_pin");
  expectedLocalId = record.localId;
  const identity = await store.loadIdentity(record.localId, { purpose: archived || rotated ? "archive" : "traffic", allowOsConsent: o["allow-os-consent"] === true });
  const recheck = () => { if (store.inspect(peer).current_digest !== pin.current_digest || store.inspect(peer).live_state !== pin.live_state) fail(sealedFailure); };
  recheck();
  return await action({ api, record, pin, identity, recheck });
 } catch (error) {
  if (error instanceof CliError) throw error;
  if (["key_lost", "key_unknown"].includes(error?.code)) {
   const status = store.status();
   const message = `This config (${status.config_identity}) expects local key ${expectedLocalId}; its key catalog lists IDs: ${status.identities.map(row => row.id).join(", ") || "none"}. Catalog entries are public metadata, not proof that private material is available. The expected private key file or keychain entry is unavailable. Use the original --config-dir that holds this key, or restore that original key from its protected backup or OS keychain. Inspect keys status --json; do not run keys init or replace the key. No plaintext fallback.`;
   fail(message, error.code);
  }
  if (error?.code === "key_store_consent") fail("This identity uses the OS keychain. Re-run this send/read with --allow-os-consent only when a human can answer the OS authorization prompt. No store fallback or plaintext retry.", "key_store_consent");
  // LocalStateError.next is fixed recovery guidance; crypto/provider text never escapes.
  fail(`Local encryption config ${store.configId()}. ${error?.next || sealedFailure}`, error?.code || "verification_failed");
 } finally { store.close(); }
}
async function readInput() {
 const chunks = []; let size = 0;
 try {
  for await (const chunk of process.stdin) {
   size += Buffer.byteLength(chunk);
   if (size > 300 * 1024) fail("Encrypted input is too large. Nothing was sent.");
   chunks.push(Buffer.from(chunk));
  }
 } catch (error) { if (error instanceof CliError) throw error; fail("Could not read piped input. Nothing was sent."); }
 return Buffer.concat(chunks).toString("utf8");
}
export async function send(o, { emit = value => console.log(JSON.stringify(value, null, 2)) } = {}) {
 // Every --recover lands here, also from an ordinary config, so it can never become a new send.
 if (o.recover !== undefined && process.env.A2A_SEALED_ENABLED !== "1") fail("send --recover reconciles only encrypted sends, in the config directory that sealed the original, with A2A_SEALED_ENABLED=1. Nothing was sent, and no new message is sent in its place.", "recover_unavailable");
 if (process.env.A2A_SEALED_ENABLED !== "1") fail(encryptionDisabled + " Use a separate --config-dir for ordinary sends. No plaintext was sent.");
 gate();
 if (o.recover !== undefined) return recoverSend(o, emit);
 if (!o.to || !C.loadPeers()[o.to]?.sealed) fail("This config directory has local keys. Select a pinned outbound alias with peers list --json. If none exists, select the existing local ID with keys status --json, verify the peer URL with its owner, and ask your human before running connect <peer URL> --sealed-key-id <id> --alias ALIAS --no-wait. Do not pair automatically or create replacement keys. Use a separate --config-dir for ordinary sends. No plaintext was sent.");
 if (o.text === undefined && process.stdin.isTTY) fail("Encrypted send requires --text TEXT or piped stdin; no terminal prompt is used. Nothing was sent.");
 if (o.push || o.wake || o.intent) fail("Encrypted send does not support --push, --wake or --intent yet; nothing was sent.");
 const pe = C.loadPeers()[o.to], token = peerToken(pe.token_env);
 if (!token) fail("The paired peer token is missing; inspect peers list --json. No plaintext was sent.");
 const text = o.text ?? await readInput();
 if (!text) fail("Encrypted send requires non-empty --text TEXT or piped stdin. Nothing was sent.");
 const taskId = o.task ? checkId(o.task, "taskId") : null;
 let contextId = o.context ? checkId(o.context, "contextId") : taskId ? null : newId();
 // Validate encoded content before loading a private key or asking for OS consent.
 const draft = { kind: "message", authorRole: "user", parts: [{ kind: "text", text, mediaType: null, metadata: {} }], metadata: {}, extensions: [], referenceTaskIds: [] };
 const preflight = await sdk();
 try { preflight.validateContent(draft, { contextId: contextId || "unresolved", messageId: "preflight", taskId, role: "user", state: null, kind: "message" }); }
 catch (error) {
  if (error?.code === "content_too_large") fail("Encrypted message is too large after JSON encoding (maximum 307072 UTF-8 bytes for content). Nothing was sent.", "content_too_large");
  fail("Encrypted text must contain 1–200000 Unicode characters within the encoded content limit. Nothing was sent.");
 }
 return paired(o.to, o, async ({ api, record: pinned, pin, identity, recheck }) => {
  const card = await fetchCard(pe.url), [url, protocol] = pickEndpoint(pe.url, card, o.proto);
  const advertised = card?.capabilities?.extensions?.filter(e => e.uri === URI);
  if (!["0.3", "1.0"].includes(protocol) || url !== pinned.peerEndpoint || advertised?.length !== 1 || advertised[0].params?.cliSeal !== true || api.canonicalJSON(advertised[0].params.pairingBundle) !== api.canonicalJSON(pinned.bundle)) fail(peerKeysChanged + " Check the published encryption capability and endpoint with the peer owner too. No plaintext was sent.", "key_changed");
  if (taskId && !contextId) {
   // A task's routing context is server-supplied, not an authenticated assignment.
   // Resolve it before signing instead of silently creating a different conversation.
   const id = newId();
   let resolved;
   try { resolved = await httpJson(url, { redirect: "error", maxResponseBytes: 1024 * 1024, body: { jsonrpc: "2.0", id, method: protocol === "1.0" ? "GetTask" : "tasks/get", params: { id: taskId, historyLength: 0 } }, headers: { authorization: `Bearer ${token}`, "A2A-Version": protocol, "A2A-Extensions": URI } }); }
   catch { fail("Could not read the task context. Nothing was sent. Inspect the original task and pass its --context explicitly."); }
   if (resolved.status !== 200 || resolved.data?.jsonrpc !== "2.0" || resolved.data?.id !== id || resolved.data.error || resolved.data.result?.id !== taskId) fail("Could not read the task context. Nothing was sent. Inspect the original task and pass its --context explicitly.");
   contextId = checkId(resolved.data.result.contextId, "task contextId");
  }
  const b = { contextId, messageId: newId(), taskId, role: "user", state: null, kind: "message" };
  const content = api.validateContent(draft, b);
  const envelope = await api.seal({ identity, recipient: pinned.bundle, binding: b, content });
  recheck();
  if (api.canonicalJSON(C.loadPeers()[o.to]) !== api.canonicalJSON(pe) || C.get(pe.token_env) !== token) fail(sealedFailure);
  const record = outbox.create({ alias: o.to, endpoint: url, protocol, localId: pinned.localId, pinDigest: pin.current_digest, contextId: b.contextId, messageId: b.messageId, requestedTaskId: taskId, envelope });
  return transmit({ api, url, protocol, token, envelope, b, o, record, emit });
 });
}
// One delivery attempt of an already-recorded envelope. The same bytes and message ID are
// used for the first attempt and every explicit recovery; nothing is resealed or renamed.
async function transmit({ api, url, protocol, token, envelope, b, o, record, emit, recovering = false }) {
 const recover = `Do not send a new message. To reconcile, run send --to ${o.to} --recover ${b.messageId}: it re-submits the same encrypted message and ID, which the recipient inbox stores at most once. You can also ask the recipient's owner to check history for context ${b.contextId} and message ${b.messageId}. No plaintext fallback.`;
 const mark = changes => { const next = outbox.update(record, changes); if (next) record = next; return next; };
 const message = api.makeMessageCarrier(envelope, protocol);
 let response;
 try {
  response = await httpJson(url, { redirect: "error", maxResponseBytes: 1024 * 1024, body: { jsonrpc: "2.0", id: b.messageId, method: protocol === "1.0" ? "SendMessage" : "message/send", params: { message, configuration: protocol === "1.0" ? { returnImmediately: true, historyLength: 1 } : { blocking: false, historyLength: 1 } } }, headers: { authorization: `Bearer ${token}`, "A2A-Version": protocol, "A2A-Extensions": URI, ...(protocol === "0.3" ? { "X-A2A-Extensions": URI } : {}) } });
 } catch { mark({ state: "unknown" }); fail("Encrypted delivery outcome is unknown. " + recover, "delivery_unknown"); }
 const { status, data, headers } = response;
 if (status === 200 && data?.jsonrpc === "2.0" && data.id === b.messageId && !Object.hasOwn(data, "result") && data.error?.code === -32602 && typeof data.error.message === "string") {
  // Peer text is untrusted. Map only documented pre-storage refusal reasons.
  const refusals = {
   sealed_invalid: "The recipient inbox could not verify this encrypted message. Nothing was delivered. Check the existing approved pairing with keys pairings --json on the receiving side and keys status --json on both sides; use a current matching CLI. Do not resend automatically or as plaintext.",
   encryption_disabled: "The recipient inbox refused the encrypted message because encryption is disabled there. Nothing was delivered. Ask the recipient's owner to check their inbox encryption setting; on hosted inboxes, the service operator controls this setting. No plaintext was sent. Do not retry automatically.",
   peer_keys_missing: "The recipient inbox refused the encrypted message because this peer has no approved encryption keys there. Nothing was delivered. Inspect keys status --json and keys pairings --json and ask the recipient's owner to check the existing human-approved key pairing. No plaintext was sent. Do not retry automatically.",
  };
  const reason = data.error.data?.reason;
  if (typeof reason === "string" && Object.hasOwn(refusals, reason)) {
   // A refused re-submission says nothing about an earlier attempt, which may have been stored.
   if (recovering) fail(`The recipient refused this re-submission (${reason}). That does not show whether the original was stored by an earlier attempt, so delivery stays unresolved and the send record stays unknown. Do not send a new message. Ask the recipient's owner to check history for context ${b.contextId} and message ${b.messageId}; send a new message only after they confirm it never arrived. No plaintext fallback.`, "recover_refused");
   mark({ state: "refused" }); fail(refusals[reason], "recipient_" + reason);
  }
 }
 if (status !== 200 || data?.jsonrpc !== "2.0" || data.id !== b.messageId || data.error || headers?.get("A2A-Extensions") !== URI) { mark({ state: "unknown" }); fail("Encrypted delivery was not confirmed. " + recover, "delivery_unknown"); }
 const task = protocol === "1.0" ? data.result?.task : data.result;
 const carries = history => Array.isArray(history) && history.some(m => { try { return api.canonicalJSON(api.readMessageCarrier(api.canonicalJSON(m), protocol)) === api.canonicalJSON(envelope); } catch { return false; } });
 let confirmed = !!task?.id && task.contextId === b.contextId && carries(task.history);
 // A recovered original can sit behind later messages in its task; look for it in a bounded read.
 if (!confirmed && recovering && task?.id && task.contextId === b.contextId) {
  const id = newId();
  try {
   const read = await httpJson(url, { redirect: "error", maxResponseBytes: 24 * 1024 * 1024, body: { jsonrpc: "2.0", id, method: protocol === "1.0" ? "GetTask" : "tasks/get", params: { id: task.id, historyLength: 20 } }, headers: { authorization: `Bearer ${token}`, "A2A-Version": protocol, "A2A-Extensions": URI } });
   confirmed = read.status === 200 && read.data?.jsonrpc === "2.0" && read.data.id === id && !read.data.error && read.data.result?.id === task.id && read.data.result.contextId === b.contextId && carries(read.data.result.history);
  } catch { confirmed = false; }
 }
 if (!confirmed) { mark({ state: "unknown" }); fail("Encrypted task routing response is invalid; delivery may have occurred. " + recover, "delivery_unknown"); }
 // The record is marked before history writes so a lost history save never invites a resend.
 const sendRecordSaved = !!mark({ state: "delivered", taskId: task.id });
 if (!sendRecordSaved) console.error(`warning: encrypted message delivered; the local send record was not updated. Do not resend. A later send --recover ${b.messageId} only confirms this delivery.`);
 // Persist only the envelope, never the locally opened content or peer-returned text.
 let stored = false, outboundSaved = false;
 if (C.get("A2A_BASE_URL") && C.get("A2A_OWNER_TOKEN")) {
  try { await owner("POST", "/owner/history", { contextId: b.contextId, dir: "out", peer: o.to, taskId: task.id, role: "user", text: "[encrypted message]", state: "submitted", data: { sealed: envelope, messageId: b.messageId } }); stored = true; }
  catch { console.error("warning: encrypted message delivered; sender history was not saved. Do not resend."); }
 } else console.error("warning: encrypted message delivered; sender history was not saved because A2A_BASE_URL / A2A_OWNER_TOKEN is missing. Do not resend.");
 try {
  const safeTask = { id: task.id, contextId: b.contextId, status: { state: taskState(task) }, sealed: envelope };
  await owner("POST", "/owner/outbound", { taskId: task.id, contextId: b.contextId, peer: o.to, endpoint: url, protocol, task: safeTask });
  outboundSaved = true;
 } catch { console.error("warning: encrypted message delivered; outbound tracking was not saved. Use poll --to ALIAS TASK_ID or history with the original context; do not resend."); }
 const result = { taskId: task.id, contextId: b.contextId, messageId: b.messageId, encrypted: true, serverReadable: false, senderHistorySaved: stored, outboundSaved, sendRecordSaved, taskStateAuthenticated: false, ...(recovering ? { recovered: true } : {}) };
 emit(result);
 return result;
}
// Explicit reconciliation of an unconfirmed send. Re-submits the recorded envelope with its
// original message ID; the recipient inbox deduplicates by peer and message ID, so a delivered
// original returns its existing task and wakes nobody again. Never reseals or picks a new ID.
async function recoverSend(o, emit) {
 gate();
 const id = checkId(o.recover, "messageId");
 for (const flag of ["text", "context", "task", "proto", "push", "wake", "intent"]) if (o[flag] !== undefined && o[flag] !== false) fail(`send --recover does not accept --${flag}; it re-submits the recorded message unchanged. Nothing was sent.`);
 const pe = o.to ? C.loadPeers()[o.to] : null;
 if (!pe?.sealed) fail("send --recover requires --to with the original pinned alias from keys outbox --json. Nothing was sent.");
 const saved = outbox.read(id);
 if (saved.alias !== o.to) fail(`This send record belongs to alias ${saved.alias}, not ${o.to}. Select the alias from keys outbox --json. Nothing was sent.`, "outbox_alias");
 if (saved.state === "delivered") { const result = { ...outbox.summary(saved), encrypted: true, recovered: false, requestMade: false }; emit(result); return result; }
 if (saved.state === "refused") fail("The recipient refused this message before storing it, so nothing was delivered and there is nothing to recover. Fix the reason it gave, then send a new message.", "outbox_refused");
 const token = peerToken(pe.token_env);
 if (!token) fail("The paired peer token is missing; inspect peers list --json. Nothing was sent.");
 return paired(o.to, o, async ({ api, record: pinned, pin, identity, recheck }) => {
  // A changed or revoked pin invalidates the record. It stays on disk unchanged.
  if (pin.current_digest !== saved.pinDigest || pinned.localId !== saved.localId || pinned.peerEndpoint !== saved.endpoint) fail(`The pairing for ${o.to} changed or was revoked after message ${id} was sealed, so this record can no longer be recovered. It was left unchanged. Ask the recipient's owner to check history for context ${saved.contextId} and message ${id}; do not send a new message until they confirm it did not arrive.`, "outbox_invalidated");
  const card = await fetchCard(pe.url), [url, protocol] = pickEndpoint(pe.url, card, saved.protocol);
  const advertised = card?.capabilities?.extensions?.filter(e => e.uri === URI);
  if (protocol !== saved.protocol || url !== saved.endpoint || advertised?.length !== 1 || advertised[0].params?.cliSeal !== true || api.canonicalJSON(advertised[0].params.pairingBundle) !== api.canonicalJSON(pinned.bundle)) fail(peerKeysChanged + " Check the published encryption capability and endpoint with the peer owner too. Nothing was sent.", "key_changed");
  // Authenticate the stored envelope as this sender's own copy before releasing it again.
  let h;
  try {
   h = api.validateEnvelopeStructure(saved.envelope).header;
   if (h.messageId !== id || h.contextId !== saved.contextId || h.taskId !== saved.requestedTaskId || h.role !== "user" || h.kind !== "message") throw Error();
   await api.open({ envelope: saved.envelope, identity, sender: identity.bundle, recipient: pinned.bundle, expected: binding(h), purpose: "sender", now: Math.max(Date.parse(h.sentAt), Date.parse(identity.bundle.notBefore), Date.parse(pinned.bundle.notBefore)) });
  } catch { fail(outbox.damaged(id), "outbox_damaged"); }
  recheck();
  if (api.canonicalJSON(C.loadPeers()[o.to]) !== api.canonicalJSON(pe) || C.get(pe.token_env) !== token) fail(sealedFailure);
  const record = outbox.update(saved, { state: "unknown", recoveries: saved.recoveries + 1 });
  if (!record) fail("Could not update the local send record. Nothing was sent; check permissions in the config directory.", "outbox_write_failed");
  return transmit({ api, url, protocol, token, envelope: saved.envelope, b: { contextId: saved.contextId, messageId: id }, o, record, emit, recovering: true });
 });
}
// Historical reads authenticate archived content without granting live/replay authorization.
export async function openRows(rows, o, { historical = false, markFailure = true } = {}) {
 const out = [];
 for (const row of rows) {
  const envelope = row.sealed ?? row.data?.sealed, peer = row.from ?? row.peer;
  try {
   if (!envelope) {
    if (peer && (row.text || row.taskId) && fs.existsSync(C.CONFIG_DIR + "/encryption/state.sqlite")) {
     const api = await sdk(), store = openState(api);
     try { if (store.inspect(peer).current?.policy === "required") fail("Refusing plaintext from a pinned peer.", "plaintext_from_pinned_peer"); }
     finally { store.close(); }
    }
    out.push(row); continue;
   }
   out.push(await paired(peer, o, async ({ api, record, identity, recheck }) => {
    const h = api.validateEnvelopeStructure(envelope).header;
    const context = row.contextId ?? row.context_id;
    if (h.contextId !== context || h.role !== "user" || h.kind !== "message" || h.state !== null || (h.taskId !== null && h.taskId !== (row.taskId ?? row.task_id))) fail(sealedFailure, "binding_mismatch");
    const senderCopy = row.dir === "out";
    const sender = senderCopy ? identity.bundle : record.bundle, recipient = senderCopy ? record.bundle : identity.bundle;
    const content = api.validateContent(await api.open({ envelope, identity, sender, recipient, expected: binding(h), purpose: senderCopy ? "sender" : "recipient", ...(historical ? { now: Math.max(Date.parse(h.sentAt), Date.parse(sender.notBefore), Date.parse(recipient.notBefore)) } : {}) }), h);
    recheck();
    const text = content.parts.map(p => p.kind === "text" ? p.text : "[unsupported encrypted part]").join("\n");
    return { ...row, text, messageId: h.messageId, messageIdAuthenticated: true, encrypted: true, locallyOpened: true, historical, taskStateAuthenticated: false };
   }, { archive: historical }));
  } catch (error) {
   const codes = { replay: "too_old", key_lost: "key_missing", key_unknown: "key_missing", key_changed: "key_changed", no_pin: "no_pin", key_store_consent: "os_consent_required", binding_mismatch: "binding_mismatch", plaintext_from_pinned_peer: "plaintext_from_pinned_peer", pin_revoked: "pin_revoked", archive_only: "archive_only", keys_rotated: "keys_rotated" };
   const reason = process.env.A2A_SEALED_ENABLED !== "1" ? "encryption_disabled" : codes[error?.code] || "verification_failed";
   const next = ({
    os_consent_required: "Re-run with --allow-os-consent when a human can answer the OS authorization prompt.",
    too_old: "Read this context with history CONTEXT --json for verified historical content; this does not admit live work.",
    encryption_disabled: encryptionDisabled,
    key_missing: error.message,
    key_changed: peerKeysChanged,
    no_pin: "Run keys status --json and keys pairings --json, then complete the existing human-approved pairing for this peer. Do not change trust automatically. No plaintext fallback.",
    binding_mismatch: "The encrypted message does not match this task or conversation. Preserve the original task/context IDs and ask the sender owner to check them; do not move or retry the message. No plaintext fallback.",
    plaintext_from_pinned_peer: "Ask the peer owner to use their approved encrypted client for this pinned pairing. Do not accept a plaintext retry.",
    pin_revoked: revoked,
    archive_only: archiveOnly,
    keys_rotated: error.message,
   })[reason] || "Preserve the original keys and pairing; inspect keys status --json. Do not resend. Report the taskId and contextId shown on this row to the inbox owner for investigation. No plaintext fallback.";
   // Do not echo unverified text, data or provider errors, even in JSON mode.
   out.push({ taskId: row.taskId ?? row.task_id ?? null, contextId: row.contextId ?? row.context_id ?? null, from: peer, encrypted: reason !== "plaintext_from_pinned_peer", locallyOpened: false, reason, next, text: reason === "plaintext_from_pinned_peer" ? "[unencrypted message refused from pinned peer]" : "[encrypted message]" });
   if (markFailure) process.exitCode = 1;
  }
 }
 return out;
}

// Recovery reads never trust an owner record's endpoint, plaintext, flags or updates.
// The selected local pin is the only authority for network destination and opening.
async function trackingRecord(taskId, optional = false) {
 if (!C.get("A2A_BASE_URL") || !C.get("A2A_OWNER_TOKEN")) {
  if (optional) return null;
  fail("outbound requires A2A_BASE_URL and A2A_OWNER_TOKEN. Use poll --to ALIAS TASK_ID with an alias from peers list --json; do not resend.");
 }
 try {
  const r = await httpJson(C.get("A2A_BASE_URL").replace(/\/$/, "") + "/owner/outbound/" + encodeURIComponent(taskId), { headers: { authorization: `Bearer ${C.get("A2A_OWNER_TOKEN")}` }, redirect: "error", maxResponseBytes: 1024 * 1024 });
  if (r.status === 404) {
   if (optional) return null;
   fail("No encrypted outbound tracking is stored for this task. That does not mean delivery failed. Use poll --to ALIAS TASK_ID (local MCP: poll_outbound with to and taskId) or history with the original context. Do not resend.", "outbound_tracking_missing");
  }
  if (r.status !== 200 || !r.data || r.data.taskId !== taskId) throw Error();
  return r.data;
 } catch (error) { if (error instanceof CliError && error.code === "outbound_tracking_missing") throw error; if (optional) return null; fail("Could not read encrypted outbound tracking. Check the selected inbox and owner credential; use history with the original context. Do not resend."); }
}
export async function recovery(taskId, o, { poll = false, emit = value => console.log(JSON.stringify(value, null, 2)) } = {}) {
 if (poll) await refuseArchiveOnly();
 gate();
 const tid = checkId(taskId, "taskId"), pe = C.loadPeers()[o.to];
 if (!o.to || pe?.sealed?.policy !== "required") fail("Encrypted outbound/poll requires --to ALIAS from peers list --json and an active approved local pin. No plaintext fallback.");
 const token = peerToken(pe.token_env);
 if (poll && !token) fail("The paired peer token is missing; inspect peers list --json. No request was made.");
 const rec = await trackingRecord(tid, poll);
 if (rec && (rec.peer !== o.to || typeof rec.contextId !== "string")) fail("Outbound tracking does not match the selected peer. Preserve the original task/context IDs; select the original alias with peers list --json. No request was made.");
 return paired(o.to, o, async ({ api, identity, record, recheck }) => {
  let task = rec?.task, protocol = rec?.protocol, url;
  if (poll) {
   [url, protocol] = pickEndpoint(pe.url, await fetchCard(pe.url), o.proto);
   if (!["0.3", "1.0"].includes(protocol) || url !== record.peerEndpoint) fail(peerKeysChanged + " No poll was made.");
   recheck();
   if (api.canonicalJSON(C.loadPeers()[o.to]) !== api.canonicalJSON(pe) || C.get(pe.token_env) !== token) fail(sealedFailure);
   const id = newId(); let response;
   try { response = await httpJson(url, { redirect: "error", maxResponseBytes: 1024 * 1024, body: { jsonrpc: "2.0", id, method: protocol === "1.0" ? "GetTask" : "tasks/get", params: { id: tid, historyLength: 20 } }, headers: { authorization: `Bearer ${token}`, "A2A-Version": protocol, "A2A-Extensions": URI } }); }
   catch { fail("Encrypted poll failed. Preserve the original task/context/message IDs; ask the recipient's owner to check history. Do not resend."); }
   if (response.status !== 200 || response.data?.jsonrpc !== "2.0" || response.data.id !== id || response.data.error || response.headers?.get("A2A-Extensions") !== URI) fail("Encrypted poll was not verified. Preserve the original IDs; ask the recipient's owner to check history. No automatic retry or plaintext fallback.");
   task = response.data.result;
  }
  if (!task || task.id !== tid || typeof task.contextId !== "string" || (rec && task.contextId !== rec.contextId)) fail("Encrypted task routing does not match the original task/context. No plaintext fallback or automatic retry.");
  checkId(task.contextId, "contextId");
  // Stored send snapshots contain one canonical envelope. Poll snapshots contain
  // canonical envelopes only; status messages, artifacts and arbitrary fields never persist.
  const envelopes = task.sealed ? [task.sealed] : task.envelopes ?? (Array.isArray(task.history) ? task.history.map(message => {
   try { return api.readMessageCarrier(api.canonicalJSON(message), protocol); }
   catch { fail("Encrypted task contains an invalid or plaintext message. Content withheld; no plaintext fallback."); }
  }) : []);
  if (!Array.isArray(envelopes) || envelopes.length < 1 || envelopes.length > 20) fail("No bounded encrypted task history is available. Use history with the original context; do not resend.");
  const rows = envelopes.map(envelope => {
   const h = api.validateEnvelopeStructure(envelope).header;
   return { taskId: tid, contextId: task.contextId, peer: o.to, dir: h.from.keyId === identity.bundle.keyId ? "out" : "in", sealed: envelope };
  });
  const opened = await openRows(rows, o, { historical: !poll, markFailure: false });
  recheck();
  const result = { taskId: tid, contextId: task.contextId, state: taskState(task), encrypted: true, serverReadable: false, taskStateAuthenticated: false,
   rows: opened.map(({ taskId, contextId, peer, dir, text, messageId, messageIdAuthenticated, locallyOpened, historical, reason, next }) => ({ taskId, contextId, peer, dir, text, messageId, messageIdAuthenticated, locallyOpened, historical, reason, next })) };
  if (poll && opened.some(row => !row.locallyOpened)) {
   result.outboundSaved = false; result.next = "Encrypted poll returned refused rows. Tracking was not updated. Follow each row's next step and preserve the original IDs; do not resend.";
  }
  if (poll && opened.every(row => row.locallyOpened)) {
   try {
    await owner("POST", "/owner/outbound", { taskId: tid, contextId: task.contextId, peer: o.to, endpoint: url, protocol, task: { id: tid, contextId: task.contextId, status: { state: taskState(task) }, envelopes } });
    result.outboundSaved = true;
   } catch { result.outboundSaved = false; result.next = "Encrypted poll succeeded but tracking was not saved. Preserve the original IDs; do not resend."; }
  }
  emit(result); return result;
 });
}
