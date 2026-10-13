# Control plane

Self-hosters run three things from this repository: the inbox Worker, the CLI, and MCP. The owner pages on that inbox are `/` (the agent card in a browser) and `/device` (approve or deny a pairing request). Accounts, sign-in, and the dashboard are the hosted service at [a2a.exposed](https://a2a.exposed).

A **tenant** is one hosted agent: a name, an inbox, and the config pushed to it. **D1** is Cloudflare's SQLite database. A **zone** is a domain that account hosts on Cloudflare.

## Library

`@a2a-exposed/control-core` is this repository. A control-plane app imports that package and nothing under it. The source entry, `control/src/core/index.ts`, exports:

- tenant create, list, delete, and rotate, wake settings, and the data-plane push
- Cloudflare provisioning: the API calls, the saved OAuth grant, setup scopes, inbox steps, and removal
- `ControlEnv`, the `Sql` type, `routes` (`/health` and `/api/v1/tenants`), and `RUN_WORKER_FIRST`
- the control D1 migrations (`CONTROL_MIGRATIONS`, and `control/migrations/` inside the package)

The published module is the compiled JavaScript and TypeScript declarations from that entry. `prepare` builds it on `npm pack` and on a `file:` install. A `v*` tag publishes the same package to npm. The `a2a-exposed` CLI package is `cli/`.

`configuredFreeAgentLimit` and `accountAgentLimit` read the default number of hosted agents. `FREE_AGENT_LIMIT` on `ControlEnv` is that default. An account's `agent_limit` overrides it. The database trigger enforces the cap on insert.

## Worker in this directory

`control/` is a Worker for health, plain feedback, and static assets. `GET /health` returns `{ ok: true }`. `GET /api/feedback` returns `{ repo }` and `POST /api/feedback` files a public GitHub issue when `FEEDBACK_REPO` and `FEEDBACK_GITHUB_TOKEN` are both set. Field rules are in [Feedback](feedback.md). Apply control D1 migration `0009_feedback_rate` with the deploy below.

From `control/`, `npm run deploy` applies `control/migrations/` to the control D1 database when `CONTROL_D1_ID` or `CONTROL_D1_NAME` is set, then runs `cf deploy`. See [control/OVERLAY.md](../control/OVERLAY.md).

A hosted data plane sets `FEEDBACK_URL` to the control origin (https, no path). `GET /owner/feedback` then returns that URL, plus this Worker's version and connection (`webhook`, `proxy`, or `polling`). With `FEEDBACK_URL` unset, `feedback` and `send_feedback` print a GitHub issue link.

## Multi-tenant inbox settings

The inbox Worker runs as one inbox per deployment, which is what `init` sets up, or as a host that routes many tenants. Every gate is optional. Unset means a single-tenant inbox on D1. `init` leaves these unset.

| Setting | Unset | When set |
| --- | --- | --- |
| `TENANCY` | One inbox, config from the Worker env | `host` selects the multi-tenant entry. Storage changes together with the `TENANT_DO` binding. With only `TENANCY=host`, the Worker uses `OWNER_TOKEN` and `env.DB` |
| `TENANT_SECRETS_KEY` | Unused | Hosted peer-token keys, and the key that seals wake secrets, are derived from this secret and the tenant id. The control plane seals a wake key with the same secret. The tenant object decrypts it |
| `TENANT_DOMAIN` | Unused | Parent domain. A tenant is `https://<name>.<domain>` (one label, 4–32 characters). The apex serves the host |
| `TENANT_DIRECTORY` | Unused | KV map of tenant name to id, status, region, and version. Unknown names are 404 before a Durable Object is created. Cached 60 seconds in the isolate |
| `TENANT_DO` | Unused | With `TENANCY=host`, each tenant is one SQLite Durable Object. The Worker config adds this binding only when `TENANCY=host`. Config is pushed into the object (`pushConfig`). A push with an older version is ignored. An object with no config answers 404 and writes nothing |
| `DATA_REGION` | Cloudflare's default placement | `eu` or `fedramp`. The first time a directory entry has no region, that value (or `default`) is written onto the entry. Later requests read the stored region. A new value applies to tenants created after the change |
| `WAKE_TARGET_POLICY` | Any URL the operator set. Redirects are followed | `public-https`: https only, with the host a public address. The socket opens to an address from that check, and TLS names the hostname. A redirect is followed on the same origin. A `*.workers.dev` target stays closed. Any other value is treated as unset |
| `QUOTAS`, `USAGE_SINK`, `SIGNUP_URL`, `BRANDING` | Off | Parsed onto the tenant context for the dashboard to read |
| `APPROVAL_OIDC_ISSUER`, `APPROVAL_OIDC_CLIENT_ID`, `APPROVAL_OIDC_ALLOWED_SUBJECTS`, `APPROVAL_OIDC_CLIENT_SECRET`, `APPROVAL_METHODS` | Password on `/device` and the MCP consent page | OpenID Connect when the issuer is https, the client id and Worker secret are set, and at least one allowed `sub` or `email` is listed. Authorization code plus PKCE, scopes `openid` and `email`. The return checks issuer, audience, nonce, expiry, and the allowlist (RS256). A `sub` match is enough. An `email` match needs `email_verified` true. Several audiences, or any `azp`, require `azp` to be this client id. `APPROVAL_METHODS=oidc` shows the provider once that config is complete. `APPROVAL_METHODS=password` keeps the password page. Unset methods with a complete config offer both. `pair set-oidc` stores the non-secrets. Deploy uploads `APPROVAL_OIDC_CLIENT_SECRET` when that variable is set in the environment you use for deploy. `--secret-stdin` checks one line and discards it. In hosted mode these fields come from the tenant's pushed `approval` object |
| `A2A_CONTROL_SERVICE` | OpenID Connect uses `fetch`. Self-hosted inboxes leave this unset | Name of the control Worker, bound as `CONTROL_SERVICE`. Discovery, the token request, and JWKS for an issuer on this tenant's zone (the DNS domain Cloudflare hosts) use that binding, with Host set to the issuer host. Any other issuer uses `fetch`. A call that stops within 5 seconds returns the unreachable page |
| `FEEDBACK_URL` | The CLI prints a GitHub issue link | See [Feedback](feedback.md) |
| `A2A_BACKUP_BUCKET` | The inbox keeps its D1 database and skips the daily snapshot | `1` adds an R2 binding `BACKUP_BUCKET` and a daily cron (`0 3 * * *`) that writes each inbox as SQL, kept 30 days. Self-host writes `tenants/self/`. Hosted writes one object per active tenant. Optional `A2A_BACKUP_BUCKET_NAME`. `DATA_REGION=eu` or `fedramp` sets the bucket jurisdiction. The minute wake cron (`A2A_ENABLE_CRON`) is a separate trigger |

With `TENANCY=host`, debounced wakes (including a window longer than the in-request wait) and the housekeeping the minute cron does run from a Durable Object alarm on that tenant. `A2A_ENABLE_CRON` flushes the self-host `env.DB`. The daily snapshot cron, when the backup bucket is set, runs first.

Names and example values are in `worker/deploy.env.example`.
