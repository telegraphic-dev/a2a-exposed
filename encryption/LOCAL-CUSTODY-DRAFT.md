# Local custody/trust API — implementation checkpoint

This branch adds a local-state API, not CLI enrollment or encrypted transport.
Backup/restore, retained local encryption-key rotation, authenticated delivery
ledger/outbox consumption and the complete CLI/stdio MCP flow are still pending.
The current SQLite table stubs are not a replay/delivery implementation.

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
AES-GCM. It does not yet export/restore the local store or enable restored live
keys. Cross-process tests cover racing initialization and process death after a
mock credential write; native lifecycle tests use simulated child processes only.

Recovery approval is action-specific. Each operation listing includes a monotonic
revision and `recovery_choices` with the approval digest for adopt or
abandon-if-absent. Pass the exact listed `approvalDigest` alongside the immutable
operation digest and explicit human approval. The digest binds configuration,
operation, state, revision and action; it is invalid after any transition, even
when the state name is unchanged. After provider reads and key self-checks, the
final SQLite transaction compares the original state/revision/digest before
changing it. A stale adoption rolls back any identity insertion. List and obtain
a new approval rather than reusing an earlier one. The unreleased schema is now
version 2; earlier draft stores are preserved and refused, never auto-migrated.
