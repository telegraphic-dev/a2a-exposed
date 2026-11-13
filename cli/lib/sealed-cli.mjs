// Thin local CLI path. The Worker sees public routing and authenticated ciphertext only.
import fs from "node:fs";
import * as C from "./config.mjs";
import { CliError, checkId, fetchCard, httpJson, newId, pickEndpoint } from "./a2a.mjs";
import { owner, peerToken } from "./commands.mjs";
import { gate, sdk, URI } from "./sealed-keys.mjs";
const fail = (message, code = "verification_failed") => { const error = new CliError(message); error.code = code; throw error; };
const binding = h => Object.fromEntries(["contextId", "messageId", "taskId", "role", "state", "kind"].map(k => [k, h[k]]));
const sealedFailure = "Encrypted operation refused. Inspect keys status --json and the original pairing; preserve the original task/context IDs. No plaintext fallback or automatic retry.";
async function paired(peer, o, action) {
 gate();
 const api = await sdk(), store = new api.LocalState(C.CONFIG_DIR);
 try {
  const pin = store.inspect(peer), record = pin.current;
  if (!record || record.policy !== "required" || !["tofu-pinned", "independently-verified"].includes(pin.live_state)) fail("No active local pin for this peer. Run keys status --json and keys pairings --json; complete the existing human-approved pairing first. No plaintext was sent.", "no_pin");
  const identity = await store.loadIdentity(record.localId, { purpose: "traffic", allowOsConsent: o["allow-os-consent"] === true });
  const recheck = () => { if (store.inspect(peer).current_digest !== pin.current_digest || store.inspect(peer).live_state !== pin.live_state) fail(sealedFailure); };
  recheck();
  return await action({ api, record, identity, recheck });
 } catch (error) {
  if (error instanceof CliError) throw error;
  if (error?.code === "key_store_consent") fail("This identity uses the OS keychain. Re-run this send/read with --allow-os-consent only when a human can answer the OS authorization prompt. No store fallback or plaintext retry.", "key_store_consent");
  // LocalStateError.next is fixed recovery guidance; crypto/provider text never escapes.
  fail(error?.next || sealedFailure, error?.code || "verification_failed");
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
 if (process.env.A2A_SEALED_ENABLED !== "1") fail("This config directory has local keys or pinned peers, so ordinary send is off here. Local encryption is disabled; A2A_SEALED_ENABLED=1 is reserved for approved local tests. Use a separate --config-dir for ordinary sends. No plaintext was sent.");
 gate();
 if (!o.to || !C.loadPeers()[o.to]?.sealed) fail("This config directory has local keys. Select a pinned alias with peers list --json; complete human-approved connect first. Use a separate --config-dir for ordinary sends. No plaintext was sent.");
 if (o.text === undefined && process.stdin.isTTY) fail("Encrypted send requires --text TEXT or piped stdin; no terminal prompt is used. Nothing was sent.");
 if (o.push || o.wake || o.intent) fail("Encrypted send does not support --push, --wake or --intent yet; nothing was sent.");
 const pe = C.loadPeers()[o.to], token = peerToken(pe.token_env);
 if (!token) fail("The paired peer token is missing; inspect peers list --json. No plaintext was sent.");
 const text = o.text ?? await readInput();
 if (!text) fail("Encrypted send requires non-empty --text TEXT or piped stdin. Nothing was sent.");
 const taskId = o.task ? checkId(o.task, "taskId") : null;
 let contextId = o.context ? checkId(o.context, "contextId") : taskId ? null : newId();
 return paired(o.to, o, async ({ api, record, identity, recheck }) => {
  const card = await fetchCard(pe.url), [url, protocol] = pickEndpoint(pe.url, card, o.proto);
  const advertised = card?.capabilities?.extensions?.filter(e => e.uri === URI);
  if (!["0.3", "1.0"].includes(protocol) || url !== record.peerEndpoint || advertised?.length !== 1 || advertised[0].params?.cliSeal !== true || api.canonicalJSON(advertised[0].params.pairingBundle) !== api.canonicalJSON(record.bundle)) fail("Peer encryption capability, pinned bundle or endpoint changed. Preserve the pairing and ask its owner; no plaintext was sent.");
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
  const content = api.validateContent({ kind: "message", authorRole: "user", parts: [{ kind: "text", text, mediaType: null, metadata: {} }], metadata: {}, extensions: [], referenceTaskIds: [] }, b);
  const envelope = await api.seal({ identity, recipient: record.bundle, binding: b, content });
  recheck();
  if (api.canonicalJSON(C.loadPeers()[o.to]) !== api.canonicalJSON(pe) || C.get(pe.token_env) !== token) fail(sealedFailure);
  const message = api.makeMessageCarrier(envelope, protocol);
  let response;
  try {
   response = await httpJson(url, { redirect: "error", maxResponseBytes: 1024 * 1024, body: { jsonrpc: "2.0", id: b.messageId, method: protocol === "1.0" ? "SendMessage" : "message/send", params: { message, configuration: protocol === "1.0" ? { returnImmediately: true, historyLength: 1 } : { blocking: false, historyLength: 1 } } }, headers: { authorization: `Bearer ${token}`, "A2A-Version": protocol, "A2A-Extensions": URI, ...(protocol === "0.3" ? { "X-A2A-Extensions": URI } : {}) } });
  } catch { fail("Encrypted delivery outcome is unknown. Do not resend. Ask the recipient's owner to check inbox/history for context " + b.contextId + " and message " + b.messageId + ". No plaintext fallback."); }
  const { status, data, headers } = response;
  if (status !== 200 || data?.jsonrpc !== "2.0" || data.id !== b.messageId || data.error || headers?.get("A2A-Extensions") !== URI) fail("Encrypted delivery was not confirmed. Do not resend automatically. Ask the recipient's owner to check history for context " + b.contextId + " and message " + b.messageId + ". No plaintext fallback.");
  const task = protocol === "1.0" ? data.result?.task : data.result;
  if (!task?.id || task.contextId !== b.contextId || !task.history?.some(m => { try { return api.canonicalJSON(api.readMessageCarrier(api.canonicalJSON(m), protocol)) === api.canonicalJSON(envelope); } catch { return false; } })) fail("Encrypted task routing response is invalid; delivery may have occurred. Preserve context " + b.contextId + " and message " + b.messageId + "; do not resend.");
  // Persist only the envelope, never the locally opened content or peer-returned text.
  let stored = false;
  if (C.get("A2A_BASE_URL") && C.get("A2A_OWNER_TOKEN")) {
   try { await owner("POST", "/owner/history", { contextId: b.contextId, dir: "out", peer: o.to, taskId: task.id, role: "user", text: "[encrypted message]", data: { sealed: envelope, messageId: b.messageId } }); stored = true; }
   catch { console.error("warning: encrypted message delivered; sender history was not saved. Do not resend."); }
  } else console.error("warning: encrypted message delivered; sender history was not saved because A2A_BASE_URL / A2A_OWNER_TOKEN is missing. Do not resend.");
  const result = { taskId: task.id, contextId: b.contextId, messageId: b.messageId, encrypted: true, serverReadable: false, senderHistorySaved: stored, taskStateAuthenticated: false };
  emit(result);
  return result;
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
     const api = await sdk(), store = new api.LocalState(C.CONFIG_DIR);
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
    return { ...row, text, encrypted: true, locallyOpened: true, historical, taskStateAuthenticated: false };
   }));
  } catch (error) {
   const codes = { replay: "too_old", key_lost: "key_missing", key_unknown: "key_missing", key_changed: "key_changed", no_pin: "no_pin", key_store_consent: "os_consent_required", binding_mismatch: "binding_mismatch", plaintext_from_pinned_peer: "plaintext_from_pinned_peer" };
   const reason = process.env.A2A_SEALED_ENABLED !== "1" ? "encryption_disabled" : codes[error?.code] || "verification_failed";
   const next = reason === "os_consent_required" ? "Re-run with --allow-os-consent when a human can answer the OS authorization prompt." : reason === "too_old" ? "Read this context with history CONTEXT --json for verified historical content; this does not admit live work." : reason === "encryption_disabled" ? "Local encryption needs the approved test flag; use a separate --config-dir for ordinary sends. No plaintext fallback." : "Preserve the original keys and pairing; inspect keys status --json. No plaintext fallback.";
   // Do not echo unverified text, data or provider errors, even in JSON mode.
   out.push({ taskId: row.taskId ?? row.task_id ?? null, contextId: row.contextId ?? row.context_id ?? null, from: peer, encrypted: reason !== "plaintext_from_pinned_peer", locallyOpened: false, reason, next, text: reason === "plaintext_from_pinned_peer" ? "[unencrypted message refused from pinned peer]" : `[encrypted message unavailable: ${reason}]` });
   if (markFailure) process.exitCode = 1;
  }
 }
 return out;
}
