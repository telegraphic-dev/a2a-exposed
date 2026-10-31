# @a2a-exposed/control-core

This directory is the source for `@a2a-exposed/control-core` and a Worker. The Worker serves `GET /health`, `GET` and `POST /api/feedback` when `FEEDBACK_REPO` and `FEEDBACK_GITHUB_TOKEN` are set, and the static files in `public/`. The owner pages for one inbox (`/` and `/device`) are on the inbox Worker. `npm run deploy` applies `migrations/` when `CONTROL_D1_ID` or `CONTROL_D1_NAME` is set, then runs `cf deploy`.

The library source entry is `src/core/index.ts`. It exports inbox provisioning, routing helpers, the `ControlEnv` type, `redact` and `sanitized`, and the D1 migrations in `migrations/`.

`redact` removes secrets from text, including URL-encoded secret parameter names in queries, fragments, and form bodies, including nested URLs and encoded values inside ordinary fields and JSON strings, and complete secret-named JSON field values of any type in serialized JSON or mixed log text. `sanitized` copies a value and does the same for every string, for a field whose name is a secret, and for a `{ name, value }`, `{ key, value }`, or `[name, value]` pair whose name identifies a secret. A field such as `name`, `title`, `url`, or `preset` stays, including a pair whose name is not a secret. The published module is compiled JavaScript and TypeScript declarations. `prepare` at the repository root builds that module on `npm pack` and on a `file:` install. The `a2a-exposed` CLI package leaves this directory out.

## Account sign-in on a Cloudflare agent

`runInboxStep` accepts optional `approvalOidc`: `{ issuer, clientId, clientSecret, allowedSubjects }`. `allowedSubjects` is one account id, a comma-separated list, or an array of ids. When the issuer is https and the client id, client secret, and allowed subjects are all set, the uploaded Worker receives:

| Binding | Type |
| --- | --- |
| `APPROVAL_OIDC_ISSUER` | plain text |
| `APPROVAL_OIDC_CLIENT_ID` | plain text |
| `APPROVAL_OIDC_CLIENT_SECRET` | secret |
| `APPROVAL_OIDC_ALLOWED_SUBJECTS` | plain text |
| `APPROVAL_METHODS` | plain text, value `oidc` |

`inboxApprovalBindings` returns that same list for an agent that already exists. A call that omits `approvalOidc` keeps the approval password on the uploaded Worker. The issuer is an https URL, and the client id, client secret, and allowed subjects each have a value.

## Pairing events

`runInboxStep` accepts optional `eventUrl` and `eventSecret`. When the URL is https and the secret has a value, the uploaded Worker receives `EVENT_URL` (plain text) and `EVENT_SECRET` (a secret). `inboxEventBindings` returns that list. A call that omits either value writes neither binding.

A hosted agent reads `EVENT_URL` from the tenant config and `EVENT_SECRET` from the sealed secrets for that agent. `createTenant` accepts optional `eventUrl`, `eventSecret`, and `secretsKey`. When the URL is https, the secret has a value, and `secretsKey` seals it, `EVENT_URL` is stored in the tenant config and `EVENT_SECRET` is stored as ciphertext in `secrets_enc`. The agent decrypts that blob when it handles a request. A partial pair, or a secret that cannot be sealed, is left out of the tenant. `pairingEventConfig` returns the normalized `{ EVENT_URL, EVENT_SECRET }` pair.

The A2A endpoint POSTs `{ type, agent, requestId, code, name, alias, ip, country, createdAt, expiresAt, pending, decision? }` to `EVENT_URL`. `type` is `pairing_requested` or `pairing_decided`. `decision` is `approved` or `denied`. `x-a2a-timestamp` is unix seconds. `x-a2a-signature` is `sha256=` plus the HMAC-SHA256 of the timestamp, a period, and the raw body. `verifyEventSignature(body, headers, secret)` accepts that request when the timestamp is within 5 minutes. The contract is also in [Protocol](../docs/protocol.md#pairing-events).

From this directory, `npm test` runs the Node tests and a Vitest suite inside Miniflare. That suite runs the Cloudflare provisioning calls in workerd against a mocked Cloudflare API.

## Removal

`runRemovalStep` deletes the address, Worker, and D1 database this setup created, then the dashboard row. Cloudflare code 10000 or 7403 on the Worker or the database means the permission from consent is still propagating. The call returns `status: "waiting"`, `removalSteps` reports state `wait`, and the text is "Waiting for Cloudflare to apply the new permission…". `retryAt` is when to call again. `removalRetryDue` reads that from the saved row. The wait runs for up to 90 seconds after `consentedAt` (or `secondsSinceConsent` on the call).

Pass `refreshAccess` to supply the access token from the caller's cache. A cache hit sets `rotated: false`. A hook that throws is recorded as a removal failure. Pass `accessToken` to use a token the caller already holds. With both omitted, the step refreshes the stored grant once and reuses that access token until the wait ends. `onEvent` receives `removal_step` and `removal_step_failed` with the step, HTTP status, Cloudflare error code, seconds since consent, rotation count, and lock outcome.

A refresh response that includes `refresh_token` replaces the stored token. A response that omits it leaves the stored token in place. `refreshTokenAfterResponse` applies that rule to a token response the caller handles itself. The refresh request omits `scope`. A response that omits `scope` leaves the stored scopes in place. Migration `0015_cloudflare_grant_access.sql` stores the sealed access token on this library's own storage, with the other files in `migrations/`. The inbox Worker D1 is unchanged.

## Tenant wake settings

`saveWakeSettings(db, plane, secretsKey, input)` accepts `WakeSaveInput`: accountId,
name, url, preset, keyHeader, key, optional hmacSecret, optional accessClientId and
accessClientSecret, and optional expectedVersion.
The caller authenticates the account, confirms the human's choice, and validates
public DNS before saving; the Worker independently enforces its wake target policy
and pinned delivery. No public or owner HTTP route is added by this function.

`hmacSecret` is stored as encrypted `WAKE_HMAC_SECRET`, never in public config.
OpenBot requires a signing secret and rejects nonempty key/keyHeader inputs.
Blank signing credentials retain a saved value only for the same URL and preset; a webhook
key also requires the same key header. Removing the URL clears wake credentials,
including the tunnel Access pair; unrelated sealed event and upstream fields are
preserved. Legacy plaintext secrets migrate on save; existing ciphertext takes
precedence and an unreadable blob fails closed. The v1 ciphertext format remains
unchanged. Both readers recognize upstream bearer and Access credentials alongside
wake and event secrets. Upgrade the data-plane
Worker before a control-plane writer starts sealing the new upstream fields.
Upgrade all control-plane writers before enabling upstream-secret writes: an older
writer does not preserve fields it does not recognize when it reseals an envelope.
Once an envelope exists, its values are authoritative; do not retain upstream
credentials only in public config alongside it.

Pass `expectedVersion` from the settings the caller tested to reject a stale save
with `conflict`. The caller still verifies its short-lived signed test receipt;
this version check does not replace authentication, confirmation or test proof.
The database update and outbox enqueue are atomic, with optimistic version checks.
A concurrent save that loses the version check returns `conflict` and enqueues
nothing, including while the winning save is still delivering its configuration.
A failed push leaves the outbox for retry and logs a generic failure code, including on outbox retries.
Optional fields preserve the call shape for existing importers; all importers use
the same credential-reuse rules, including callers that omit the new fields.

Tunnel Access credentials are supplied together using `accessClientId` and
`accessClientSecret`. A partial pair is refused. Blank fields retain the saved
pair only for the identical wake URL; changing or removing that URL clears it.
The pair is sealed as `WAKE_ACCESS_CLIENT_ID` and `WAKE_ACCESS_CLIENT_SECRET`,
never returned in public config. Creating Cloudflare objects, confirming settings,
and checking a passing wake test remain the caller's responsibility.
