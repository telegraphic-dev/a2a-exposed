# Local custody/trust API — implementation checkpoint

The local-state and delivery-ledger APIs support custody, retained receiving-key
rotation and local replay/outbox operations. CLI enrollment, encrypted transport
and the complete CLI/stdio MCP flow remain pending. Privileged caller attestations
require a reviewed host integration before enabling traffic.

`stores()` lists explicit choices without creating credentials. `LocalState`
opens an existing database read-only by default; `create:true` initializes a new
owner-only encryption directory and database, while `write:true` is needed for
existing-state actions. File keys use exclusive mode-600 writes in a 0700 folder.
Status exposes only public bundles/store/provenance. `loadIdentity` is a privileged
in-process API, not tool output; it self-checks private/public correspondence
without network and refuses live traffic use. Lost files never trigger rotation.

The optional pinned `@napi-rs/keyring` 2.1.2 adapter is isolated in a bounded child
process; secrets use stdin/stdout pipes inside the local process, not command
arguments, environment variables or transcript output. Linux explicitly selects
Secret Service, never the reboot-volatile kernel fallback. No OS credential entry
is accessed unless `allowOsConsent:true` is explicitly supplied by the owner-facing
caller. Native operations may need the owner's OS authorization; file storage is
the unattended alternative. There is no silent fallback. Native-provider errors
are fixed local codes; a timed-out operation may require status/recovery review,
not an assertion that a key was deleted. Windows file protection uses an explicit
current-user ACL and fails if it cannot establish/check it. Native platform
operations and Windows ACL behavior have not been exercised on real accounts.

Trust proposals bind config/local identities and key bundle, exact endpoint,
pairing identity, full old record/version, new bundle/policy/verification decision,
operation and nonce. Approving uses exact compare-and-swap; older approvals fail.
Prior approved records are retained separately for future archive opening.
New/pending proposals hold the live state, and losing a key does not change pins.
`tofu-pinned` is local trust, not evidence a remote token pairing exists; pairing
is explicitly not checked by this API. Independent verification requires the
owner's separate-channel decision. The safety code is computed locally.

The `ownerApproved`, `independentVerified` and `rePairVerified` arguments are
privileged caller attestations, not proofs. A CLI/MCP integration must obtain
human approval of the exact proposal and a separately verified pairing outcome;
it must never populate these flags from peer messages, hosted assertions or
untrusted API input. No network route exposes these methods. This checkpoint
is not approval to use that incomplete integration with real credentials.

Current tests use disposable private directories and synthetic in-memory keys.
They cover restart/own-copy opening, read-only discovery, no private keys in
status/SQLite, file modes/symlinks/loss, explicit stores/consent, exact approval,
independent/re-pair holds, concurrent proposals and retained trust history.
No native keychain entries, server credentials, pairing grants or live resources
were touched. Public protocol/privacy acceptance remains a later gate.

Initialization commits a public recovery intent before the first external write.
An uncertain outcome blocks new initialization until an explicit exact-digest
reconciliation; an absent observation retains the old intent for late completion.
Adoption self-checks the original credential and never replaces an active identity.
The native broker PID is committed before private pipe input, and reconciliation
refuses a still-running broker. Timeout handling waits for exit/close, escalates
termination, and reports an unreaped process as unknown rather than success.

Safety-code inspection accepts the exact pending proposal digest before approval;
without it a pending change refuses to show the old code. Independent approval
also binds the compared proposal digest. Identity replacement requires both
separately approved re-pairing and independent re-verification. Literal boolean
OS consent is checked at both custody and broker boundaries. Schema version,
structure and integrity are checked without migration or replacement. Public
status/proposal/history listings have explicit bounded continuation inputs.

The isolated backup byte-format primitive uses bounded scrypt and authenticated
AES-GCM. The local store snapshot API described below uses it; it never enables restored
live keys. Cross-process tests cover racing initialization and process death after a
mock credential write; native lifecycle tests use simulated child processes only.

Recovery approval is action-specific. Each operation listing includes a monotonic
revision and `recovery_choices` with the approval digest for adopt or
abandon-if-absent. Pass the exact listed `approvalDigest` alongside the immutable
operation digest and explicit human approval. The digest binds configuration,
operation, state, revision and action; it is invalid after any transition, even
when the state name is unchanged. After provider reads and key self-checks, the
final SQLite transaction compares the original state/revision/digest before
changing it. A stale adoption rolls back any identity insertion. List and obtain
a new approval rather than reusing an earlier one. The unreleased schema is
version 5; earlier draft stores are preserved and refused, never auto-migrated.


## Protected backup and archive-only restore API

`state.createBackup({destination,passphrase,allowOsConsent})` takes a separate
consistent SQLite read transaction, validates bounded static-table rows and all
private/public key pairs, encrypts them, then writes a new exclusive protected
file. Passphrase is an in-process Uint8Array from a protected source, never a
command argument or tool-visible field. Credentials stay out of public output.
Known lost keys and unresolved credential writes refuse backup. An explicitly
observed-absent credential remains catalogued and counted as absent; the backup
cannot recover a credential written after that observation/snapshot.

`restoreBackup({source,destination,passphrase,store:"file",
acknowledgeReplayRollback:true})` requires a new destination, explicit file-store
selection and replay-rollback acknowledgment. Native restores are unsupported;
there is no silent store fallback. Validate every decrypted row and available
key before creating a target directory. Import uses a private staging directory
with a durably recorded archive-only hold before private writes, then atomically
installs the canonical encryption directory. A failed/interrupted stage remains
protected for inspection; never overwrite it on retry. Existing targets are
never merged. The encrypted source backup remains the recovery source.

The restored config gets a fresh config UUID and records its source UUID and
public operation provenance hash. Private keys, historical pins, proposals,
replay rows and pending delivery IDs are retained; original provider credentials
are converted to explicitly selected protected files. The global restore hold
blocks key initialization, recovery actions and trust writes; identity rows and
inspection show archive-only, and live-use loads remain refused. No automatic
resend or delivery happens. A future separate fresh receiving identity and peer
re-verification flow is required before live enrollment; it is not implemented.
This is a local API checkpoint, with no working backup/restore CLI command yet.

## Local receiving-key rotation

`rotationPlan(id)` lists the exact current key/store and an action-specific
approval digest bound to config, previous bundle and latest operation revision.
`rotateLocal({id,approvalDigest,ownerApproved:true,allowOsConsent})` retains the
Ed25519 identity and old X25519 keys, generates a fresh receiving key, and follows
the same durable intent/write/commit/reconciliation rules as initialization.
Concurrent plans produce only one successor. A failed write never retires the
old current key; uncertain writes hold further rotation until exact recovery.
Retired rows cannot authorize new trust proposals/approvals or safety-code claims.
Existing peer bindings stay held after rotation until a new independently
verified local-key proposal is approved; rotation grants no remote pairing.
Backups include both old and new private keys, and restores retain them under
the archive-only hold. There is no key deletion API or live key advertisement.

Backup preflight checks the passphrase and destination existence before any
credential read; a racing exclusive-create failure is backup_destination_exists.
Restore syncs the SQLite file and staging directory, then the promoted directory
and its parents where directory fsync is supported. Results distinguish
file-and-directory-sync-completed from directory-sync-unverified. These record
completed system calls, not proof of hardware power-loss durability. Unsupported
platform directory sync remains unverified. A sync/I/O failure after promotion
returns restore_installed_readback_failed and retains the archive-only target;
it must not suggest an automatic overwrite/retry. Native/Windows durability and
real power-loss behavior are untested.

## Durable initial-request receiver API

The unreleased local-state schema is version 5 for assignment/provenance and
outbound/chain tables; earlier drafts remain preserved/refused, not migrated.
`DeliveryLedger` is a privileged local API with no HTTP/model callback. Its
pairingVerified/pairingIdentity/activation arguments are trusted local-transport
attestations, never peer-controlled fields or permission grants. The real client
adapter must derive them from existing human-authorized pairing and negotiated
transport; that adapter/traffic path is not implemented here.

`receiveInitial` verifies public signature/bindings before credential access,
opens the request and prepares its signed assignment, then rechecks the exact
current pin and atomically commits replay, assignment, ciphertext delivery and
provenance. No computed receipt escapes a failed commit. Namespace uses the
stable local signing identity plus peer identity/message ID, surviving X25519
rotation. Exact duplicates reuse the original receipt/ackId/deliveryId; changed
context/digest/task or conflicting task assignment refuses. A stable local/peer/task ID binds exactly one initial request/context, enforced both by a transaction check and database uniqueness across contexts. New pending trust or
revocation during verification prevents commit. SQLite contains ciphertext and
public provenance, not opened content.

Pending receipt publication and model consumption are distinct. Cached receipt
preparation requires current pairing/trust and never re-signs a new assignment.
Transport acceptance does not claim peer receipt. Delivery reads are explicit,
untrusted and at-least-once with a stable ID; only explicit consumed acknowledgment
closes the local outbox. No exactly-once external-effect guarantee is made.
Revoked/pending/rotated trust holds live reads and publication, while historical
rows remain. Restored archive-only state lists those rows but cannot create,
consume or acknowledge live work. Backups retain new ledger rows as encrypted
archive state; full semantic/interop restore audit is still an acceptance gate.
## Local sender, response and chain API

These methods remain isolated SDK algorithms; no CLI/Worker transport is enabled.
`prepareRequest` commits a self-opened encrypted request before returning its ID;
`beginTransmission` commits transmitting before releasing the cached ciphertext
once. A crash or timeout leaves unknown delivery, never permission for automatic
re-send/new-ID/plaintext fallback. `recordTransport` retains provisional transport
IDs separately; only a verified immutable peer assignment grants task authority.
`acceptAssignment` pins that assignment and can hold a co-carried later snapshot
while complete signed history is obtained; `acceptResponse` requires a previously
pinned assignment and an inner digest of the exact locally prepared request.
Acceptance and readback share an answered-request validator: the cached row must
have user-request provenance (null reference_digest), an attempted state, exact
current trust/key and digest, and a cached role=user/kind=message envelope whose
IDs and sender/recipient match. An outgoing agent response is never a request
being answered, even when both task directions share context/task strings.
The local adapter must validate actual Task wrappers before attesting their IDs.

`receiveFollowup` requires the existing inbound assignment, exact context/task and
protocol. It queues ciphertext/provenance/replay atomically; duplicate packets keep
the same local delivery ID. `prepareResponse` binds the exact accepted request
and commits its ciphertext before transmission. Full snapshots start at revision
zero, then bind the previous signed envelope digest. Snapshot head and outgoing
ciphertext share a transaction, and concurrent creators compare the original
head. Accepted snapshots must be consecutive; gaps refuse as provenance_incomplete,
forks/terminal resurrection refuse, and older accepted snapshots read history-only.
Terminal heads reject new follow-ups. These checks do not establish real adapter,
Task-history ordering, multi-process sender, semantic restore or live traffic
acceptance; those remain separate gates.


## Local Task reconstruction

`acceptTask` accepts an exact raw Task for an explicitly selected cached initial
request. It validates any receipt and all public signatures before loading keys,
opens agent events, and orders snapshots by commitment-checked revisions.
One transaction binds the immutable assignment and queues the entire verified
batch with replay/provenance/chain state. An incomplete or forked chain, changed
trust or failed commit leaves no partial new assignment/delivery/head. Cached
history user messages must be actual attempted local user requests; response-to-
response correlation remains refused. Omitted Task artifacts are empty; present
artifacts must still be an empty array. Routing-only cancellation cannot replace
currentPeerState, which is derived from signed local chain state. The result
returns IDs, not plaintext or model consumption. No actual network adapter calls
this isolated API yet; archive/native/traffic/release gates remain.


Task import does not place ordinary agent messages on the snapshot chain. A new
unsequenced message is held with task_terminal if the known head or incoming
verified batch is terminal, regardless of server array order or poll grouping.
The whole rejected batch rolls back, including any new assignment. Previously
accepted duplicate IDs remain stable; this does not infer their chronology from
sentAt. Terminal content belongs inside a signed full snapshot. Separate archive
opening remains unavailable and cannot authorize live delivery.

A locally retained, exact current-pin assignment remains valid for fresh
follow-ups after the initial envelope's 30-day admission window. The closed
retained-cache path checks request bytes/digest/purpose/provenance and both request
and receipt signatures against current bundles; a repeated receipt must equal
the immutable saved one. It does not backdate now or expose an archive-mode flag.
First unassigned requests/receipts still use live admission freshness, and every
incoming agent envelope still passes the current-time live freshness checks.


Transport proposals may include the exact peerEndpoint independently of the key
bundle cardUrl, on the same canonical HTTPS origin. This endpoint is part of the
human-approved proposal/record digest; a discovered interface cannot silently
replace it. Bundle input is synchronously cloned before asynchronous verification.
Existing omitted-endpoint SDK calls keep cardUrl as their endpoint and require a
new explicit proposal before using another protocol path.


LocalState.locked may take a trusted authorizationGuard plus withAuthorizationLease.
Both must be functions and must be provided together. The host lease precedes the
DB queue, encloses the complete transaction, and must coordinate every actual
pairing-store writer. The synchronous guard returns literal true before writes
and after the action await immediately before COMMIT; failure rolls back. The
Task transport supplies this guard from its fresh local pairing reader, including
effective credential and endpoint, rather than reusing a captured verified flag.
No actual cross-process pairing store or public approval proof is added here.

The host pairing snapshot includes a nonnegative safe-integer revision. Every
revocation, restoration or credential-generation change increments it under the
same host lease, even if token bytes later match again. Final guard comparison
includes this revision to reject in-flight revoke/restore ABA changes. The real
store must persist/enforce that monotonicity; a synthetic reader does not prove it.
