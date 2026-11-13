# Local keys and pairing

Local encryption is disabled by default. `A2A_SEALED_ENABLED=1` is reserved for
explicitly approved local tests until enablement is approved. Setting it enables
key pairing only in this change; sending encrypted messages is not implemented.
Do not configure it on a real inbox yet.

The local CLI loads `@a2a-exposed/encryption` only for key commands. Install the
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

Once a local key store exists, this intermediate change refuses ordinary `send`
before sending any plaintext, including when the test flag is unset. This also
protects against a deleted or replaced peer mirror. Until encrypted transport is
implemented, use a separate config directory for ordinary server-readable sends. The Worker never imports the optional HPKE package.

Follow-ups: signer rotation #379, further approval ceremonies #380,
quarantine/invalidation #381, uncertain-failure recovery #382, populated-store
backup/restore #383, broader hardening scans #384. No release or deployment is
part of the local test workflow.

`connect --json` emits newline-delimited JSON, one object per step. With local
keys, `key_comparison` precedes `authorization_pending` (also on resume), and
`keys_pinned` precedes `connected`. Parse each line separately. For `keys code`,
use the connecting side's ALIAS or the approving side's LABEL from `keys pairings`.
