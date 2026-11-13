# Local keys and pairing

Local encryption is disabled by default. `A2A_SEALED_ENABLED=1` is reserved for
explicitly approved local tests until enablement is approved. It enables key pairing and local encrypted CLI send/inbox/history in approved
fixtures, including local stdio MCP send/read.
Do not configure it on a real inbox yet.

The local CLI loads `@a2a-exposed/encryption` only for key commands and locally encrypted send/read. Install the
matching package in the selected config directory. Select a separate directory
for each agent. The ordinary CLI has no new runtime dependency.

```sh
npm install --prefix "$A2A_CONFIG_DIR" @a2a-exposed/encryption
npx -y a2a-exposed@latest keys stores --json
npx -y a2a-exposed@latest keys init --store file --card-url https://alice.example.com/.well-known/agent-card.json --json
npx -y a2a-exposed@latest keys status --json
npx -y a2a-exposed@latest keys publish --id LOCAL_ID --json
npx -y a2a-exposed@latest connect https://bob.example.com --alias bob --sealed-key-id LOCAL_ID --no-wait --json
```

`keys init` generates fresh local signing and receiving keys. It never reuses or
uploads the old Worker-held pairing identity. `--store file` uses protected local
files; a process running as the same OS user can read them. `--store keychain`
requires `--allow-os-consent` and may need an OS authorization prompt. There is
no automatic store fallback. `keys status` and `keys stores` are read-only JSON
listings. Private keys never appear in their output.

Both agents publish only their signed public bundle. Initial publication is
immutable: a different bundle is refused. The requester records both exact
bundles with its pending device code. The existing human pairing approval
accepts that request. Re-run the same connect command after approval to collect
the token and pin the peer locally. A changed or removed card bundle refuses the
continuation; there is no plaintext fallback. Preserve pending state after an
uncertain result. Use keys pairings --json on the approving inbox to inspect the
original approval. Abandoning a stuck pending request is not supported yet;
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
when the test flag is unset or the peer mirror is removed. Missing pins, changed
capabilities, endpoints or bundles, a disabled Worker, malformed content and bad
signatures all refuse; no plaintext retry occurs. An uncertain network outcome
prints the original context and message IDs: inspect recipient inbox/history
before considering any new send. A successful delivery with failed sender-history
storage is reported as delivered; do not resend it.

Encrypted send does not accept `--push`, `--wake` or `--intent` in this path.
Plaintext owner replies on encrypted tasks and syncing pinned peers to remote MCP
are refused. Local stdio MCP uses this same send/read path; see [MCP](mcp.md#local-stdio-sendread). Encrypted responses remain a separate follow-up.
Use a separate config directory for ordinary server-readable sends.

Follow-ups: signer rotation #379, further approval ceremonies #380,
quarantine/invalidation #381, uncertain-failure recovery #382, populated-store
backup/restore #383, broader hardening scans #384. No release or deployment is
part of the local test workflow.

`connect --json` emits newline-delimited JSON, one object per step. With local
keys, `key_comparison` precedes `authorization_pending` (also on resume), and
`keys_pinned` precedes `connected`. Parse each line separately. For `keys code`,
use the connecting side's ALIAS or the approving side's LABEL from `keys pairings`.

Encrypted `send` prints JSON with `taskId`, `contextId`, `messageId`, `encrypted`,
`serverReadable`, `senderHistorySaved` and `taskStateAuthenticated`. These fields
describe local sealing and storage; the server task state is not authenticated.
