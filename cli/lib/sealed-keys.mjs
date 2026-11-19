// Local CLI adapter. The optional crypto package is never loaded for ordinary commands.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as C from "./config.mjs";
import { CLI, CliError, httpJson, pickEndpoint } from "./a2a.mjs";
import { baseUrl } from "./commands.mjs";
export const URI = "https://a2a.exposed/ext/sealed/v1";
const fail = message => { throw new CliError(message); };
export const encryptionDisabled = "Local encryption is disabled. Set A2A_SEALED_ENABLED=1 in this local CLI or MCP process only after owner approval; the inbox Worker needs its own setting (on hosted inboxes, the service operator controls this). Only the exact value 1 enables encryption; true, yes and whitespace do not. No plaintext fallback.";
// The independent ceremony: a human compares the complete code with the other owner, then records it.
export const verifyNext = "Trust on first use; not independently verified. Read the complete code with the other owner through another trusted channel, such as a call. If every group matches, have your human run keys verify --id ID --peer PEER --code \"CODE\" with the code the other owner read out; do not copy it from this output. If any group differs, do not use this pairing. Run keys revoke --peer PEER, ask the approving inbox owner to revoke it with token revoke LABEL (select LABEL with keys pairings --json), and tell the other owner.";
export const mismatchGuidance = "Safety code mismatch: the code you entered differs from the code computed from the pinned keys. Nothing was changed. Do not use this pairing. Check that you read the complete code for this peer; if it still differs, run keys revoke --peer PEER, ask the approving inbox owner to revoke it with token revoke LABEL (select LABEL with keys pairings --json), and tell the other owner. No plaintext fallback.";
export const peerKeysChanged = "The peer's published keys changed. Ask its owner whether they changed them; do not continue until they confirm. Communication is held; key replacement is not supported yet.";
export function gate() {
 if (process.env.A2A_SEALED_ENABLED !== "1") fail(encryptionDisabled);
}
export const archiveOnly = "This config directory is a restored archive-only copy. Live sends, inbox reads, polls and send recovery stay held; use history CONTEXT --json for verified historical reads. No plaintext fallback.";
// keys restore writes this marker into the new directory next to the archive-only store.
export const ARCHIVE_MARKER = "archive-only.json";
// Admission guard for live reads (inbox, poll). It runs before the first network request,
// because reading the live inbox acknowledges wakes and replies meant for the live identity.
// It fails closed: with local encryption state present, the store's archive flag is read
// whatever the encryption setting, and an unreadable state refuses. The marker that
// keys restore writes is an extra check that needs no package.
export async function refuseArchiveOnly() {
 const held = (message = archiveOnly) => { const error = new CliError(message); error.code = "archive_only"; throw error; };
 if (fs.existsSync(path.join(C.CONFIG_DIR, ARCHIVE_MARKER))) held();
 if (!fs.existsSync(path.join(C.CONFIG_DIR, "encryption"))) return;
 const unconfirmed = "This config directory has local encryption state, and it could not be confirmed that it is not a restored archive-only copy. Nothing was requested from the inbox. Install the matching optional @a2a-exposed/encryption package here and inspect keys status --json; preserve the encryption folder unchanged. No plaintext fallback.";
 let api, store;
 try { api = await load(); store = new api.LocalState(C.CONFIG_DIR); }
 catch { held(unconfirmed); }
 let archived;
 try { archived = store.status().archive_only; } catch { archived = undefined; } finally { store.close(); }
 if (archived !== false) held(archived === true ? archiveOnly : unconfirmed);
 // Keys rotated: a live read would acknowledge wakes and replies for pins the retired key
 // can no longer serve, so refuse before any request until each pin is re-paired or revoked.
 let rotated = [];
 try { store = new api.LocalState(C.CONFIG_DIR); rotated = typeof store.rotatedPins === "function" ? store.rotatedPins() : []; }
 catch { held(unconfirmed); } finally { store?.close(); }
 if (rotated.length) {
  const error = new CliError(`Keys rotated: ${rotated.map(pin => pin.peer).join(", ")} still ${rotated.length === 1 ? "uses" : "use"} a retired local key. Nothing was requested from the inbox, so no wakes or replies were acknowledged. Release each old pin with keys revoke --peer PEER; re-pairing under a new alias alone does not release it. To keep talking to a peer, re-pair with the new key first (connect URL --sealed-key-id NEW_ID --alias NEW_ALIAS, then keys verify), then revoke its old pin. Old history stays readable with history CONTEXT --json.`);
  error.code = "keys_rotated"; throw error;
 }
}
export async function sdk() {
 gate();
 return load();
}
// Loads the optional package without the traffic gate; only sdk() callers may use it for traffic.
async function load() {
 const require = createRequire(path.join(C.CONFIG_DIR, "package.json"));
 try {
  const primitives = await import(pathToFileURL(require.resolve("@a2a-exposed/encryption")).href);
  const state = await import(pathToFileURL(require.resolve("@a2a-exposed/encryption/local-state")).href);
  if (typeof state.localSafetyCode !== "function" || typeof state.localSafetyEmoji !== "function") throw Error("matching package required");
  const carriers = await import(pathToFileURL(require.resolve("@a2a-exposed/encryption/carriers")).href);
  const content = await import(pathToFileURL(require.resolve("@a2a-exposed/encryption/content")).href);
  return { ...primitives, ...state, ...carriers, ...content };
 } catch { fail(`Install the matching optional @a2a-exposed/encryption package in this config directory before keys init; run ${CLI} keys stores --json afterward. No keys or network requests were created.`); }
}
async function owner(method, route, body, operation = "Local key pairing") {
 const base = baseUrl(), token = C.get("A2A_OWNER_TOKEN");
 if (!base || !token) fail("Select a configured inbox with --config-dir; A2A_BASE_URL and A2A_OWNER_TOKEN are required.");
 const r = await httpJson(base + route, { method, body, headers: { authorization: `Bearer ${token}` } });
 if (r.status !== 200) fail(`${operation} request failed (HTTP ${r.status}): ${r.data?.error || "request refused"}.${r.status === 404 ? " Check the inbox flag and matching Worker version." : ""}${r.status === 409 && operation === "Public-key publication" ? " This inbox keeps the public key it published first; it cannot be replaced, including after keys rotate. Pairings other agents request from this inbox still use that first key." : ""} No private key was sent.`);
 return r.data;
}
// Damaged or unsupported local state shows fixed recovery guidance, never a stack trace or path.
export function openState(api, options) {
 try { return new api.LocalState(C.CONFIG_DIR, options); }
 catch (error) {
  const wrapped = new CliError(error instanceof api.LocalStateError ? error.next : "Local encryption state could not be opened. Preserve the encryption folder unchanged and inspect keys status --json. Do not run keys init over it. No plaintext fallback.");
  wrapped.code = error instanceof api.LocalStateError ? error.code : "local_state_unavailable";
  throw wrapped;
 }
}
export async function selected(id) {
 if (!id) fail("Select --id from keys status --json before this action.");
 const api = await sdk(), store = openState(api);
 try {
  const row = store.row(id);
  if (row.live_state !== "local-only") fail("Selected key is retired; run keys status --json.");
  return { api, bundle: JSON.parse(row.bundle) };
 } catch (error) { fail(error.next || error.message); }
 finally { store.close(); }
}
export async function pinPairing({ id, peer, bundle, localBundle, endpoint }) {
 const { api, bundle: own } = await selected(id);
 if (api.canonicalJSON(own) !== api.canonicalJSON(localBundle)) fail("Local key changed since pairing; preserve the original pairing and inspect keys status --json.");
 await api.verifyBundle(bundle, { cardUrl: bundle.cardUrl, identityKey: bundle.identityKey });
 const store = openState(api, { write: true });
 try {
  const old = store.inspect(peer);
  if (old.current) {
   if (old.current.state === "revoked") fail("This peer's local pin was revoked with keys revoke and is never re-enabled in place. Use a new human-approved pairing under a new alias or label; no trust was changed.");
   if (old.current.localId !== id || old.current.peerEndpoint !== endpoint || api.canonicalJSON(old.current.bundle) !== api.canonicalJSON(bundle)) fail(peerKeysChanged);
  } else {
   const proposal = await store.propose({ peer, localId: id, bundle, peerEndpoint: endpoint, pairingIdentity: bundle.identityKey, expectedCurrent: old.current_digest, policy: "required", verification: "tofu" });
   // This adapter is called only after successful device redemption or an explicit
   // owner-side import of that approved request, bound to both exact bundles.
   await store.approve({ peer, digest: proposal.digest, expectedCurrent: old.current_digest, ownerApproved: true });
  }
  return { peer, local_id: id, key_id: bundle.keyId, verification: "tofu", independently_verified: false, safety_code: store.safetyCode(id, peer).code, safety_emoji: store.safetyCode(id, peer).safety_emoji, traffic_requires_test_flag: true };
 } finally { store.close(); }
}
export async function prepareConnect(id, base, card) {
 const { api, bundle } = await selected(id);
 const extensions = card?.capabilities?.extensions;
 const matches = Array.isArray(extensions) ? extensions.filter(e => e.uri === URI) : [];
 if (matches.length !== 1) fail("Peer does not advertise the local-key pairing protocol; nothing was requested. No plaintext fallback.");
 const other = matches[0].params?.pairingBundle;
 try { await api.verifyBundle(other, { cardUrl: new URL("/.well-known/agent-card.json", base).href, identityKey: other?.identityKey }); }
 catch { fail("Peer public-key verification failed. Preserve the original pairing; no token was redeemed and no plaintext fallback is allowed."); }
 const [endpoint] = pickEndpoint(base, card);
 if (new URL(endpoint).origin !== new URL(other.cardUrl).origin) fail("Peer endpoint differs from the key-card origin.");
 const code = api.localSafetyCode(bundle, other);
 return { id, localBundle: bundle, peerBundle: other, endpoint, safetyPreview: code, safetyEmoji: api.localSafetyEmoji(bundle, other), params: { sealed_bundle: api.canonicalJSON(bundle), sealed_responder_key_id: other.keyId } };
}
// The backup passphrase comes only from piped stdin: never a prompt, argument or environment variable.
export const passphraseGuidance = "Pipe the backup passphrase on stdin, for example from your password manager's command-line tool. It is never read from a terminal prompt, a command argument or an environment variable. Use at least 12 characters. Nothing was written.";
async function readPassphrase() {
 if (process.stdin.isTTY) fail(passphraseGuidance);
 const chunks = []; let size = 0;
 try { for await (const chunk of process.stdin) { size += chunk.length; if (size > 4098) { for (const c of chunks) c.fill(0); fail(passphraseGuidance); } chunks.push(Buffer.from(chunk)); } }
 catch (error) { if (error instanceof CliError) throw error; fail(passphraseGuidance); }
 const value = Buffer.concat(chunks); for (const c of chunks) c.fill(0);
 if (!value.length || !value.toString("utf8").trim()) { value.fill(0); fail(passphraseGuidance); }
 return value;
}
const absolute = (value, flag) => { if (typeof value !== "string" || !value) fail(`Select ${flag} PATH.`); return path.resolve(value); };
export async function command(p, o) {
 gate();
 const actions = ["stores", "init", "status", "publish", "pairings", "pin", "code", "verify", "revoke", "rotate", "outbox", "backup", "restore"];
 if (p.length !== 1 || !actions.includes(p[0])) fail("usage: keys stores|init|status|publish|pairings|pin|code|verify|revoke|rotate|outbox|backup|restore; use keys stores --json and keys status --json before actions");
 const action = p[0];
 const allowed = { stores: ["json"], init: ["store","card-url","allow-os-consent","json"], status: ["json"], publish: ["id","json"], pairings: ["json"], pin: ["id","peer","user-code","json"], code: ["id","peer","json"], verify: ["id","peer","code","json"], rotate: ["id","approve","allow-os-consent","json"], revoke: ["peer","json"], outbox: ["json"], backup: ["to","allow-os-consent","json"], restore: ["from","to","acknowledge-replay-rollback","json"] };
 for (const key of Object.keys(o)) if (!allowed[action].includes(key)) fail(`keys ${action} does not accept --${key}; run keys stores --json and keys status --json before selecting inputs.`);
 const api = await sdk();
 let result;
 if (action === "stores") result = await api.stores();
 else if (action === "outbox") {
  result = (await import("./sealed-outbox.mjs")).list();
  result.next = "Records hold only encrypted messages and public IDs. Never send a new message to replace an unconfirmed one; use send --to ALIAS --recover MESSAGE_ID.";
 }
 else if (action === "revoke") {
  // Local invalidation only fails closed: it holds encrypted use of this pin and keeps history.
  if (!o.peer) fail("keys revoke requires --peer ALIAS (connecting side) or LABEL from keys pairings --json (approving side).");
  const store = openState(api, { write: true });
  try {
   const current = store.inspect(o.peer), record = current.current;
   if (!record) fail("No local pin exists for this peer; nothing was changed. Run peers list --json or keys pairings --json.");
   if (record.state === "revoked") result = { peer: o.peer, revoked: true, changed: false };
   else {
    const proposal = await store.propose({ peer: o.peer, localId: record.localId, bundle: record.bundle, peerEndpoint: record.peerEndpoint, pairingIdentity: record.pairingIdentity, expectedCurrent: current.current_digest, policy: record.policy, verification: "tofu", operation: "revoke" });
    const approved = await store.approve({ peer: o.peer, digest: proposal.digest, expectedCurrent: current.current_digest, ownerApproved: true });
    result = { peer: o.peer, revoked: approved.record.state === "revoked", changed: true, version: approved.record.version };
   }
   result.next = "Encrypted sends, reads and send recovery for this peer are now held in this config directory. History and send records stay unchanged. This does not change the inbox server: to stop the peer's access there, the inbox owner runs token revoke LABEL. Using this peer again needs a new human-approved pairing under a new alias.";
  } finally { store.close(); }
 }
 else if (action === "backup") {
  const destination = absolute(o.to, "--to");
  const passphrase = await readPassphrase(), store = openState(api);
  try { result = await store.createBackup({ destination, passphrase, allowOsConsent: o["allow-os-consent"] === true }); }
  finally { passphrase.fill(0); store.close(); }
  result.next = "Keep the backup file and its passphrase apart. Local send records are not included. A restore goes into a new config directory and is archive-only: history reads only, no live sends.";
 }
 else if (action === "restore") {
  if (o["acknowledge-replay-rollback"] !== true) fail("keys restore requires --acknowledge-replay-rollback: a restore can roll back replay history, so the restored copy is archive-only. Nothing was written.");
  const source = absolute(o.from, "--from"), destination = absolute(o.to, "--to");
  if (path.resolve(destination) === path.resolve(C.CONFIG_DIR)) fail("Restore into a new directory, not the current config directory. Nothing was written.");
  const passphrase = await readPassphrase();
  try { result = await api.restoreBackup({ source, destination, passphrase, store: "file", acknowledgeReplayRollback: true }); }
  finally { passphrase.fill(0); }
  // The marker lets inbox and poll refuse before any request, even with encryption off.
  try { fs.writeFileSync(path.join(destination, ARCHIVE_MARKER), JSON.stringify({ v: 1, archive_only: true, config_identity: result.config_identity }) + "\n", { mode: 0o600, flag: "wx" }); result.archive_marker = true; }
  catch { result.archive_marker = false; console.error("warning: the archive-only marker file was not written. The restored store is still archive-only, and inbox and poll still check it before any request."); }
  result.next = `Restored as an archive-only copy with a new config identity. Use it with --config-dir for history CONTEXT --json only, after installing the matching @a2a-exposed/encryption package and inbox settings there. Live sends, inbox reads, polls and recovery stay held; inbox and poll refuse before contacting the inbox. The original backup file is unchanged.`;
 }
 else if (action === "rotate") {
  // Signer-authority rotation (#379): plan first, then the exact human-approved digest. Local only.
  if (!o.id) fail("keys rotate requires --id from keys status --json. Run it without --approve first to see the exact plan and its approval digest. Nothing was changed.");
  if (o.approve !== undefined && (typeof o.approve !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(o.approve))) fail("--approve takes the approval_digest printed by keys rotate --id ID --json. Nothing was changed.");
  const store = openState(api, { write: o.approve !== undefined });
  try {
   if (typeof store.signerRotationPlan !== "function") fail("Install the matching optional @a2a-exposed/encryption package in this config directory; this version cannot rotate signer keys. Nothing was changed.");
   if (o.approve === undefined) {
    const plan = store.signerRotationPlan(o.id);
    result = { ...plan, changed: false, approve: `keys rotate --id ${o.id} --approve=${plan.approval_digest} --json`, next: `Nothing was changed. Show this plan to the human. After approval, run the approve command. The old key will open old history only and never sign again. Held pins: ${plan.plan.heldPins.map(pin => pin.peer).join(", ") || "none"}; each needs a new human-approved pairing with the new key, then keys verify.` };
   } else {
    const rotated = await store.rotateSigner({ id: o.id, approvalDigest: o.approve, ownerApproved: true, allowOsConsent: o["allow-os-consent"] === true });
    result = { rotated: true, changed: true, id: rotated.id, previous_id: rotated.previous_id, key_id: rotated.bundle.keyId, key_store: rotated.key_store, old_key_retained: true, held_pins: rotated.held_pins,
     next: `The new identity ${rotated.id} is local only. The old key ${rotated.previous_id} is retired: it opens old history and never signs again. Encrypted sends to held pins refuse with "Keys rotated". Live inbox reads and polls stay held until each held pin is revoked with keys revoke --peer PEER. To resume with a peer, run connect URL --sealed-key-id ${rotated.id} --alias NEW_ALIAS (its owner approves) and keys verify, then revoke its old pin. This inbox keeps its first published key: keys publish cannot replace it, and pairings other agents request from this inbox stay held. That needs a Worker-side follow-up.` };
   }
  } finally { store.close(); }
 }
 else if (action === "verify") {
  if (!o.id || !o.peer || typeof o.code !== "string") fail("keys verify requires --id from keys status --json, --peer ALIAS (connecting side) or LABEL from keys pairings --json (approving side), and --code with the complete safety code the other owner read to you through another trusted channel. Nothing was changed.");
  const store = openState(api, { write: true });
  try {
   if (typeof store.verifyIndependent !== "function") fail("Install the matching optional @a2a-exposed/encryption package in this config directory; this version cannot record independent verification. Nothing was changed.");
   try { result = await store.verifyIndependent({ peer: o.peer, localId: o.id, code: o.code, ownerApproved: true }); }
   catch (error) {
    if (error?.code === "safety_code_mismatch") { const e = new CliError(mismatchGuidance); e.code = error.code; throw e; }
    throw error;
   }
  } finally { store.close(); }
  result = { peer: result.peer, local_id: result.local_id, verified: true, changed: result.changed, verification: "independent", independently_verified: true, safety_code: result.code, local_key_id: result.local_key_id, peer_key_id: result.peer_key_id, version: result.record.version,
   next: "This pin is now independently verified for these exact keys. If either side's keys change, encrypted traffic is held and a new human-approved pairing and a new comparison are needed. Encrypted traffic still needs A2A_SEALED_ENABLED=1 in each local process and on each inbox Worker." };
 }
 else if (action === "pairings") {
  result = await owner("GET", "/owner/sealed-pairings");
  result.next = "After human approval, the requester must re-run the same connect command to collect the token. Only then is the pairing listed here for keys pin. Do not create another request.";
 }
 else if (action === "publish") {
  const { bundle } = await selected(o.id);
  const data = await owner("PUT", "/owner/sealed-key", bundle, "Public-key publication");
  if (api.canonicalJSON(data.bundle) !== api.canonicalJSON(bundle)) fail("Public-key publication readback differs; preserve keys and stop.");
  result = { published: true, id: o.id, key_id: bundle.keyId, traffic_requires_test_flag: true };
 } else if (action === "pin") {
  if (!o.peer || !o["user-code"] || !o.id) fail("Select --peer and --user-code from keys pairings --json and --id from keys status --json.");
  const data = await owner("GET", "/owner/sealed-pairings");
  const pairing = data.pairings?.find(r => r.peer === o.peer && r.userCode === o["user-code"]);
  if (!pairing) fail("No matching active human-approved pairing; run keys pairings --json. No trust was changed.");
  result = await pinPairing({ id: o.id, peer: o.peer, bundle: pairing.requester, localBundle: pairing.responder, endpoint: new URL("/", pairing.requester.cardUrl).href });
  result.next = verifyNext + " Do not replace keys automatically.";
 } else {
  if (action === "init" && (!o.store || !o["card-url"])) fail("keys init requires --store from keys stores --json and --card-url https://agent.example.com/.well-known/agent-card.json.");
  if (action === "init") {
   let url; try { url = new URL(o["card-url"]); } catch { fail("--card-url must be a canonical HTTPS /.well-known/agent-card.json URL; no keys were created."); }
   if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || url.pathname !== "/.well-known/agent-card.json" || url.href !== o["card-url"]) fail("--card-url must be a canonical HTTPS /.well-known/agent-card.json URL; no keys were created.");
  }
  const store = openState(api, { create: action === "init" });
  try {
   if (action === "init") result = await store.initialize({ store: o.store, cardUrl: o["card-url"], allowOsConsent: o["allow-os-consent"] === true });
   if (action === "status") result = store.status();
   if (action === "code") {
    if (!o.id || !o.peer) fail("keys code requires --id from keys status --json and --peer ALIAS (connecting side) or LABEL from keys pairings --json (approving side).");
    result = store.safetyCode(o.id, o.peer);
    result.independently_verified = result.verification === "independent";
    result.next = result.independently_verified ? "This pin was independently verified with keys verify. Compare again through another trusted channel whenever you are unsure." : verifyNext;
   }
  } finally { store.close(); }
 }
 if (!o.json && result.safety_emoji) console.log(`Safety emoji: ${formatSafetyEmoji(result.safety_emoji)}
${emojiGuidance}
Full safety code (details): ${result.code || result.safety_code}`);
 console.log(o.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
}

export function formatSafetyEmoji(items) { return Array.isArray(items) && items.length === 7 ? items.map(x => `${x.emoji} ${x.name}`).join(" · ") : "(unavailable)"; }
export const emojiGuidance = "Compare every emoji and name in order through another trusted channel; if any differs, stop and deny. This quick 42-bit check is weaker than the full 60-digit code. Without commit-reveal, an attacker repeatedly generating keys could match the short display; compare the full code for high-stakes pairings. It does not independently verify a peer. keys verify still requires the complete numeric code read by the other owner.";

// Read public pin metadata only; never load a private identity or authorize traffic.
export async function peerSafety(peer, entry) {
 if (entry?.sealed?.policy !== "required") return {};
 let store;
 try {
  const api = await load(); store = openState(api);
  const comparison = store.safetyCode(entry.sealed.localId, peer);
  return { safety_emoji: comparison.safety_emoji, safety_code: comparison.code, verification: comparison.verification, comparison_guidance: emojiGuidance };
 } catch { return { safety_emoji: null, safety_code: null, comparison_guidance: "Safety comparison unavailable. Inspect keys status --json and keys code for this peer; no trust was changed." }; }
 finally { store?.close(); }
}
