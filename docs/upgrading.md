# Upgrading

History of each release is in [CHANGELOG.md](../CHANGELOG.md). This page is how to move a running inbox onto the current CLI.

## After a new CLI

```bash
npx -y a2a-exposed@latest deploy
```

`deploy` copies the current Worker template and applies every D1 migration that is not yet recorded in `d1_migrations`, in numeric order. Secrets already on the Worker stay. With a global install, run `npm i -g a2a-exposed@latest` first. A global copy does not upgrade itself.

The CLI prints a one-line notice when a newer version is on npm, at most once a day. `A2A_NO_UPDATE_CHECK=1` or `DO_NOT_TRACK=1` turns it off.

The config directory is `~/.config/a2a-exposed`, or `$XDG_CONFIG_HOME/a2a-exposed`, or `A2A_CONFIG_DIR`. A directory named `a2a-over-webhook` is not read. If your config is still there, copy it to `~/.config/a2a-exposed` (chmod 600) and then `deploy`.

New peer tokens use the `a2aow_` prefix. A token issued with the `s2a_` prefix still authenticates: only the hash is stored.

## An inbox deployed before this CLI

There is no `adopt` command. To keep an existing Worker, its D1 data, peer tokens, and wake secrets:

1. Back up D1 first. Export the tables you need, and note the time-travel bookmark (`npx cf d1 time-travel get-bookmark <db-id>`).
2. Write `config.env` yourself (chmod 600) with `CLOUDFLARE_ACCOUNT_ID`, `A2A_WORKER_NAME`, `A2A_D1_NAME`, `A2A_D1_ID`, `A2A_HOSTNAME` (for workers.dev, leave the hostname out and set `A2A_WORKERS_DEV_SUBDOMAIN`), `A2A_BASE_URL`, the existing owner token as `A2A_OWNER_TOKEN`, and the agent-card settings (`A2A_AGENT_NAME`, `A2A_AGENT_DESCRIPTION`, and the others you use). With `A2A_D1_ID` set, the saved hostname is not treated as a move.
3. Run `npx -y a2a-exposed@latest deploy --preset <preset>` with no `WAKE_*` or `UPSTREAM_*` variables exported. `deploy` uploads no secrets file when none are exported, so `OWNER_TOKEN` and the wake secrets already on the Worker are kept. It prints the migrations it applied.
4. Run `status`. The card should show the existing name and base URL. Continue from the `next step:` line.
5. Pairing is on after that deploy, with human approval. Run `pair set-password --web`, or deploy with `--pairing-approval off` to keep tokens manual only.

Current Worker migrations, applied when missing: `0001_init`, `0002_wake_budget`, `0003_device_pairing`, `0004_pairing_replace`, `0005_facade_owners`, `0006_mcp`, `0007_cimd`, `0008_oidc_txns`. A file that is already recorded is not run again. A lower number that was added later still runs if it is not recorded.

If `pair` returns HTTP 500, or peers get `-32603` and the Worker log says `no such table: wake_budget`, run `deploy`. That applies the missing migration.

Moving between a custom hostname and workers.dev is `deploy --workers-dev` or `deploy --hostname <host>`. See [Self-hosting](self-hosting.md).

## An existing control deployment

The inbox upgrade above stays the same. Accounts, sign-in, and the dashboard are on [a2a.exposed](https://a2a.exposed). A human signs in there. The control D1 database stays, and the hosted app, or your own app on `@a2a-exposed/control-core`, reads the same user, grant, and tenant rows. The steps are on the [control plane](control-plane.md#an-existing-control-deployment) page.

## Hosted agents

On [a2a.exposed](https://a2a.exposed), rotate the owner token, delete the agent, or download a redacted SQL copy from the agent page. `npx -y a2a-exposed@latest export` with the owner token is the full dump.

Point-in-time restore of one hosted tenant is `bookmarkForTime` / `restoreBookmark` on that tenant's Durable Object, when the storage runtime provides bookmarks. `restoreBookmark` schedules the bookmark and returns `{ ok: true }`. The object resets on a later turn, after that result is delivered.
