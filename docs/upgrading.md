# Upgrading

History of each release is in [GitHub Releases](https://github.com/telegraphic-dev/a2a-exposed/releases). This page is how to move a running A2A endpoint onto the current CLI.

`status` reports the deployed Worker version and CLI version. An older Worker, including one whose `/health` has no `version`, produces a deploy next step and exit code 1. Unreachable health reports an unknown version. Cached npm latest can add an upgrade hint without a foreground registry request. Deploy sets the Worker version tag `a2a-exposed-<version>` and message `a2a-exposed <version> <ISO date>`.

## After a new CLI

```bash
npx -y a2a-exposed@latest deploy
```

`deploy` copies the current Worker template and applies every D1 migration that is not yet recorded in `d1_migrations`, in numeric order. Secrets already on the Worker stay, including the owner token. The pages `/` and `/device` stay. `export` prints the A2A endpoint; `export --sql` prints SQL. With a global install, run `npm i -g a2a-exposed@latest` first. A global copy does not upgrade itself.

The CLI prints a one-line notice when a newer version is on npm, at most once a day. `A2A_NO_UPDATE_CHECK=1` or `DO_NOT_TRACK=1` turns it off.

The config directory is `~/.config/a2a-exposed`, or `$XDG_CONFIG_HOME/a2a-exposed`, or `A2A_CONFIG_DIR`.

New peer tokens use the `a2aow_` prefix. Only the hash is stored.

## Sender upgrade

Senders should label each message for the peer's wake routing. The CLI and MCP `send` have taken `--intent` / `intent` (and `--wake` / `wake`) since v0.8.49. CLI `reply` now takes the same flags, and the MCP `reply` tool already does.

1. Use the current CLI: `npx -y a2a-exposed@latest`.
2. Reconnect the MCP client so it reads the current `send` and `reply` tool descriptions.
3. Refresh the official skill: `npx skills add telegraphic-dev/a2a-exposed`.
4. Set `intent` on every send and every reply, and `wake` only when the `auto` default is wrong.

Both fields stay optional. A message without them is still accepted and still wakes the peer. Set `intent` anyway, so the peer's `WAKE_ROUTING=shadow` counts, and a later `enforce`, can classify your traffic. See [Protocol](protocol.md#wake-routing).

## Key-based wake presets

Since v0.8.56, `grok-bot`, `claude-code`, `openclaw-wake` and `openclaw-agent` need `WAKE_WEBHOOK_KEY`, and `hermes` needs `WAKE_HMAC_SECRET`, as `mausbot` and `openbot` already did. If one of these presets is saved without its credential, the upgraded Worker no longer sends the wake: it logs `wake_render_failed`. Before, it sent the wake and the receiver refused it with a 401. A hosted save of such a preset without its credential is refused with error `key`.

1. Run `wake preview`. It names the missing setting.
2. Export the credential from protected storage and run `wake set` again. Hosted: pass `--key-file` or `--key-env` (`--hmac-secret-file` or `--hmac-secret-env` for `hermes`). Switching a hosted agent to a key-based preset needs the key again.
3. Run `wake test`.

`generic` keeps optional authentication. Turning a wake off needs no key. See [Presets](receiving-messages.md#presets).

## Adopt an existing Worker

To keep an existing Worker, its D1 data, peer tokens, and wake secrets:

1. Back up D1 first. Export the tables you need, and note the time-travel bookmark (`npx cf d1 time-travel get-bookmark <db-id>`).
2. Write `config.env` yourself (chmod 600) with `CLOUDFLARE_ACCOUNT_ID`, `A2A_WORKER_NAME`, `A2A_D1_NAME`, `A2A_D1_ID`, `A2A_HOSTNAME` (for workers.dev, leave the hostname out and set `A2A_WORKERS_DEV_SUBDOMAIN`), `A2A_BASE_URL`, the existing owner token as `A2A_OWNER_TOKEN`, and the agent-card settings (`A2A_AGENT_NAME`, `A2A_AGENT_DESCRIPTION`, and the others you use). With `A2A_D1_ID` set, the saved hostname is not treated as a move.
3. Run `npx -y a2a-exposed@latest deploy --preset <preset>` with no `WAKE_*` or `UPSTREAM_*` variables exported. `deploy` uploads no secrets file when none are exported, so `OWNER_TOKEN` and the wake secrets already on the Worker are kept. It prints the migrations it applied.
4. Run `status`. The card should show the existing name and base URL. Continue from the `next step:` line.
5. Pairing is on after that deploy, with human approval. Run `pair set-password --web`, or deploy with `--pairing-approval off` to keep tokens manual only.

Current Worker migrations, applied when missing: `0001_init`, `0002_wake_budget`, `0003_device_pairing`, `0004_pairing_replace`, `0005_facade_owners`, `0006_mcp`, `0007_cimd`, `0008_oidc_txns`, `0009_outbound_seen`, `0010_conversation_peer`, `0011_conversation_owner`, `0012_conversation_peer_owner`, `0013_reply_delivery`, `0014_peer_address`, `0015_outbound_source`, `0016_wake_busy`, `0017_wake_routing`. A file that is already recorded is not run again. A lower number that was added later still runs if it is not recorded. `0014_peer_address` adds nullable columns, so existing peer tokens keep working. `0016_wake_busy` adds a nullable `busy_until_ms` column on `wakes`, so existing wake rows keep working. `0017_wake_routing` adds routing counters and a dedup fingerprint table. Existing messages and wakes stay in place.

If `pair` returns HTTP 500, or peers get `-32603` and the Worker log says `no such table: wake_budget`, run `deploy`. That applies the missing migration.

Moving between a custom hostname and workers.dev is `deploy --workers-dev` or `deploy --hostname <host>`. See [Self-hosting](self-hosting.md).
