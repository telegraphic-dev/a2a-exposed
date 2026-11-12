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

## Internal maintenance and staged grant records

`LocalState._withMaintenanceQueue` is an internal coordinator mechanism. A host
must acquire its authority lease before the shared in-process SDK queue. The
callback can commit distinct SQLite transactions while retaining that queue;
ordinary SDK writers wait until it exits. Synchronous authority checks run on
entry, transaction boundaries and exit. Queue reentry, escaped transaction
handles, open transactions at callback exit, read-only stores and archive holds
refuse. A failed later stage rolls back only its open transaction; earlier
committed stages remain durable. An uncertain COMMIT never implies rollback.

The queue is not a cross-process writer lock. An idle interval between SQLite
transactions permits another process to write. A future host must coordinate
all pairing, credential and SDK writers under the same real authority lease.
The stage-aware exit check may validate an already committed host transition;
it cannot permit another SDK write after authority has been released.

Within a live maintenance transaction, `stageGrant`, `inspectGrant` and
`transitionGrant` operate on exact immutable configuration/intent/set/epoch/
revision/MAC bindings. SQL constraints also enforce canonical UUID/base64url
encoding, generation uniqueness and retained monotonic states: staged to ready
or void, then ready to void. Void history cannot be deleted or resurrected by
replacement. A ready record is coordination metadata; it grants no pairing,
trust, admission, publication or delivery authority.

Schema 6 preserves and refuses older draft stores without migration. A store
with any host-grant history, including void rows, refuses backup before private
credential reads or output creation. Restore refuses imported host-grant rows
before creating a target. Empty-host backups still restore archive-only. Host
grant archival, host authority integration and the continuation coordinator
remain unfinished; these internal methods enable no CLI/MCP/Worker route.

## Internal continuation codecs and source snapshots

`cli/lib/continuation-records.mjs` is a private, synchronous codec. Its keyed,
domain-separated records bind an exact root/configuration/epoch/set, ordered
membership and exclusions, source fingerprint, credential source, trust version,
comparison evidence, intent and reconciliation observations. Canonical encoding
refuses accessors, hidden fields, sparse arrays and noncanonical digest encodings.
Tokens and compared safety codes are represented by keyed commitments in records.
Caller inputs are copied before use.

The attestation codec authenticates caller-supplied evidence; it does not prove
human approval, independent comparison or current authority. Fresh-use checks
apply a bounded comparison lifetime; expired intents remain inspectable for
no-grant abandonment. Abandonment distinguishes absent, empty and nonempty values
in both original sources. Its observations bind the diagnosing process, including
file-only plans and finalization. The reconciliation MAC authenticates both its
payload and an explicit process commitment. A restarted process can diagnose missing old environment values
for abandonment, but cannot reuse the old process's reconciliation approval.
Finalize-shaped records require the exact ready set, original source/member
commitments and the environment process binding. Structural validity alone never
authorizes finalization or any external effect.

`cli/lib/continuation-sources.mjs` snapshots explicitly supplied bounded UTF-8
bytes and environment objects. It performs no file or environment reads. Strict
literal parsing rejects malformed, duplicate or ambiguous source entries instead
of silently normalizing them. Inventory selection requires a complete, sorted
partition of selected and excluded aliases and unambiguous explicit credential
variables. Nonempty environment values take precedence over file values; an
empty environment value permits the file value. Legacy pairing metadata supplies
no verified identity, endpoint or approval evidence. Private source texts and
selected tokens are privileged in-memory inputs and must never be tool output.

These modules are not imported by a CLI command, Worker, MCP route or SDK adapter.
They create no file, credential, grant or approval and perform no network call.
Authority leases, authenticated membership and human provenance, durable intent
storage, the continuation coordinator and admission remain unfinished. Comparing
snapshots does not prevent an undetectable change-and-restore between reads.

## Remaining integration boundaries

Pairing identity and extension activation are privileged caller attestations in
this SDK. A reviewed host must supply current authorization before transport,
acceptance, publication and local consumption. The codecs and ledger invoke no network or
model callbacks; only the explicitly constructed transport adapter invokes fetch. Read/ack gives stable at-least-once delivery IDs and does not
promise exactly-once external effects.

The unreleased local schema changes from version 2 to 6. Older draft stores are
preserved and refused rather than migrated. Backup restores remain archive-only;
semantic ledger restore, live continuation, native credential-store acceptance
and real Windows validation remain outside this slice. See the
[local custody contract](../../encryption/LOCAL-CUSTODY-DRAFT.md).
