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
and archive-only restore APIs. No CLI enrollment, rotation, replay/outbox
consumption or live encrypted transport is enabled.
