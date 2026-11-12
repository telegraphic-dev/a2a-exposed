# Sealed v1 local SDK integration contracts

These contracts refine the [review draft](sealed-v1.md). The local SDK exposes
content/carrier codecs, signed task assignments and a persistent ciphertext
ledger, plus a privileged sealed-only JSON-RPC adapter. CLI, MCP and Worker
messaging do not use these APIs. Encryption remains
disabled; host authorization, transport integration and platform acceptance are
required before enabling traffic.

## Content and carriers

`./content` validates messages and complete task snapshots. Supported inline
text, data and file parts preserve their metadata between A2A 0.3 and 1.0.
URI files, lossy conversions and partial snapshot updates are refused.
`./carriers` validates exact structural wrappers and outer bindings without
claiming authentication. The packaged JSON schemas describe those structures;
signatures, pinned trust and local policy remain separate requirements.

`./tasks` reads bounded raw Task JSON before ordinary protocol normalization.
It preserves sealed history and assignment controls, refuses plaintext artifacts
and conflicting duplicate events, and treats routing state, timestamps and
server history order as untrusted.

## Assignment and durable acceptance

`./assignment` binds a signed assignment to the original request digest,
context, message ID and assigned task ID. A co-carried response is also bound by
its digest. Inputs are snapshotted before asynchronous verification. Creating a
receipt alone does not establish durable acceptance or model consumption.

`DeliveryLedger.receiveInitial` commits replay state, a stable signed assignment
and ciphertext delivery together before returning a receipt. Task uniqueness
spans contexts. Duplicate acceptance reuses the retained assignment and delivery
IDs. Receipt transport and local model acknowledgment are separate operations.
The database stores encrypted content and provenance; plaintext is opened only
through an explicit local read under current trust.

## Outbound correlation and task history

Local preparation retains the exact encrypted request. A single-use transition
authorizes a transport attempt; an unknown outcome does not authorize a retry.
Response acceptance requires provenance from a locally attempted user request,
an immutable peer-signed assignment and current pinned trust.

Full snapshots form consecutive signed revision chains. Gaps, forks and terminal
state conflicts refuse acceptance. `acceptTask` verifies all events before
atomically committing assignment, delivery and chain state. Verified revisions
determine snapshot order. Older snapshots remain history-only; unsequenced new
messages cannot be inserted around a terminal snapshot.

## Explicit sealed-only transport

`./transport` sends only previously prepared ciphertext to the exact approved
HTTPS endpoint and fixed protocol. It requires the pinned public bundle, fresh
local grant/credential revision and a host authorization lease. Every response
must confirm extension activation. Redirects, plaintext responses, retries and
protocol fallback are refused. Send and poll acceptance recheck authorization
before writes and COMMIT. Tests use synthetic HTTP/provider fixtures; the real
CLI pairing writer lock and platform integration remain unfinished. See the
[adapter host contract](sealed-v1-integration.md#sealed-only-json-rpc-client-adapter).

## Remaining integration boundaries

Pairing identity and extension activation are privileged caller attestations in
this SDK. A reviewed host must supply current authorization before transport,
acceptance, publication and local consumption. The codecs and ledger invoke no network or
model callbacks; only the explicitly constructed transport adapter invokes fetch. Read/ack gives stable at-least-once delivery IDs and does not
promise exactly-once external effects.

The unreleased local schema changes from version 2 to 5. Older draft stores are
preserved and refused rather than migrated. Backup restores remain archive-only;
semantic ledger restore, live continuation, native credential-store acceptance
and real Windows validation remain outside this slice. See the
[local custody contract](../../encryption/LOCAL-CUSTODY-DRAFT.md).
