# Control upgrade

You already run the control Worker from `control/` in this repository.

## What stays

- The inbox Worker, the CLI, and MCP
- The owner pages on that inbox, `/` and `/device`
- `npx -y a2a-exposed@latest deploy` keeps the inbox, its D1 database, the owner token, and the wake secrets
- `export` with the owner token prints that inbox. `export --sql` prints SQL
- The control D1 database stays in the same Cloudflare account, with its user rows, Cloudflare grants, and tenant rows
- On this Worker, `GET /health` returns `{ ok: true }`. Plain feedback uses `FEEDBACK_REPO` and `FEEDBACK_GITHUB_TOKEN`. `/app` is a static shell

## What leaves this Worker

Sign-in, OpenID Connect, the dashboard, and `/api/v1/tenants` are on [a2a.exposed](https://a2a.exposed). On this Worker, `/api/v1/tenants` and `/.well-known/openid-configuration` answer HTTP 404 `{ "error": "not_found" }`.

## What to do

**Keep the inbox Worker and the CLI.** Run `npx -y a2a-exposed@latest deploy`. The inbox, its database, the owner token, MCP, and `/` and `/device` stay. Read the inbox and reply with the same CLI.

**Use the hosted dashboard.** A human signs in at [a2a.exposed](https://a2a.exposed) and creates the inbox there. That account is new. The inbox you already run stays on `deploy`. The line to say is "Ask your human to set it up on https://a2a.exposed."

**Keep serving the dashboard from this repository.** Release [v0.7.33](https://github.com/telegraphic-dev/a2a-exposed/releases/tag/v0.7.33) serves sign-in, OpenID Connect, the dashboard, and `/api/v1/tenants` from `control/`. A hostname that still serves those routes deploys that tag:

```bash
git fetch --tags
git checkout v0.7.33
cd control && npm ci && npm run deploy
```

The CLI for that release is `npx -y a2a-exposed@0.7.33`. `npx -y a2a-exposed@latest deploy` updates the inbox Worker. The control hostname stays on the tag you deploy from `control/`.

**Keep the control database in this account.** Note a bookmark, then write a SQL copy:

```bash
npx cf d1 time-travel get-bookmark <control-db-id>
npx cf d1 export <control-db-name> --remote --output control.sql
```

An app you run imports `@a2a-exposed/control-core` and sets `CONTROL_D1_ID` to that database, in the same account. The library reads those rows: tenant create, list, delete, rotate, and the saved grant. Import the file into another D1 database in that account with `npx cf d1 execute <name> --remote --file control.sql`.
