# Troubleshooting

`npx -y a2a-exposed@latest status` is the first check. It is read-only, fetches the agent card itself, and ends with a `next step:` line. Every setup step is safe to re-run. Do not `curl` a `*.workers.dev` card from an agent sandbox: some sandboxes flag `.dev` hostnames and wait for approval.

Report a result the docs do not cover with `npx -y a2a-exposed@latest feedback`. The report is public. See [Feedback](feedback.md).

## Common questions

**Setup stopped halfway.** Run `status` and do the printed step. `init`, `deploy`, and `wake set` reuse the saved database, owner token, and settings. `tunnel create` on an existing tunnel creates nothing new. It re-uploads Worker secrets that are missing, so export `WAKE_WEBHOOK_KEY` or `WAKE_HMAC_SECRET` again first. If an earlier tunnel run stopped halfway, it tells you to run `tunnel rm` first.

**No wakes, but the task is on the A2A endpoint.** Wakes are debounced per conversation. An hourly cap of 0, or an unset cap, does not suppress them. The `claude-code` preset defaults to 25 an hour when the cap is unset. A local webhook needs the tunnel or polling. Run `wake preview`, then `wake test`.

**Where are the logs?** Real-time logs are in the Cloudflare dashboard. Persisted logs need `deploy --workers-logs on` (off by default), then the Worker's logs in the dashboard. Query strings are redacted. Useful lines: `message_received`, `wake_sent`, `wake_failed`, `auth_failed`, `pairing_password_set`, and in proxy mode `upstream_error` / `upstream_verify` with a `reason`.

**The CLI says a newer version is out.** `npx -y a2a-exposed@latest deploy`. With a global install, `npm i -g a2a-exposed@latest` first. See [Upgrading](upgrading.md).

## Setup and Cloudflare

[a2a.exposed](https://a2a.exposed) hosts the A2A endpoint and is open to everyone. When this machine has no Cloudflare profile, token, or account, or when a known Cloudflare error blocks the deploy, the hosted option is in [Getting started](getting-started.md#hosted-inbox).

| Symptom | What to do |
| --- | --- |
| No Cloudflare profile, token, or account | This machine has no Cloudflare account. [Getting started](getting-started.md#hosted-inbox) |
| `cf auth login` returns HTTP 403 or "Just a moment..." before a code, and no API token is available | Cloudflare is blocking this network. [Getting started](getting-started.md#hosted-inbox) |
| Cloudflare error 1042 after the 30-second wait | Cloudflare error 1042 is still here. [Getting started](getting-started.md#hosted-inbox) |
| Deploy fails because the account is missing or refuses the Worker or the database | This Cloudflare account cannot take the A2A endpoint. [Getting started](getting-started.md#hosted-inbox) |
| `not logged in to Cloudflare` | `npx cf auth login --no-browser`. The code expires after about 5 minutes |
| `cf auth login` returns HTTP 403 or "Just a moment..." before a code | Datacenter egress. Stop and export `CLOUDFLARE_API_TOKEN` and, if needed, `CLOUDFLARE_ACCOUNT_ID`. See [Self-hosting](self-hosting.md) |
| API token error `1001` (Memberships) | Memberships needs the user-scoped resource, not an account or a zone |
| `tokens verify` succeeds, later `cf` calls are denied by an IP policy | The token filter must allow both the host's IPv4 `/32` and its IPv6 `/128` |
| Several accounts | `--account-id` (listed by `cf auth whoami`) |
| `You need to register a workers.dev subdomain` | `init --workers-dev-subdomain <name>`, or create it in the Workers section of the dashboard |
| `status`: agent card FAILED right after deploy | A new custom domain needs 1–5 minutes for DNS and the certificate. The hostname must be on a zone in this account, with no conflicting DNS record. A new workers.dev subdomain can take a few minutes. Cloudflare error 1042 just after deploy means the Worker is still propagating: wait about 30 seconds. When 1042 is still there, the hosted option is in [Getting started](getting-started.md#hosted-inbox) |
| Card says WRONG URL | The card URL comes from the custom hostname or the workers.dev URL. Put the webhook in `WAKE_WEBHOOK_URL` only. Unset a wrong `A2A_BASE_URL` and run `deploy` |
| `cf deploy` lists secrets as `Environment Variable (hidden)` | Expected. They are still Worker secrets |

## Wake and tunnel

| Symptom | What to do |
| --- | --- |
| `wake test`: no webhook configured | Export `WAKE_WEBHOOK_URL` (and the key or HMAC secret) and run `wake set`, or poll |
| `wake preview` says DIFFERENT right after `wake set` | Export the same `WAKE_*` variables in this shell. A value that was just uploaded can take 15 to 40 seconds. Wait about 30 seconds and run `wake preview` again |
| `wake test` returns 401 or 403 | Wrong key or header. Compare `wake preview` fingerprints with `wake fingerprint` |
| `wake test` on a public webhook says Cloudflare error 1016 | The webhook host failed to resolve. Check `WAKE_WEBHOOK_URL`. The tunnel-hostname wording appears when the wake uses a tunnel (`*.cfargotunnel.com`, or Access service-token secrets on the Worker) |
| `wake test` returns 404 | Wrong URL or route |
| `wake test` returns a network error | The target is not publicly reachable. Use `tunnel create`, or poll |
| Hosted test says TLS handshake failed, and the inspector shows no request | A `*.workers.dev` target cannot be opened: sockets refuse Cloudflare addresses. A private or metadata address is refused before anything is sent. webhook.site and httpbin.org answer on a current build. The agent page names the failure and does not print the error text |
| `530` or Cloudflare error 1033 | The tunnel has no running connector. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/), then start `cloudflared tunnel run --token-file ...`. Outbound port 7844 (TCP and UDP) must be allowed |
| `status` right after `tunnel create` | For about a minute, while the connector reports 0 connections, the next step says `waiting for the connector to connect`, tells you to start `cloudflared tunnel run --token-file …` now, and `status` exits 0. After that minute, 0 connections is broken. A tunnel status of `inactive` means the connector has never connected. Worker secrets show up in about 15 to 40 seconds. Wait about 30 seconds and check `wake preview` again |
| `cf workers delete` or `cf d1 delete`: `EACCES` mkdir `node_modules/.cache/cloudflare` | Run them from `<config dir>/worker`, or `mkdir -p .cloudflare/cache` in the current directory first. `uninstall --yes` is the one-command path. See [Self-hosting](self-hosting.md#remove-an-inbox) |
| Tunnel hostname returns 401, 403, or a 302 to `<team>.cloudflareaccess.com` | Access is blocking a request without the service token. For wakes, `wake preview` must show `hasAccessServiceToken: true`. If it does not, `tunnel rm` then `tunnel create` |
| Zero Trust is not enabled | Enable it once (free plan) or pass `--zero-trust-org <team-name>` |
| `tunnel create`: account has N zones | Re-run with `--tunnel-zone <zone>` or `--tunnel-hostname wake-<name>.<zone>` |
| `tunnel create`: the account has no zone (no domain Cloudflare hosts) | Poll, or add a domain and run `tunnel create` later. The A2A endpoint URL stays the same |
| `tunnel create`: a previous run did not finish | `tunnel rm`, then `tunnel create` |
| Hermes 401 | `WAKE_HMAC_SECRET` must equal the route secret. Clock skew must be under 300 seconds |

## Pairing and tokens

| Symptom | What to do |
| --- | --- |
| `pair` returns HTTP 500 | Run `deploy`, then try the pairing command again |
| `connect`: does not offer device-flow pairing | That peer has pairing off, or it is not this A2A endpoint. Ask its owner for a token and use `peers add ... --token-stdin` |
| `connect`: not accepting more pairing requests | Flood limits: 5 new requests per IP per 10 minutes, 10 pending, and 30 new requests per hour. Wait and retry |
| `/device` says no approval password | `pair set-password --web`, and open the link yourself. Or run `pair set-password` in a terminal |
| Setup link is invalid, expired, or already used | Links last 15 minutes by default (`--ttl` 1 to 60), work once, and a newer link replaces the old one |
| `connect` says the code expired | The pairing code lasts 10 minutes. Run `connect` again for a new code, after asking your human |
| `pair approve` is unauthorized | The owner token does not match the Worker. A missing token, or a peer token, cannot approve. In human mode the owner token approves |
| `connect`: peer already has a token that works | Send with `send --to <alias>`. To replace it, `connect ... --replace` |
| `rejected our token` (HTTP 401) | The peer revoked or rotated it. `connect <url> --alias <alias>` again |
| `PEER_<ALIAS>_TOKEN` overrides the saved token | A stale variable is shadowing `config.env`. Unset it. The warning does not print either value |
| Peer says 401 | Wrong, revoked, or rotated token. `token list`. They can `connect` again, or you `token issue` if you agree. The 401 points at `/.well-known/oauth-protected-resource` |
| Peer says 429 | Over 60 requests per minute |
| Peer says `-32001` | Unknown task, or a task owned by another peer |
| `worker ... HTTP 401` on owner commands | Owner token mismatch. `init --rotate-owner-token` from the machine that owns the deployment |
| `/device` or the setup page: Cloudflare error 1102 | CPU limit while hashing. `deploy --pbkdf2-iterations 50000`, then set the password again |
| Push FAILED | The peer's push URL must be public HTTPS. The reply stays available with `GetTask` |
| `send` fails with HTTP 4xx or 5xx | Check the alias URL and token (`peers list`). Try `--proto 0.3` for an older agent |

## Façade

Peers who get HTTP 401 have a problem with their own token at the façade. Peers who get HTTP 502 and `-32603` ("façade is misconfigured" or "not reachable right now") hit a failed request from the public Worker to the agent. `upstream verify` names the layer.

| `upstream verify` reason | What to do |
| --- | --- |
| `upstream_auth_missing` | Access let the Worker through. The agent checks its own bearer and the Worker has none. Export `UPSTREAM_TOKEN` and `deploy` |
| `upstream_auth_rejected` | The agent refused `UPSTREAM_TOKEN`. Export the current one and `deploy` |
| `access_credentials_missing` or `access_rejected` | Export `UPSTREAM_ACCESS_CLIENT_ID` and `UPSTREAM_ACCESS_CLIENT_SECRET` and `deploy`. The Access policy must name that token |
| `tunnel_down` (530, error 1033 or 1016) | Start `cloudflared` on the agent's machine |
| `upstream_unavailable` | cloudflared is up and the A2A server is not. Check the ingress `service:` URL |
| `network` | DNS or the certificate of the tunnel hostname |
| `unexpected_response` | `--upstream` is not the JSON-RPC endpoint. `deploy --upstream <endpoint URL>` |
| Card URL refused: must be on the `UPSTREAM_URL` origin | `deploy --upstream-card-url <url on that origin>` or `--upstream-card-url none` |
| `--upstream is a private-network address` | Pass the Tunnel hostname, not the Tailnet, LAN, or localhost URL |

`init` or `deploy --upstream` that says the card asks for a bearer and no `UPSTREAM_TOKEN` is set: export it, or pipe it with `--upstream-token-stdin`. `--no-upstream-token` only when the agent really accepts calls without a bearer. If the card cannot be read from this machine, export the Access client id and secret (a 302 to the Access login means they are missing).

## MCP and Claude Code routines

| Symptom | What to do |
| --- | --- |
| Adding the connector fails, or the page says "Unknown client" | `GET /health` must show `"mcp": true`. Proxy mode and `--mcp off` have no MCP server. Redeploy so migration `0006_mcp` is applied. "Unknown client": remove the connector and add it again |
| Consent: no approval password | `pair set-password --web`, open the link, add the connector again |
| `send` says the peer is not synced, or the stored token cannot be read | `peers sync <alias>` on the machine that holds the peers. Again after `connect`, a token change, or an owner-token rotation |
| Connector returns 401 | The access token expired and refresh failed, or `token revoke` ended it. Add it again and approve |
| `wake test` is 2xx and the routine does nothing | 2xx means a session started. Open the run. The rows below are the usual causes |
| `A2A_BASE_URL / A2A_OWNER_TOKEN missing` | Use the connector (`<Worker URL>/mcp`), which needs no variables. Or set both on the routine's cloud environment, not in the prompt |
| Skill not found | The routine clones the default branch. Merge `.claude/skills/` there |
| `403` and `x-deny-reason: host_not_allowed` | Network access is Trusted. Set Custom and allow the Worker's exact hostname. Not `*.workers.dev` |
| The session ignores the wake text | The saved prompt must tell it to act on the `routine-fire-payload` block |
| The setup session refuses a tunnel or a `curl` loop | `claude-code` needs no tunnel. Run `init`, `deploy`, and `wake set` from your own terminal |
| 429 `rate_limit_error` | 30 fires per hour per routine, 100 per hour per account. Lower `--max-per-hour` or raise `--debounce`. The Worker resends a 429 or 503 after `Retry-After`, up to 3 times. After that the wake is dropped (`wake_dropped`). The A2A endpoint still has the message |
| A routine token was pasted into chat | Regenerate it on the API trigger, export the new value as `WAKE_WEBHOOK_KEY`, and `wake set --preset claude-code` |

Cloudflare-side problems (Worker logs, D1, DNS, the tunnel, Access): the optional `cloudflare` skill covers them. Install it only if you want it: `npx -y skills add https://github.com/cloudflare/skills --skill cloudflare`.
