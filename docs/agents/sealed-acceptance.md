# Local encrypted-path acceptance

Encryption stays disabled on real inboxes until the owner explicitly approves
enablement. This checklist exercises the one `A2A_SEALED_ENABLED=1` switch only
inside disposable fixtures. See [local keys and pairing](../local-key-pairing.md)
for the operator workflow and trust limits.

## Reproduce locally

Use Node 22.18+ and the isolated environment described in
[verification](verification.md). Install the locked `worker/` and `encryption/`
dependencies first; no Cloudflare credentials or deployment are needed.
From `worker/` run:

```sh
node scripts/stamp-version.mjs
TZ=Europe/Prague node --import ./test/register-hooks.mjs --test test/sealed-pairing.test.ts
TZ=UTC node --import ./test/register-hooks.mjs --test test/sealed-pairing.test.ts
TZ=UTC STORAGE_BACKEND=d1 node --import ./test/register-hooks.mjs --test test/sealed-pairing.test.ts
TZ=UTC STORAGE_BACKEND=do node --import ./test/register-hooks.mjs --test test/sealed-pairing.test.ts
```

The test launches separate CLI processes and local stdio MCP subprocesses for
Alice and Bob. Each has its own protected temporary config and local file keys.
Requests for their example HTTPS origins go to a loopback fixture bridge; other
network destinations are refused. The real Worker handles pairing, task storage,
owner reads and history. Temporary stores and the bridge are removed on exit.

## Acceptance checks

| Boundary | Required result |
| --- | --- |
| Key generation and publication | Only signed public bundles leave the local store; extra private fields and replacement bundles are refused. |
| Human-approved pairing | No token or local pin before fixture approval; resuming a changed public bundle refuses. Both local safety codes match, labelled TOFU and not independently verified. |
| CLI, A2A 0.3 and 1.0 | Seal sends; recipient inbox and both histories open locally. Task continuations keep the original context. |
| Local stdio MCP | `list_peers`, `send`, `inbox` and `history` use the same pins and crypto path across process restarts. Verified message IDs survive projection. |
| Server privacy | Every exported application table and captured request body excludes synthetic private text. Private key material never appears in captured requests or command output. |
| Off switch | CLI-off, Worker-off and nonliteral switch values refuse; failure never produces a plaintext send. |
| Missing local key | CLI and MCP refuse without a plaintext retry or replacement key; restoring the original key restores reads. |
| Corruption and downgrade | Tampered signatures/context/ciphertext, plaintext for pinned peers and stale live rows refuse. Historical rows retain signature checks. |
| Uncertain delivery | A sender-history save failure remains delivered and says not to resend. Server task state remains explicitly unauthenticated. |
| Bounds and consent | Oversized encoded content refuses before key access. Keychain access without explicit OS-consent permission refuses. |

Passing these fixtures shows local software behavior with the selected storage
backend. It does not establish that a hosted deployment, desktop MCP client,
browser pairing approval or live keychain prompt works. Record those separately
when explicitly approved test resources and a human are available. Do not claim
them from subprocess tests.

## Enablement decision

Preserve the test logs, commit SHA, storage backend and timezone with the review.
Run the full contributor validation before publishing the PR. Obtain current-head
code and UX approval before merge. Keep production configuration unchanged.
The final owner decision must separately name which inboxes and clients may be
enabled; this checklist grants no access and changes no deployed configuration.

Deferred work remains linked from #173: signer rotation #379, further approval
ceremonies #380, quarantine/invalidation #381, uncertain-failure recovery #382,
populated-store backup/restore #383 and broader hardening scans #384.
