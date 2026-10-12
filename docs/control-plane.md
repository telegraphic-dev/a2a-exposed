# Control plane

`control/` is a second Worker. Hono serves `/app`, `/api`, `/health`, and `/.well-known`. Workers static assets serve everything else. The npm package does not include it. A self-hosted inbox from `npx -y a2a-exposed@latest init` does not need this Worker.

From `control/`, `npm run deploy` applies `control/migrations/` to the control D1 database and then runs `cf deploy`. With `CONTROL_D1_ID` and `CONTROL_D1_NAME` both unset, that step is skipped. A failed migration does not deploy.

With no environment variables it is a neutral shell. The name defaults to Inbox. Login, mail, and billing stay off. Brand, marketing pages, and legal copy are layered on at build time. See [control/OVERLAY.md](../control/OVERLAY.md). The hosted service's name is a2a.exposed. A deployment of this directory uses `BRAND_NAME` and does not include that name. See [TRADEMARKS.md](../TRADEMARKS.md).

## Sign-in

Login (GitHub, Google, or email) turns on only when D1, `AUTH_SECRET`, and that provider are set. Cloudflare is not a sign-in method.

A sign-in that does not complete returns to `/app?error=<code>`. The page shows a short message for `auth`, `turnstile`, `deadline`, `invalid-input-secret`, `rate_limit`, `unavailable`, `invite`, `email`, `state_mismatch`, `invalid_code`, `email_not_found`, `unable_to_create_user`, and the other known codes. An unknown code shows the same message as `auth`.

`SIGNUP_ALLOWLIST`, when set, is a comma-separated list of exact emails and `*@domain` wildcards. It is matched case-insensitively against the provider's verified email when the account is created and on every later sign-in, including a magic link and the CLI device flow. Unset or empty, sign-in stays open. A refusal is `/app?error=invite` and the page says "Sign-in is invite-only for now." A brand overlay replaces that sentence with `signupClosed`. A missing or invalid invite code still says "That invite code is not valid." An unverified address does not match. GitHub uses its own verified flag. Google uses `email_verified`. A magic link counts because the link was received.

The sign-in page allows each enabled provider origin in `form-action`. Buttons say "Continue with …". With Turnstile on, the buttons stay disabled until the check returns a token. The page says "Waiting for the check…" until then. A reused token says "The check expired. Please try again."

The control Worker logs `social_sign_in_failed` when the provider page is never reached, `social_sign_in_timeout` when that sign-in does not return, and `oauth_callback_failed` when the provider sends the browser back. None of those lines includes the OAuth code, state, Turnstile token, or secret. A sign-in or callback that does not return in time is `deadline`.

A signed-in `/app` shows the account and its agents. Sign out is a same-origin post.

```bash
npx -y a2a-exposed@latest login --control-url https://control.example
```

`signup` is the same flow for a first account. The page is `/app/device`. It asks for the code from that terminal before it approves. The session is stored as `CONTROL_TOKEN` and is not printed. Login has to be on, or the command stops.

When `ISSUER` is set, login and the OpenID Connect document use it, including when `SITE_URL` is a different origin. Unset, discovery uses the request origin when it is https and matches `SITE_URL` (or when `SITE_URL` is also unset).

## Agents

`POST /api/v1/tenants` turns on only when login is on and the data-plane Durable Object plus its name directory are bound. It creates one agent, returns the owner token once, and pushes that config into the object. A JSON client sends `application/json`. The signed-in page posts the same route as a form. A browser request from another host is rejected. The page that shows the owner token is not stored. A page restored from the back-forward cache drops the token. The token is shown with no surrounding whitespace, and a Copy button. Without JavaScript the token is still that value.

The name is 4–32 letters, numbers, or hyphens. Reserved names are rejected.

Unset or empty, an account has no agent cap. `FREE_AGENT_LIMIT`, when set to a non-negative integer, is the default (a deployment that wants a free plan sets 2). `user.agent_limit` overrides that number. The database rejects an insert past the cap, including when two creates overlap. After a delete, `/app` says how many agent slots remain.

`/app/agents/<name>` is for an agent that account owns. It shows status, public URL, agent-card link, and inbox counts from `GET /owner/summary` (tasks in each state, and pending pairing requests; no message text). Counting does not mark tasks seen, so a pending wake stays.

The same page:

- Shows a masked wake preview (`Bearer ••••` or `••••`, and that a key is saved, with none of the key). Sends a test wake. Edits the wake URL, preset, and key header. The key is write-only. A test that was not sent says why (for example TLS handshake failed, or the HTTP status) and does not print the error text. The note that Claude Code starts a new cloud session is shown only when that preset is the one saved. `WAKE_MAX_PER_HOUR` of `0`, or an unset cap, does not suppress wakes. The `claude-code` preset still defaults to 25 an hour when the cap is unset.
- Lists pending pairing requests and approves or denies them. An approval from this page is the human decision. The session is the browser cookie from the last 10 minutes. A CLI bearer token does not approve. The claimed name, alias, and card URL are shown as the requester sent them. A private address is text, not a link. A claim shaped like a token is left blank. Times are labeled UTC. A token from pairing shows its code.
- Lists inbound peers. Revoking one asks for confirmation. Lists outbound peers. An empty list notes that peers the CLI added locally are not shown.
- Lists MCP connectors. Revoking one asks for confirmation and a sign-in from the last 10 minutes.
- Shows a message log of recent history. Reading it does not mark tasks seen.
- Offers a SQL download. It is the same tables as `export`, then redacted so stored token hashes do not authenticate. Ciphertext, push tokens, re-pair hashes, requester IP addresses and countries, OAuth codes, the approval-password hash, password-setup hashes, and OpenID Connect sign-in rows are left out. A pasted hosted owner token is replaced. That file is not a backup. `npx -y a2a-exposed@latest export` with the owner token is the full dump.
- Rotates the owner token after a confirmation and a sign-in from the last 10 minutes. The new token is shown once on that agent's page. The previous one stops working when the tenant has stored the new hash. A push the tenant did not store leaves the previous token in place. The token is shown only when the stored hash is still that token.
- Deletes the agent after the name is typed and a sign-in from the last 10 minutes. The page says what is removed and points at the redacted export or `export` first. The hostname is marked deleted so it stops routing, that tenant's storage is wiped, and the control-plane row is removed last, which frees the agent-limit slot. A config flush cannot put that agent back. A new agent may reuse the name. A retry finishes a delete that stopped part way. A self-hosted inbox has no such delete.

When the sign-in is older than 10 minutes, the page says so before approve, deny, revoke, rotate, or delete. The sign-in link returns to that agent. Those posts stay on this origin. The account is checked before any owner call.

`pair approve` on the owner HTTP API is unchanged: while pairing approval is human, that call is refused. In agent mode it is still the agent's decision.

## Cloudflare setup

A signed-in account opens `/app/cloudflare`. The page asks what you want, in plain language: give the agent a public A2A address (it receives messages and is woken by webhook), make an agent that already speaks A2A reachable, or both. Technical names (inbox, façade, Cloudflare Tunnel) are secondary hints. It then asks which web address: a free Cloudflare address such as `my-agent.yourname.workers.dev`, or a domain already on the Cloudflare account such as `agent.example.com`.

The next page names the Cloudflare permissions that choice needs, and only then sends the browser to Cloudflare. The consent asks for those scopes plus `user-details.read`. `offline_access` is included so a refresh token can be kept. A workers.dev inbox does not ask for Zone Read, DNS Write, or Workers Routes Write. A façade asks for Cloudflare Tunnel Write. Access is not requested.

Choosing on this page does not need a fresh sign-in. Continue to Cloudflare, which grants access, and disconnect do: the sign-in has to be from the last 10 minutes. An older session is sent to sign in again. The page says "For your security, please sign in again to change your Cloudflare connection." That same action continues after sign-in. The account and setup pages do not show this before the click.

The account page says "Lets Inbox set things up in your Cloudflare account. It isn't used to sign in." An overlay brand name replaces Inbox. The callback stores the Cloudflare account id and the latest refresh token encrypted with `AUTH_SECRET`. It does not store the access token. Cloudflare treats that refresh token as single-use: a later refresh replaces the stored one, and a rejected refresh drops it. A timeout keeps the stored token and does not try again. If an optional permission was declined, the page says which setup that blocks.

When the grant can create an inbox, the same page asks for a name and creates it in that Cloudflare account: a D1 database, the inbox Worker, and the public address. A free address is `https://<name>.<account>.workers.dev`. If the account has no workers.dev name yet, the page asks for one. Your own domain asks for a hostname that is already on a domain in that account, then attaches the Worker there. The owner token is shown once. The account page links to that address. A second create does not make another inbox. Creating it needs a sign-in from the last 10 minutes, the same gate as Continue to Cloudflare. Tests call a stub of the Cloudflare API. A live account is not part of those tests.

A connection for an agent you already run is not created. That still needs cloudflared on a machine you control, and this page does not start it. `npm run build` and `npm run deploy` bundle the inbox Worker and its migrations into static assets. Those files are not committed. Apply control D1 migration `0011_cloudflare_inbox` (`npm run deploy` applies it).

A Cloudflare callback that is not that consent, including one with no session, returns to `/app` and creates no session. An unlinked Cloudflare sign-in creates no account and says "Sign in another way first, then connect Cloudflare from your account." Disconnect is on the account page and deletes the saved refresh token. Apply control D1 migration `0010_cloudflare_grant` (`npm run deploy` applies it). Rotating `AUTH_SECRET` makes a saved refresh token unreadable. The account connects again.

Token and profile requests stop after 5 seconds. The callback deadline aborts one that is still running. The connect button stays off when `CLOUDFLARE_OAUTH_CLIENT_ID` or `CLOUDFLARE_OAUTH_CLIENT_SECRET` is unset. When the client id is set, deploy passes `secrets.env` as `cf deploy --secrets-file secrets.env`. A missing file, or a file that does not set `CLOUDFLARE_OAUTH_CLIENT_SECRET`, does not deploy, and the secret is not printed.

The email from the Cloudflare user API is not verified, so it does not match `SIGNUP_ALLOWLIST` and does not auto-link.

## Feedback routes

`POST /api/feedback` and `/app/feedback` stay 404 until `FEEDBACK_REPO` is set and either the GitHub App or `FEEDBACK_GITHUB_TOKEN` is set. Field rules, labels, and the public-issue warning are in [Feedback](feedback.md). Apply control D1 migration `0009_feedback_rate`.

A hosted data plane sets `FEEDBACK_URL` to the control origin (https, no path). Only a hosted tenant posts feedback there. `GET /owner/feedback` then returns that URL, plus this Worker's version and connection (`webhook`, `proxy`, or `polling`). Any other value is ignored. Unset, `feedback` and `send_feedback` print a GitHub issue link.

## Multi-tenant settings

The Worker can run as one tenant per deployment, which is what `init` sets up, or as a host that routes many tenants. Every gate is optional. Unset means a single-tenant inbox on D1. `init` does not set any of them.

| Setting | Unset | When set |
| --- | --- | --- |
| `TENANCY` | One tenant, config from the Worker env | `host` selects the multi-tenant entry. Storage changes only together with the `TENANT_DO` binding. On its own the Worker still uses `OWNER_TOKEN` and `env.DB` |
| `TENANT_SECRETS_KEY` | Unused | Hosted tenant peer-token keys, and the key that seals wake secrets, are derived from this secret and the tenant id, not from `OWNER_TOKEN`. The control plane uses the same secret to seal a wake key. The tenant object decrypts it |
| `TENANT_DOMAIN` | Unused | Parent domain. A tenant is `https://<name>.<domain>` (one label, 4–32 characters). The apex is not a tenant |
| `TENANT_DIRECTORY` | Unused | KV map of tenant name to id, status, region, and version. Unknown names are 404 before a Durable Object is created. Cached 60 seconds in the isolate |
| `TENANT_DO` | Unused | With `TENANCY=host`, each tenant is one SQLite Durable Object. The Worker config adds this binding only when `TENANCY=host`. Config is pushed into the object (`pushConfig`). A push with an older version is ignored. An object with no config answers 404 and writes nothing |
| `DATA_REGION` | Cloudflare's default placement | `eu` or `fedramp`. The first time a directory entry has no region, that value (or `default`) is written onto the entry. Later requests read the stored region, so changing this setting does not move a tenant |
| `WAKE_TARGET_POLICY` | Any URL the operator set. Redirects are followed | `public-https`: https only, no credentials in the URL, and the host must not be private, loopback, link-local, CGNAT, or a name that resolves to one of those. The socket opens to an address from that check, and TLS names the hostname. A redirect is followed only on the same origin. A `*.workers.dev` target cannot be opened. Any other value is treated as unset |
| `QUOTAS`, `USAGE_SINK`, `SIGNUP_URL`, `BRANDING` | Off | Parsed onto the tenant context. They do not change requests |
| `APPROVAL_OIDC_ISSUER`, `APPROVAL_OIDC_CLIENT_ID`, `APPROVAL_OIDC_ALLOWED_SUBJECTS`, `APPROVAL_OIDC_CLIENT_SECRET`, `APPROVAL_METHODS` | Password only. `/device` and the MCP consent page are unchanged | OpenID Connect when the issuer is https, the client id and Worker secret are set, and at least one allowed `sub` or `email` is listed. Authorization code plus PKCE, scopes `openid` and `email`. The return checks issuer, audience, nonce, expiry, and the allowlist (RS256). A `sub` match is enough. An `email` match needs `email_verified` true. Several audiences, or any `azp`, require `azp` to be this client id. `APPROVAL_METHODS=oidc` hides the password once that config is complete. `APPROVAL_METHODS=password` keeps the password page even if an issuer is set. Unset methods with a complete config offers both. `pair set-oidc` stores the non-secrets. The client secret comes from the environment or stdin and is not written to `config.env`. In hosted mode these fields come from the tenant's pushed `approval` object, not from the Worker's `APPROVAL_OIDC_*` |
| `A2A_CONTROL_SERVICE` | OpenID Connect uses `fetch` | Name of the control Worker, bound as `CONTROL_SERVICE`. Discovery, the token request, and JWKS for an issuer on this tenant's zone use that binding, with Host set to the issuer host. Any other issuer still uses `fetch`. A call that does not finish within 5 seconds returns the unreachable page. Leave this unset on a self-hosted inbox |
| `FEEDBACK_URL` | Ignored | See [Feedback routes](#feedback-routes) |
| `A2A_BACKUP_BUCKET` | No backup bucket and no daily snapshot cron | `1` adds an R2 binding `BACKUP_BUCKET` and a daily cron (`0 3 * * *`) that writes each inbox as SQL, kept 30 days. Self-host writes `tenants/self/`. Hosted writes one object per active tenant. Optional `A2A_BACKUP_BUCKET_NAME`. `DATA_REGION=eu` or `fedramp` sets the bucket jurisdiction. The minute wake cron (`A2A_ENABLE_CRON`) is a separate trigger |

With `TENANCY=host`, debounced wakes (including a window longer than the in-request wait) and the housekeeping the minute cron does run from a Durable Object alarm on that tenant. `A2A_ENABLE_CRON` still flushes the self-host `env.DB`. The daily snapshot cron, when the backup bucket is set, runs first and does not flush.

Names and example values are in `worker/deploy.env.example`.
