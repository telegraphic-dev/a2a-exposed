# Sealed v1 integration contracts — second-review draft

These contracts refine the [base draft](sealed-v1.md). They are requirements for
later integration, not features of the isolated primitives package. They must
pass protocol/cryptographic implementation review before any encrypted traffic.
Conflicting earlier draft prose is superseded here.

## Optional installation and lazy loading

The base `a2a-exposed` CLI remains runtime dependency-free. The endpoint Worker
adds no encryption dependencies; its existing `tunnelfetch` dependency is
unrelated to this extension. Neither lists `@a2a-exposed/encryption` or any hpke-js package as a regular
dependency. Encryption is a separate, explicit optional install; a self-hoster
who never uses it installs no encryption or HPKE packages. HPKE runtime
dependencies belong only to `@a2a-exposed/encryption`.

The integrated CLI must import the encryption package lazily, only when an
encryption operation is requested. Ordinary plaintext commands and help must
work without it. A missing package must fail promptly, before encryption work
or network traffic, with a clear error and an explicit install command for the
supported CLI installation mode. It must never silently fall back to plaintext
or install packages implicitly during send, read, status or doctor. Only the
explicit enable operation described below may install the optional package.
Installation instructions and isolated
installed-package tests for each supported mode are required before exposing
encrypted CLI commands. An optional peer dependency may describe compatibility;
it must not make the package part of the default install.

The CLI provides local setup/discovery and the optional loader. Encrypted
send/read commands remain unavailable; local stdio MCP exposes setup/discovery only. These
contracts do not claim encrypted message delivery.

## One-command enablement and agent discovery

Local setup interface: `a2a-exposed encryption enable`.
One explicit invocation installs the compatible optional package into the selected
local configuration and sets up local keys. Local stdio MCP offers the same
operation and typed result for file-backed setup; native OS consent remains a
human local-CLI action. No private keys go to the hosted service. Remote MCP
cannot enable local custody or claim end-to-end encryption; it returns guidance
to the local CLI or local stdio MCP. Enablement never approves a peer, changes a
pairing, or counts as independent verification.

The command supports noninteractive execution: configuration directory, key
store and any required consent have explicit parameters or named configuration
inputs. Read-only JSON discovery lists supported stores and current setup before
action. Missing choices fail promptly with the listing command and the exact
next invocation. OS consent remains an explicit human decision. Installation or
key-store failure leaves an inspectable, recoverable state and must not report
success or generate a replacement identity on retry. Repeating enable preserves
an existing identity. Installation modes (including npx) need durable package
resolution tests; a successful install that the next process cannot load fails
acceptance.

Both OSS SKILL.md files must mention optional encryption and when to suggest it:
when the user asks to keep message content private from the relay/service, or a
peer requires it. Describe the local-client requirement and privacy limits.
Do not suggest that a skill installation itself installs encryption or that
ordinary hosted MCP keeps plaintext private from the service.

CLI status and doctor, in text and JSON, report:

| State | Meaning | Next action |
| --- | --- | --- |
| off | Optional package is absent | Exact enable command for this configuration |
| available | Package can load, but local setup is incomplete or disabled | Exact enable command, or diagnostic-led recovery for existing/unusable state |
| on | Local setup is enabled and usable | Peer-specific trust and delivery checks still apply |

These are local setup states, never a blanket privacy claim for every message.
Key-store failure is an explicit diagnostic, not a healthy on state. Status and
doctor remain read-only and work without the package.

Setup/discovery has a separate exact JSON envelope:
`{ok,code,operation,configIdentity,setupState,setupOutcome,diagnostics,next}`.
operation is `enable`, `status` or `doctor`; configIdentity is the selected local
configuration UUID, or null before local state exists. setupState is the
`off`/`available`/`on` state above. setupOutcome is `no-change`, `enabled` or
`recovery-required`; diagnostics is a bounded array of `{code,next}` with safe
fixed codes and explicit recovery guidance. Status/doctor always use no-change
and never install, create keys or access OS credentials. A failed enable reports
ok false and recovery-required when partial installation/key creation needs
reconciliation; it reports no-change when nothing changed. Existing keys with
setup incomplete remain available, never on. The result never contains private
keys, secret paths, passphrases or credential values. Remote MCP refuses enable
with local-client-required guidance in this setup envelope; it cannot invent
local readiness or configuration identity. Such remote refusals use null for
setupState/configIdentity, no-change for setupOutcome, and local-client-required
in diagnostics; local discovery reports off/available/on when it has evidence; an unreadable
package/configuration reports null with an explicit diagnostic, never guessed
readiness. CLI failures exit 1; MCP uses
isError true with that same structured result. This is a draft result contract,
not evidence that encrypted message delivery is implemented.

MCP send results disclose whether the service could read that message's content,
with a structured server-readable indicator and concise prose. Distinguish
plaintext/server-readable, sealed locally, and unknown; do not turn transport
acceptance into a claim of peer opening or verified identity. Remote MCP
plaintext sends remain explicitly server-readable. Required encryption refuses
unsupported remote paths and never silently downgrades.

The agent card extension advertises implemented protocol support and supported
Task response paths only after integration gates pass. Discovery is capability
information, never trust approval. A required peer with a missing local package
fails before transmitting content and names the exact enable command for the
selected installation mode/configuration; it never sends plaintext first.

## Integration phases and acceptance

1. Foundation: keep the base CLI free of runtime dependencies and the Worker
   free of encryption dependencies. Preserve isolated primitive review and keep
   encrypted traffic disabled. Specify optional installation, setup states and
   privacy wording in this draft.
2. Local custody and setup: implement explicit one-command CLI/local stdio MCP
   enablement, read-only JSON choice discovery, idempotent setup and recovery.
   Test missing/invalid inputs, denied consent, interrupted installation, missing
   stores and restart/retry without key loss or replacement. Retain all custody
   and trust review gates.
3. Transport and discovery: integrate lazy loading, required-peer refusal,
   per-message MCP privacy results, status/doctor states, both OSS skills and
   truthful card advertisement in the same feature delivery. Test base commands
   without the package, each installation mode across fresh processes, local
   MCP parity, unsupported remote MCP, failed setup and zero plaintext fallback.
4. Acceptance: verify off/available/on and all refusal/recovery wording with
   Claudia before merge or publication. Run the complete protocol, privacy,
   custody, archive/replay, storage and client matrix plus exact-head review;
   discoverability does not relax any encrypted-traffic gate. Nothing in this
   draft authorizes a release or deployment.

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
HTTP 200, with error.data exactly `{code,operation,deliveryStatus,retryable,next,details}`.
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
The following envelope is for transport/trust/archive operations only; setup
and discovery use the separate enable/status/doctor envelope above. Here
operation is send, reply, read, inspect, propose, approve, recover, backup or restore;
deliveryStatus is not-sent, rejected, unknown, transport-accepted,
locally-opened or locally-acknowledged. Success/readback is exactly
`{ok:true,code,operation,deliveryStatus,next,details}`; failure is exactly
`{ok:false,code,operation,deliveryStatus,retryable,next,details}`. details is a
bounded object containing public identifiers and safe enumerated result facts,
including the per-message privacy object below; never plaintext, private keys,
credential values or secret paths. A trust/archive result may use empty details.
For example, `{ok:false,code:"approval_stale",operation:"approve",
deliveryStatus:"not-sent",retryable:false,next:"Run peer keys inspect --to ALIAS --json and approve the current exact proposal.",details:{}}`.

Every send/reply result, including failure, has `details.privacy` exactly
`{serverReadable,contentMode}`. serverReadable is JSON true, false or the string
`"unknown"`; contentMode is plaintext, sealed, unknown or not-sent. true means
the actual outbound content was server-readable plaintext (including remote MCP
plaintext sends); false is allowed only for locally validated sealed content
actually submitted without plaintext fallback. This does not attest peer opening
or peer verification. An untransmitted refusal uses contentMode not-sent and
serverReadable unknown: no content was sent, so no sealed-send claim is made.
After transmission, a timeout may have deliveryStatus unknown while readability
is still known from the actual submitted bytes (true/plaintext or false/sealed).
If those bytes/path cannot be established, use unknown/unknown. Readability never
implies delivery, and unknown delivery never authorizes a fresh-message retry.
JSON-RPC error.data carries these same details for send/reply errors; CLI and MCP
retain them on both successful and failed results. For batch/history results,
associate a separate privacy object with each message ID in details.messages;
do not collapse messages with different privacy states to one blanket label.
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

Both agent-authored integration content variants require requestDigest of the
exact locally recorded user request being answered (initial or follow-up).
User-authored initial and follow-up content omit this member; it is never null.
A user follow-up instead requires a locally authenticated assignment matching
its signed context/task and peer identities. Neither referenceTaskIds nor a
Worker-proposed task ID grants that authority. A later agent response identifies
the particular user request's signed-envelope digest and must also match the
already authenticated assignment and snapshot chain.

## Exact content and structural message-carrier checkpoint

The package includes Draft 2020-12 schemas in `encryption/schemas/` for primitive
envelopes, decrypted content and the two message carrier versions. Schemas are
packaged files, not yet an advertised/served extension or traffic acceptance.
Runtime verification additionally enforces canonical bytes, UTF-8 size, key and
signature checks, header bindings, unique artifact IDs and cross-field agreement.

Canonical supported parts have an explicit kind, nullable mediaType and metadata
object. Text adds text; data adds an object-valued data member; file adds exactly
`file:{name:string|null,bytes:canonicalBase64}`. Files are inline only. Original
0.3 file.name/mimeType/bytes map to canonical name/mediaType/bytes; 1.0
filename/mediaType/raw map to the same values. Text/data mediaType and metadata
are retained in both directions, including empty inline files and empty names.
Missing optional media/name fields map to null, and missing metadata to an empty
object. Unknown, mixed, URI, non-JSON or oversized representations refuse before
sealing; they are never silently stripped, truncated or fetched. Each message or
artifact has 1..100 parts, and snapshot artifacts have unique IDs.

The current content validator supports role-matched message/task-poll carriers.
Owner-direct wire-user/logical-agent replies remain refused until their separate
authenticated request mapping is implemented and reviewed. Artifact delta and
streaming paths remain unsupported. Snapshot shape validates revision/linkage,
terminal/state and nested authorship, but only the future ledger can authorize a
chain or make a delivery current. Structural message-carrier extraction returns
the envelope only; it does not authenticate, decrypt, approve trust or deliver.
Assignment receipt primitives are defined below. Task wrappers, persisted chain
ordering/replay/outbox and actual Worker/CLI messaging integration remain pending
and gate all traffic.

## Assignment primitive and correlation checkpoint

Agent-authored message/snapshot content includes the canonical 32-byte
requestDigest. User-authored content omits it; an agent snapshot's nested status
message carries the same digest. The content validator checks its shape and,
when given the locally expected request digest, exact equality. This closes the
cross-request content mapping before any message is delivered.

`createAssignment` verifies/opens the initial user request and validates content
before signing. A co-carried response must self-open the creator's archive copy,
match task/context/peer bindings and contain that exact requestDigest. The signer
self-verifies its receipt signature. `verifyAssignment` checks the pinned public
bundles, exact request/ciphertext digest and task binding, response digest when
present, and Ed25519 signature. Live verification retains freshness checks;
archive receipt verification is an explicit separate purpose and creates no work.
`openAssignedResponse` also verifies/decrypts the response and checks its inner
requestDigest. All returned peer content remains untrusted data.

These are local cryptographic primitives. A computed receipt is not a model
consumption acknowledgment or durable-acceptance proof by itself. Do not publish
it until the future local assignment/replay/outbox transaction commits. A
malicious endpoint can lie about its persistence; the profile does not certify
another endpoint's disk. Lost/rolled-back state still needs archive-only restore.

Receipt-only carriers use the immutable null-response assignment, fixed text
`[encrypted request accepted]`, ackId/context/task and outer agent role; no
peer-supplied text or extra fields are accepted. Co-carried carriers require a
non-null responseDigest matching the full sealed envelope and exact outer/header
bindings. Their parser returns both envelope and receipt; the ordinary envelope
parser refuses that metadata rather than silently discarding it. Signature/trust
verification remains separate from structural extraction. Packaged assignment,
receipt-carrier and assigned-carrier schemas cover these exact wire shapes.
Task wrappers, persisted assignment/chain ordering, replay/outbox and Worker/CLI
message paths remain pending; no encrypted traffic is enabled by this checkpoint.


## Isolated local delivery algorithms

The separate privileged SDK now implements initial and follow-up receiver
acceptance, persistent outbound ciphertext, single-use transmission authorization,
peer-signed assignment pinning, correlated responses and consecutive full-snapshot
chains. See [local custody/delivery API](../../encryption/LOCAL-CUSTODY-DRAFT.md).
This implements the local transaction portion of the requirements above; it does
not integrate them with actual Worker/CLI/MCP message paths or Task wrappers.
Caller pairing/activation attestations must come from a reviewed local adapter.
No encrypted traffic, exactly-once model effects, native-platform acceptance or
complete archive semantics are established by these isolated algorithms.


## Raw Task wrapper extraction

The isolated `./tasks` API accepts raw Task JSON, not JSON-RPC envelopes or
Message-only responses. `readTaskCarrier` parses duplicate-safe raw JSON before
normalizers, bounded to 1 MiB and 1000 history entries. 0.3 kind fields and 1.0
roles/states remain distinct; IDs are never truncated. Outer artifacts may be omitted or
empty; a present non-array/nonempty value refuses. Metadata may only be empty or the fixed v1 extension marker, and status
may contain only routing state, an optional sealed/control Message and an
optional UTC timestamp. Receipt-only status and a missing status Message remain
routing-only information, never proof of peer state or model consumption.

Nested context/task bindings and current signed snapshot header state must match
the wrapper; initial null-task user messages are allowed only in history. User
status snapshots/direct replies are unsupported. Unknown fields, plaintext or URI
parts, mixed versions, conflicting duplicate messages and changed immutable
assignment receipts refuse. Identical ciphertext may appear with its receipt in
history and without that metadata in status; the original receipt is retained.
Timestamp validity is checked but timestamps and supplied history order never
establish provenance. The result labels authentication unverified and history
order untrusted, preserving events for later signature/pin/assignment/chain
validation. No Worker, CLI or MCP message path invokes this isolated parser yet.


## Local Task-to-ledger reconstruction

`DeliveryLedger.acceptTask` connects raw Task extraction to the privileged local
ledger, without an HTTP/model callback or real client integration. The caller
selects the original initial request ID and supplies locally established pairing
and activation attestations. A provisional server task ID cannot grant authority:
a new assignment requires its peer-signed receipt bound to that cached attempted
user request. Subsequent polling may use the locally pinned immutable assignment
when its original receipt is absent from a truncated response.

All raw wrappers, public signatures and any supplied receipt are checked before
credential access. User history entries must exactly match attempted local cached
requests. Agent events are decrypted and commitment/content checked, then snapshots
are ordered by their verified revisions, never server timestamps/array order.
Assignment, replay, queued ciphertext/provenance and complete snapshot heads commit
in one transaction. Gaps, forks, wrong request digests, trust changes or commit
failure return no new delivery IDs and roll back the complete new batch. Previously
committed work is retained. No automatic re-send follows a failed poll/import.

The result contains stable delivery IDs and currentPeerState from the local
verified chain, not plaintext. Transport routing state is reported separately as
unauthenticated; unsigned cancellation or a receipt-only Task never creates peer
state. Explicit read/consumption remains separate, and older accepted snapshots
stay history-only. Real transport negotiation, live/native platforms, archive
opening/full restore semantics and release acceptance remain required gates.


### Terminal grouping and long-lived assigned tasks

Ordinary top-level agent messages have no authenticated position on the snapshot
chain. Task import therefore holds any newly discovered such message when either
the existing head or incoming verified batch is terminal. It rejects the whole
new batch rather than infer chronology from sorting, timestamps or packet grouping.
Already accepted duplicate message IDs retain their stable delivery/readback;
new terminal content uses the encrypted statusMessage inside a signed snapshot.

The initial live-envelope age limit does not expire an exact locally retained
assignment. A private retained-cache verifier rechecks the cached user request's
purpose/bytes/digest/current pin and both request/receipt signatures, without
reapplying the original send-age cutoff. Repeated receipt bytes must match exactly.
This path is unavailable to a first unassigned stale request or new receipt and
never changes now for incoming content. Fresh follow-up replies pass the same
current-time envelope checks through both Task import and direct acceptance;
stale/future incoming responses still refuse. No general archive/admission bypass
or actual network transport is enabled.


## Sealed-only JSON-RPC client adapter

The isolated `SealedJsonRpcClient` sends only an existing locally prepared user
request; preparation/trust approval remain separate. It never fetches a new card,
approves a key, switches protocol/endpoint or sends plaintext. `LocalState.propose`
accepts peerEndpoint separately from the signed key-card URL, validates canonical
HTTPS on the same origin, and includes the exact RPC path in the proposal/record
digest. Omitting it retains the earlier SDK default of the card URL; a real client
must approve the actual RPC endpoint rather than silently replace that default.
Cross-origin RPC interfaces are unsupported by this client profile.

The host supplies a synchronous fresh pairing snapshot with exactly
`{identity,endpoint,token,verified:true,revision}`. This is a privileged local saved-grant
attestation, never peer-supplied data or an approval mechanism. The eventual CLI
host must derive it from its protected human-authorized pairing and effective
credential; imported credentials are not automatically proof of an approved grant.
That saved-pairing integration is not implemented by this adapter.

Discovery requires one sealed-v1 AgentExtension with required false and params
exactly `{bundle:SIGNED_PUBLIC_BUNDLE,responseKind:"task"}`; optional description
is bounded. The bundle must equal the current approved pin. The selected fixed
JSONRPC protocol/interface URL must equal the independently approved endpoint.
The packaged capability schema describes discovery only and grants no trust.
Cards declaring another sealed version do not trigger fallback.

Each send/poll uses A2A-Extensions; 0.3 also sends X-A2A-Extensions and requires
both corresponding echoes. When both response headers appear, sealed URI sets
must agree; unrelated extension differences do not conflict. Missing/unsupported
activation, Message-only responses, mismatched JSON-RPC IDs, raw duplicate keys,
invalid UTF-8, oversized bodies and non-JSON responses refuse. Redirects are
never followed. Responses are bounded to 1 MiB; TLS checks stay with the default
fetch implementation and are never bypassed. No retry loop exists.

A send commits its one-time transmission authorization before submitting cached
ciphertext. The original local pin and pairing/credential are rechecked before
submission and response acceptance. Polling selects the original locally signed
assignment instead of accepting a server-supplied task ID. Task bodies enter
acceptTask only after per-request negotiation/raw RPC validation. No plaintext
history is uploaded to the owner API; no model callback is made.

Send results use the existing typed transport envelope and details.privacy.
Pre-submission refusal is unknown/not-sent readability; submitted validated
sealed bytes are false/sealed even when delivery is unknown. A repeated attempt
whose old submitted path cannot be established is unknown/unknown, never a new
sealed-send claim. All failures have retryable false. Acknowledgment/delivery
state remains separate from readability and model consumption.

The tests inject a synthetic fetch transport and use protected temporary local
states on both sides. They do not establish real HTTP/provider/platform, Worker
routing/card advertisement, production installation, CLI/MCP wiring or release
acceptance. Those gates remain in force; no service capability is enabled.


### Adapter commit authorization and routing restrictions

The transport constructor also requires withPairingLease(run). The privileged
host must acquire its configuration-wide pairing/credential authorization lease,
await run(), and release only after it resolves/rejects. Every local grant/token/
endpoint mutation path must participate in that same lock or equivalent revision
protocol. Acquiring this lease precedes the local SQLite queue, avoiding reverse
lock ordering. This callback is never supplied through peer JSON or model flags.
A fake/no-op callback in synthetic tests is not a real cross-process pairing lock;
the actual CLI pairing store implementation remains an acceptance gate.

acceptTask receives a private synchronous authorizationGuard and that lease. The
current exact grant, verified state, effective credential, endpoint and pin are
re-read inside BEGIN IMMEDIATE before writes and again immediately before COMMIT,
after all crypto/key awaits and the action await. A failed guard rolls back the
whole acceptance transaction. Lease callbacks must invoke/await the transaction
once; missing, fire-and-forget and asynchronous-guard forms fail closed. This
also applies to receipt-only send responses and previously pinned assignments.

Concurrent failures re-read the original ID's current outbound state. If another
caller acquired transmission authority, the loser reports unknown delivery and
unknown/unknown readability rather than stale not-sent. One caller still obtains
ciphertext/submits; no failure starts a second request or plaintext fallback.

This bounded client refuses nonempty/invalid interface tenant values and unknown
selected-interface routing fields before transmission. Empty tenant denotes the
ordinary unscoped interface; real tenant routing is unsupported. Selected modern
interfaces must explicitly declare the exact protocol and JSONRPC binding. Legacy
0.3 main URLs honor preferredTransport (JSONRPC only, default when absent) and
protocolVersion (0.3/0.3.0 only, default only without modern-only contradictions).
An explicit additionalInterfaces JSONRPC entry may select its approved URL.
A legacy URL cannot override an explicit HTTP+JSON binding or a 1.0-only version.

The host pairing snapshot includes a nonnegative safe-integer revision. Every
revocation, restoration or credential-generation change increments it under the
same host lease, even if token bytes later match again. Final guard comparison
includes this revision to reject in-flight revoke/restore ABA changes. The real
store must persist/enforce that monotonicity; a synthetic reader does not prove it.
