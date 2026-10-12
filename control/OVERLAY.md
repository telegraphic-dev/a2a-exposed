# Control plane overlay

`control/` is the hosted product's application: dashboard, accounts, and the control API. It is MIT, neutral, and empty until configured. A self-hosted deploy with no environment variables serves a working shell and does not call an identity provider, a mailer, or a billing service.

The public site (name, colours, marketing pages, legal copy) is not in this tree. A private overlay copies three directories onto this one, then prerenders. Dashboard and API code stay here; the overlay does not fork them.

## What the overlay replaces

Apply the overlay before `node scripts/prerender.mjs` (or `npm run build`):

1. **Brand.** Copy the overlay's `brand/` onto `control/brand/`, or set `CONTROL_BRAND_DIR` to that directory. Vite aliases `@brand/*` to it. These files are the seam:
   - `brand.config.ts` exports `brandConfig(env) -> { name, supportEmail, footerLinks, legal, signupClosed }`. `name` comes from `env.BRAND_NAME` in the neutral file. Footer links must be `https:` URLs or paths that start with `/`. `signupClosed` is the sentence shown when `SIGNUP_ALLOWLIST` refuses a sign-in. The neutral file says "Sign-in is invite-only for now."
   - `Header.tsx` exports `Header({ name })`.
   - `Footer.tsx` exports `Footer({ name, links })`.
   - `SignInAside.tsx` exports `SignInAside()`.
   - These components are Hono JSX (`hono/jsx`). The Vite config sets that runtime for every TSX file, including a brand directory outside this package.
   - `tokens.css` and `logo.svg`. Prerender copies these two into the asset directory after `public/`, so they win over a file of the same name in `public/`.
2. **Content.** Copy Markdown onto `control/content/`, or set `CONTROL_CONTENT_DIR`. Each `*.md` file has frontmatter `title` and optional `description`. `index.md` becomes `/`. `docs/install.md` becomes `/docs/install` plus a `/docs/install.md` twin. Pages without a title fail the build. An empty `content/` leaves the neutral home page.
3. **Public.** Copy the overlay's `public/` onto `control/public/`. Files in the overlay win. This is how a branded `robots.txt` replaces the neutral one (the neutral file disallows only `/app` and `/api`).

`scripts/prerender.mjs` reads those directories and writes HTML, Markdown twins, `_headers` alternate links, and, when `SITE_URL` is an https origin, `sitemap.xml`. A build with `SITE_URL` unset deletes a sitemap this script wrote earlier (it carries an `a2a-exposed-sitemap` comment), including one left in the same output directory. A sitemap copied from `public/` or the overlay, with no such comment, stays. It does not delete other pages removed from `content/` when writing into an existing directory. A production build should pass `--out` pointing at an empty directory, then point Vite at it with `CONTROL_PUBLIC_DIR`.

```bash
node scripts/prerender.mjs \
  --content content --brand brand --public public \
  --overlay-public /path/to/overlay/public \
  --out /tmp/control-public --site "$SITE_URL"
```

## Runtime configuration

Every binding is optional and read from the environment in `cloudflare.config.ts`. Unset means off.

| Variable | Effect when set |
| --- | --- |
| `CONTROL_WORKER_NAME` | Worker name. Default `a2a-exposed-control`. |
| `CONTROL_HOSTNAME` | Custom domain. Unset: `workers.dev`. |
| `CONTROL_ROUTE` / `CONTROL_ROUTE_ZONE` | Extra fetch route (`triggers.fetch`). |
| `CONTROL_D1_NAME` / `CONTROL_D1_ID` | Control D1 binding `DB`. Omitted when both are unset. Login needs it. `npm run deploy` applies `control/migrations/` with `cf d1 migrations apply` before `cf deploy`. A failed apply does not deploy. |
| `CONTROL_DATA_PLANE` | Worker name that exports `TenantStore`. With the directory id, turns on `POST /api/v1/tenants` and a five-minute outbox retry. |
| `CONTROL_TENANT_DIRECTORY_ID` | KV namespace id of the data plane's name directory. The same namespace the inbox reads. |
| `BRAND_NAME` | Name in the shell. Default `Inbox`. |
| `SITE_URL` | https origin used for the sitemap. Omitted when unset. |
| `ISSUER` | https origin of this control plane as an OpenID Connect issuer, and the origin Better Auth uses for login on that host. Unset: discovery uses the request origin when it is https and matches `SITE_URL` (or when `SITE_URL` is also unset). A request to a different origin does not publish the document. When `ISSUER` is set, that other origin does not sign in either. |
| `TENANT_DOMAIN` | Parent domain for tenant hosts. Unused until tenants exist. |
| `DATA_REGION` | `eu` or `fedramp`. Unset: the platform default. |
| `AUTH_SECRET` | Session secret, at least 32 characters. A secret, not a var. Login stays off without it. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth. Both are required. The id is a plain var when set. The secret is not a var: put it in a chmod-600 `secrets.env` and pass that file with `cf deploy --secrets-file secrets.env`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth. Both are required. |
| `CLOUDFLARE_OAUTH_CLIENT_ID` / `CLOUDFLARE_OAUTH_CLIENT_SECRET` | Cloudflare OAuth. Both are required. The id is a plain var, bound only when it is set. The secret is not a var. When the id is set, `npm run deploy` passes a chmod-600 `secrets.env` with `cf deploy --secrets-file secrets.env`, the same path as `GITHUB_CLIENT_SECRET`. The file has to set `CLOUDFLARE_OAUTH_CLIENT_SECRET`. A missing file, or a file that does not set it, does not upload, and the secret is not printed. `cf dev` reads it from `.dev.vars`. With the id unset, that file is not required. Scope is `user-details.read` only. Unset: this provider stays off. Cloudflare is connect-only. It is not a sign-in method, it does not match `SIGNUP_ALLOWLIST`, and it does not auto-link. A signed-in account connects it from `/app` with a same-origin post and a sign-in from the last 10 minutes. The page says "Connect Cloudflare" and "Lets <brand> set things up in your Cloudflare account. It isn't used to sign in." The brand is Inbox unless this overlay sets `BRAND_NAME`. The callback stores the Cloudflare account id and does not store the access or refresh token. A callback that is not that connect, including one with no session, creates no session and says "Sign in another way first, then connect Cloudflare from your account." Disconnect is the same post. The token and profile requests each stop after 5 seconds, and the callback deadline aborts one that is still running. |
| `MAIL_FROM` | Sender address. With the `EMAIL` send binding, turns on email sign-in. |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Optional. Both are required before the widget is shown. Browser feedback uses the same check when both are set. |
| `FEEDBACK_REPO` | `owner/repo` that receives feedback issues. With the GitHub App (`FEEDBACK_GITHUB_APP_ID` and `FEEDBACK_GITHUB_APP_PRIVATE_KEY`) or with `FEEDBACK_GITHUB_TOKEN`, turns on `POST /api/feedback` and `/app/feedback`. The app is used when both of its settings are set, including when the token is also set. If both are set and the id is not digits, or the key is not a PEM, the routes stay on and the post answers 502. The token is not used. Neither credential, or a value that is not `owner/name`, and those routes stay 404. A blank app id or a blank private key counts as unset. The form says the report is a public GitHub issue on this repository and not to include confidential information. The agent page then shows hosted and the connection (webhook wake, proxy, or polling, from that agent's `UPSTREAM_URL` or `WAKE_WEBHOOK_URL`) and links to the form with those filled in. |
| `FEEDBACK_GITHUB_APP_ID` | GitHub App id. A plain var, bound as written, including a value that is not digits. With the private key, a non-numeric id answers 502 and does not use `FEEDBACK_GITHUB_TOKEN`. Not a `GITHUB_` name: that prefix is the sign-in OAuth app. |
| `FEEDBACK_GITHUB_APP_PRIVATE_KEY` | PEM private key for that app. A secret, not a var. `BEGIN RSA PRIVATE KEY` (PKCS#1, what GitHub downloads) is converted to PKCS#8 for WebCrypto. `BEGIN PRIVATE KEY` is used as-is. A one-line secret may store newlines as `\n`. A key that does not sign, or a GitHub call that fails, answers 502 and does not log the key, the JWT, or the installation token. |
| `FEEDBACK_GITHUB_APP_INSTALLATION_ID` | Optional installation id. A plain var, bound as written. Unset or blank: the app JWT calls `GET /repos/{owner}/{repo}/installation`. A non-numeric value is still deployed, answers 502, and does not look the installation up. The installation token is cached until a minute before it expires. |
| `FEEDBACK_GITHUB_TOKEN` | Fine-grained token with Issues write on that one repository. A secret, not a var. Used only when the app id or the private key is unset. A set id that is not digits, or a set id with a key that is not a PEM, does not fall back to this token. Deploy does not drop a non-numeric id. Not a `GITHUB_` name: that prefix is the sign-in OAuth app. |
| `INVITES_REQUIRED` | `1` requires an `invite_` code in `invites` before the first account for an email is created. Unset: anyone who can use a configured provider can sign in. |
| `SIGNUP_ALLOWLIST` | Comma-separated exact emails and `*@domain` wildcards, matched case-insensitively against the provider's verified email. `*@example.com` matches `person@example.com` and not `person@sub.example.com`. Unset or empty: sign-in stays open. A non-empty list is checked when the account is created and on every later sign-in, including a magic link and a CLI device session. An address the provider has not verified does not match. Trust is per provider: GitHub uses its `verified` flag, Google uses `email_verified`, and a magic link counts because the link was received. Cloudflare is not a sign-in provider, so its email is not checked against this list. With either Cloudflare variable unset, connect stays off. A refusal returns to `/app?error=invite` and the page says the brand `signupClosed` sentence ("Sign-in is invite-only for now." unless the overlay replaces it). A missing or invalid invite code still says "That invite code is not valid." The addresses for a hosted deploy are set in that deploy, not in this tree. |
| `FREE_AGENT_LIMIT` | Default number of agents per account, a non-negative integer. Unset or empty: no cap. An account's `agent_limit` overrides it. |
| `CONTROL_WORKERS_LOGS` | `1` enables Workers Logs with query strings redacted. |
| `CLOUDFLARE_ACCOUNT_ID` | Account, when the token can see more than one. |

Do not commit account ids, zone names, or hostnames of real deployments. Examples use `example.com`.

Account linking follows the provider's verified-email flag, and only onto an account whose email is already verified. Better Auth treats a trusted provider as sufficient even when that flag is false, so the trusted-provider list is empty. GitHub links when the matching address is `verified`. Google links when `email_verified` is true. A magic link links because it proves the address. Cloudflare is not a sign-in provider. Connecting it stores the Cloudflare account id on the signed-in account and does not store the access or refresh token. A callback that is not a connect from a signed-in session of the last 10 minutes does not create or resume a session. That trust is per provider. GitHub and Google still use their own flags. The session cookie is `__Host-a2a_session` (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`). A CLI signs in at `/app/device` (client id `a2a-cli`). The page shows the code and approves only after the owner types the same code from the terminal. The token is not printed. An invite for an email sign-in is stored against the hash of that magic-link token, so the link works in another browser. OAuth still carries the invite in `__Host-a2a_invite` for the same browser, because the provider redirect does not include it.

## Static assets and the Worker

`cf` (the same CLI as `worker/`) builds this package. There is no `assets.directory` field: Vite's `publicDir` (`public`, or `CONTROL_PUBLIC_DIR`) is the asset source. On `cf` 1.0.0-beta.13 the runtime shape is:

- `worker.assets.runWorkerFirst`: `true` (`src/routing.ts`). Path patterns cannot match `Accept`, so every request runs the Worker. `Accept: text/markdown` is answered from the `.md` twin; anything else the Worker does not handle is `env.ASSETS.fetch`.
- `worker.assets.htmlHandling`: `auto-trailing-slash`, so `/docs/install` serves `docs/install/index.html`.
- `bindings.assets()` exposes `env.ASSETS`.
- Custom domains are `worker.domains`. `cf build` records them as a string array on the worker config.
- Extra routes are `triggers.fetch({ pattern, zone? })`. `cf build` records `{ type: "fetch", pattern, zone }` when a zone is set.

`Accept: text/markdown` is handled in Hono: it fetches the `.md` twin through `env.ASSETS`, sets `Vary: Accept`, and sets `Link: rel="canonical"` to the HTML path. A quality of zero (`text/markdown;q=0`) is ignored. A request that does not accept Markdown falls through to the asset, and that response also sends `Vary: Accept`, so a cache cannot reuse the HTML body for a Markdown request. `/app` and `/api` responses send `X-Robots-Tag: noindex`.

## Migrations

`control/migrations/` is append-only numbered SQL for Control D1, same rule as `worker/migrations/`. Add a new numbered file; do not edit an old one. `npm run deploy` applies every file not yet recorded in `d1_migrations`, in numeric order, and then runs `cf deploy`. When `CLOUDFLARE_OAUTH_CLIENT_ID` is set, that deploy passes `secrets.env` with `--secrets-file`, and a missing file or secret does not upload. The database argument is `CONTROL_D1_ID`, or `CONTROL_D1_NAME` when the id is unset. The Cloudflare connect insert needs the unique index in `0008_account_provider.sql`. That file first drops an extra row for the same provider and account id, keeping the earliest, so an existing duplicate does not stop the migration. The user row stays. That apply finishes before the new Worker is uploaded. With `CONTROL_D1_ID` and `CONTROL_D1_NAME` both unset, deploy skips this step. A direct `cf deploy` does not apply migrations. `0009_feedback_rate` counts `POST /api/feedback` per address, and per owner token when the bearer matches `tenants.owner_token_hash`. Any other bearer stays on the address bucket. Without that table, a configured feedback endpoint answers 503.
