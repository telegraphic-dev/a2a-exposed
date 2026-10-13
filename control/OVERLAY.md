# Worker

This directory is the `@a2a-exposed/control-core` library and a Worker. The Worker serves `/health`, `GET` and `POST /api/feedback` when `FEEDBACK_REPO` and `FEEDBACK_GITHUB_TOKEN` are set, and the static files in `public/`. The owner pages for an inbox (`/` and `/device`) are on the inbox Worker.

An app imports the published module `@a2a-exposed/control-core`. The source entry is `src/core/index.ts`.

`npm run deploy` applies `migrations/` when `CONTROL_D1_ID` or `CONTROL_D1_NAME` is set, then runs `cf deploy`. D1 is Cloudflare's SQLite database.

`BRAND_NAME`, when set, is the name on the shell page. The default name is Inbox.
