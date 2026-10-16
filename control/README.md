# @a2a-exposed/control-core

This directory is the source for `@a2a-exposed/control-core` and a Worker. The Worker serves `GET /health`, `GET` and `POST /api/feedback` when `FEEDBACK_REPO` and `FEEDBACK_GITHUB_TOKEN` are set, and the static files in `public/`. The owner pages for one inbox (`/` and `/device`) are on the inbox Worker. `npm run deploy` applies `migrations/` when `CONTROL_D1_ID` or `CONTROL_D1_NAME` is set, then runs `cf deploy`.

The library source entry is `src/core/index.ts`. It exports inbox provisioning, routing helpers, the `ControlEnv` type, and the D1 migrations in `migrations/`. The published module is compiled JavaScript and TypeScript declarations. `prepare` at the repository root builds that module on `npm pack` and on a `file:` install. The `a2a-exposed` CLI package leaves this directory out.

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

A hosted agent reads the same two fields from the tenant config. `createTenant` accepts optional `eventUrl` and `eventSecret` and stores them when both are usable. `pairingEventConfig` returns `{ EVENT_URL, EVENT_SECRET }` for a config the control plane already updates.

The A2A endpoint POSTs `{ type, agent, requestId, code, name, alias, ip, country, createdAt, expiresAt, pending, decision? }` to `EVENT_URL`. `type` is `pairing_requested` or `pairing_decided`. `decision` is `approved` or `denied`. `x-a2a-timestamp` is unix seconds. `x-a2a-signature` is `sha256=` plus the HMAC-SHA256 of the timestamp, a period, and the raw body. `verifyEventSignature(body, headers, secret)` accepts that request when the timestamp is within 5 minutes. The contract is also in [Protocol](../docs/protocol.md#pairing-events).

From this directory, `npm test` runs the Node tests and a Vitest suite inside Miniflare. That suite runs the Cloudflare provisioning calls in workerd against a mocked Cloudflare API.

## Removal

`runRemovalStep` deletes the address, Worker, and D1 database this setup created, then the dashboard row. Cloudflare code 10000 or 7403 on the Worker or the database means the permission from consent is still propagating. The call returns `status: "waiting"`, `removalSteps` reports state `wait`, and the text is "Waiting for Cloudflare to apply the new permission…". `retryAt` is when to call again. `removalRetryDue` reads that from the saved row. The wait runs for up to 90 seconds after `consentedAt` (or `secondsSinceConsent` on the call).

Pass `refreshAccess` to supply the access token from the caller's cache. A cache hit sets `rotated: false`. A hook that throws is recorded as a removal failure. Pass `accessToken` to use a token the caller already holds. With both omitted, the step refreshes the stored grant once and reuses that access token until the wait ends. `onEvent` receives `removal_step` and `removal_step_failed` with the step, HTTP status, Cloudflare error code, seconds since consent, rotation count, and lock outcome.

A refresh response that includes `refresh_token` replaces the stored token. A response that omits it leaves the stored token in place. `refreshTokenAfterResponse` applies that rule to a token response the caller handles itself. The refresh request omits `scope`. A response that omits `scope` leaves the stored scopes in place. Migration `0015_cloudflare_grant_access.sql` stores the sealed access token on this library's own storage, with the other files in `migrations/`. The inbox Worker D1 is unchanged.
