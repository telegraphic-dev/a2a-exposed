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
| Side channels | Every encrypted fixture text is absent from wake webhook bodies (encrypted wakes carry only `[encrypted message]`), other Worker outbound requests, Worker logs, `export` JSON and SQL output, stderr of every command, stdout of commands that do not open content, and every local config file including SQLite. Private key material, including rotated keys, appears only in its own key file. A2A 0.3 and 1.0 push deliveries carry the sealed envelope, never its opened text. |
| Size boundaries | Exactly 200000 characters and exactly 307072 encoded content bytes send and open intact; one more character or byte refuses with no request. |
| Local-store faults | Garbage or truncated local SQLite, an unparsable key file and a private key that does not match its public identity each refuse sends and reads with fixed guidance, no stack trace and no request. The damaged bytes stay in place and no replacement key is created. |
| Transaction faults | Killing a writer, a competing SQLite write lock, a full database and an exception after a partial write leave no partial rows. A competing writer returns `state_busy`; the next write succeeds after the lock is released. |
| File custody | Linux, macOS and Windows CI reopen the original file key and refuse broadened POSIX permissions or Windows ACLs without replacing it. Native broker timeout and output tests use child-process doubles. |
| Native keychain | On the same three CI runners, a `keychain` key is stored in the real OS credential store (macOS Keychain, Linux Secret Service, Windows Credential Manager), never in a local file or the SQLite store. It reopens after restart and rotation, and every read, rotation and backup without consent refuses before the provider is called. A backup restores to a file store that opens the same messages. A deleted provider entry refuses reads as `key_lost` and creates no replacement. The test deletes its entries. |
| Concurrency | Parallel sends from one config get distinct message and task IDs, and parallel reads open each one. |
| Off switch | CLI-off, Worker-off and nonliteral switch values refuse; failure never produces a plaintext send. |
| Missing local key | CLI and MCP refuse without a plaintext retry or replacement key; restoring the original key restores reads. |
| Corruption and downgrade | Tampered signatures/context/ciphertext, plaintext for pinned peers and stale live rows refuse. Historical rows retain signature checks. |
| Uncertain delivery | A sender-history save failure remains delivered and says not to resend. Server task state remains explicitly unauthenticated. |
| Original-ID recovery | A send whose response is lost after storage, or whose connection dies before storage, recovers with `send --recover`: one stored task, no second wake, same message ID. A delivered record makes no request. A refused re-submission keeps the record `unknown` and recoverable. New text, context, task or protocol, a wrong alias, a config without encryption, and a damaged or edited record refuse with no request and leave the record unchanged. Records hold no plaintext. |
| Local revocation | `keys revoke` holds sends, reads and recovery for that pin with no request, keeps history and records, and is idempotent. |
| Backup and restore | The passphrase comes from piped stdin only; terminal, empty and short input refuse. Backups never overwrite and hold no plaintext or readable key. Restore needs the rollback acknowledgment and a new directory; a wrong passphrase creates nothing. The restored copy reads verified history and refuses sends; inbox and poll refuse before any request, by marker or by store flag with encryption on or off, and refuse when neither can be confirmed. |
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

Signer rotation (#379) and the independent `keys verify` ceremony (#380) are
covered by the two-CLI fixture. Deferred work remains linked from #173:
Worker-side key continuity after rotation, and interactive keychain prompts from #384. Abandoning a stuck pending
connect request, native keychain restore and MCP recovery tools are not covered yet.
The side-channel and push scans cover fixture transports, not an external push receiver.
Transaction fault injection runs locally; file custody and the native keychain round
trip run on the three CI operating systems. The keychain test runs unattended on
disposable runners, where no OS consent prompt appears. Prompt wording, denial and
timeout on a person's desktop remain open in #384; record them with a human present.

The native keychain test writes to the current user's OS credential store, so it
skips unless `A2A_NATIVE_KEYCHAIN_TEST=1`. Set that only on a disposable CI runner,
never on a workstation with real keys.
