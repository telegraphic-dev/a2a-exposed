# Local grant continuation schema proposal

Authority coordinator/schema proposal only. No grant-admission API or command
is implemented. Isolated codec/SDK staging implementations are described below. This
does not change the approved quarantine implementation or permit encrypted traffic.
Review this proposal before implementing a schema upgrade or exposing resume.
The integration contract remains in [sealed-v1-integration.md](sealed-v1-integration.md).
Current shipped-in-source boundaries are listed in the [internal SDK contract](sealed-v1-sdk.md).
The complete schema-3 coordinator below remains proposed. The default authority
initializer remains schema 2; an isolated fresh schema-3 initializer and I-checkpoint
maintenance foundation are described below.
This draft does not establish authenticated membership or human approval provenance.

## Representation

All records reject unknown keys, duplicate JSON keys, getters, symbols, sparse
arrays, invalid UTF-8 and noncanonical identifiers. JSON integers are nonnegative
safe integers; UUIDs are lowercase UUIDv4. A digest is canonical 32-byte base64url.
Opaque private MACs use domain-separated HMAC-SHA256 under the existing private
recovery key. No secret-derived unkeyed digest is public. IDs and record versions
are distinct: random IDs never substitute for monotonic revision checks.

Proposed authority schema 3 preserves the authority row fields from schema 2 and
adds suspension_epoch (UUID), active_set (nullable UUID). Fresh stores start with
active_set null: initialization alone admits no grant. The epoch changes whenever
quarantine commits, even if source bytes match an older state. Schema 1/2 files
are preserved/refused, never migrated or reset automatically in this draft.
Existing schema-2 diagnostics/recovery behavior remains unchanged until reviewed
replacement APIs are implemented.

Additional authority tables have these exact columns (SQL constraints must mirror
the validation below). Serialized records are canonical JSON, never executable:

- continuation_intents: id UUID primary key, epoch UUID, baseline_revision integer,
  target_revision integer, set_id UUID unique, plan_mac digest, intent_mac digest, state enum
  prepared/set-committed/eligible/aborted, record JSON. One prepared/set-committed intent per
  configuration, enforced by a partial unique index, not just an application query.
- grant_sets: id UUID primary key, intent_id UUID unique, epoch UUID,
  target_revision integer, membership_mac digest, state committed/eligible/void.
- grant_members: set_id UUID foreign key, grant_id UUID, pairing_identity digest,
  alias ASCII [A-Za-z0-9_-]{1,80}, record JSON, member_mac digest. Primary key
  (set_id,grant_id); unique (set_id,alias), (set_id,pairing_identity) and
  (set_id,credential_variable). credential_variable is also an explicit column.
- continuation_attestations: id UUID primary key, plan_mac digest unique,
  epoch UUID, created_ms integer, expires_ms integer, consumed_intent nullable
  UUID unique, attestation_mac digest, record JSON. Single-use, maximum age 10 minutes; future clocks or
  clock regression below created_ms refuse. This limit is proposal policy.

The immutable plan payload P contains exactly config_identity, canonical_root,
epoch, baseline_revision, target_revision, source_mac, set_id, plan_nonce (digest),
members (ordered member records), and excluded_aliases (sorted strings).
target_revision is baseline_revision + 1; overflow refuses. Members sort by grant_id
UTF-8 byte order. Excluded aliases sort by UTF-8 bytes, without duplicates or
selected/excluded overlap. Duplicate identities/aliases/variables refuse before
MAC calculation. The selection must explicitly partition the complete protected
peer inventory: no unmentioned alias. Adding/removing/replacing a member or changing
exclusion requires a new aggregate plan/approval; no incremental union.

Each member record M has exactly grant_id, pairing_identity, alias, endpoint,
credential_variable, credential_source (file/environment), credential_mac,
process_mac (digest or null), trust_record_digest, trust_record_version,
local_id, local_bundle_digest, peer_bundle_digest, policy (required only),
verification (independent), pairing_provenance (approved-connect/local-adoption),
pairing_decision_id UUID. The sealed-only continuation profile admits ONLY the
SDK's exact required policy. SDK off/allow-server-readable, opportunistic and all
unknown policies refuse before intent/attestation consumption. There is no mapping,
policy weakening or plaintext fallback. Revoked/TOFU/unknown records are not admitted.

Define H(domain,value) = HMAC-SHA256(K, UTF8(domain + "\n") || UTF8(canonicalJSON(value)))
encoded as canonical base64url; K is the private authority recovery key. Domains
below are literal strings; all arrays preserve the listed order, object keys use
the existing strict SDK canonicalJSON algorithm. Credential strings are encoded
as strings, never exposed as unkeyed hashes. B = [canonical_root,config_identity,epoch,set_id].
Compute in this acyclic order:

1. source_mac = H("sealed continuation source v1", [canonical_root,config_identity,
   epoch, [["config.env",present,exact_utf8_text_or_null],["peers.json",present,
   exact_utf8_text_or_null]]]). Missing versus empty is distinct; malformed input refuses.
2. For each member, credential_mac = H("sealed continuation credential v1",
   [B,grant_id,credential_variable,credential_source,effective_token]); process_mac
   is null for file, otherwise H("sealed continuation process v1",
   [B,grant_id,in_memory_process_nonce]). No nonce or token is stored in a record.
3. member_mac = H("sealed continuation member v1", [B,M]); ordered member pairs
   Q = [[grant_id,member_mac],...]. Q is bijective with P.members in the same order.
4. membership_mac = H("sealed continuation membership v1", [B,Q,P.excluded_aliases]).
5. plan_mac = H("sealed continuation plan v1", [P,membership_mac]). P contains no
   attestation/intent reference. This prevents recursive MAC inputs.
6. Attestation A (defined below) binds plan_mac. attestation_mac =
   H("sealed continuation attestation v1", A), covering EVERY immutable A field.
7. Final immutable intent record = {plan:P,membership_mac,plan_mac,attestation_id,
   attestation_mac}; intent_mac = H("sealed continuation intent v1",
   [intent_id,final_immutable_intent_record]). State is a separate SQL column.

Every read/transition checks SQL/JSON equality: intent config/epoch/revisions/set
and plan_mac equal P/the final record; grant-set config bindings and membership_mac
equal the intent; each member's set/grant/alias/pairing/variable columns equal M
and its member_mac recomputes; attestation id/plan/epoch/times equal A and its MAC
recomputes. Full row cardinality and Q/members/comparisons equality are checked,
not only known rows. No duplicate row or historical eligible set may supply a member.

The random pairing_identity is 32 random bytes encoded as canonical base64url,
compatible with the SDK's existing field. It is generated only in an explicitly
human-approved pairing/adoption transaction and is not derived from alias, token,
userCode, server label or key bundle. grant_id and pairing_decision_id are new
UUIDs in that same transaction. Re-pair or revoke terminates the old grant;
replacement creates new IDs, never revives the old identity. Alias rename requires
an explicit new plan but does not manufacture identity continuity. Legacy adoption
is an explicit local human decision, not evidence of remote credential validity;
no old paired metadata can supply its approval. Adoption UX/transaction is gated.

## Fresh files, environment and verification

Read config.env and peers.json under the authority lease, bounded to 1 MiB each,
fatal UTF-8, protected owner files, no symlink. JSON duplicate keys refuse globally.
Env syntax allows comments/blank lines, optional export, valid variable names and
serializer-compatible quoted/unquoted values; any malformed line, duplicate name,
NUL, invalid quote/escape or unsupported shell syntax refuses the entire source.
No shell expansion or permissive cached legacy parser. Missing selected files or
values refuse planning/finalization/admission. The explicitly tagged no-grant
abandonment variant below alone can represent their absence. Unrelated source
changes conservatively hold every grant.

A member names an explicit token variable; never derive one from alias during
admission. Reject duplicate variable names across selected members, including an
attempted intentional share. Check selected-versus-excluded legacy aliases for
normalization collisions and refuse ambiguous adoption rather than transfer the
omitted alias's token. The future pairing writer must assign explicit unique
variables. Empty environment values fall back to file; nonempty values override.
Record source kind/name separately, so equal bytes from another source invalidate.
Only own string data-property values are read; getters are never evaluated.

The coordinator owns a fresh random 32-byte in-memory process-instance nonce;
PID alone never identifies a process. Environment members bind process_mac to that
nonce through the private authority MAC. Neither nonce nor token is persisted or
exported. Another process/restart cannot use them: environment_reapproval_required,
with a fresh local plan required. A set containing ANY environment member is
process-bound as an aggregate: in another process ALL its members, including file
members, are held. Only wholly file-backed sets may cross processes. No foreign
nonce is loaded or inferred. Recheck
selected environment descriptors/value at every submission/final acceptance. An
observed credential change holds the operation under its original IDs, no fallback.
This scopes approval to a process's captured environment, not a claim that another
process's environment can be locked. No environment adoption convenience API. Environment-bound grants are usable only
within the approving long-lived host process; a fresh CLI invocation must replan.
This restriction must appear in future listing/usage output, never a silent hold.

SDK proposal approval completes BEFORE continuation planning. Planning binds the
resulting current trust record/version, not the old proposal's expected record.
The immutable attestation A contains exactly id UUID, config_identity,
canonical_root, epoch, plan_mac, comparisons (ordered array), decision_id UUID,
created_ms, expires_ms. Each comparison contains exactly grant_id,
approved_proposal_digest, compared_safety_code_mac, current_trust_digest,
current_trust_version. Comparisons are bijective with P.members in grant_id order:
no extra/duplicate/missing entry, reused or swapped peer evidence. Each approved
proposal must resolve to that member's exact resulting trust record and compared
key tuples. compared_safety_code_mac = H("sealed continuation comparison v1",
[B,grant_id,approved_proposal_digest,exact_locally_computed_safety_code]).
The trusted adapter confirms the human independently compared that member's code;
merely recomputing its MAC is never independent evidence.

A is created only by a privileged local human-approval adapter after independent
comparison for EVERY selected peer AND review of the full aggregate plan, including
endpoints, policies and exclusions. Website approval alone, SDK approval alone,
peer data or arbitrary model booleans cannot mint A. The adapter is unimplemented;
absence refuses. No continuation API accepts independentVerified:true as evidence.
This records a local human decision, not cryptographic proof of a remote person.
The separately stored attestation_mac authenticates identity, comparisons, decision
and validity times. consumed_intent is initially null; its ONLY permitted change
is null to the exact final intent ID in the I transaction. It is never cleared.
The SQL/JSON checks above and final intent MAC bind that same immutable attestation;
changing expiry/decision, cross-plan or cross-epoch substitution refuses.

Readiness is separately checked before staging and before finalization: no pending
SDK proposal/rotation/key operation, no retired/lost local key, no revoked/off
policy, no restored archive-only/paused state. A matching record digest does not
override any such hold. Changes invalidate the plan; never rerun SDK approve to
make an old plan match. Safety codes alone do not bind RPC path/credential/policy.

## Private maintenance coordinator and two-store agreement

A new private withAuthorityMaintenance coordinator owns ONE authority SQLite
connection with separate transactions in the phases below. It may inspect suspended
state; ordinary grant
leases/snapshots retain their refusal. No public allowSuspended flag. File mutators
stay synchronous; SDK callbacks are never passed to them. Reentrant authority writes
and maintenance entered from a grant lease refuse, rather than acquire another
connection or bypass locking. All maintenance, normal writers and reconciliation
acquire authority before SDK; they never await authority while holding an SDK lock.

The coordinator owns one authority connection across phases, but NOT one SQLite
transaction across commits. It uses a NEW private SDK queue-lease API, not repeated
calls to LocalState.locked (which release their queue on return). The lease exposes
only private staged transactions/readiness checks; it never invokes another public
queued SDK method while held. It owns the SDK connection and serializes in-process
SDK operations until explicit release. BEGIN IMMEDIATE transactions on that SDK
connection provide cross-process exclusion where stated below. All eventual host
trust/key/grant writers must take authority first; this wiring is a pre-activation
gate. Ordinary uncoordinated SDK APIs cannot coexist with activated host grants.
Neither a JS queue alone nor an idle connection proves a cross-process lock.

Exact normal coordinator phases (A=authority connection, S=SDK connection; each
BEGIN is IMMEDIATE, each durable COMMIT uses synchronous FULL):

1. No SDK lease held. A BEGIN; validate exact approved P/A, H, all readiness and
   untouched source/environment. Insert prepared intent, consume attestation,
   set revision=target, pending=intent, suspended=1, active_set=null. A COMMIT -> I.
   No lock remains; pending prevents writers/resumers from taking over the intent.
2. A BEGIN; recheck I/ownership/source/environment. Acquire private SDK queue lease;
   S BEGIN; recheck SDK readiness, insert exact staged row; S COMMIT -> S. Queue
   stays held, SDK SQL lock is released. Insert authority set/member rows and mark
   intent set-committed; A COMMIT -> C. Release SDK queue immediately before any
   A reacquisition. Neither SQL lock remains. Do not await A while holding S/queue.
3. A BEGIN; recheck exact C/ownership/source/environment. Acquire SDK queue lease;
   S BEGIN; recheck exact staged row/trust/readiness; mark ready; S COMMIT -> R.
   Retain queue, then S BEGIN immediately and re-read the committed ready row and
   all readiness. If a cross-process SDK writer interleaved in that gap, validate
   its effects/refuse; never use an older transaction snapshot. Hold S reserved
   transaction through the final A checks and COMMIT -> E. Then S ROLLBACK (it was
   read-only) and release SDK queue. A connection is now outside a transaction.

On any exception, roll back whichever SQL transactions remain open and release
SDK transaction/queue before releasing/closing A. Do not undo earlier durable
commits or continue to another phase automatically. After S/C/R commit failures,
read-only diagnosis determines the actual checkpoint; never infer it from a thrown
return. Every A reacquisition occurs with no S transaction/queue held. During each
unlocked gap the exact pending intent blocks normal writers/other coordinators;
only separately approved reconciliation may act on it. Concurrent reconciliation
must compare actual checkpoint under A before acquiring S. Reentrant maintenance
or queue use refuses. Final S reserved transaction prevents SDK changes between
final readiness and E COMMIT, including another process that ignores the host queue.

SDK schema 6 (implemented below) uses host_grant_sets with exact columns config_id UUID,
intent_id UUID primary key, set_id UUID unique, epoch UUID, target_revision integer,
membership_mac digest, state staged/ready/void. This holds no credentials, grants no
trust and never changes trust records or message provenance. Older SDK schemas are
preserved/refused in this draft. Final schema inspection must include this table;
backup/semantic restore acceptance must be extended before release.

Use these checkpoints in order; durable states are authoritative, not a returned
success flag:

| Checkpoint | Authority store | SDK store | Eligible? |
| --- | --- | --- | --- |
| H | Suspended; no intent | No matching row | No |
| I | Intent prepared, pending=id, revision=target | No matching row | No |
| S | Same I | Exact set staged | No |
| C | Set committed; intent set-committed, still pending | Same staged row | No |
| R | Same C | Exact row ready | No |
| E | Set/intent eligible; active_set=id; pending=null; suspension cleared | Same ready row | Only exact admitted members |

The eligibility commit point is the final phase-3 authority COMMIT (R→E). Immediately before
it, re-read exact sources/environment, intent, epoch, revision, complete membership,
attestation consumption and SDK trust/readiness/ready row under authority→SDK locks.
SDK queue remains held until authority COMMIT is known; release in reverse order.
Readers require BOTH matching E and ready row (config/intent/set/epoch/revision/MAC)
plus member/readiness/source checks. Never infer agreement from active_set alone.
Every eventual file writer invalidates the active set before source mutation;
revocation/repair/restore cannot retain grant eligibility accidentally. A failed
COMMIT returns no new authorization. A later close/release error may follow a real
COMMIT: return unknown with retained intent/set IDs, no retry or rollback promise.

## Interruption and reconciliation

Read-only diagnosis lists exact public intent/set IDs, checkpoint, selected and
excluded aliases, held reasons and available actions. It never repairs automatically.
A reconciliation payload X contains exactly action (abandon/finish-abandon/
finalize-exact-set), root, config_identity, epoch, authority_revision, intent_id,
set_id, authority_checkpoint, intent_mac, authority_set_state (null or enum),
sdk_row (exact full row or null), observations (tagged union below), attestation_mac
and approval_nonce (fresh digest). Validate every repeated identity/field against
the authenticated original intent and exact current rows before issuing a plan.
Its private approval identifier is H("sealed continuation reconcile v1", X);
action and tagged observations are inside the MAC. Original consumed continuation
approval is never reusable. Separate explicit human approval of this exact X,
literal local owner approval through the trusted adapter and final CAS after all
awaits remain required. Private observation/MAC material is never printed.

For finalize-exact-set, observations is exactly {kind:"finalize",source_mac,
current_member_macs:Q}. Strict complete live source/token/process validation and
Q equality with the original aggregate are mandatory. Missing credentials, foreign
process, expired attestation or abandonment-shaped observations refuse BEFORE any
eligibility effect. No tag conversion or fallback from abandonment is permitted.

For abandon/finish-abandon ONLY, observations is exactly {kind:"no-grant-abandon",
source_mac,members:O}. O has one entry per original authenticated member in original
grant_id order, with exactly grant_id, original_member_mac, process_status
(not-applicable/same/unavailable), current_process_mac, environment, file.
The original member MAC is recomputed from the stored authenticated M, never by
reconstructing the lost token/nonce. For file-backed original M process_status is
not-applicable; for environment-backed M it is same only if this live process's
nonce reproduces M.process_mac, otherwise unavailable. current_process_mac is
H("sealed continuation abandon process v1", [root,config_identity,epoch,intent_id,
current_in_memory_process_nonce]); it binds this NEW approval to the diagnosing
process without reconstructing or persisting the old nonce. Another restart must
list/approve a new X, never recover the original environment to finish abandonment.

Both environment and file observation objects contain exactly state and value_mac.
state is absent/empty/nonempty; value_mac is null for absent and otherwise
H("sealed continuation abandon value v1", [root,config_identity,epoch,intent_id,
grant_id,source_kind,original_credential_variable,current_string_value]). source_kind
is the literal environment or file matching the field; cross-field substitution
is invalid. Empty
is an observed actual empty string, NEVER a fabricated credential. Environment
observations use only own string data-property descriptors; getter/invalid type
refuses. File observations use the strict parser. A safely absent selected file or
absent variable yields absent; no fallback value is invented. source_mac binds
actual protected-file presence/bytes, including safe absence, with the earlier
source domain. A changed nonempty value, availability, source file or process
makes X stale on recheck; it must be relisted/approved, not silently substituted.
No live effective token or complete Q is needed for this no-grant action.

This exception covers valid owned stores with safely readable or safely absent
source files only. Unsafe permissions/symlinks, nonregular files, invalid UTF-8,
malformed source syntax, getters, damaged/mismatched stores or unverified original
intent/MAC stay held/manual-only. Do not weaken file safety, read unsafe files,
reset a store or ask to reinsert an obsolete secret. O grants no trust/eligibility;
a value MAC or unavailable-process tag is only an exact abandonment observation.
Finalization still requires the distinct complete live variant above.

| Observed state | Available actions and consequences |
| --- | --- |
| H | New continuation plan only; no resume flag |
| I, no SDK row | abandon: authority-only finish transition below; no SDK row is created |
| S or C, exact staged row | abandon: mark SDK void first, then authority aborted/void, stay suspended |
| C plus ready (R) | finalize-exact-set if all original bindings/readiness/attestation validity remain valid, or abandon (void SDK first) |
| I or C, exact SDK void row for original intent/set | finish-abandon only, with new exact approved X; never finalize |
| E plus exact ready | inspect-completed only; never repeat website/SDK approval or send |
| Any mismatched, missing, damaged or unexpected row | hold/manual diagnosis; no finalize/reset/automatic deletion |

Abandon/finish-abandon never needs an unexpired ORIGINAL attestation; its consumed
record remains evidence. Finalize requires original attestation still valid plus
fresh reconciliation approval and all unchanged bindings/readiness. Expiry can
therefore prevent finalize without preventing safe abandonment.

For abandon: with no S lease, A BEGIN and exact X/state check; acquire S queue and
S BEGIN when a row exists. CAS exact staged/ready -> void, S COMMIT (durable void),
retain queue and A transaction; then perform the authority finish transition and
A COMMIT. Release S queue without reacquiring A. Crash after SDK void leaves the
explicit I/C+void row above. finish-abandon obtains a NEW X/approval, A BEGIN then
S queue/S BEGIN, verifies the exact void row, and performs only that finish.
For I with no SDK row: A BEGIN then S queue/S BEGIN verifies absence and holds it
through authority finish/COMMIT, then S ROLLBACK and releases queue. No row is added.
These paths use the same connection/lock ownership as normal phases, no public
SDK queued callback, and no authority reacquisition with S held.

Authority finish atomically CASes matching pending=intent and original checkpoint,
sets intent=aborted, existing set=void (absence allowed only at I), active_set=null,
suspended=1, pending=null, revision=current_revision+1 (overflow refuses). Retain
epoch, source fingerprint, all historical rows and consumed attestation unchanged.
This is H with aborted history, not deletion/reset; source drift still holds and
may separately require quarantine. Replaying finish fails checkpoint/revision CAS.
Competing finalize/abandon cannot both win: A serialization and exact X exclude it.
If only a void commit succeeded, remain held until listed finish-abandon; never
clear pending based solely on an error result.

An E/ready failure discovered later holds use; changing a ready row or
trust record cannot silently make it valid again. An external source drift uses
quarantine; any old active_set must be invalidated within that reviewed replacement
transaction. Original outbound IDs, assignments, replay/chain and ciphertext rows
are never rewritten/rebound by continuation. Pending old-generation operations
remain held; archive/history eligibility requires its separate reviewed path.

## Noninteractive outputs and minimum tests

No proposed command is available. Future plan/inspect output follows the separate
setup envelope, operation continuation-plan/continuation-inspect. An action uses
operation continuation-apply with status held/local-complete/unknown; include
intent_id, set_id, checkpoint, local_grants_eligible boolean, selected/excluded
aliases, choices/action IDs, held reasons and next listing operation. Never emit
raw provider errors, tokens, source MACs, attestation internals or keyed membership
MACs. A user approval identifier is opaque, bounded and action-specific. Missing
or stale inputs direct back to the read-only listing; no prompt is required.

local-complete means local exact-set admission only: not website approval, remote
credential validity, successful transmission, delivery or model consumption.
Continuation operations create no signing/encryption key and perform zero fetch.
A separate earlier send may have happened: acceptance failure then retains original
IDs and unknown/sealed/no-retry privacy facts (N1), never claims historical not-sent.

Before implementation acceptance, test all six checkpoints and every adjacent
crash/COMMIT/release boundary with real independent local processes and synthetic
private fixtures. Verify mixed selected/omitted peers, set composition/duplicate
rejection, alias-variable collisions, file↔environment equal-byte changes, process
restart/PID reuse, getter/duplicate/UTF-8 refusal, stale/expired/future/replayed
attestations, SDK approval/pending/archive/local-key holds, writer/revoke/restore ABA,
concurrent finalize/abandon and all one-store-only disagreements. Require zero
fetch/key creation during planning/refusal, private read-only diagnostics, retained
original message IDs and full rollback where COMMIT genuinely did not occur.


D1–D4 additional design pass cases: valid A+B independent comparisons are fully
representable; A-only/swapped/extra/duplicate comparison evidence and changed
decision/expiry/plan/epoch refuse. At EVERY durable edge record A SQL/S SQL/queue
ownership and externally visible checkpoint; test S->C and R->E COMMIT failures,
reacquisition races and final cross-process exclusion. Crash after SDK void must
allow exactly approved finish-abandon with expired original attestation, retained
rows and one revision advance. Only SDK required policy is admitted; every other
policy refuses before intent consumption. A mixed file/environment set is wholly
held in a foreign/restarted process; a wholly file-backed set is not process-bound.


D5 additional pass cases: environment-only I/C/R plus process restart or token
removal permits a newly approved no-grant abandon X without old token/nonce;
finalize remains held. I/C+void with missing credentials permits finish-abandon
and exactly one revision advance. An observed variable removal/change/reintroduction or
restart after X is listed invalidates that exact approval. Changes through a
coordinated writer also invalidate revision. A value changed and returned to the
same bytes between all observations is undetectable from a value MAC alone; no
unobserved out-of-band ABA detection is claimed. An abandonment tag
passed to finalize always refuses. Safe source absence is representable; unsafe
files or damaged stores remain explicitly manual-only. Both abandonment variants
retain source files/fingerprint, suspension and historical evidence unchanged.


## Isolated record codec implementation boundary

The internal cli/lib/continuation-records.mjs implements synchronous record cloning,
structural validation, exact domain-separated MACs, multi-member plan/attestation/
intent integrity, tagged no-grant observations and reconciliation equality. It
uses only Node built-ins and does not load the optional SDK or node:sqlite.
All inputs are explicit synthetic/privileged in-process data; it reads no files,
environment, keychain or account. Token/nonce/MAC inputs never belong in argv or
model-facing output. The host must create fresh protected key/nonce inputs; the
codec neither creates nor persists them. No command imports this module yet.

The codec's bindAttestation authenticates supplied adapter records; it does not
verify human provenance or fetch/check SDK approved-proposal history. Likewise,
sourceMac does not parse/approve protected sources or prove source ownership;
observeAbandonment accepts already parsed string maps and refuses getters. A
nonempty observation MAC's live source/value correctness requires fresh host
reconstruction and assertUnchanged, not structural verification alone.
authenticateIntent/authenticateReconciliation verify integrity, not grant eligibility,
clock freshness or either-store agreement. assertFresh is a separate required
clock check for new/finalize use; expired records remain authenticatable for safe
abandonment. Complete inventory partition/collision checks against actual peers,
SDK trust/readiness checks, independent human adapters, replay consumption, SQLite
schemas/coordinator/CAS/crash transitions and actual grant admission are NOT yet
implemented here. No codec return is permission to resume, send or mutate stores.


### Isolated strict source snapshots

The internal cli/lib/continuation-sources.mjs parses explicit byte snapshots only;
it reads no file or ambient environment and no command imports it. Each source is
at most 1 MiB with fatal UTF-8, no BOM normalization, NUL or lone surrogates.
peers.json rejects duplicate keys at every depth before normalization. config.env
accepts blank/comment lines, optional export, explicit assignments, safe unquoted
serializer characters, JSON double-quoted strings and literal single-quoted strings;
malformed lines, duplicate variables and unsupported unquoted shell syntax refuse.
Quoted text is literal; nothing expands or executes.

The snapshot exposes an internal inventory and requires an explicit complete,
disjoint selected/excluded partition before credential selection. It conservatively
refuses alias-normalization collisions or shared explicit credential variables
anywhere in that inventory. Missing token_env never derives one from alias.
Nonempty captured environment values override saved values; actual empty values
fall back to file for selection. Invalid/getter values refuse without fallback.
Only selected variable descriptors are inspected, never unrelated environment
values. Returned legacy_url is descriptive and is NOT an approved RPC endpoint;
paired metadata/token_stored never yields verified pairing or stable grant identity.

The separate abandonmentValues path can represent original variable absence or
actual empty strings when files/values are safely absent in the supplied snapshot.
It supplies no credentials for admission and creates no approval or grant. Host
integration must establish owner permissions/no symlinks, read the exact fresh
bytes under the correct authority/maintenance lease, construct protected process
snapshots, bind/compare source fingerprints and readiness, and preserve original
IDs. None of these physical reader/coordinator/writer gates is accepted by a pure
parser. Parser/selection results include privileged credential values and source
text; they must never be emitted to tools/logs/model output or passed in argv.


### Ordinary protected source reader

The internal authority module now offers readContinuationSourceSnapshot for a
privileged synchronous callback. It uses the existing schema-2 authority snapshot
transaction, or borrows an existing configuration-wide lease. Pending, suspended,
wrong-identity and drifted configurations refuse; there is no allowSuspended flag
or maintenance/recovery bypass. This is not yet the proposed schema-3 coordinator.

Source files are owner/private regular files, bounded to 1 MiB, opened with
O_NOFOLLOW and O_NONBLOCK, then checked by descriptor before reading. Nonblocking
open prevents a regular-file-to-FIFO race from hanging before descriptor refusal.
The exact aggregate fingerprint of the actual read bytes must match the authority
row BEFORE parsing or invoking the callback. Pre/post fingerprint observations
alone would not bind the bytes actually parsed. The parser still rejects malformed
sources. Root identity/canonical-path checks and the authority's final source
check precede return. Collected raw buffers are wiped; returned private strings
cannot be reliably erased by JavaScript and must stay out of logs/tool output.

The callback's view expires on return/throw and cannot be reused asynchronously;
returning a promise refuses. Copied callback values are privileged snapshots, not
proof of current grant authorization. Callbacks must perform read-only local work;
if one changes files, an error does not roll back those effects. Cooperating writer
exclusion is exercised with an independent process. Observed root/source changes
refuse, but this is not protection against an owner's arbitrary unobserved
change-and-restore between all observations. Common writer integration, environment
rechecks/process provenance, trust/readiness/human decisions, suspended maintenance,
store agreement/admission and all native/platform/archive/privacy/traffic/release
gates remain. No CLI command activates this reader or approves any grant.


Ordinary authority snapshots, revision reads and outer grant leases now capture
canonical requested/root path, root device/inode, marker device/inode/configuration
identity and DB device/inode before opening the authority connection. They check
the anchor after acquisition and source validation. A borrowed snapshot uses the
outer lease's original anchor, never a new baseline from the current directory.
Requested-path aliases must still resolve to that same root. Marker parsing is
followed by fresh file-identity checks and a final root check; the snapshot/lease
also checks again AFTER final source/row I/O before returning a result.

Replacement roots with identical source bytes cannot satisfy the old anchor.
Observed marker or database instance replacements also refuse even when their
bytes match. Files/directories and any external effects remain retained on error;
no automatic rollback or reset is implied. These finite identity checks do not
make filesystem namespace changes atomic or prevent an arbitrary owner from
changing paths after the last check. Common writer coordination remains mandatory;
unobserved out-of-band races/change-and-return remain outside this guarantee.
Other maintenance/mutation/recovery writer paths still need that integration;
this ordinary-reader checkpoint does not approve them or lift suspension.


### Bounded mutation and quarantine instance checks

The existing synchronous file mutator, read-only quarantine planner and quarantine
transaction now capture the same root/marker/DB instance anchor before opening.
An active outer lease cannot be silently rebased onto a replacement root by these
operations; same-process writes and nested grant leases remain refused while that
lease is held. Diagnostic revision reads also retain the active acquisition anchor. The
mutator validates around its durable pending barrier, each transaction acquisition,
the callback, recorded source fingerprint and final commit/return. Quarantine
validates before and after commit. A later failure can therefore retain either a
pending barrier or completed writes/suspension: inspect the original retained
store/IDs, never assume rollback or retry automatically.

Unreleased quarantine approval tokens now use the literal domain
"a2a-exposed authority recovery v2" plus newline and JSON.stringify of the existing
ordered v1 payload with an appended array [root_dev,root_ino,marker_dev,marker_ino,
db_dev,db_ino]. Values come from the original anchor, not caller flags. This binds
the exact instance generation as well as canonical root/config/revision/intent/
suspension/fingerprints/action. Replacing/copying the root or marker/DB instance
invalidates an old approval even if UUID, private MAC key and source bytes match.
Old v1 approval identifiers require a fresh read-only plan; they are not accepted
or upgraded automatically. Schema remains 2; no stored schema migration or grant
resume is included. MAC keys and instance fields stay private; the plan still
returns only a bounded opaque approval token and the existing safe fields.

These checks cover the named mutation/quarantine APIs, not atomic filesystem
namespace ownership, all initialization/diagnostic paths or actual CLI config and
pairing-writer wiring. Shared-writer integration, the maintenance coordinator,
schemas 3/6, human/source/trust/readiness/replay admission and earlier platform/
archive/privacy/traffic/release gates remain. Quarantine still only suspends.


### Bounded initialization and diagnostics

Authority creation now anchors the private root before source hashing, reserves
DB and marker files exclusively with owner-private descriptors, and checks the
exact reserved instances around schema creation/commit and marker publication.
The final row must still be the expected revision-zero, nonpending baseline; a
concurrent mutation after marker publication refuses the stale setup result while
retaining the completed store. A file may be incomplete after failure; no artifact is deleted, replaced or
silently initialized again. The ordinary initializer refuses if either authority
file already exists. Two cooperating creators cannot both reserve the database.
Local authority MAC material is created only inside that new store; this is not
an A2A signing/receiving key, remote pairing or grant approval.

Diagnostic reads bind root/file instances before opening, check marker identity,
compare before/after row state around source I/O, and validate anchors again before
returning status. Absent/incomplete results also verify the observed partial state;
malformed marker content refuses instead of reporting completion. An active outer
lease's original anchor remains authoritative. Final anchor checks re-resolve
requested aliases after marker reads, so an observed parent-alias retarget cannot
leave a successful old-namespace result behind.

Initialization failures can preserve a committed DB without a marker, a partial
marker, or disjoint partial files if an owner races the namespace at an exclusive
open. They never imply rollback or permission to reset, regenerate or delete those
files. Inspect/preserve every original location. File fsync completion is not a
claim of directory/hardware power-loss durability. Finite namespace checks remain
subject to the stated owner-race limit. All actual config/pairing-writer wiring,
maintenance schemas/coordinator, human/trust/environment/replay admission and
platform/archive/privacy/traffic/release gates remain; no command activates these
components or resumes suspended grants.


### Isolated SDK maintenance queue mechanism

The internal LocalState._withMaintenanceQueue supplies the private SDK queue
lifetime needed by the proposed coordinator. It requires trusted withAuthorityLease
and literal synchronous assertAuthority(stage) callbacks; no command calls it and the real
maintenance authority adapter is not implemented. Test wrappers are synthetic host
attestations, not proof that a physical authority lease was obtained. The wrapper
must invoke/await its callback once and hold authority before the SDK queue.
Guard stages are the literal entry, transaction and exit. Entry/transaction guards
must attest the live physical authority transaction and exact original intent.
Exit runs only after the callback has closed its SDK transaction; it grants no
permission for another SDK write. A C/E phase whose authority COMMIT intentionally
released that physical lock may satisfy exit by validating its exact durable
committed intent/set/revision instead. The host callback scope must still be live.
This prevents a legitimate phase ending from masquerading as a missing host lease,
without weakening begin/commit guards. The real adapter must implement these exact
checks; a callback that simply returns true is not physical-authority proof.

The callback receives synchronous begin/commit/rollback/transactionState methods. One
SDK queue lease spans separate SQLite transactions/commits; the view expires on
exit, cleanup attempts rollback of an unfinished transaction on exit/refusal, and earlier committed
stages remain. Cleanup/rollback failures retain uncertainty; errors/host release
failures never imply all stages rolled back.
Queued normal SDK writers share that queue across LocalState instances. Async
context tracking refuses same-root reentry/cycles and any nested maintenance call
before it can acquire authority in reverse order. Detection is ancestry-scoped,
not a global wait-for graph; independent chains across multiple configurations
still require ordered/no cross-config nesting in the real host. The owning state cannot be
closed while maintenance holds it. Root/connection/config identity and restored
archive holds are rechecked; these are in-process connection checks, not new
physical namespace attestation. Ordinary queued transactions also recheck their
captured connection and archive hold after queue acquisition and before commit.

Only a held BEGIN IMMEDIATE transaction provides cross-process SDK write exclusion.
An idle queue between commits is intentionally NOT a physical database lock; the
coordinator must follow the reviewed authority/queue/transaction reacquisition
phases and recheck exact rows/readiness. Queue ownership alone does not stage/admit a grant. The explicit SDK staging
operations below do not approve SDK trust, human evidence, grant admission or
automatic reconciliation.
All real writer wiring, namespace provenance, source/approval/replay/restore/privacy/
platform/traffic/release gates remain. It is privileged host code, not a sandbox
against code that already owns the raw SDK database connection.


### SDK schema-6 staging records

The SDK now stores the exact host_grant_sets columns proposed above. Canonical
UUIDv4/digest encodings, safe positive target revisions and state are checked in
both the internal record snapshot and SQL constraints. A config-bound insertion
trigger requires the current SDK config identity; new rows start staged. Unique
intent/set IDs and (config_id,epoch,target_revision) prevent multiple sets claiming
one generation. SQL triggers retain rows, forbid binding updates and permit only
staged->ready/void and ready->void; there is no resurrection or reset.

The private maintenance view adds stageGrant, inspectGrant and transitionGrant.
All require a live explicit SDK transaction and transaction-stage authority guard.
Inputs are cloned/validated before host callbacks; each full binding remains
immutable. Repeating the exact staged binding can return that staged row without
rewriting it; other collisions refuse. State changes compare the complete binding
and exact expected state, with no automatic retry or state guessing. Internal
results include private membership MACs and must not be emitted to model/tool
output. MAC syntax is validated here; only the authority can authenticate the
opaque membership MAC and full human-approved aggregate. ready is merely the SDK
half of the future agreement, never permission to deliver or activate keys.

Schema 5 and older drafts are preserved/refused without automatic migration.
Nonempty host-grant history currently refuses backup/restore BEFORE any private
credential-provider read or output/destination creation, including void rows;
records are never silently omitted or revived. Empty-host schema-6 snapshots
continue the existing archive-only restore profile. A separately reviewed archive
format is required for operational host-grant history. This deliberate draft hold
must be resolved before complete lifecycle/release acceptance. No full authority/SDK phase
coordinator, human decision, current trust/source readiness,
all-writer/namespace integration, replay/admission, traffic or release is enabled.


### Isolated authority continuation tables

`cli/lib/continuation-tables.mjs` implements the four proposed continuation tables
as isolated internal storage primitives. Its installer requires an empty,
version-zero database inside a caller-owned transaction with foreign keys enabled.
It does not set a schema version, initialize a physical authority store or migrate
schema 2. The default physical pairing authority still creates and accepts schema 2 only.
The separate fresh initializer below installs these tables with a physical
schema-3 authority row. The default schema-2 initializer remains unchanged.

STRICT tables constrain canonical UUIDs and MAC encodings, safe revisions,
attestation validity windows, states and unique member aliases/identities/variables.
A partial unique index and insertion guard retain the single pending intent even
against INSERT OR REPLACE. Triggers retain all history, freeze immutable bindings,
limit state transitions and allow attestation consumption only once for its exact
prepared plan/epoch. Canonical JSON and keyed authenticity are checked by the
reader, not inferred from SQL syntax constraints.

The private codec's authorityRows projection authenticates an entire immutable
intent and produces canonical SQL records and member MACs. readContinuationIntent
checks every repeated SQL/JSON/MAC field, the exact consumed attestation, complete
member cardinality/order, set binding and state agreement. It returns private MAC
material and must never feed model/tool output. It can inspect authenticated
expired history; that is not permission to use an expired approval.

prepareContinuationIntent checks freshness and records/consumes the complete
attestation and prepared intent. commitContinuationMembers requires the exact
prepared immutable intent, inserts the entire set/member aggregate, and compares
its original ID, MAC, epoch, target revision, set and state before changing state
to set-committed. Savepoints retain the caller's outer transaction and roll back
partial storage writes on failure. They never commit the caller's transaction.
Independent-process tests cover reserved-lock exclusion and retained I/C record
checkpoints after process exit. These are storage tests, not a completed physical
host coordinator or proof of source/human/SDK readiness.

No eligible/finalize/abandon API is exposed. Privileged raw SQL is not sandboxed
and can still perform the schema's declared state transitions; an eligible SQL
row alone never grants admission. The future coordinator must atomically bind
these writes to its real authority-row revision/pending/epoch/active-set CAS,
validate source/environment/readiness and human provenance, and follow every
reviewed authority-to-SDK phase. None of those checks is supplied by a caller's
ability to MAC a record. The separate schema-3 initializer/reader and I-checkpoint maintenance foundation
are described below. The Final SDK/authority phase coordination, all writers, reconciliation, human
comparison, admission, archive/platform/privacy and traffic/release gates remain unfinished. No command imports these primitives.


### Fresh physical schema-3 authority foundation

The internal initializeContinuationAuthority entry point creates a fresh protected
POSIX authority database and marker using the existing exclusive-file and namespace
anchors. It installs the continuation tables and a STRICT authority row with a
random suspension_epoch, active_set null, revision zero and suspension set. It
refuses existing or incomplete stores; schema 1/2 is never migrated or reset.
The original schema-2 initializer and readers/writers remain separate and refuse
schema 3. No command calls the new entry points.

The schema-3 reader checks identity, canonical epoch, pending-intent cardinality,
epoch/revision binding and active-set/intent state agreement. Pending or active
records are authenticated against the real private recovery key and canonical
root. Public diagnostics expose IDs and suspension/source-mismatch state, never
source hashes, MACs, credentials or the recovery key. SQL guards retain the
authority identity and history and constrain pending/active bindings. Privileged
raw SQL is not an admission or human-approval boundary.

withContinuationAuthorityMaintenance owns one anchored physical connection and
explicit synchronous BEGIN IMMEDIATE, FULL COMMIT and rollback operations across
its callback. It shares writer exclusion with the legacy authority lease and
refuses same-configuration reentry. It can inspect suspended state; it cannot
produce an ordinary grant lease. Its source view and keyed record methods expire
when their scopes end. Exact parsed source bytes are compared to the real authority
fingerprint, and changed namespaces or sources refuse. An idle connection provides
no cross-process SQL lock.

The private prepareIntent primitive implements only the nonauthorizing I checkpoint.
It authenticates the supplied immutable plan/attestation with the actual store key,
checks freshness and the current epoch/revision/root/config, partitions the exact
protected peer inventory, and compares endpoints, explicit variables and current
file/environment credentials. Environment records bind a fresh process-instance
nonce that is neither persisted nor reconstructed from a PID. The attestation
consumption, prepared intent and authority revision/pending/suspension CAS share
one transaction. Current source/environment and approval freshness are rechecked
before I COMMIT, including after callback awaits; observed clock regression refuses.
No active set is created. A savepoint protects the caller's
transaction; the caller still owns the durable commit. Errors retain uncertainty
with the attempted intent/set IDs, without retrying or promising rollback of a
previous commit.

This is storage and maintenance groundwork, not the full I/S/C/R/E coordinator.
The isolated phase-2 adapter below adds nonauthorizing S/C after durable I.
The codec's ability to MAC synthetic comparison records does not establish human
provenance, SDK trust or readiness. No privileged human adapter or eligibility phase
adapter is wired here; prepareIntent is not a public approval operation. Tests
use synthetic comparisons and credentials only. Epoch rotation on quarantine,
all writer invalidation, SDK staging/ready/final exclusion, active-set eligibility,
reconciliation and admission remain required before activation. No method here
clears suspension, resumes a grant or sends encrypted traffic.


### Isolated readiness and suspended phase-2 coordinator

The private SDK maintenance view adds async assertReadiness for an exact bounded
aggregate of expected alias, endpoint, pairing identity, trust digest/version,
local identity/bundle digest, peer bundle digest and required/independent policy.
It requires a live authority guard and reserved SDK transaction. Current trust
SQL/JSON/version and every binding must match, with independently-verified state;
revoked, TOFU, off and server-readable records refuse even if their digest matches.
Pending proposals for selected peers and any noncommitted key operation hold the
aggregate. This conservatively includes abandoned key-operation records pending
separately reviewed reconciliation. Retired/lost keys and restored archive state
also refuse. Bundle signatures and the private file key pair are verified locally.
Every member is rechecked after provider awaits; all private files are reread
before returning. Input snapshots reject getters, unknown fields and duplicate
aliases/identities. Observed clock regression refuses. No trust row or approval
is created, and no private key, trust digest or membership MAC is returned.

This readiness profile permits protected file keys only. Native credential stores
refuse before a provider call, with no OS consent prompt or silent file fallback.
It is an internal prerequisite, not human-comparison provenance or a promise that
readiness remains true after its reserved SDK transaction ends. Existing SDK
connection/root checks do not establish physical SDK namespace ownership; the
remaining host/platform integration must supply that before activation.

The authority maintenance view adds async stageIntent for phase 2 only. The caller
must already own an authority BEGIN IMMEDIATE on a durable exact I checkpoint.
Uncommitted preparation, a different intent, an existing SDK stage or a completed C
refuse rather than resume automatically. The method authenticates the entire intent,
rechecks current exact sources/environment/process binding and approval freshness,
and acquires the SDK queue while retaining authority. Inside SDK BEGIN IMMEDIATE
it runs readiness, inserts the exact host binding and commits S. It then records the
complete authority member aggregate and commits C while the SDK queue stays held.
The queue exit checks the exact durable authority C witness without acquiring a
new authority transaction. The queue is released before any later authority BEGIN.

C remains suspended, pending and without an active set. A raw cross-process SDK
writer can run in the S-to-C gap: C confers no eligibility, and the future R/E
phase must reread all readiness under its own reserved transaction. The adapter
does not make the ready transition, clear suspension or admit a grant. SDK or
authority commit/close errors retain original IDs and unknown checkpoint status;
I, S or C may be durable. There is no retry, rewind or automatic reconciliation.

Tests use real physical authority and SDK stores with synthetic human attestations.
They exercise readiness holds, changed environment after awaits, independent-process
lock ordering and pre/post S/C COMMIT faults. No command imports the coordinator.
The initial I primitive still lacks trusted human provenance and pre-I SDK readiness
integration; R/E, quarantine epoch rotation, all-writer invalidation, reconciliation,
admission, native/platform/archive/privacy and traffic/release acceptance remain.


### Isolated suspended SDK-ready checkpoint

The private authority maintenance view adds async readyIntent for the C-to-R
portion of phase 3. It requires a durable authenticated C, matching pending intent,
unchanged source/environment and a fresh attestation. It takes the authority
reserved transaction before acquiring the SDK queue. In a reserved SDK transaction
it compares every staged binding field, reruns aggregate readiness and commits
only the exact staged-to-ready transition. It immediately opens a NEW SDK
reserved transaction, re-reads the exact ready binding and reruns all readiness.
A cross-process mutation in the R-commit gap must therefore be observed or refuse.

The authority remains unchanged at C: pending intent retained, suspension set,
no active set, no eligible intent or grant set. The final SDK reserved transaction
covers all final authority/source checks. This groundwork ends by rolling back
the read-only authority and SDK transactions, releasing the queue without
reacquiring authority. No final E transition is implemented. A future phase-3
coordinator must extend that reserved window through its reviewed E CAS/COMMIT;
it cannot treat this method's result as readiness that remains valid after release.

A pre/post R COMMIT failure retains public intent/set IDs and an unknown outcome.
R may already be durable even if the method throws. Existing ready/void rows
refuse: there is no automatic retry, resumption, rewind or reconciliation. The
ability to bind a synthetic attestation is still not proof of human comparison.
No command invokes this method; grant admission, human provenance, pre-I readiness,
E, quarantine/writer integration and lifecycle acceptance remain unfinished.
