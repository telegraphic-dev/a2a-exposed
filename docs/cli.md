# CLI

Node 22.18+, zero dependencies. Nothing needs a global install:

```bash
npx -y a2a-exposed@latest --help
npx -y a2a-exposed@latest --version
npx -y a2a-exposed@latest <command>
```

Optional on your own machine: `npm i -g a2a-exposed@latest`, then `a2a-exposed <command>`. Re-run the install to upgrade. See [Upgrading](upgrading.md).

Config is `~/.config/a2a-exposed/config.env` (chmod 600), or `$XDG_CONFIG_HOME/a2a-exposed`. Override the directory with `--config-dir` or `A2A_CONFIG_DIR`. Environment variables override the file. `config` prints the file with secrets masked. `url` prints the public base URL and exits 1 when none is configured.

From a checkout: `node <checkout>/cli/bin/a2a-exposed.mjs <command>`.

## Setup

Needs a Cloudflare login (`npx cf auth login --no-browser`). On a VPS where that returns HTTP 403 before a code, export `CLOUDFLARE_API_TOKEN`. The hosted A2A endpoint is open to everyone: [Getting started](getting-started.md#hosted-inbox). See [Self-hosting](self-hosting.md).

### `init` and `deploy`

`init` deploys the Worker and D1. `deploy` redeploys with the saved settings. Secrets already on the Worker stay, unless you export new values.

```text
init [--hostname <host> | --workers-dev [--workers-dev-subdomain NAME]]
     [--agent-name N] [--agent-description D] [--agent-skills JSON]
     [--provider-organization O --provider-url U]
     [--preset P] [--worker-name W] [--d1-name D]
     [--account-id ID] [--cf-profile NAME] [--cli-command CMD]
     [--debounce S] [--max-per-hour N]
     [--pairing-approval human|agent|off] [--pbkdf2-iterations N]
     [--workers-logs on|off] [--mcp on|off] [--cron] [--rotate-owner-token]
     [--upstream URL [--upstream-card-url URL] [--upstream-token-stdin | --no-upstream-token]]
     [--worker-dir DIR] [--tunnel]
```

| Flag | Effect |
| --- | --- |
| `--hostname` | Custom domain. Omit it and the Worker is served on `https://<worker>.<account subdomain>.workers.dev` |
| `--workers-dev` | Move an existing custom-domain deployment to workers.dev. `--hostname` moves it back. The old URL answers 301 (the card) or 410 |
| `--workers-dev-subdomain` | Register the account's workers.dev subdomain when it has none |
| `--preset` | `grok-bot`, `claude-code`, `openclaw-wake`, `openclaw-agent`, `hermes`, or `generic` |
| `--worker-name` | Worker name. Also the default D1 name |
| `--d1-name` | D1 database to create or reuse |
| `--account-id` | When the login can see more than one account |
| `--cf-profile` | Named `cf` auth profile. Saved and used by later `cf` calls |
| `--cli-command` | Command shown in wake hints. Default `npx -y a2a-exposed@latest`. Saved as `WAKE_CLI_COMMAND` |
| `--debounce` | Wake debounce in seconds. `claude-code` defaults to 20. Others default to 10 |
| `--max-per-hour` | Hourly cap. `0` or unset is unlimited, except `claude-code`, which defaults to 25 when unset |
| `--pairing-approval` | `human` (default), `agent`, or `off` |
| `--pbkdf2-iterations` | Approval-password cost, 50000–100000. Default 100000. Lower it only if `/device` hits Cloudflare error 1102 |
| `--workers-logs` | `on` enables persisted Workers Logs. Query strings are redacted. Default off |
| `--mcp` | `on` (default) or `off`. Remote MCP at `<url>/mcp`. Proxy mode has none |
| `--manage-url` | https dashboard page (`MANAGE_URL`). A pairing wake, the MCP inbox line, `pair list`, and `inbox` include it. `none` clears it |
| `--event-url` | https URL that receives a signed pairing event (`EVENT_URL`). `none` clears it. The post also needs `EVENT_SECRET` |
| `--event-secret-stdin` | Read `EVENT_SECRET` from stdin and upload it on this deploy. A hidden prompt on a terminal. The value stays out of `config.env` and out of the command output. Or export `EVENT_SECRET` |
| `--cron` | One-minute cron that flushes pending wakes |
| `--upstream` | Public façade. `none` switches back to the A2A endpoint. See [Self-hosting](self-hosting.md#public-facade) |
| `--upstream-card-url` | Upstream card. Must be on the `--upstream` origin |
| `--upstream-token-stdin` | Read `UPSTREAM_TOKEN` from stdin |
| `--no-upstream-token` | The upstream checks no bearer. Saved |
| `--worker-dir` | Where the Worker project copy lives. Default `<config dir>/worker`. `--dir` is the same flag |
| `--tunnel` | On `init` only: deploy, then `tunnel create` |
| `--rotate-owner-token` | On `init`: replace the owner token. Other settings come from `config.env`. Then update `A2A_OWNER_TOKEN` wherever this A2A endpoint is called, and run `peers sync` |

Wake secrets are read from `WAKE_WEBHOOK_URL`, `WAKE_WEBHOOK_KEY`, and `WAKE_HMAC_SECRET`. They are never arguments.

### `wake`

| Command | Effect |
| --- | --- |
| `wake set` | Save wake settings, upload secrets from the environment, redeploy. Flags: `--preset`, `--agent-id`, `--key-header`, `--key-prefix`, `--body-template`, `--cli-command`, `--debounce`, `--max-per-hour` |
| `wake preview` | Rendered request with credentials masked, plus SHA-256 fingerprints. Export `WAKE_WEBHOOK_URL`, `WAKE_WEBHOOK_KEY`, and `WAKE_HMAC_SECRET` in this shell. `match` means the exported value is the one on the Worker. `DIFFERENT` means they differ: the variable is absent from this shell, or the upload is still propagating (about 15 to 40 seconds after `wake set`, `wake unset`, or `tunnel create`). Wait about 30 seconds and run it again |
| `wake fingerprint` | Fingerprints of `WAKE_*` exported in this shell |
| `wake test` | Send a test wake and print the HTTP status |
| `wake unset` | Remove wake secrets. The agent polls |

### `tunnel`

For a webhook that only listens locally. Needs Zero Trust and a zone on the account. The A2A endpoint can be on workers.dev.

| Command | Effect |
| --- | --- |
| `tunnel create` | Named tunnel, proxied DNS, and an Access app that admits one service token. The tunnel, the Access app, and the service token are named `a2a-exposed wake <worker>`. The DNS host is `wake-<word>-<word>-<4 hex>.<zone>` unless `--tunnel-hostname` is set. A finished tunnel creates nothing when you run it again. A partial tunnel stops and asks for `tunnel rm`. Prints the Access application name and ids, and `tunnel rm` as the undo. Export `WAKE_WEBHOOK_KEY` (hermes: `WAKE_HMAC_SECRET`). The connector machine needs [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/). Flags: `--tunnel-zone`, `--tunnel-hostname`, `--tunnel-origin`, `--tunnel-path`, `--show-token`, `--zero-trust-org`, `--dir`, `--worker-dir`. Secrets show up in about 15 to 40 seconds. Wait about 30 seconds and check again |
| `tunnel status` | Tunnel, Access, and Worker state, plus probes. A network error says DNS may still be propagating; retry in 30 seconds. An `inactive` tunnel reads as `never connected`. The Access warning appears only for an HTTP response other than 401 or 403 |
| `tunnel rm` | Prints each removed object: DNS record, tunnel, Access app, and service token (named `a2a-exposed wake <worker>`), plus Worker secrets `WAKE_ACCESS_CLIENT_ID`, `WAKE_ACCESS_CLIENT_SECRET`, `WAKE_WEBHOOK_KEY`, and `WAKE_HMAC_SECRET`. `WAKE_WEBHOOK_URL` goes too when it is this tunnel's. If the tunnel is already gone, the saved ids are cleared. With nothing saved, prints `nothing to remove`. A missing Worker (Cloudflare error 10007) is already gone |

### `status`, `upstream`, `url`, `config`

| Command | Effect |
| --- | --- |
| `status [--json]` | Deployment, base URL, agent card, wake mode (webhook, tunnel, or none), tunnel state, and in proxy mode the upstream card, Access credential, upstream bearer, live check, last failed peer call, and a card-leak check. Warns when a peer-token variable shadows a saved token. When `GET /owner/mcp` reports enabled and the agent card is reachable, prints `claude mcp add --transport http a2a-exposed <base URL>/mcp`. Prints the next step. With nothing deployed, that step says to run `init`. Exit 1 means something is broken. For about a minute after `tunnel create`, while the connector reports 0 connections, the next step says `waiting for the connector to connect`, tells you to start `cloudflared tunnel run --token-file …` now, and the exit code stays 0. After that, 0 connections is broken. A tunnel status of `inactive` reads as `never connected`. Wake settings from `wake set`, `wake unset`, and `tunnel create` show up in `wake preview` in about 15 to 40 seconds. Wait about 30 seconds and check again. Read-only, except the no-op upstream probe in proxy mode |
| `upstream verify [--json]` | Proxy mode only. Exit 1 unless the A2A app answered. `status` runs the same check |
| `url` | Public base URL |
| `config` | Masked config and its path. `A2A_TUNNEL_TOKEN_FILE` is printed as its path. `A2A_TUNNEL_SECRETS_AT` is printed as its value |

## Remove

| Command | Effect |
| --- | --- |
| `uninstall [--yes] [--dry-run] [--dir DIR \| --worker-dir DIR]` | Remove the Worker, the wake tunnel when one is saved, and the D1 database. Prints the plan first. `--dry-run` prints the plan and changes nothing. Asks first; off a terminal, pass `--yes`. An empty config exits 1 with `nothing is deployed from <config dir>`. The config directory stays: the owner token and `WAKE_*` values stay, and a later `init` reuses the owner token. `--dir` and `--worker-dir` are the Worker project directory (default `<config dir>/worker`). See [Self-hosting](self-hosting.md#remove-an-inbox) |

## Inbox

The owner token authenticates these commands.

| Command | Effect |
| --- | --- |
| `inbox [--context C] [--all] [--json]` | Unhandled inbound tasks. Peer text is untrusted. Then pending pairing requests, including the dashboard URL when `MANAGE_URL` is set. With `--json`, tasks go to stdout and requests to stderr |
| `show <taskId>` | Full task JSON |
| `working <taskId>` | Mark the task `working` |
| `reply <taskId> (--text T \| --stdin) [--state completed\|input-required\|rejected\|failed\|working] [--artifact] [--artifact-name N] [--force]` | Reply. Default state is `completed` |
| `history <contextId> [-n 50] [--json]` | Conversation log |
| `contexts` | Recent conversations |
| `export [--sql]` | JSON dump (`GET /owner/export`). `--sql` prints the same tables as SQL. The read is one transaction. Peer-token hashes and encrypted outbound peer tokens are in the dump. The owner token stays a Worker secret |

## Pairing

| Command | Effect |
| --- | --- |
| `connect <url> [--alias A] [--name N] [--card-url URL] [--replace] [--no-wait] [--json]` | Ask another A2A endpoint for a token. Prints a code and a link. The code lasts 60 minutes. Stores the token and does not print it. `--no-wait` prints the code and exits; run the same command again to check. An expired code exits 1 and does not request a new one silently. An alias whose token still works is refused unless `--replace`. A `*.ts.net` or LAN card is informational. A non-https card is left out |
| `pair set-password --web [--ttl MIN] [--json]` | One-time link where a human sets the approval password. `--ttl` is 1 to 60 minutes (default 15). A new link invalidates the previous one |
| `pair set-password` | The same, in a terminal, no echo. The human types the password there |
| `pair set-oidc --issuer URL --client-id ID --subjects SUB[,SUB...] [--methods password,oidc] [--secret-stdin]` | Optional OpenID Connect on `/device` and the MCP consent page. Deploy uploads `APPROVAL_OIDC_CLIENT_SECRET` only when that variable is set in the environment you use for deploy. `--secret-stdin` checks one line and discards it. `config.env` keeps the issuer and client id |
| `pair list [--json]` | Pending requests, the approval mode, when the password was set, and the dashboard URL when `MANAGE_URL` is set |
| `pair approve <code>` | Approves with the owner token. In human mode the decision is the owner's. In agent mode, run it only after the human says yes |
| `pair deny <code>` | Any mode. On `/device`, deny needs no password |

## Tokens and outbound peers

| Command | Effect |
| --- | --- |
| `token issue <label>` | Print a new peer token once. Fails if the label is active. Manual fallback to `connect` |
| `token rotate <label>` | Replace that label's token |
| `token list` | Labels, how each was created (pairing code and date), and MCP connectors (`mcp-*`) |
| `token revoke <label>` | Immediate. Works for peer labels and MCP connectors. An unknown label exits 1 |
| `peers add <alias> <url> [--token-env VAR \| --token-stdin]` | Store an outbound peer. The token is `PEER_<ALIAS>_TOKEN` in the config file |
| `peers list` / `peers rm <alias>` | List or remove |
| `peers sync [alias...]` / `peers unsync <alias>` | Upload peers so the MCP connector can send to them. URL and token are encrypted on the Worker with a key derived from the owner token. Re-run after `connect`, a token change, or an owner-token rotation |
| `send --to <alias\|url> [--text T \| stdin] [--context C] [--task T] [--push] [--proto 0.3\|1.0]` | Send. The CLI reads the peer card and prefers A2A 1.0 |
| `poll --to <alias\|url> <taskId> [--proto 0.3\|1.0]` | Fetch a task you sent |
| `outbound <taskId>` | Stored state, including pushed updates |

A `PEER_<ALIAS>_TOKEN` value in the environment overrides `config.env`. When they differ, `connect`, `send`, `poll`, `peers`, and `status` warn. The values are not shown.

## Owner

One A2A endpoint has one owner token, saved by `init` in `config.env`. That token authenticates the owner commands. `GET /` in a browser shows the agent card. `/device` approves or denies a pairing request with the approval password. `pair set-password` sets that password. `pair set-oidc` adds OpenID Connect on `/device` and the MCP consent page when the issuer, client id, client secret, and allowlist are all set.

## Feedback

`feedback` is documented in [Feedback](feedback.md).

## Environment variables

| Variable | Role |
| --- | --- |
| `A2A_CONFIG_DIR` | Config directory |
| `A2A_BASE_URL` | Public base URL of the Worker |
| `A2A_OWNER_TOKEN` | Owner API token |
| `A2A_HOSTNAME` | Custom hostname. Omit for workers.dev |
| `A2A_DOCUMENTATION_URL` | Public https documentation link on the agent card |
| `A2A_NO_UPDATE_CHECK` | `1` turns off the daily npm update notice. `DO_NOT_TRACK=1` does the same |
| `CLOUDFLARE_API_TOKEN` | API token when browser login is blocked |
| `CLOUDFLARE_ACCOUNT_ID` | Account, when the token can see more than one |
| `CF_PROFILE` | Named `cf` auth profile |
| `WAKE_WEBHOOK_URL` | Wake URL. Worker secret |
| `WAKE_WEBHOOK_KEY` | Bearer or API key. Worker secret |
| `WAKE_HMAC_SECRET` | HMAC secret for `hermes` and signed `generic` wakes |
| `WAKE_ACCESS_CLIENT_ID` / `WAKE_ACCESS_CLIENT_SECRET` | Access service token for a wake tunnel. Set by `tunnel create` |
| `WAKE_CLI_COMMAND` | Command in wake hints |
| `WAKE_PRESET`, `WAKE_AGENT_ID`, `WAKE_KEY_HEADER`, `WAKE_KEY_PREFIX`, `WAKE_BODY_TEMPLATE` | Wake shape. Usually set by flags |
| `WAKE_DEBOUNCE_SECONDS`, `WAKE_MAX_PER_HOUR` | Debounce and hourly cap |
| `UPSTREAM_TOKEN` | Façade only. Bearer presented to the private agent |
| `UPSTREAM_ACCESS_CLIENT_ID` / `UPSTREAM_ACCESS_CLIENT_SECRET` | Façade only. Access service token for the upstream tunnel |
| `PEER_<ALIAS>_TOKEN` | Outbound peer token. Overrides the saved value |
| `APPROVAL_OIDC_CLIENT_SECRET` | OpenID Connect client secret. Not written to `config.env` |

Deploy-time Worker settings for a manual `cf deploy` are listed in `worker/deploy.env.example`.
