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

Local deployment and option errors are reported before the Node version check.
For example, `deploy` without saved deployment settings reports `no saved deployment`
even on older Node. Valid deployment requests still stop before writing configuration
or calling Cloudflare when Node is older than 22.18.

## Automation

Supply required choices through command options or named configuration inputs.
Commands run without a terminal and report missing inputs instead of waiting
for someone to type. Supply secrets through their documented environment
variables, private files or stdin options, never plaintext arguments.

Use `--workers-dev-subdomain NAME` for account subdomain registration and
`--yes` for the documented feedback or uninstall confirmation after approving
the action. Optional terminal prompts are conveniences. For pairing-password
setup without a terminal, `pair set-password --web` prints the owner's setup
link. Website sign-in and owner approval remain explicit steps.

## Setup

`init` checks approval-password readiness after deployment. If it reports `Approval password: not set`, run `npx -y a2a-exposed@latest pair set-password --web` and give the one-time link privately to the human. If the check is unavailable, use `pair list --json`. Pairing wakes repeat this guidance while the password is absent. Password setup guidance appears only when password approval is enabled; OIDC-only endpoints omit it.

Needs a Cloudflare login (`npx cf auth login --no-browser`). On a VPS where that returns HTTP 403 before a code, export `CLOUDFLARE_API_TOKEN`. The hosted A2A endpoint is open to everyone: [Getting started](getting-started.md#hosted-inbox). See [Self-hosting](self-hosting.md).

### `init` and `deploy`

`--skip-install` skips the Worker dependency install; use it only when the copied Worker already has its dependencies.

`init` deploys the Worker and D1. `deploy` redeploys with the saved settings. Secrets already on the Worker stay, unless you export new values.

Workers.dev subdomain registration uses the system `script` utility on macOS and Linux. It supports CLI runs started by automation without an outer terminal. An unexpected prompt times out and stops the terminal job. CLI shutdown signals (SIGINT, SIGTERM, SIGHUP) also stop the detached terminal job.

```text
init [--hostname <host> | --workers-dev [--workers-dev-subdomain NAME]]
     [--agent-name N] [--agent-description D] [--agent-skills JSON]
     [--provider-organization O --provider-url U]
     [--preset P] [--worker-name W] [--d1-name D]
     [--account-id ID] [--cf-profile NAME] [--cli-command CMD]
     [--debounce S] [--busy S] [--max-per-hour N]
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
| `--preset` | `grok-bot`, `claude-code`, `openclaw-wake`, `openclaw-agent`, `hermes`, `openbot`, `mausbot`, or `generic` |
| `--worker-name` | Worker name. Also the default D1 name |
| `--d1-name` | D1 database to create or reuse |
| `--account-id` | When the login can see more than one account |
| `--cf-profile` | Named `cf` auth profile. Saved and used by later `cf` calls. When `whoami` lists no accounts, `init` reads `cf accounts list` outside the Worker directory and saves the account when that list has exactly one. A failed list prints cf's error unless `--account-id` is already set |
| `--cli-command` | Command shown in wake hints. Default `npx -y a2a-exposed@latest`. Saved as `WAKE_CLI_COMMAND` |
| `--debounce` | Wake debounce in seconds. `claude-code` defaults to 20. Others default to 10 |
| `--busy` | Busy cool-down in seconds after a sent wake. `0` disables it. Unset uses the preset default: 300 for `claude-code`, 180 for the others. See [Receiving messages](receiving-messages.md#what-a-wake-contains) |
| `--max-per-hour` | Hourly cap. `0` or unset is unlimited, except `claude-code`, which defaults to 25 when unset |
| `--pairing-approval` | `human` (default), `agent`, or `off` |
| `--pbkdf2-iterations` | Approval-password cost, 50000–100000. Default 100000. Lower it only if `/device` hits Cloudflare error 1102 |
| `--workers-logs` | `on` enables persisted Workers Logs. Query strings are redacted. Default off |
| `--mcp` | `on` (default) or `off`. Remote MCP at `<url>/mcp`. Proxy mode has none |
| `--manage-url` | https dashboard page (`MANAGE_URL`). A pairing wake, the MCP inbox line, `pair list`, and `inbox` include it. `none` clears it |
| `--event-url` | https URL that receives a signed pairing event (`EVENT_URL`). `none` clears it. The post also needs `EVENT_SECRET` |
| `--event-secret-stdin` | Read `EVENT_SECRET` from stdin and upload it on this deploy. A hidden prompt on a terminal. The value stays out of `config.env` and out of the command output. Or export `EVENT_SECRET` |
| `--cron` | One-minute cron that flushes pending wakes. Self-hosted busy catch-ups need this cron. Without it, `wake preview` reports `busySeconds` of 0 |
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
| `wake set` | Self-hosted: save wake settings, upload secrets from the environment, redeploy. Flags: `--preset`, `--agent-id`, `--key-header`, `--key-prefix`, `--body-template`, `--cli-command`, `--debounce`, `--busy`, `--max-per-hour`. Hosted: use the configured address and owner token to test then save through the hosted service; no Cloudflare deploy. Read presets with `hosted capabilities --json`; supply `WAKE_WEBHOOK_URL` or `--url` and protected secrets |
| `wake preview` | Rendered request with credentials masked, plus SHA-256 fingerprints. Export `WAKE_WEBHOOK_URL`, `WAKE_WEBHOOK_KEY`, and `WAKE_HMAC_SECRET` in this shell. `match` means the exported value is the one on the Worker. `DIFFERENT` means they differ: the variable is absent from this shell, or the upload is still propagating (about 15 to 40 seconds after `wake set`, `wake unset`, or `tunnel create`). Wait about 30 seconds and run it again |
| `wake fingerprint` | Fingerprints of `WAKE_*` exported in this shell |
| `wake check [--local-url URL] [--json]` | Hermes delivery diagnostic: unsigned loopback POST must return 401/403 before the signed Worker test requires 2xx. Exits 1 on failure; no inbox task or receiver execution proof. See the [recipe](hermes.md) |
| `wake test` | Send a test wake and print the HTTP status |
| `wake unset` | Remove wake secrets. The agent polls |

### `tunnel`

For a webhook that only listens locally. Needs Zero Trust and a zone on the account. The A2A endpoint can be on workers.dev.

| Command | Effect |
| --- | --- |
| `tunnel create` | Named tunnel, proxied DNS, and an Access app that admits one service token. The tunnel, the Access app, and the service token are named `a2a-exposed wake <worker>`. The DNS host is `wake-<word>-<word>-<4 hex>.<zone>` unless `--tunnel-hostname` is set. A finished tunnel creates nothing when you run it again. A partial tunnel stops and asks for `tunnel rm`. Prints the Access application name and ids, and `tunnel rm` as the undo. Export `WAKE_WEBHOOK_KEY` (hermes/openbot: `WAKE_HMAC_SECRET`). The connector machine needs [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/). Hermes: `--preset hermes --hermes-route a2a-wake --hmac-secret-stdin` reads the subscription secret from protected stdin; the preset must match the deployed setting. See the [recipe](hermes.md). Flags: `--tunnel-zone`, `--tunnel-hostname`, `--tunnel-origin`, `--tunnel-path`, `--show-token`, `--zero-trust-org`, `--dir`, `--worker-dir`. Secrets show up in about 15 to 40 seconds. Wait about 30 seconds and check again |
| `tunnel zones [--json]` | List active Cloudflare zones before choosing `--tunnel-zone`; no resource changes |
| `tunnel status` | Tunnel, Access, and Worker state, plus probes. A network error says DNS may still be propagating; retry in 30 seconds. An `inactive` tunnel reads as `never connected`. The Access warning appears only for an HTTP response other than 401 or 403 |
| `tunnel rm` | Prints each removed object: DNS record, tunnel, Access app, and service token (named `a2a-exposed wake <worker>`), plus Worker secrets `WAKE_ACCESS_CLIENT_ID`, `WAKE_ACCESS_CLIENT_SECRET`, `WAKE_WEBHOOK_KEY`, and `WAKE_HMAC_SECRET`. `WAKE_WEBHOOK_URL` goes too when it is this tunnel's. If the tunnel is already gone, the saved ids are cleared. With nothing saved, prints `nothing to remove`. A missing Worker (Cloudflare error 10007) is already gone |

A hosted-only config has `A2A_BASE_URL` and `A2A_OWNER_TOKEN`, with no Worker or D1 metadata. `status --json` reports `deployment: "hosted"`, checks the card, health and owner API, and reports wake settings when available. The hosted service manages its Worker version. `tunnel create|status|rm` provisions only self-hosted infrastructure; for a hosted address, configure a public HTTPS webhook through the hosted service or use polling if Tunnel delivery is unavailable. To delete a hosted agent, use its hosted settings and deletion confirmation. `uninstall` leaves the hosted agent and local config untouched.

For an existing hosted address, the two-entry [config.env example](getting-started.md#hosted-inbox)
is enough for `wake preview|test|set --json`. The CLI selects the agent from
`A2A_BASE_URL` and uses its matching owner token; no setup grant or `--agent` is
needed. The service origin defaults to `https://a2a.exposed`; use `--control-url`
for another compatible service. An explicit `--agent` cannot borrow a different
agent's owner token. Scoped setup without an owner token still selects an
explicit agent from `hosted list --json`.

```bash
npx -y a2a-exposed@latest hosted capabilities --json
npx -y a2a-exposed@latest wake preview --json
npx -y a2a-exposed@latest wake set --preset grok-bot --key-env WAKE_WEBHOOK_KEY --json
npx -y a2a-exposed@latest wake test --json
```

Provide `WAKE_WEBHOOK_URL` and the key through the routine's protected secret
store before running these commands. `wake set` tests the draft before saving;
`wake test` tests without saving. With no draft overrides, testing reuses the
saved URL, preset and same-destination credentials. Neither writes wake secrets
to local config nor deploys a Worker. A missing hosted URL names `wake set` and
the protected inputs. Unsupported API or refused owner access points to dashboard
Wake settings or hosted MCP `set_wake`, never self-hosted `init`/`deploy`.
See [hosted CLI setup](#hosted-setup-from-the-cli) for scoped grants and references.

### `status`, `upstream`, `url`, `config`

For a reachable hosted endpoint with no webhook, `status` points to
`hosted capabilities --json` before setup. Check hook support and the hosted
service's route compatibility, then choose webhook or polling with the human,
including the polling interval and cost. If setup capabilities are unavailable,
use dashboard Wake settings or hosted MCP `set_wake`. Saved wake settings do not
prove delivery: read `wake preview --json` for the saved agent, authorize and run
a draft test with explicit inputs, then verify a real inbox-and-reply run.
`status` performs none of those writes or tests.

Hosted draft-test failures preserve saved settings and return fixed recovery guidance.
`transport-socket` identifies a failed public-HTTPS socket connection; it does
not prove that the receiver credentials are wrong. An owner-created Cloudflare
Tunnel can pass local checks while remaining unreachable by that transport.
`cloudflare-target-unsupported` confirms the service cannot use that route;
choose a supported public HTTPS route, polling, or an explicitly authorized
self-hosted Worker. DNS, TLS and Access failures name their respective checks.
Keep Access, hook authentication and HTTPS verification enabled.

| Command | Effect |
| --- | --- |
| `status [--json]` | Worker version (compared with the CLI and cached npm latest), deployment, base URL, agent card, wake mode (webhook, tunnel, or none), tunnel state, and in proxy mode the upstream card, Access credential, upstream bearer, live check, last failed peer call, and a card-leak check. Warns when a peer-token variable shadows a saved token. When `GET /owner/mcp` reports enabled and the agent card is reachable, prints `claude mcp add --transport http a2a-exposed <base URL>/mcp`. Prints the next step. With an empty config, that step says to run `init`; hosted configs receive hosted recovery guidance. Exit 1 means something is broken. For about a minute after `tunnel create`, while the connector reports 0 connections, the next step says `waiting for the connector to connect`, tells you to start `cloudflared tunnel run --token-file …` now, and the exit code stays 0. After that, 0 connections is broken. A tunnel status of `inactive` reads as `never connected`. Wake settings from `wake set`, `wake unset`, and `tunnel create` show up in `wake preview` in about 15 to 40 seconds. Wait about 30 seconds and check again. Eight layers are printed in order, each `PASS`, `FAIL`, or `SKIP`: Worker DNS (system lookup, then DNS-over-HTTPS when that lookup fails), Worker (TLS, the agent card, and `/health`), Owner API, Wake DNS, Access (whether the wake host is protected and whether a service token is configured; secrets are not printed), Connector, Local webhook (HTTP status of the wake endpoint), and Pairing. A 401 or 403 fails the local webhook layer only when the response shows Cloudflare Access. The webhook's own auth refusal reports the HTTP status and passes, as does a 401 or 403 with no Access marker. A failure names the missing or mismatched object and a fix. Later layers are still checked after an earlier failure. `--json` adds `layers`, an array of those eight results. Exit 1 if any layer fails. Read-only, except the no-op upstream probe in proxy mode. When the Worker reports them, an `addresses` line lists paired peers with no callback and announcements still pending |
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
| `WAKE_DEBOUNCE_SECONDS`, `WAKE_BUSY_SECONDS`, `WAKE_MAX_PER_HOUR` | Debounce, busy cool-down, and hourly cap. `WAKE_BUSY_SECONDS=0` disables the cool-down |
| `UPSTREAM_TOKEN` | Façade only. Bearer presented to the private agent |
| `UPSTREAM_ACCESS_CLIENT_ID` / `UPSTREAM_ACCESS_CLIENT_SECRET` | Façade only. Access service token for the upstream tunnel |
| `PEER_<ALIAS>_TOKEN` | Outbound peer token. Overrides the saved value |
| `APPROVAL_OIDC_CLIENT_SECRET` | OpenID Connect client secret. Not written to `config.env` |

Deploy-time Worker settings for a manual `cf deploy` are listed in `worker/deploy.env.example`.

Worker dependency installs save npm output in `<config dir>/npm-install.log` (mode 600) and print that path only on failure. Inspect the log locally and redact secrets before sharing it.

In the staging secure-link integration, an expired approval request requires a
new request with the same command: `hosted link create` or `hosted link finish`.
An expired grant after approval requires `hosted link finish` for fresh approval.
A connector token already saved locally remains on disk; wake settings are not
saved when the grant expires. A polling refusal requires fresh approval, rather
than changes to hostname or creation options.

For internal secure-link tests, HTTP 409 save refusals (including `failed` and
`conflict`) emit `wake_result=not-saved`. This result also means the test wake was
delivered but saving settings was not confirmed. Save the settings in Wake
settings on the website, then test again. The connector token remains on disk;
the CLI does not retry the test or save automatically.


## Hosted setup from the CLI

Run `hosted capabilities --json` to list scopes and wake presets.

If capabilities returns `unsupported` (including HTTP 404 from the discovery route), scoped CLI setup is unavailable at that service origin. Check `--control-url`; use the service dashboard or hosted MCP `create_agent`/`set_wake` with human confirmation and secret entry. Scoped login stops before requesting approval and keeps local credentials unchanged. Do not repeat the failing discovery command or run `init`/`deploy` to repair a hosted address.

When discovery succeeds, request only the
scopes you need with `login --machine NAME --scopes "agents:create agents:owner-token wake:write wake:test"
--control-url https://a2a.exposed --json`. The human follows the printed approval link once.
The CLI saves the scoped setup grant in the protected configuration; it never prints it.
`hosted list --json` lists agents before selection. `hosted create --name NAME --json` saves
the new agent's owner credential locally without returning it in output. Use a separate
`--config-dir` for each agent; creation refuses to overwrite an existing deployment.

Use `wake preview --agent NAME --json` to inspect the settings, then `wake test` or `wake set`
with explicit `--url` and `--preset`. `set` tests before saving. Webhook is the default for
OpenClaw and Hermes; use polling if there is no public webhook. A tunnel needs its separate
Cloudflare authorization. When capabilities advertises `wake_removal`, read `wake preview --agent NAME --json`, then run `wake remove --agent NAME --version N --json` with the version you selected; `wake unset` is an alias. Removal sends no test webhook. A stale version fails; already absent settings return `already_removed` without another change. Older services keep removal on the agent's Wake settings page.

Read secrets through `--key-file`, `--key-env` or `--key-stdin`; signing secrets through
`--hmac-secret-file` or `--hmac-secret-env`; Access pairs through the corresponding
`--access-client-id-file|--access-client-id-env` and
`--access-client-secret-file|--access-client-secret-env`. Protected files must be regular
files with no group or other permissions. No secret belongs in an argument value.

When capabilities lists `secret_reference: true`, `wake set` uploads the draft for a
short-lived reference before testing and saving. `wake prepare --agent NAME --url URL
--preset P --reference-file FILE --json` saves a reference in a new mode-600 file without
printing it. Use it within ten minutes with `wake set --agent NAME --reference-file FILE
--json` (or `--reference-env VAR`). Existing files are never replaced.
MCP `set_wake` accepts the reference as `secretReference`, with the same agent, URL, preset
and key header. Both the setup grant and the OAuth grant must still authorize the save.
The server spends a reference before its test, even on failure; prepare a new draft to
retry after checking current settings. Raw keys remain browser-only in MCP. Without a
reference the browser confirmation stays available. The service currently enables
references only on staging; capabilities is the source of available choices.

Hosted setup commands exit 0 on success and 1 on a refusal or failure. `--json` returns `{ok, code, next}`; credential values are omitted. The approval link and comparison code are printed on stderr for the human.

Hosted listings and wake previews include their result fields in text output; use `--json` for structured output. Owner credentials remain bound to their deployment origin even when a setup URL is overridden.

Scoped login prints the machine label and requested permissions beside the approval code. Compare all three with the approval page. `hosted list` lists hosted agents; Cloudflare-linked Workers are listed in dashboard Your agents. Hosted `wake preview` shows the effective key header and destination origin, with any path and query hidden. Direct wake preview/test/set prefer a matching saved agent owner token, so revoking setup access does not disable that owner's credential. Reference prepare/set still require the scoped setup grant. A spent or expired reference needs a fresh `wake prepare` and a new protected reference file.

`status --agent NAME --json` reads the selected hosted agent's wake configuration,
including its version, preset and whether a webhook is configured. Select the name
with `hosted list --json`; use `--control-url URL` for another hosted service.
It uses setup approval with `wake:test` or `wake:write`, or the matching agent's
owner credential. This read-only check does not test delivery, health or the card;
`status --json` keeps the full diagnostics for the saved deployment.
Empty or malformed reference files and environment values fail before a network
request with `invalid_reference` and guidance to run `wake prepare` using a new
protected reference file. Hosted failures exit 1 in text and JSON output.

Hosted reference capacity failures exit 1 with `code: too_many_references`.
`retry_after` reports seconds from `Retry-After` (seconds or an HTTP date),
falling back to a nonnegative integer body `retry_after`. The recognized capacity
message is retained; other service fields and arbitrary text are omitted.
`next` says when to run `wake prepare` again with a new protected reference file.
If no valid delay is supplied, wait for an unused reference to expire. The CLI
never retries automatically or saves a reference on this refusal.

Hosted MCP removal can use a scoped single-use reference: run `wake prepare --agent NAME --clear --version N --reference-file FILE --json` after reviewing `wake preview`. The service must advertise wake removal and secret references, and the setup grant needs both wake scopes. Pass the protected file's reference to MCP `set_wake` with `clear: true` and `secretReference`; never put it in CLI arguments or chat. The reference authorizes removal only for that account, agent and version, expires after ten minutes and is single-use. A save reference cannot remove, and a removal reference cannot save. Without a reference, MCP removal retains the browser confirmation. `wake remove --version N --reference-file FILE` can consume a prepared removal reference through the CLI instead.


When `hosted capabilities --json` advertises `preflight`, check `hosted names --name NAME --json` anonymously before device approval. It checks only the supplied name and reserves nothing. Approve a read-only `agents:read` grant with `login --machine NAME --scopes agents:read`, then read `hosted capacity --json` for account room and `hosted list --json` for your hosted agents. Reading capacity does not assign a plan or reserve room. Approve creation scopes only when ready; existing `agents:create` access can also read capacity. `hosted create --name NAME --json` repeats advertised preflight checks before POST, and the server still enforces name uniqueness and account limits atomically. A concurrent creation can invalidate the earlier result.

Hosted MCP offers `name_availability` and `creation_capacity` when supported. The latter reports only the creation room this connection can use, without account totals or other agents. These tools do not spend the connection's creation allowance. Account-wide counts require the separate setup read grant. All commands use explicit names and JSON outcomes; no credentials belong in arguments or printed output.

The staging `hosted link create|finish --json` commands write one result object
on stdout: `{ok, code, reason, field, phase, status, hostname, next}`. Fields
without a value are `null`; success also includes `saved` and
`connectorStarted`. Approval links, codes and connector guidance remain on
stderr. Exit status is 0 on success and 1 on any failure. Diagnostics contain
only local guidance and recognized public codes, never grants or signing secrets.

Both commands require an explicit `--preset ID` before any approval request,
even when a link already has a saved preset. List choices with
`hosted capabilities --json` and select the agent with `hosted list --json`.
`create --hostname` accepts a DNS name or a root HTTPS URL. It normalizes case,
one trailing root dot and IDN labels to ASCII. Credentials, ports, non-root
paths, queries, fragments, IP addresses and malformed labels receive distinct
local validation reasons before any network request. Invalid hostname input
is never echoed in the result.

## Hosted upstream configuration

For a hosted service advertising upstream configuration in `hosted capabilities --json`, use `hosted list --json` to choose an existing agent. Approve only the needed `upstream:write` and `upstream:test` scopes with `login --machine NAME --scopes SCOPES`; the agent's saved owner token also authorizes that agent alone.

Run `hosted upstream preview --agent NAME --json` to read `version` and `configured`. Supply that explicit `--version N` to `hosted upstream set --agent NAME --url URL`, `hosted upstream clear --agent NAME`, or `hosted upstream verify --agent NAME`. Read preview again after saving. A version conflict requires another review of the current version; the CLI never retries a write automatically.

Set reads the agent bearer with `--upstream-token-file FILE` or `--upstream-token-env VAR`, and the Access pair with `--access-client-id-file FILE` / `--access-client-id-env VAR` and `--access-client-secret-file FILE` / `--access-client-secret-env VAR`. Files must be regular, mode 600, and at most 4098 bytes. Defaults are the named environment variables `UPSTREAM_TOKEN`, `UPSTREAM_ACCESS_CLIENT_ID` and `UPSTREAM_ACCESS_CLIENT_SECRET`. A new address needs a new Access pair; blank credentials keep saved values only for the same address. Clear removes the address and every upstream credential. Preview and results never print credentials or the saved address. Verify reports a connection layer code and sends no peer message or task. Keep secrets out of arguments, chat and MCP tool inputs.
