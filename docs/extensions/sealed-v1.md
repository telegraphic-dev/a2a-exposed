# Sealed messages v1 — review draft

Extension URI: `https://a2a.exposed/ext/sealed/v1`. This is a vendor profile of
A2A 0.3 and 1.0, not an A2A standard. This draft is not enabled by the service.
The URI must serve this specification before traffic is enabled. Breaking
changes require a new URI. No private key is sent to a Worker.

## Modes and activation

Cards advertise the extension with `required: false` and a signed public key
bundle. A pinned pairing independently chooses `off`, `required`, or
`allow-server-readable`; a pinned encryption bundle defaults to `required`.
Unknown/unpaired callers use server-readable mode and still require normal
pairing authorization. An optional card extension cannot weaken local policy.

A2A 1.0 requests activate the extension with the comma-separated
`A2A-Extensions` header. Legacy 0.3 accepts `X-A2A-Extensions` too; when both
are present their URI sets must agree. Responses echo the activated URI in the
corresponding header (both when both were supplied). This profile requires the
echo even though the base A2A guidance says SHOULD. A missing echo is an
unconfirmed encrypted delivery, never permission to send plaintext or resend.
An unsupported version is never replaced with a supported version. A required
pairing rejects an inactive/unsupported extension before accepting content.

Sources: [A2A extensions](https://a2a-protocol.org/latest/topics/extensions/),
[A2A 1.0 specification](https://a2a-protocol.org/latest/specification/),
[RFC 9180](https://www.rfc-editor.org/rfc/rfc9180),
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785).

## Keys and custody

Each local identity uses fresh Ed25519 signing and X25519 encryption keys.
A formerly uploaded signing key must not be an encryption trust root. Existing
server-readable pairing identity and local encryption identity are separate.
A bundle has exactly `v`, `suite`, `cardUrl`, `identityKey`, `encryptionKey`,
`keyId`, `notBefore`, and `signature`. Public keys are raw 32-byte base64url;
keyId is the full base64url SHA-256 of the raw encryption key. `v` is 1.
Suite is `HPKE-X25519-SHA256-ChaCha20Poly1305` (KEM 0x0020, KDF 0x0001,
AEAD 0x0003), base mode. `notBefore` is canonical UTC ISO-8601 with milliseconds.
`cardUrl` is a canonical public HTTPS card URL without credentials or fragment.
The signature is Ed25519 over UTF-8 `a2a-exposed sealed key v1\n` followed by
canonical JSON of all bundle fields except signature. The card URL and validity
are checked against the requested card, not an unsigned redirect.

The local pin stores the complete signed bundle and policy. Initial keys are
TOFU, not independently verified. Locally computed safety codes cover both
identities and encryption key IDs, sorted by identity bytes; a separate trusted
channel is needed to mark verification. Any identity or encryption-key change
holds sending and opening. Approval names both the expected old bundle digest
and exact proposed new bundle digest; a changed proposal invalidates approval.
Identity changes require re-pairing and independent re-verification. Rotation
never silently upgrades trust. Old local decryption keys remain available for
history until explicitly removed. Worker mirrors are never the trust root.

## Envelope

A sealed A2A Message contains exactly one DataPart, no content-bearing outer
metadata, and `extensions: [URI]`. The DataPart has `metadata: {URI: {v:1}}`
and `data: {v:1, suite, header, recipient, sender, signature}`. The two copies
have exactly `{enc, ct}` with unpadded canonical base64url. Enc is 32 bytes;
ct includes the AEAD tag. Unknown/duplicate fields and malformed encodings
are rejected. Transport JSON rejects duplicate member names before parsing.

Header fields are exactly:

- `from` and `to`: `{cardUrl, identityKey, keyId}` from the pinned bundles.
- `contextId`, `messageId`: nonempty printable ASCII, at most 200 characters.
- `taskId`: null only for a new initial request, otherwise the exact task ID.
- `role`: `user` or `agent`, normalized from the outer A2A role.
- `state`: null for a message, otherwise the normalized task state.
- `kind`: `message`, `status`, or `artifact`.
- `sentAt`: canonical UTC ISO-8601 with milliseconds.
- `commitment`: SHA-256 of the random commitment nonce and canonical content.

The local sender chooses context/message IDs before sealing. The outer message
must carry matching IDs/role and the extension. Task/state-bearing containers
must match signed task/state/kind. The initial null task ID is accepted only
as the first request; the local replay ledger binds it to the first observed
assigned task ID and will not allow reassignment. Changing a task's routing
state without signed content does not create authenticated peer content.

The canonical plaintext is `{nonce, content}`. Nonce is a fresh random 32-byte
base64url value. Content contains all original parts, arbitrary message
metadata, content-bearing status data, artifact names/metadata/parts and
supported inline attachment names/bytes. External attachment URLs are refused
for required pairings: fetching them would disclose content outside the
boundary. Maximum canonical plaintext is 300 KiB; final transport must fit the
existing 1 MiB request limit. No chunking or external attachment store is v1.

`commitment = SHA256(rawNonce || UTF8(canonicalJSON(content)))`. The nonce is
inside both encrypted copies, not in the header, to avoid plaintext dictionary
attacks. Each endpoint opens only its designated copy and checks it against this commitment. Any successfully validated openings are bound to the same content under the hash assumptions. It does not prove the other copy can be opened; the sender must self-open its history copy before transmission to catch accidental errors. A dishonest sender can sign an unusable history copy.

Canonical JSON follows RFC 8785's ECMAScript serialization and UTF-16 key
ordering. Reject non-finite numbers, lone surrogates, undefined, sparse arrays,
non-JSON types and nesting deeper than 32. Strict envelope schemas fix every
signed field and reject extras. Receivers enforce duplicate-name rejection on
the raw transport, not merely on an already parsed object.

For each copy independently, create a fresh RFC 9180 sender context with the
copy's pinned public encryption key. `info` is UTF-8
`a2a-exposed sealed v1 recipient` or `a2a-exposed sealed v1 sender` respectively.
AAD is UTF-8 canonicalJSON(header). Seal the identical plaintext into both.
The Ed25519 signature covers UTF-8 `a2a-exposed sealed envelope v1\n` followed
by canonical JSON of `{v,suite,header,recipient,sender}`. Verify that signature
against the local pinned sender identity before attempting to decrypt either
copy; HPKE base mode alone does not authenticate the sender. Never open an
alternate unpinned key automatically. Sender-history opening checks the same
signature and bindings as recipient opening.

## Replay, history and failures

Persist `(sender identity, messageId, signed-envelope digest, context, assigned
task ID)` atomically before delivering plaintext. Same ID/different digest or
assignment is rejected. Reading the identical stored envelope again as history
is idempotent, not a new delivery. Only a committed first delivery triggers a
model-facing notification. Keep replay records for at least the accepted age
window (30 days) plus clock skew; reject envelopes older than 30 days or more
than five minutes in the future. Replay persistence failure holds delivery.
Opening history does not re-run side effects. Lost old keys produce a specific
unreadable result, never a plaintext fallback. Backup/restore must restore pins,
verification and replay state together, with the rollback/replay limit stated.

Stable error codes: `encryption_required`, `extension_unsupported`,
`extension_unconfirmed`, `key_unknown`, `key_changed`, `verification_failed`,
`replay`, `key_lost`, `content_unsupported`, `content_too_large`, `state_unavailable`.
Errors contain fixed guidance and public identifiers only, never content or
private material. CLI listings support JSON; key/trust choices are explicit.
Backup passphrases come from a protected file, named environment variable or
stdin, never argv or a required terminal prompt.

## Server boundary and rollout gate

Workers validate structure, mirrored pairing policy, outer bindings and size,
and store ciphertext and minimal routing/state metadata. Local clients repeat
all security checks without trusting the server. Server-readable remote MCP,
owner text sends and facade sends refuse required pairings. Browser logs show
metadata and a fixed encrypted label only. Wakes and pushes for all peers carry
fixed labels/identifiers, never content or unsolicited sealed blobs. Clients
fetch and open locally. Redact ciphertext from previews and errors as well.

Do not advertise or enable this extension until complete integration covers
inbound/outbound histories, snapshots, artifacts, pushes, exports, caches and
all local clients. Acceptance requires official HPKE vectors, independent
cross-language envelope opening, mutation/downgrade/replay/size tests, restart
and key-change/loss/restore tests, and plaintext/private-key scans over every
server surface. A cryptographic implementation review is a release gate;
passing round-trip tests alone is insufficient.

Metadata (routing, timing, state, size) remains visible. Static recipient keys
provide no forward secrecy. Old plaintext/backups remain server-readable.
The endpoint's model provider can read content after local opening.


## Review status and integration revision

The first AX review found nine integration blockers. This specification remains
an unfrozen draft. [Integration contracts](sealed-v1-integration.md) resolves the
proposed task assignment, carrier, ordering, durable delivery, archive, custody
and error contracts for a second review. Those contracts are not implemented by
the isolated primitives package. No encrypted traffic, card advertisement or
CLI encryption dependency is enabled by the foundation PR. CLI inclusion is
part of the later integrated client, after the package/protocol review gate.
