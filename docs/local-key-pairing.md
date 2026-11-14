# Local keys and pairing

Local encryption is disabled by default. After the owner approves an environment,
set `A2A_SEALED_ENABLED=1` separately in each local CLI or MCP process and on each
inbox Worker. A hosted Worker passes this setting to its tenants; tenant overrides
are operator-managed, with no dashboard or tenant-owner API control. Production
must leave it unset until its owner explicitly approves production enablement.
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
from its protected backup or use the original config directory that holds it; do not initialize a replacement. `live_state: local-only`
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
`keys pin`. Do not start a second request to populate the listing. Abandoning a stuck pending request is not supported yet;
recovery commands are tracked in #382.

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
with `keys pairings --json`) and tell the other owner. This change does not provide an independent-verification
approval ceremony or rotation command.

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
prints the original context and message IDs. Ask the recipient's owner to check
their local inbox/history for that message ID before considering any new send. A successful delivery with failed sender-history
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

Follow-ups: signer rotation #379, further approval ceremonies #380,
quarantine/invalidation #381, uncertain-failure recovery #382, populated-store
backup/restore #383, broader hardening scans #384. No release or deployment is
part of the local test workflow.

`connect --json` emits newline-delimited JSON, one object per step. With local
keys, `key_comparison` precedes `authorization_pending` (also on resume), and
`keys_pinned` precedes `connected`. Parse each line separately. For `keys code`,
use the connecting side's ALIAS or the approving side's LABEL from `keys pairings`.

`traffic_requires_test_flag: true` in key/pairing results means traffic still
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
