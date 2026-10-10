# Control plane overlay

`control/` is the hosted product's application: dashboard, accounts, and the control API. It is MIT, neutral, and empty until configured. A self-hosted deploy with no environment variables serves a working shell and does not call an identity provider, a mailer, or a billing service.

The public site (name, colours, marketing pages, legal copy) is not in this tree. A private overlay copies three directories onto this one, then prerenders. Dashboard and API code stay here; the overlay does not fork them.

## What the overlay replaces

Apply the overlay before `node scripts/prerender.mjs` (or `npm run build`):

1. **Brand.** Copy the overlay's `brand/` onto `control/brand/`, or set `CONTROL_BRAND_DIR` to that directory. Vite aliases `@brand/*` to it. These files are the seam:
   - `brand.config.ts` exports `brandConfig(env) -> { name, supportEmail, footerLinks, legal }`. `name` comes from `env.BRAND_NAME` in the neutral file. Footer links must be `https:` URLs or paths that start with `/`.
   - `Header.tsx` exports `Header({ name })`.
   - `Footer.tsx` exports `Footer({ name, links })`.
   - `SignInAside.tsx` exports `SignInAside()`.
   - These components are Hono JSX (`hono/jsx`). The Vite config sets that runtime for every TSX file, including a brand directory outside this package.
   - `tokens.css` and `logo.svg`. Prerender copies these two into the asset directory after `public/`, so they win over a file of the same name in `public/`.
2. **Content.** Copy Markdown onto `control/content/`, or set `CONTROL_CONTENT_DIR`. Each `*.md` file has frontmatter `title` and optional `description`. `index.md` becomes `/`. `docs/install.md` becomes `/docs/install` plus a `/docs/install.md` twin. Pages without a title fail the build. An empty `content/` leaves the neutral home page.
3. **Public.** Copy the overlay's `public/` onto `control/public/`. Files in the overlay win. This is how a branded `robots.txt` replaces the neutral one (the neutral file disallows only `/app` and `/api`).

`scripts/prerender.mjs` reads those directories and writes HTML, Markdown twins, `_headers` alternate links, and, when `SITE_URL` is an https origin, `sitemap.xml`. It does not delete pages removed from `content/` when writing into an existing directory. A production build should pass `--out` pointing at an empty directory, then point Vite at it with `CONTROL_PUBLIC_DIR`.

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
| `CONTROL_D1_NAME` / `CONTROL_D1_ID` | Control D1 binding `DB`. Omitted when both are unset. Login needs it. Apply `control/migrations/` with `cf d1 migrations apply`. |
| `CONTROL_DATA_PLANE` | Worker name that exports `TenantStore`. With the directory id, turns on `POST /api/v1/tenants` and a five-minute outbox retry. |
| `CONTROL_TENANT_DIRECTORY_ID` | KV namespace id of the data plane's name directory. The same namespace the inbox reads. |
| `BRAND_NAME` | Name in the shell. Default `Inbox`. |
| `SITE_URL` | https origin used for the sitemap. Omitted when unset. |
| `ISSUER` | OIDC issuer origin. Unused until login is configured. |
| `TENANT_DOMAIN` | Parent domain for tenant hosts. Unused until tenants exist. |
| `DATA_REGION` | `eu` or `fedramp`. Unset: the platform default. |
| `AUTH_SECRET` | Session secret, at least 32 characters. A secret, not a var. Login stays off without it. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth. Both are required. The secret is not a var. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth. Both are required. |
| `CLOUDFLARE_OAUTH_CLIENT_ID` / `CLOUDFLARE_OAUTH_CLIENT_SECRET` | Cloudflare OAuth. Scope is `user-details.read` only. The profile has no verification flag, so this provider does not auto-link. |
| `MAIL_FROM` | Sender address. With the `EMAIL` send binding, turns on email sign-in. |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Optional. Both are required before the widget is shown. |
| `INVITES_REQUIRED` | `1` requires an `invite_` code in `invites` before the first account for an email is created. Unset: anyone who can use a configured provider can sign in. |
| `CONTROL_WORKERS_LOGS` | `1` enables Workers Logs with query strings redacted. |
| `CLOUDFLARE_ACCOUNT_ID` | Account, when the token can see more than one. |

Do not commit account ids, zone names, or hostnames of real deployments. Examples use `example.com`.

Account linking follows the provider's verified-email flag. Better Auth treats a trusted provider as sufficient even when that flag is false, so the trusted-provider list is empty: GitHub links when the matching address is `verified`, Google when `email_verified` is true, and a magic link because it proves the address. Cloudflare's user payload has no verification field, so that provider does not auto-link. The session cookie is `__Host-a2a_session` (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`). An invite for an email sign-in is stored against the hash of that magic-link token, so the link works in another browser. OAuth still carries the invite in `__Host-a2a_invite` for the same browser, because the provider redirect does not include it.

## Static assets and the Worker

`cf` (the same CLI as `worker/`) builds this package. There is no `assets.directory` field: Vite's `publicDir` (`public`, or `CONTROL_PUBLIC_DIR`) is the asset source. On `cf` 1.0.0-beta.13 the runtime shape is:

- `worker.assets.runWorkerFirst`: `string[] | boolean`. Path patterns only. This package lists `/health`, `/app`, `/app/*`, `/api`, `/api/*`, `/.well-known`, and `/.well-known/*` (`src/routing.ts`). A header such as `Accept` cannot be matched.
- `worker.assets.htmlHandling`: `auto-trailing-slash`, so `/docs/install` serves `docs/install/index.html`.
- `bindings.assets()` exposes `env.ASSETS`.
- Custom domains are `worker.domains`. `cf build` records them as a string array on the worker config.
- Extra routes are `triggers.fetch({ pattern, zone? })`. `cf build` records `{ type: "fetch", pattern, zone }` when a zone is set.

`Accept: text/markdown` is handled in Hono when the request already reached the Worker: it fetches the `.md` twin through `env.ASSETS` and sets `Link: rel="canonical"` to the HTML path. Requesting the `.md` URL directly is a static hit and does not invoke the Worker. `/app` and `/api` responses send `X-Robots-Tag: noindex`.

## Migrations

`control/migrations/` will hold append-only numbered SQL for Control D1, same rule as `worker/migrations/`. There are none yet.
