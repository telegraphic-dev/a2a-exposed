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
     [--workers-logs on|off] [--mcp on|off] [--cron]
     [--manage-url URL] [--event-url URL] [--event-secret-stdin]
     [--rotate-owner-token]
     [--upstream URL [--upstream-card-url URL] [--upstream-token-stdin | --no-upstream-token]]
     [--worker-dir DIR] [--tunnel]
```

| Flag | Effect |
| --- | --- |
| `--hostname` | Custom domain. Omit it and the Worker is served on `https://<worker>.<account subdomain>.workers.dev` |
| `--workers-dev` | Move an existing custom-domain deployment to workers.dev. `--hostname` moves it back. The old URL answers 301 (the card) or 410 |
| `--workers-dev-subdomain` | Register the account's workers.dev subdomain when it has none |
| `--preset` | `grok-bot`, `claude-code`, `openclaw-wake`, `openclaw-agent`, `hermes`, `openbot`, or `generic` |
| `--worker-name` | Worker name. Also the default D1 name |
| `--d1-name` | D1 database to create or reuse |
| `--account-id` | When the login can see more than one account |
| `--cf-profile` | Named `cf` auth profile. Saved and used by later `cf` calls. When `whoami` lists no accounts, `init` reads `cf accounts list` outside the Worker directory and saves the account when that list has exactly one. A failed list prints cf's error unless `--account-id` is already set |
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

### `hosted link create` and `hosted link finish`

One bot runs these commands on its own receiver machine. A second bot and
manual secret copying are not required. First sign the CLI in to the selected
service with `login --control-url https://control.example`; the owner approves
that sign-in in the browser. The saved account session is sent only to that
same service when starting a setup request, never to the connector or webhook.

To create a link and complete setup:

```bash
npx -y a2a-exposed@latest hosted link create --agent example \
  --control-url https://control.example --hostname wake.example.com \
  --origin http://127.0.0.1:8644 --path /webhooks/inbox --preset hermes \
  --secret-from hermes --route inbox
```

The owner approves the exact hostname, local origin, webhook path and preset
on the printed approval page before the service creates Cloudflare resources.
The page handles Cloudflare reconnect if permissions are missing. Creation
reuses an identical ready link. A different existing link returns `link_exists`;
the CLI does not remove or replace it. A failed creation returns
`provision_failed`: inspect the approval page for the failing phase and any
cleanup needed. There is no automatic retry of provisioning.

After approval, creation continues through the same connector, wake test and
save steps as `finish`. The approved metadata must match the requested plan
before the CLI reads or transfers the signing secret. All four creation
options are required; `finish` refuses them rather than ignoring them.

For recovery, finish an existing link:

Use this on the machine that receives wakes for an agent you already created on [a2a.exposed](https://a2a.exposed), when that service lets you finish a secure link from here.

1. Create the agent, or the secure link, on a2a.exposed.
2. Sign in from this machine with `npx -y a2a-exposed@latest login --control-url https://control.example` and approve the code it prints. `login` saves `CONTROL_URL`. `hosted link finish` uses that saved value when you omit `--control-url`.
3. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/) on this machine.

```bash
npx -y a2a-exposed@latest hosted link finish --agent example \
  --control-url https://control.example --secret-from hermes \
  --hermes-home /path/to/hermes-home --route inbox
```

The owner opens the printed approval URL and confirms the code. The CLI never
approves the page. It fetches the connector token once, writes it atomically
with mode 600, starts cloudflared in the background using `--token-file`, and
checks the service's connector status every three seconds for up to 60 seconds.
Only a connected status allows the signed wake test. A passing test saves the
wake settings. The connector stays running; no startup service is installed.
Child output is suppressed. If it exits, inspect your cloudflared installation.

For an existing link with no preset, pass `--preset <id>` to finish. The CLI validates
the option before requesting approval or exchanging the request for a grant.
This preset is used for local secret-source validation and the wake test.

`--control-url` defaults to saved `CONTROL_URL`. The account token stays bound to its saved service origin. Environment sessions require both `CONTROL_URL` and `CONTROL_TOKEN`; a partial override is rejected before any request. Choose exactly one source:

- `--secret-file FILE`: regular file, mode 600, no symlinks. One trailing line ending is removed.
- `--secret-env VAR`: names an existing environment variable, never its value.
- `--secret-from hermes`: reads `webhook_subscriptions.json` under `--hermes-home`,
  `HERMES_HOME`, or `~/.hermes`. The approved preset must be `hermes` and the path
  exactly `/webhooks/<name>`. `--route`, if supplied, must match that name.
  Missing, disabled, or unsigned subscriptions are refused. Static YAML routes
  and profile-prefixed paths need an explicit file or environment source; the
  adapter refuses to guess which route secret the gateway uses.

`--token-file FILE` overrides `~/.a2a-exposed/links/<agent>.token`. `--no-run`
writes the token and prints only the connector command after approval; it does
not start cloudflared or test/save the wake. Start that command locally, then
rerun finish without `--no-run` with fresh approval to complete setup.

If token delivery or the write fails, run finish again. Fresh approval fetches
the token for the same ready link, without provisioning. Denial, expiry,
revocation, connection failure, and a failed wake test exit non-zero. The
signing secret, verifier, grant, and connector token stay out of CLI output,
URLs, and process arguments. Keep token files private. Approve the page yourself. The CLI does not fill it.

### `tunnel`

For a webhook that only listens locally. Needs Zero Trust and a zone on the account. The A2A endpoint can be on workers.dev.

| Command | Effect |
| --- | --- |
| `tunnel create` | Named tunnel, proxied DNS, and an Access app that admits one service token. The tunnel, the Access app, and the service token are named `a2a-exposed wake <worker>`. The DNS host is `wake-<word>-<word>-<4 hex>.<zone>` unless `--tunnel-hostname` is set. A finished tunnel creates nothing when you run it again. A partial tunnel stops and asks for `tunnel rm`. Prints the Access application name and ids, and `tunnel rm` as the undo. Export `WAKE_WEBHOOK_KEY` (hermes/openbot: `WAKE_HMAC_SECRET`). The connector machine needs [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/). Flags: `--tunnel-zone`, `--tunnel-hostname`, `--tunnel-origin`, `--tunnel-path`, `--show-token`, `--zero-trust-org`, `--dir`, `--worker-dir`. Secrets show up in about 15 to 40 seconds. Wait about 30 seconds and check again |
| `tunnel status` | Tunnel, Access, and Worker state, plus probes. A network error says DNS may still be propagating; retry in 30 seconds. An `inactive` tunnel reads as `never connected`. The Access warning appears only for an HTTP response other than 401 or 403 |
| `tunnel rm` | Prints each removed object: DNS record, tunnel, Access app, and service token (named `a2a-exposed wake <worker>`), plus Worker secrets `WAKE_ACCESS_CLIENT_ID`, `WAKE_ACCESS_CLIENT_SECRET`, `WAKE_WEBHOOK_KEY`, and `WAKE_HMAC_SECRET`. `WAKE_WEBHOOK_URL` goes too when it is this tunnel's. If the tunnel is already gone, the saved ids are cleared. With nothing saved, prints `nothing to remove`. A missing Worker (Cloudflare error 10007) is already gone |

### `status`, `upstream`, `url`, `config`

| Command | Effect |
| --- | --- |
| `status [--json]` | Worker version (compared with the CLI and cached npm latest), deployment, base URL, agent card, wake mode (webhook, tunnel, or none), tunnel state, and in proxy mode the upstream card, Access credential, upstream bearer, live check, last failed peer call, and a card-leak check. Warns when a peer-token variable shadows a saved token. When `GET /owner/mcp` reports enabled and the agent card is reachable, prints `claude mcp add --transport http a2a-exposed <base URL>/mcp`. Prints the next step. With nothing deployed, that step says to run `init`. Exit 1 means something is broken. For about a minute after `tunnel create`, while the connector reports 0 connections, the next step says `waiting for the connector to connect`, tells you to start `cloudflared tunnel run --token-file …` now, and the exit code stays 0. After that, 0 connections is broken. A tunnel status of `inactive` reads as `never connected`. Wake settings from `wake set`, `wake unset`, and `tunnel create` show up in `wake preview` in about 15 to 40 seconds. Wait about 30 seconds and check again. Eight layers are printed in order, each `PASS`, `FAIL`, or `SKIP`: Worker DNS (system lookup, then DNS-over-HTTPS when that lookup fails), Worker (TLS, the agent card, and `/health`), Owner API, Wake DNS, Access (whether the wake host is protected and whether a service token is configured; secrets are not printed), Connector, Local webhook (HTTP status of the wake endpoint), and Pairing. A 401 or 403 fails the local webhook layer only when the response shows Cloudflare Access. The webhook's own auth refusal reports the HTTP status and passes, as does a 401 or 403 with no Access marker. A failure names the missing or mismatched object and a fix. Later layers are still checked after an earlier failure. `--json` adds `layers`, an array of those eight results. Exit 1 if any layer fails. Read-only, except the no-op upstream probe in proxy mode. When the Worker reports them, an `addresses` line lists paired peers with no callback and announcements still pending |
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
| `inbox [--context C] [--from PEER] [--all] [--json]` | Unhandled inbound tasks, following every page, and a reply to a message you sent until this list is read. Past 10000 pages it exits with an error instead of a short list. Peer text is untrusted. `--from` is one peer. The wake hint includes it. A reply is marked `reply` and `kind: "outbound"`: read it with `history`, and continue that conversation with `send`. `--all` keeps showing a reply after it has been listed. Then pending pairing requests, including the dashboard URL when `MANAGE_URL` is set. With `--json`, the rows go to stdout and pairing requests to stderr |
| `show <taskId>` | Full task JSON |
| `working <taskId>` | Mark the task `working` |
| `reply <taskId> (--text T \| --stdin) [--state completed\|input-required\|rejected\|failed\|working] [--artifact] [--artifact-name N] [--force]` | Reply. Default state is `completed` |
| `history <contextId> [--from PEER] [-n 50] [--json]` | Conversation log. `--from` is one peer. The wake hint includes it. Without `--from`, the log is every peer that owns that context id, and each row has `peer` |
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
| `token list` | Labels, how each was created (pairing code and date, or a reverse pairing), and MCP connectors (`mcp-*`) |
| `token revoke <label>` | Immediate. A later push reply to a task already sent is rejected. Works for peer labels and MCP connectors. An unknown label exits 1 |
| `peers add <alias> <url> [--token-env VAR \| --token-stdin]` | Store an outbound peer. The token is `PEER_<ALIAS>_TOKEN` in the config file |
| `peers list` / `peers rm <alias>` | List or remove |
| `peers sync [alias...]` / `peers unsync <alias>` | Upload peers so the MCP connector can send to them. URL and token are encrypted on the Worker with a key derived from the owner token. Re-run after `connect`, a token change, or an owner-token rotation |
| `peer announce (--to <alias> \| --all) [--reissue] [--json]` | Tell synced peers this inbox's current https card URL. They switch only after the card proves the same pairing identity. A peer that does not support this keeps the current pairing. A revoked return token stays revoked unless `--to` and `--reissue`. The return token is not printed. Run `peers sync` first |
| `peer forward --to <card-url> [--hours N]` / `peer forward --off` | On the inbox you are leaving, forward a direct reply to the new card and answer with a moved pointer. `--hours` is 1 to 720 (default 168) |
| `send --to <alias\|url> [--text T \| stdin] [--context C] [--task T] [--push] [--proto 0.3\|1.0]` | Send. The CLI reads the peer card and prefers A2A 1.0 |
| `poll --to <alias\|url> <taskId> [--proto 0.3\|1.0]` | Fetch a task you sent |
| `outbound <taskId>` | Stored state, including pushed updates |

A `PEER_<ALIAS>_TOKEN` value in the environment overrides `config.env`. When they differ, `connect`, `send`, `poll`, `peers`, and `status` warn. The values are not shown.

`send` without `--push` and `poll` work with just the peer configuration; your own `A2A_BASE_URL` and `A2A_OWNER_TOKEN` are not required. When both are configured, the CLI also saves history and outbound task state to your Worker. These writes are best-effort: failures warn on stderr without hiding the peer response on stdout or changing a successful exit code. Do not resend a delivered message because its history could not be saved. `--push` requires both your Worker's `A2A_BASE_URL` and `A2A_OWNER_TOKEN`; missing or partial owner configuration fails before contacting the peer. The Worker needs the saved outbound task token to authenticate push updates. If saving it fails after delivery, the CLI explicitly warns that push updates cannot authenticate: use `poll --to <alias|url> <taskId>` instead, not another send. `history` and `outbound` require owner configuration.

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
| `WAKE_HMAC_SECRET` | HMAC secret for `hermes`, `openbot`, and signed `generic` wakes |
| `WAKE_ACCESS_CLIENT_ID` / `WAKE_ACCESS_CLIENT_SECRET` | Access service token for a wake tunnel. Set by `tunnel create` |
| `WAKE_CLI_COMMAND` | Command in wake hints |
| `WAKE_PRESET`, `WAKE_AGENT_ID`, `WAKE_KEY_HEADER`, `WAKE_KEY_PREFIX`, `WAKE_BODY_TEMPLATE` | Wake shape. Usually set by flags |
| `WAKE_DEBOUNCE_SECONDS`, `WAKE_MAX_PER_HOUR` | Debounce and hourly cap |
| `UPSTREAM_TOKEN` | Façade only. Bearer presented to the private agent |
| `UPSTREAM_ACCESS_CLIENT_ID` / `UPSTREAM_ACCESS_CLIENT_SECRET` | Façade only. Access service token for the upstream tunnel |
| `PEER_<ALIAS>_TOKEN` | Outbound peer token. Overrides the saved value |
| `APPROVAL_OIDC_CLIENT_SECRET` | OpenID Connect client secret. Not written to `config.env` |

Deploy-time Worker settings for a manual `cf deploy` are listed in `worker/deploy.env.example`.
