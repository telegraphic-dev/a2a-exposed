# Local keys and pairing

Local encryption is disabled by default. After the owner approves an environment,
set `A2A_SEALED_ENABLED=1` separately in each local CLI or MCP process and on each
inbox Worker. A hosted Worker passes this setting to its tenants; tenant overrides
are operator-managed, with no dashboard or tenant-owner API control. The hosted
production service has had it on since 2026-11-14. A self-hosted Worker leaves it
unset, so encryption stays off there until its owner sets it.
Only the exact value `1` enables encryption; `true`, `yes` and whitespace do not.
Setting the Worker flag does not configure the local CLI or MCP process.

The local CLI loads `@a2a-exposed/encryption` only for key commands and locally encrypted send/read. Install the
matching package in the selected config directory. Select a separate directory
for each agent. Export `A2A_CONFIG_DIR` to an absolute path before running both
npm and the CLI, or pass `--config-dir /absolute/path` on every CLI command.
The flag overrides `A2A_CONFIG_DIR`; npm's `--prefix` must select that same directory.
The ordinary CLI has no new runtime dependency.

```sh
export A2A_CONFIG_DIR="/absolute/path/to/alice-config"
npm install --prefix "$A2A_CONFIG_DIR" @a2a-exposed/encryption@CLI_VERSION
npx -y a2a-exposed@latest keys stores --json
npx -y a2a-exposed@latest keys init --store file --card-url https://alice.example.com/.well-known/agent-card.json --json
npx -y a2a-exposed@latest keys status --json
npx -y a2a-exposed@latest keys publish --id LOCAL_ID --json
npx -y a2a-exposed@latest connect https://bob.example.com --alias bob --sealed-key-id LOCAL_ID --no-wait --json
```

Replace `CLI_VERSION` with the selected CLI's `--version` output. The encryption
package is published by the maintainer tag workflow alongside the CLI. If that
version predates encryption publishing and npm returns 404, stop: use a matching
source checkout and its locally packed encryption tarball for contributor tests,
or wait for a maintainer release that includes it. Do not install a mismatched
version or enable encryption to work around a missing package.

`keys init` generates fresh local signing and receiving keys. It never reuses or
uploads the old Worker-held pairing identity. `--store file` uses protected local
files; a process running as the same OS user can read them. `--store keychain`
requires `--allow-os-consent` and may need an OS authorization prompt. There is
no automatic store fallback. `keys status` and `keys stores` are read-only JSON
listings. Status reports `private_key_status`: `present` checks only file existence
and protected permissions, `key_missing` means the original file is absent, and
`unavailable` means the file check failed. Keychain availability is `not_checked`;
status never opens a private key or prompts the OS. Restore a missing original key
from its protected backup or use the original config directory that holds it; do not initialize a replacement.
A damaged key file, a private key that does not match its public identity, or an
unreadable `encryption/state.sqlite` refuses sends and reads with fixed recovery
guidance before any network request. The damaged files stay unchanged for
inspection; restore the originals from a trusted backup rather than running
`keys init` over them. See [recovery, revocation and backup](#recovery-revocation-and-backup). `live_state: local-only`
means an active local identity, including after public-bundle publication; it is
not a remote publication check. Private keys never appear in these listings.

Both agents publish only their signed public bundle. Initial publication is
immutable: a different bundle is refused. The requester records both exact
bundles with its pending device code. The existing human pairing approval
accepts that request. Re-run the same connect command after approval to collect
the token and pin the peer locally. A changed or removed card bundle refuses the
continuation; there is no plaintext fallback. Preserve pending state after an
uncertain result. Use keys pairings --json on the approving inbox to inspect the
original approval **after the requester has collected the token**. Immediately
after human approval it can still return `pairings: []`; the requester must resume
the same connect command before the receiving owner runs `keys pairings` and
`keys pin`. Do not start a second request to populate the listing. Abandoning a stuck pending request is not supported yet.

The receiving owner imports the approved request into their own local pins:

```sh
npx -y a2a-exposed@latest keys pairings --json
npx -y a2a-exposed@latest keys pin --id LOCAL_ID --peer LABEL --user-code CODE --json
npx -y a2a-exposed@latest keys code --id LOCAL_ID --peer LABEL --json
```

Select `LABEL` and `CODE` from the active approved pairing listing, and `LOCAL_ID`
from local status. Pinning checks that the approval contains exactly that local
bundle. Revoked pairings cannot be imported. Existing pins are never replaced by
this command. Pin the reverse direction through its own human-approved connect
when a separate outbound credential is needed.

The CLI computes the same safety code on both computers from both public
identities, key IDs and card URLs. It labels the pin **trust on first use (TOFU)**,
with `independently_verified: false`. Hosted pairing approval alone does not prove
that the service relayed authentic keys. Compare the complete code through a
separate trusted channel. If any group differs, do not use this pairing: ask the
approving inbox owner to revoke it with `token revoke LABEL` (select the label
with `keys pairings --json`) and tell the other owner.

**Independent verification.** The owners read the complete code to each other
over a separate trusted channel, such as a call. Each side then records the code
it heard: `keys verify --id LOCAL_ID --peer ALIAS_OR_LABEL --code "CODE" --json`.
The CLI recomputes the code from the exact pinned keys and needs every one of the
60 digits to match; spacing is ignored. Only then does the pin change from TOFU
to `independently-verified`, bound to those exact keys. A mismatch changes nothing
and gives the recovery steps above. The proposal, the code check and the approval
run in one transaction, so a failure leaves the pin unchanged. `keys code` reports
`independently_verified` for each pin.

## Local encrypted CLI messages

After both local pins are imported, the connecting side can send with the existing
human-approved credential:

```sh
npx -y a2a-exposed@latest peers list --json
npx -y a2a-exposed@latest send --to bob --text "fixture message"
npx -y a2a-exposed@latest inbox --json
npx -y a2a-exposed@latest history CONTEXT_ID --json
```

Run inbox/history in the receiving agent's config directory; sender history also
opens the sender's encrypted copy. The CLI seals the content with HPKE for both
the receiver and sender, signs its public context/message/task binding, and sends
one ciphertext-only data part. A2A 0.3 and 1.0 use the same envelope. The Worker
checks the signature against the exact approved public bundles without holding
private keys or importing HPKE. It stores ciphertext and public routing metadata.
Wakes and server previews contain `[encrypted message]`. The CLI verifies the
pinned sender and recipient and opens content locally; JSON marks it
`locallyOpened: true`. Message content remains untrusted peer data.

Context/message IDs and any caller-supplied task ID are signed. With `--task`
and no `--context`, the CLI first reads that task's public routing context before
sealing; passing both uses the explicit context. Encrypted send requests only the
latest history entry so a growing task remains within the response bound. The initial
server-assigned task ID and server state are routing hints; this path does not
claim a recipient-signed task assignment or exactly-once model consumption.
Reading history repeatedly does not consume or execute the message. Inbox admission uses the 30-day live freshness window. Historical reads verify
the signature and ciphertext at the signed time without granting live/replay
authorization, and are labelled `historical: true`. Unreadable rows return a safe
reason and their task/context IDs while other rows remain readable; the command
exits 1 if any row is refused. Local state, key changes or missing
keys can prevent reads; preserve the original store rather than creating new keys.

Use `--allow-os-consent` explicitly on send, inbox or history for a keychain key.
Without it, keychain reads fail promptly; OS authorization is never automatic.
There is no file-store fallback. A local OS prompt may still need a human.

Once a local key store exists, ordinary plaintext `send` is refused, including
when the encryption flag is unset or the peer mirror is removed. Missing pins, changed
capabilities, endpoints or bundles, a disabled Worker, malformed content and bad
signatures all refuse; no plaintext retry occurs. An uncertain network outcome
prints the original context and message IDs and the exact recovery command; see
[recovery, revocation and backup](#recovery-revocation-and-backup). Never send a
new message to replace an unconfirmed one. A successful delivery with failed sender-history
storage is reported as delivered; do not resend it.

A recipient that explicitly refuses because its encryption is off or this peer
has no approved keys gets a specific local message and next step; no plaintext
is sent. Ask the recipient owner to check the setting or existing pairing
before any new attempt. Other errors still leave delivery unconfirmed, so
preserve the original IDs and check recipient history before any new send.

Encrypted text is limited to 200000 Unicode characters and 307072 UTF-8 bytes for canonical content, including JSON structure and escaping. Both limits are checked before private-key access, for `--text` and piped stdin.

Encrypted send does not accept `--push`, `--wake` or `--intent` in this path.
Plaintext owner replies on encrypted tasks and syncing pinned peers to remote MCP
are refused. Local stdio MCP uses this same send/read path; see [MCP](mcp.md#local-stdio-sendread). Encrypted responses remain a separate follow-up.
A missing encrypted outbound record does not mean delivery failed. Use `poll --to ALIAS TASK_ID --json` (local MCP: `poll_outbound`) or history with the original context; do not resend.
Use a separate config directory for ordinary server-readable sends.

## Recovery, revocation and backup

**Send records.** Before the first network byte, `send` saves a local record of
the signed encrypted message and its public IDs in `sealed-outbox/` in the config
directory (folder mode 700, files 600). It never holds the message text. If the
record cannot be saved, nothing is sent. The record ends as `delivered`, `refused`
(the recipient refused before storing it, so nothing was delivered) or `unknown`.

```sh
npx -y a2a-exposed@latest keys outbox --json
npx -y a2a-exposed@latest send --to bob --recover MESSAGE_ID --json
```

`keys outbox` lists public fields and a next step per record, newest first.
`send --recover` is explicit and never automatic. It only ever reconciles an
encrypted record: in a config directory without one, or with encryption off, it
refuses and never sends a new message in its place. It re-submits the same
encrypted bytes with the same message ID; it never reseals, picks a new ID or
takes new text, context, task or protocol. The recipient inbox stores a message
once per peer and message ID: if the original arrived, it returns that task and
wakes nobody again; if not, it stores it now. A `delivered` record makes no
request. Recovery first checks that the pin, local key, endpoint and published
capability are unchanged and authenticates the stored envelope as this sender's
own copy. A changed or revoked pairing, or a damaged record, refuses. The record
is left unchanged for inspection, and the recipient's owner can check history for
the original IDs. The recipient applies its normal 30-day freshness window. A refusal during recovery leaves the record `unknown`: it does not show whether an earlier attempt was stored, so ask the recipient's owner to check history before sending a new message. Only a refusal of the first attempt marks a record `refused`. MCP
has no recovery tool yet; run the CLI with the same `--config-dir`.

**Local revocation.** `keys revoke --peer ALIAS_OR_LABEL --json` marks one local
pin revoked. Encrypted sends, reads and send recovery for that peer stop in this
config directory, plaintext stays refused, and history and send records are kept.
It does not change the inbox server: to stop the peer's access there, the inbox
owner runs `token revoke LABEL`. A revoked pin is never re-enabled in place; using
the peer again needs a new human-approved pairing under a new alias.

**Signer rotation.** `keys rotate --id LOCAL_ID --json` prints an exact plan, the
pins it will hold and an `approval_digest`; it changes nothing. After the human
approves that plan, `keys rotate --id LOCAL_ID --approve DIGEST --json` creates a
fresh signing and receiving identity for the same card URL. The old identity is
retired: it still opens old history (`history CONTEXT --json`) and never signs
again. Sends and send recovery on its pins refuse with "Keys rotated" and send
nothing. While any pin still uses the retired key, `inbox` and `poll` refuse before
contacting the inbox, so no wake or reply is acknowledged for a pin the new key
cannot serve. `keys revoke --peer` still works on such a pin (revoking only removes
trust) and releases the inbox. An interrupted rotation is recorded with its
lineage, so exact recovery from `keys status --json` completes the approved
rotation instead of abandoning the new key. To talk to a peer again, make a new human-approved pairing with
the new key (`connect URL --sealed-key-id NEW_ID --alias NEW_ALIAS`), then run
`keys verify` with the other owner. A changed plan, such as a new pin, needs a new
approval. Rotation is local only: the store schema and backups are unchanged, and
nothing changes on the inbox. The inbox keeps the public key it published first,
so `keys publish` cannot replace it and pairings other agents request from this
inbox still use the old key and are held. Worker-side continuity (a chained
publish that refuses a mismatch, plus bundle history) is a possible follow-up.

**Backup.** `keys backup --to FILE --json` writes a new encrypted file (scrypt and
AES-256-GCM) with the keys, pins, trust history and delivery records. It never
overwrites a file. The passphrase comes only from piped stdin, never a terminal
prompt, argument or environment variable; a terminal or empty input refuses, and
it needs at least 12 characters. Keychain keys need `--allow-os-consent`. Send
records are not included. Unresolved key creation or a known missing key refuses.

**Restore.** `keys restore --from FILE --to NEW_DIR --acknowledge-replay-rollback --json`
restores into a new directory only and never merges. It uses file storage and
gives the copy a new config identity. The copy is archive-only: `history CONTEXT --json`
opens verified history (`historical: true`), while send, inbox, poll and recovery
stay held. Inbox and poll refuse before contacting the inbox, so a restored copy
never acknowledges wakes or replies meant for the live identity. With local
encryption state present, they check the store's archive flag whatever the
encryption setting, and refuse if it cannot be read; `keys restore` also writes an
`archive-only.json` marker that needs no package. To read history there, install the matching optional
`@a2a-exposed/encryption` package in `NEW_DIR` and give it the inbox settings
(`config.env`). A wrong passphrase creates nothing. A restored copy cannot become a
live identity; that needs a fresh key and new peer verification, which is not
implemented.

**Damaged state.** A damaged state database, key file or send record is never
repaired, moved or replaced. It refuses with fixed guidance and stays in place.
Restore a backup into a new directory to read history.

Follow-ups: Worker-side key continuity after rotation, cross-platform key custody
and encrypted push delivery from #384. Not covered yet: abandoning a stuck pending connect request, native
keychain restore, and MCP recovery tools. No release or deployment is part of
the local test workflow.

## Suggested, never the default

An ordinary pairing is server-readable: both inbox servers can read its
messages. When an ordinary `connect` finds that the peer card advertises
`https://a2a.exposed/ext/sealed/v1`, or that this config directory already has
local keys, it says so after the pairing code and prints the
`connect ... --sealed-key-id KEY_ID` command. With `--json`, the
`authorization_pending` line carries an `encryption` object
(`server_readable`, `peer_offers_encryption`, `local_keys`, `command` when one
applies, and `next`). The ordinary request continues unchanged: `connect` never
creates keys, adds the flag or pins anything. To switch, ask the peer owner not
to approve the ordinary code; in a config directory with local keys, use a new
alias, since abandoning a pending request is not supported yet.

On the approving inbox, `/device` and `pair list` label a request that carries
public bundles as an **encrypted key pairing** and show its safety code: the
same code the requester's `connect` printed. `GET /owner/pairing` flags it with
`sealed: true` and `safetyCode`; it never lists bundles or keys. Compare the code
through another trusted channel before approving. This is trust on first use,
not independent verification. Approval pins nothing; the receiving owner still
runs `keys pairings --json` and `keys pin` after the requester collects its token.

`connect --json` emits newline-delimited JSON, one object per step. With local
keys, `key_comparison` precedes `authorization_pending` for a new request or
`checking_authorization` on resume, and
`keys_pinned` precedes `connected`. Parse each line separately. For `keys code`,
use the connecting side's ALIAS or the approving side's LABEL from `keys pairings`.

The existing `traffic_requires_test_flag: true` field is retained for compatibility.
It means traffic still
requires exact `A2A_SEALED_ENABLED=1` in the local process and each Worker. It is
not a second flag or evidence of enablement.

Encrypted sends save only ciphertext in sender history and outbound tracking.
Use `peers list --json` to select the original pinned alias, then
`outbound TASK_ID --to ALIAS --json` for a stored snapshot or
`poll --to ALIAS TASK_ID --json` to fetch at the pinned peer endpoint.
These commands open verified message content locally and never return raw peer
status messages, artifacts or arbitrary task fields. Task state and initial task
assignment remain unauthenticated routing hints. Poll reads at most 20 messages;
use `history CONTEXT_ID --from ALIAS --json` for longer conversation history.
Stored outbound reads use archive verification; poll uses the live freshness
check. A refused row remains encrypted and includes recovery guidance.

`outboundSaved` reports optional tracking independently of `senderHistorySaved`.
A successful send stays successful if either save fails. A missing outbound
record does not mean delivery failed: poll with the original task ID and local
alias, or ask the recipient owner to check the original context/message IDs.
No command automatically retries a send or falls back to plaintext. Polling uses
the selected local pin, never an endpoint supplied by the tracking record.
`--allow-os-consent` remains an explicit human-present keychain choice on reads.

Encrypted `send` accepts `--json` and prints JSON with `taskId`, `contextId`, `messageId`, `encrypted`,
`serverReadable`, `senderHistorySaved`, `outboundSaved` and `taskStateAuthenticated`. `historical: true` on a history row selects archive
verification even for a freshly sent message; it does not mean the message is old.
These fields
describe local sealing and storage; the server task state is not authenticated.

## Continue from a one-way pairing

A one-way encrypted pairing lets the recipient read locally but does not give it
an outbound credential. To continue, list `peers list --json` in the original
config directory and use an existing pinned alias with `send` and the same
context ID. If none exists, list `keys status --json`, select the existing local
ID, verify the peer URL with its owner, and ask your human before running
`connect <peer URL> --sealed-key-id <id> --alias ALIAS --no-wait`.
The reverse pairing needs owner approval; never pair automatically, create
replacement keys, or fall back to plaintext `reply`.

`keys pin` includes safety-code mismatch recovery. A resumed `connect --json`
reports `checking_authorization` before checking its saved request, rather than
claiming that an already-approved request is still pending. Key catalog entries
are public metadata; a listed ID does not prove its private material is present.
Sent history uses the sender's outbound alias; received history uses the
recipient's inbound token label. Different names alone do not prove different
peers. Confirm the pairing and safety code before associating those labels.

## Acceptance before enablement

Use the existing `A2A_SEALED_ENABLED` switch on both local CLI processes and both
fixture Workers. Only the literal value `1` enables this path. An unset switch
on either side refuses encrypted traffic. Setting it on a CLI does not configure
a Worker or enable a hosted account. There is no second enablement flag and no
plaintext fallback. Real inbox enablement still requires explicit approval.

Contributors can reproduce the complete local path with the
[acceptance checklist](agents/sealed-acceptance.md). It uses two disposable local
agents, real CLI and stdio processes, and the real Worker with fixture storage.
It does not deploy resources, approve a real pairing, or use an owner's account.
The fixture simulates the human approval boundary; it does not verify a browser
approval or an operating-system keychain prompt.

Local stdio MCP `list_peers.encryptionEnabled` describes only the current MCP
process's exact `A2A_SEALED_ENABLED=1` setting. It does not report or enable an
inbox Worker or a peer; each needs its own separately approved setting.
A refused verification row tells the operator not to resend and to report its
`taskId` and `contextId` to the inbox owner. Preserve those IDs with the original
keys and pairing. The approval-page safety-code work remains tracked in [#380](https://github.com/telegraphic-dev/a2a-exposed/issues/380).
