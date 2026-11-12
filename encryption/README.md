# @a2a-exposed/encryption

Local-only primitives for the review-draft [sealed A2A extension](../docs/extensions/sealed-v1.md).
This foundation does not enable encrypted CLI, MCP or Worker traffic. No E2E
product support or cryptographic audit is claimed. Integration, persistent trust,
key custody, replay protection and independent review are required before use.

The package uses pinned hpke-js RFC 9180 primitives and Ed25519 signatures.
It seals independently to the recipient and sender-history keys and binds both
copies with a salted commitment. Keys stay in the caller's local process.
`generateIdentity`, `verifyBundle`, `seal`, `open`, `canonicalJSON` and `parseJSON`
are the draft API. Callers must provide exact outer bindings and locally pinned
public bundles, and persist policy/replay records before delivering plaintext.
`seal` self-opens the sender archive copy before returning. `open` is a primitive,
not authorization or replay storage: it does not validate the integration
message/snapshot union or content/header semantics, so it must not deliver to a
model directly. Object-form `open` cannot recover duplicate JSON names lost by
an upstream parser; validate bounded raw transport JSON before using that form.
The top-level primitive does not implement archive/history, durable delivery or
trust authorization. Invalid caller-supplied clock values are refused.

Static keys do not provide forward secrecy. Lost keys can make old history
unreadable. Host operators still observe routing, timing, state and size. Once
opened, content is visible to the local agent/model provider.

Run `npm ci --ignore-scripts` and `npm test` in this directory. Pack with
`npm pack --dry-run`; no release or deployment is performed. Node 22.18+.

The separate `./local-state` API is an incomplete local custody/trust checkpoint.
See [local custody contracts](LOCAL-CUSTODY-DRAFT.md) for protected local backup
and archive-only restore APIs. Local receiving-key rotation retains old keys under exact explicit approval.
No live CLI enrollment or encrypted transport is enabled. Privileged local replay/outbox APIs are described below.


`./content` validates the exact supported plaintext union and losslessly maps
supported inline parts between A2A 0.3/1.0 without fetching file URIs.
`./carriers` checks structural message carriers/bindings only. See packaged
`schemas/` and the [SDK integration contract](../docs/extensions/sealed-v1-sdk.md).
Neither API replaces signatures, local
trust, assignment, replay/chain checks or model-delivery authorization. No CLI
message path uses them yet.


`./assignment` verifies request/response correlation and signed task assignment
primitives. Receipt-bearing codecs preserve the control receipt separately from
ciphertext. They do not establish durable acceptance/model consumption;
use the local ledger and reviewed host authorization before publication/delivery.


`./ledger` adds local durable initial-request acceptance: cached assignment,
replay and ciphertext outbox commit together before a receipt is returned.
Delivery/publication reads and acknowledgments are separate local operations;
there is no network/model callback. Pairing/activation are trusted caller
attestations until a reviewed transport adapter exists. Local outbound preparation,
one-time transmission authorization, correlated response acceptance, follow-ups
and consecutive snapshot chains are implemented without network callbacks.
See [the local sender contract](LOCAL-CUSTODY-DRAFT.md#local-sender-response-and-chain-api).
Actual messaging, semantic restore and real platform acceptance
remain gated.


`./tasks` extracts exact raw 0.3/1.0 Task wrappers and history without ordinary
normalizers. It preserves sealed events and assignment controls, rejects outer
plaintext/artifacts and conflicting bindings, and marks routing state and history
order unverified. This parser does not authenticate receipts, reconstruct chains
or deliver content; the privileged ledger and future transport adapter must do so.


`DeliveryLedger.acceptTask` connects this extraction to the local cryptographic
and transaction gates: verify receipts/signatures, open content, order snapshots
by verified revisions, then commit the whole assignment/delivery/chain batch.
It returns stable delivery IDs and verified chain state separately from untrusted
routing state. Gaps/forks/failure do not partially publish new work. It remains a
privileged local API; no Worker/CLI/MCP messaging route enables it yet.


`./transport` provides a privileged sealed-only JSON-RPC client for explicit local
hosts. It takes a fresh local pairing/credential callback, approved endpoint,
fixed protocol and a card matching the approved bundle. Send releases a prepared
ciphertext once; polling uses a locally signed assignment. Activation echo is
required on every response, redirects are refused, and failures never trigger a
new ID, version or plaintext retry. Results contain IDs/state and truthful send
privacy facts, not plaintext or credentials. Tests use synthetic fetch/provider
fixtures. Actual saved-pairing CLI wiring, Worker routing, native platforms and
production traffic remain unimplemented/unaccepted; this export enables none of
those automatically.
