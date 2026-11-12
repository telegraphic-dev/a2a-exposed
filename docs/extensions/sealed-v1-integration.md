# Sealed v1 integration contracts — second-review draft

These contracts refine the [base draft](sealed-v1.md). They are requirements for
later integration, not features of the isolated primitives package. They must
pass protocol/cryptographic implementation review before any encrypted traffic.
Conflicting earlier draft prose is superseded here.

## Task assignment and receipts (F1)

A new sender chooses cryptographically random UUIDv4 context/message IDs (at
most 200 ASCII characters). A request with `taskId:null` has no authenticated
task assignment. A Worker's response ID is **provisional routing metadata**.
It cannot authenticate a peer acknowledgment or task state.

On first verified receipt, the recipient local client atomically binds its own
identity, sender identity, context and signed-envelope SHA-256 digest to exactly
one observed task ID. Message-only encrypted responses are unsupported in v1. In that same
transaction it persists a signed assignment acknowledgment and pending delivery
record. Conflicting concurrent observations lose the compare-and-swap and stay
held; they do not create another acknowledgment or delivery. An existing context
can contain a new request with another message ID and task; its assignment is
independent. A repeated initial envelope matches the saved assignment only.

The acknowledgment has exactly `{v:1, kind:"assignment", requestDigest, from,
to, contextId, requestMessageId, taskId, responseKind, responseDigest, ackId, signature}`. `from`
and `to` use the signed peer objects; `from` is the recipient of the initial
request. Digests are 32-byte unpadded base64url; ackId is a UUIDv4.
`responseKind` is `task` in v1 and taskId is nonempty. Message-only encrypted
responses are unsupported; null is reserved for the unassigned initial request.
Sign Ed25519 over UTF-8 `a2a-exposed sealed assignment v1\n` plus RFC 8785
canonical JSON of every field except signature; signature is 64-byte base64url.

The receipt has exactly one location: `Message.metadata[URI].assignment`.
No receipt is inserted into the envelope or added as a second DataPart. A
content-bearing response still has exactly one sealed DataPart; its outer
metadata has exactly `{URI:{v:1,assignment:receipt}}`. A receipt-only Message
instead has exactly one TextPart with fixed text `[encrypted request accepted]`,
that same metadata, role agent, messageId equal to ackId, the signed contextId,
the assigned taskId when non-null, and extensions `[URI]`. The 0.3 TextPart
additionally carries kind text; 1.0 has no kind field. No dynamic text or other
metadata is permitted. This is a control receipt, never model-facing content.
The receipt signs the local-opened-and-durably-recorded assignment milestone,
not model consumption. Validate raw JSON, activation, schema, signature and
expected request digest/bindings before accepting it. Emit it only after the
request has passed signature, local pins, decryption, commitment, content-schema
validation and the durable transaction. Its pending-outbox delivery retries the
same receipt/ackId. A Task may have no status Message while receipt-pending;
its routing state is untrusted. Task responses use the same metadata receipt inside their status Message,
with either the fixed receipt-only carrier or one encrypted response. Unexpected
Message-only encrypted responses are refused without plaintext fallback.
No new unauthenticated RPC is introduced. Store/retrieve the receipt with the
original task. It contains no original content. The sender checks the
recipient pin, original request digest/context/message ID and exact assigned
ID, then pins the acknowledgment atomically. Before this, report transport
accepted/assignment pending; do not send assigned-task follow-ups or claim
peer-authenticated state. An absent acknowledgment never authorizes resend.

A server can suppress, reorder or misroute provisional assignments. It cannot
make a recipient sign two assignments when that recipient's durable state is
intact. Lost/rolled-back state weakens that guarantee and requires the restore
procedure below; server availability and metadata integrity are not E2E promises.

## Content, carriers and ordering (F2/F6)

The canonical plaintext union is `{nonce, content}` with content exactly:

- message: `{kind:"message", authorRole, parts, metadata, extensions,
  referenceTaskIds}`; original parts are losslessly retained in the encrypted
  array, including text/data mediaType and file name/bytes/mediaType. Missing
  maps/arrays use empty values. authorRole is `user` or `agent`.
- snapshot: `{kind:"snapshot", authorRole, revision, previousDigest, state,
  statusMessage, artifacts, metadata, terminal}`. statusMessage is a message
  content object or null; each artifact is `{artifactId, name, description,
  parts, metadata, extensions}`. All names/descriptions are encrypted.
  Artifacts are complete replacements. There are no artifact append/chunk
  events in v1: refuse append/lastChunk/deltas before processing content.

Outer `header.kind` maps `message` to message and `status` to snapshot. The
reserved artifact kind is refused until a separately reviewed mapping exists.
`header.state` is null for message and the normalized state for snapshot.
Each snapshot binds assigned task, author identity, nonnegative safe-integer
revision and previous signed-envelope digest. First revision is 0, previousDigest
is null; later revisions are consecutive and reference the accepted predecessor.
Each author has a separate chain. Store the latest accepted revision/digest in
the local ledger; stale valid events remain history, not current peer state.
A gap/truncated history is incomplete, not a new trusted baseline. Reconstruct
current peer state only from a complete verified chain. Checkpoints are unsupported in v1; a newly restored
client with a truncated chain reports provenance incomplete.

A2A 0.3 uses a single `kind:"data"` part; 1.0 uses a single `data` part.
Both carry the extension marker in part metadata and list the extension on the
Message. Outbound initial/follow-up message carrier uses the base protocol's
required message ID, context ID, task ID when known, role and parts only.
Task snapshots use a normal Task with opaque ID/context, routing status state
and its status Message containing the sealed snapshot. Artifact content never
appears in outer Task.artifacts; use an empty array. Task.history contains only
sealed Message carriers and the defined receipt-only control carrier. Outer
metadata is empty except the fixed extension marker and defined assignment receipt.
Task cancellation without a signed snapshot is an untrusted transport action;
never present it as peer-authored encrypted content.

The header role binds the **wire** role. `content.authorRole` separately binds
logical authorship. Owner direct replies currently use an outer `user` role;
that carrier must retain wire role user, inner authorRole agent, encrypted
referenceTaskIds and authenticated original-assignment mapping. Polling owner
replies use status Messages with wire role agent. Existing text reply helpers
must not rewrite a sealed payload. Until both mappings have lossless fixtures,
required pairings refuse direct reply mode and use the original Task polling
path. No unsupported path may accept plaintext first and refuse later.

Validate signed raw input before normalizers. The package/transport limit is
200 characters, matching existing IDs; 201/256/257 are refused, never truncated.
Required traffic refuses file URI parts without fetching; URI-looking strings
inside encrypted data/text are untrusted data and are never dereferenced.
Streaming, artifact deltas and non-JSON bindings (gRPC/REST) are unsupported in
v1. GetTask/history retrieval activates the extension for every request; no
stream reconnect semantics are advertised. Plain clients keep their existing
A2A behavior and explicit server-readable labels.

## Durable delivery and archive opening (F3/F4)

Use a local SQLite transaction to persist the envelope reference, replay record,
assignment/snapshot state and durable delivery-outbox row together. Uniqueness
is `(local identity ID, peer signing identity, message ID)`. Store digest,
context, assigned task and trust-record digest. One local process owns the
SQLite writer lock; concurrent CLI/MCP processes use the same database/lock and
bounded busy timeout. Disk-full/lock/transaction failure holds content and emits
state_unavailable; no plaintext notification is returned on a failed commit.

Return a stable delivery ID from the outbox. The local agent explicitly acks
that ID after consumption; until then it may be returned again after restart.
A crash before commit creates no delivery; a crash after commit but before
return leaves a pending row; a crash after return but before ack can redeliver
the same ID. This is durable at-least-once delivery with idempotent IDs, **not
exactly-once external effects**. Consumers must deduplicate their own actions.
First live delivery applies the 30-day age/five-minute future bounds. Store an
observed-time high-water mark and hold if the local clock moves backward beyond
the allowed skew; do not prune replay records on a rolled-back clock.

Explicit `history` opening is a separate read-only mode that never creates an
outbox entry, task action or wake. It can open content older than 30 days with
retained local keys and the historically approved bundle record. Report original
trust provenance, signed time and whether local acceptance exists; server time
is not proof. Previously accepted old-key history remains readable during a
pending key change. Unknown/unapproved historical bundles stay held. Revoked or
compromised bundles require a separate explicit archive-only override, always
labelled untrusted; they never authorize live work. Key deletion yields key_lost.
The primitive's default live age check does not implement archive policy; a
separate reviewed archive API is required before CLI history integration.

## Trust, custody and backup (F5/F7)

All operations use an explicit --config-dir, whose local identity/agent ID is
shown in every listing/readback. No alias alone identifies a key. Local states:
unpinned, tofu-paired, independently-verified, change-pending, retired, revoked.
A pin binds canonical endpoint/card URL, existing pairing identity when any,
fresh local encryption identity, complete signed bundle digest and policy.
Changing endpoint, pairing identity, encryption identity/key or relaxing required
policy creates a new proposal and loses independent verification.

Prompt-free command contracts (names remain review-draft):

- `keys stores --json` lists supported stores and availability, without creating keys.
- `keys init --store keychain|file --config-dir DIR --json` creates fresh keys;
  the store is explicit, file uses private directory 0700/files 0600. Keychain
  unavailable/denied fails promptly, never silently falls back. File mode is
  labelled in all status results. No automatic platform permission prompts.
- `peer keys inspect --to ALIAS --json` lists current/proposed signed bundles,
  full digests, endpoint/local identity and trust state. It proposes nothing.
- `peer keys propose --to ALIAS --bundle-file FILE --expected-current DIGEST|none
  --policy required|off|allow-server-readable --json` validates and records a
  proposal only. Human pairing authorization remains separate.
- `peer keys approve --to ALIAS --expected-current DIGEST|none --proposal DIGEST
  --verification tofu|independent --json` compare-and-swaps the exact approved
  change. independent explicitly records the owner's separate-channel decision;
  no hosted assertion can set it. Identity changes additionally require a new
  human-approved pairing before approval succeeds. Reject names the exact digest.
- Policy relaxation requires the same proposal/approval flow, not a send flag.

The proposal digest is SHA-256 of UTF-8 `a2a-exposed sealed trust proposal v1\n`
plus canonical JSON of exactly `{v:1,configIdentity,localIdentity,peerEndpoint,
pairingIdentity,currentRecordDigest,currentRecordVersion,newBundleDigest,
newPolicy,operation,verificationDecision,proposalNonce}`. configIdentity is a
local random UUID, not a path; peerEndpoint is the exact canonical HTTPS origin
and protocol path, never an alias alone. operation is enroll, rotate, re-pair,
policy, verify, reject or revoke. verificationDecision is tofu or independent;
newPolicy is one of the three policy strings. proposalNonce is fresh 32-byte
base64url. The currentRecordDigest covers the complete local trust record,
including endpoint, pairing/encryption identities, policy, verification and
monotonic version, domain-separated with `a2a-exposed sealed trust record v1\n`.
None means no prior record. Every approval field, including policy and
verification, must equal the proposal; `--verification` cannot edit it. The
transaction compare-and-swaps the full current record/version and exact proposal
digest. Stale approval returns approval_stale with inspect guidance. A new
policy with unchanged keys, alias reuse or provenance change still changes the
digest. A peer-supplied bundle can only propose; owner authorization is the
explicit local approve operation under the caller's human-approval policy,
never a hosted mirror, incoming peer request or automatic tool action. Only
the human-approved re-pair result can authorize an identity-change proposal.

Safety-code bytes are UTF-8 `a2a-exposed sealed safety v1\n` followed by canonical
JSON of the two peer tuples `{cardUrl,identityKey,keyId}`, sorted by their raw
32-byte identity public keys, then canonical cardUrl for ties. SHA-256 becomes
an unsigned big-endian integer; reduce modulo 10^60, zero-pad to 60 decimal
digits and display 12 groups of five. Same identity on both ends is refused.
Compare all groups through a separate trusted channel. This is a user comparison
code, not server attestation; automated equality via the same relay is not verification.

Backup is a versioned encrypted local file. Draft format: strict JSON
`{format:"a2a-exposed local backup",v:1,kdf:"scrypt",N:32768,r:8,p:1,salt,nonce,ct}` with random 32-byte salt,
12-byte AES-256-GCM nonce and base64url ciphertext+16-byte tag; AAD is canonical
JSON of all fields except ct. Derive 32 bytes from UTF-8 passphrase without
Unicode normalization. Reject parameters outside the fixed v1 tuple before
allocating KDF memory. Minimum 12-byte passphrase; input is protected file,
named env or stdin, and exactly one source. Backup destination must be new,
created exclusively mode 0600. Include local identity, retained keys, historical
pins, policy/verification records, replay ledger and pending delivery IDs in
one consistent transaction snapshot. Restore decrypts/validates everything to
a new private directory and atomically installs only after all checks pass.
Never partially merge keys into active state or overwrite an existing config.
Backup contents/private keys never appear in stdout/errors.

Offline backups cannot prove no newer state existed. After restore, require
explicit `keys restore --ack-replay-rollback` and keep live delivery paused until
peers re-verify and a new local receiving identity is enrolled; old keys/pins
remain archive-only. Multi-device live use of one identity is unsupported;
cloning the SQLite state loses the single-writer guarantee and is not advertised.

## Byte rules, privacy and errors (F7/F8/F9)

All signature fields are unpadded canonical base64url of 64 bytes. Public keys,
nonces, commitments/digests and HPKE encapsulations are 32 bytes. Ciphertexts
include a 16-byte tag. CSPRNG is the platform crypto API; each copy uses fresh
HPKE base-mode sequence zero and exactly one Seal/Open. The sender self-opens
its archive copy before transmitting. This does not prove a dishonest sender
created an openable copy. UTF-8 decoding is fatal; duplicate JSON member names,
including escaped equivalent names, are refused both outside and inside.
Depth counts the root as 0 and refuses a child at depth 33. No Unicode
normalization or normalization of signed bytes is permitted.

Card URLs are canonical `URL.href` HTTPS URLs with no username/password,
fragment or query; default ports are omitted. Exact percent-encoded path bytes
are signed and immutable, never decoded/re-encoded. Address migration is a new
exact-digest trust proposal; old bundles remain historical only. Initial
notBefore may be at most five minutes ahead; it is not a historical trust timestamp.

Outer IDs are local random UUIDs, never copies of message text/names. The only
outer metadata is the fixed extension URI/v value and necessary assignment
receipt. No preview/extraction of DataParts, dynamic error text, telemetry,
feedback or crash log may expose content, ciphertext or private keys. Wakes
and pushes contain fixed labels and opaque identifiers for all peers, and never
attempt to deliver sealed blobs to an unaware callback. Arbitrary hostile peers
can deliberately put content into routing IDs; this is not a confidentiality
promise for attacker-chosen plaintext. Honest local clients never do so.

Delivery milestones are distinct: transport accepted, extension activated,
peer signature verified, locally opened, locally acknowledged. Header echoes
and Worker state are not peer receipts. Compromise of either endpoint's retained
private decryption key can expose that endpoint's copies; metadata/deletion,
timing/size, compromised local endpoints and model providers remain outside E2E.

For JSON-RPC, use -32602 for known malformed/unsupported/required input rejection,
HTTP 200, with error.data exactly `{code,operation,deliveryStatus,retryable,next}`.
Authentication/rate/body-size errors retain their existing transport handling.
Safe string codes include invalid_envelope, approval_stale and state_unavailable
in addition to the base draft. Known rejected input has deliveryStatus rejected;
a missing echo/timeout after transmission has unknown and retryable false.
CLI JSON exits 1 and emits the same typed object on stdout (safe prose on stderr).
MCP uses isError true plus the typed structured result. Read-only status and
inspect list recovery choices; no uncertain-send error suggests a fresh ID retry.
On a request carrying both extension header names, compare only the sets of
sealed-profile URIs; unrelated extensions keep their independent activation.
Unsupported sealed versions do not activate v1. Retrieval/polling requests must
activate the same version; no HTTP header activates encryption in a local policy.


## Remaining schema and implementation gates

Before any integrated traffic, commit machine-readable exact content/carrier
schemas and cross-version request/receipt/snapshot fixtures, including kind/state,
terminal flag and carrier/logical-role agreement. The isolated `open` primitive
does not perform this schema validation and cannot deliver directly to a model.
Chain uniqueness is local identity + peer author identity + context + assigned
task; switching author cannot reset a chain within an approved assignment.
There is no authenticated total order between the two authors' chains. Display
latest locally observed verified state; hash chains cannot detect suppression
of an unseen latest update. Checkpoints are **unsupported in v1**, not an escape
from incomplete chains. A truncated chain remains incomplete until full history
is recovered; no hosted timestamp can approve a baseline.

Backup input is valid UTF-8; strip exactly one final LF (and its preceding CR),
with no other whitespace/Unicode normalization. Maximum backup file is 32 MiB;
maximum decrypted snapshot is 16 MiB with fixed schema/count limits checked
before import. Set scrypt maxmem explicitly to 64 MiB for N=32768,r=8,p=1.
Refuse oversized/incorrect-parameter files before KDF work; never allocate from
untrusted numeric fields. Windows file mode requires an explicit current-user
ACL and refusal of inherited broad read permissions, not a chmod claim.
Unsupported/denied keychain returns key_store_unavailable with `keys stores
--json` guidance, never fallback or a permission prompt. Cross-platform custody
remains unimplemented and has no support claim.

Before-send validation/self-open/persistence failure reports deliveryStatus
not-sent; accepted transport but missing echo reports unknown and retryable false.
operation is send, reply, read, inspect, propose, approve, backup or restore;
deliveryStatus is not-sent, rejected, unknown, transport-accepted,
locally-opened or locally-acknowledged. Success/readback is exactly
`{ok:true,code,operation,deliveryStatus,next,details}` with public identifiers only;
failure is `{ok:false,code,operation,deliveryStatus,retryable,next}`. For example,
`{ok:false,code:"approval_stale",operation:"approve",deliveryStatus:"not-sent",
retryable:false,next:"Run peer keys inspect --to ALIAS --json and approve the current exact proposal."}`.
CLI delivery outbox discovery uses `delivery list --json`; acknowledgment uses
`delivery ack --delivery-id ID --json`. Neither changes pairing/trust policy.
Finite safe-integer clock milliseconds are mandatory for primitives; callers
cannot bypass freshness with NaN or Infinity. Raw transport validation and byte
bounds precede object-form primitive calls, because lost duplicate names cannot
be reconstructed from a JavaScript object.


## Request/response correlation refinement

Encrypted **Message-only** agent responses with no assigned Task are unsupported
in v1. Do not emit them or try to open null-task agent envelopes (the primitive
refuses those). A card for this profile must declare Task-based encrypted
responses. An unexpected Message-only response after send is unsupported with
unknown delivery, never authorization to resend. The receipt-only control
carrier above is not an encrypted Message-only content response.

The assignment receipt also has required `responseDigest`, null if it is emitted
before an encrypted response exists, otherwise the 32-byte base64url SHA-256 of
the canonical signed response envelope. A co-carried encrypted response is legal
only with a non-null exact responseDigest. Verify receipt signature, original
pending request digest, assignment and response digest before treating that first
response as correlated. If a receipt-only null-response acknowledgment was
already committed, it is immutable: do not add a response to it or change its
ackId/signature. Later responses carry no such assignment metadata and instead
use the inner requestDigest rule below. Retain the original receipt in Task
history so a first poll can recover the full verified assignment; missing
receipts keep the response held. Co-carried content Message IDs follow the
envelope's signed messageId; receipt-only IDs equal ackId.

Both integration content variants have a required `requestDigest`: null for an
initial user request and the exact canonical signed-envelope digest of the
request being answered for agent-authored content. A local receiver of a response
must match it against its pending sent-request ledger entry as well as context,
authenticated assignment and snapshot chain. For a user follow-up it names the
original assigned request digest, which must already be locally approved. A
new response cannot be matched merely because it has a valid key, a shared
context or a first-seen message ID. Reordering/co-carrying responses and receipts
for distinct requests in one context must therefore fail correlation.
