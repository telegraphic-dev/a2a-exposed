// Local CLI adapter. The optional crypto package is never loaded for ordinary commands.
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as C from "./config.mjs";
import { CLI, CliError, httpJson, pickEndpoint } from "./a2a.mjs";
import { baseUrl } from "./commands.mjs";
export const URI = "https://a2a.exposed/ext/sealed/v1";
const fail = message => { throw new CliError(message); };
export const encryptionDisabled = "Local encryption is disabled. Set A2A_SEALED_ENABLED=1 in this local CLI or MCP process only after owner approval; the inbox Worker needs its own setting. Only the exact value 1 enables encryption; true, yes and whitespace do not. No plaintext fallback.";
export const peerKeysChanged = "The peer's published keys changed. Ask its owner whether they changed them; do not continue until they confirm. Communication is held; key replacement is not supported yet.";
export function gate() {
 if (process.env.A2A_SEALED_ENABLED !== "1") fail(encryptionDisabled);
}
export async function sdk() {
 gate();
 const require = createRequire(path.join(C.CONFIG_DIR, "package.json"));
 try {
  const primitives = await import(pathToFileURL(require.resolve("@a2a-exposed/encryption")).href);
  const state = await import(pathToFileURL(require.resolve("@a2a-exposed/encryption/local-state")).href);
  if (typeof state.localSafetyCode !== "function") throw Error("matching package required");
  const carriers = await import(pathToFileURL(require.resolve("@a2a-exposed/encryption/carriers")).href);
  const content = await import(pathToFileURL(require.resolve("@a2a-exposed/encryption/content")).href);
  return { ...primitives, ...state, ...carriers, ...content };
 } catch { fail(`Install the matching optional @a2a-exposed/encryption package in this config directory before keys init; run ${CLI} keys stores --json afterward. No keys or network requests were created.`); }
}
async function owner(method, route, body) {
 const base = baseUrl(), token = C.get("A2A_OWNER_TOKEN");
 if (!base || !token) fail("Select a configured inbox with --config-dir; A2A_BASE_URL and A2A_OWNER_TOKEN are required.");
 const r = await httpJson(base + route, { method, body, headers: { authorization: `Bearer ${token}` } });
 if (r.status !== 200) fail(`Local key pairing request failed (HTTP ${r.status}): ${r.data?.error || "request refused"}.${r.status === 404 ? " Check the inbox flag and matching Worker version." : ""} No private key was sent.`);
 return r.data;
}
export async function selected(id) {
 if (!id) fail("Select --id from keys status --json before this action.");
 const api = await sdk(), store = new api.LocalState(C.CONFIG_DIR);
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
 const store = new api.LocalState(C.CONFIG_DIR, { write: true });
 try {
  const old = store.inspect(peer);
  if (old.current) {
   if (old.current.localId !== id || old.current.peerEndpoint !== endpoint || api.canonicalJSON(old.current.bundle) !== api.canonicalJSON(bundle)) fail(peerKeysChanged);
  } else {
   const proposal = await store.propose({ peer, localId: id, bundle, peerEndpoint: endpoint, pairingIdentity: bundle.identityKey, expectedCurrent: old.current_digest, policy: "required", verification: "tofu" });
   // This adapter is called only after successful device redemption or an explicit
   // owner-side import of that approved request, bound to both exact bundles.
   await store.approve({ peer, digest: proposal.digest, expectedCurrent: old.current_digest, ownerApproved: true });
  }
  return { peer, local_id: id, key_id: bundle.keyId, verification: "tofu", independently_verified: false, safety_code: store.safetyCode(id, peer).code, traffic_requires_test_flag: true };
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
 return { id, localBundle: bundle, peerBundle: other, endpoint, safetyPreview: code, params: { sealed_bundle: api.canonicalJSON(bundle), sealed_responder_key_id: other.keyId } };
}
export async function command(p, o) {
 gate();
 if (p.length !== 1 || !["stores", "init", "status", "publish", "pairings", "pin", "code"].includes(p[0])) fail("usage: keys stores|init|status|publish|pairings|pin|code; use keys stores --json and keys status --json before actions");
 const action = p[0];
 const allowed = { stores: ["json"], init: ["store","card-url","allow-os-consent","json"], status: ["json"], publish: ["id","json"], pairings: ["json"], pin: ["id","peer","user-code","json"], code: ["id","peer","json"] };
 for (const key of Object.keys(o)) if (!allowed[action].includes(key)) fail(`keys ${action} does not accept --${key}; run keys stores --json and keys status --json before selecting inputs.`);
 const api = await sdk();
 let result;
 if (action === "stores") result = await api.stores();
 else if (action === "pairings") result = await owner("GET", "/owner/sealed-pairings");
 else if (action === "publish") {
  const { bundle } = await selected(o.id);
  const data = await owner("PUT", "/owner/sealed-key", bundle);
  if (api.canonicalJSON(data.bundle) !== api.canonicalJSON(bundle)) fail("Public-key publication readback differs; preserve keys and stop.");
  result = { published: true, id: o.id, key_id: bundle.keyId, traffic_requires_test_flag: true };
 } else if (action === "pin") {
  if (!o.peer || !o["user-code"] || !o.id) fail("Select --peer and --user-code from keys pairings --json and --id from keys status --json.");
  const data = await owner("GET", "/owner/sealed-pairings");
  const pairing = data.pairings?.find(r => r.peer === o.peer && r.userCode === o["user-code"]);
  if (!pairing) fail("No matching active human-approved pairing; run keys pairings --json. No trust was changed.");
  result = await pinPairing({ id: o.id, peer: o.peer, bundle: pairing.requester, localBundle: pairing.responder, endpoint: new URL("/", pairing.requester.cardUrl).href });
 } else {
  if (action === "init" && (!o.store || !o["card-url"])) fail("keys init requires --store from keys stores --json and --card-url https://agent.example.com/.well-known/agent-card.json.");
  if (action === "init") {
   let url; try { url = new URL(o["card-url"]); } catch { fail("--card-url must be a canonical HTTPS /.well-known/agent-card.json URL; no keys were created."); }
   if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || url.pathname !== "/.well-known/agent-card.json" || url.href !== o["card-url"]) fail("--card-url must be a canonical HTTPS /.well-known/agent-card.json URL; no keys were created.");
  }
  const store = new api.LocalState(C.CONFIG_DIR, { create: action === "init" });
  try {
   if (action === "init") result = await store.initialize({ store: o.store, cardUrl: o["card-url"], allowOsConsent: o["allow-os-consent"] === true });
   if (action === "status") result = store.status();
   if (action === "code") {
    if (!o.id || !o.peer) fail("keys code requires --id from keys status --json and --peer ALIAS (connecting side) or LABEL from keys pairings --json (approving side).");
    result = store.safetyCode(o.id, o.peer);
   }
  } finally { store.close(); }
 }
 console.log(o.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
}
