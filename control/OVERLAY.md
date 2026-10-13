# Control Worker

This directory is the control library and a Worker. The Worker serves `/health`, `GET` and `POST /api/feedback` when `FEEDBACK_REPO` and `FEEDBACK_GITHUB_TOKEN` are set, and the static files in `public/`. The owner pages for an inbox (`/` and `/device`) are on the inbox Worker. The multi-tenant dashboard is [a2a.exposed](https://a2a.exposed), built on `@a2a-exposed/control-core`. A hostname that still serves sign-in, OpenID Connect, the dashboard, and `/api/v1/tenants` deploys tag `v0.7.33`. The steps are in [Migrating](../docs/upgrading.md#migrating).

A control-plane app imports the published module `@a2a-exposed/control-core`. The source entry is `src/core/index.ts`. In the same Cloudflare account, point that app at the existing control D1 database and it reads the same user, grant, and tenant rows. The repository page for operators, including an existing deployment, is `docs/control-plane.md`.

`npm run deploy` applies `migrations/` when `CONTROL_D1_ID` or `CONTROL_D1_NAME` is set, then runs `cf deploy`. D1 is Cloudflare's SQLite database.

`BRAND_NAME`, when set, is the name on the shell page. The default name is Inbox.
