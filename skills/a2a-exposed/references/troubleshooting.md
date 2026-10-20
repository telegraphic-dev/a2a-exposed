# Troubleshooting the A2A endpoint

One present-tense action per symptom. Cloudflare login, error 1042, and the hosted A2A endpoint are in the setup skill: [setup troubleshooting](../../a2a-exposed-setup/references/troubleshooting.md).

| Symptom | Action |
| --- | --- |
| `A2A_BASE_URL / A2A_OWNER_TOKEN missing` | Run the setup skill, or set both as environment secrets. In a Claude Code routine, use the connector tools when the session has them. |
| `worker ... HTTP 401` | The owner token in `config.env` differs from the Worker secret. Run `init --rotate-owner-token` from the machine that owns the deployment. |
| `request to ... failed` | DNS, network, or egress. Run `status`. A new custom domain takes a few minutes. |
| No wakes arriving | Run `status`, then `wake preview`, then `wake test`. An agent behind NAT uses `tunnel create` (a zone on the account) or polling. |
| `wake preview` says DIFFERENT | Export `WAKE_WEBHOOK_URL`, `WAKE_WEBHOOK_KEY`, and `WAKE_HMAC_SECRET` in this shell. A fresh upload takes about 15 to 40 seconds. Wait about 30 seconds and run `wake preview` again. |
| `wake test` says Cloudflare error 1016 on a public webhook | That webhook host failed to resolve. Check `WAKE_WEBHOOK_URL`. A tunnel wake names the tunnel hostname's DNS record. |
| `wake test` returns TLS Handshake Failed and the inspector shows no request | Use a public HTTPS wake URL. webhook.site and httpbin.org accept a test. A `*.workers.dev` target is refused. |
| Peer says 401 | That peer token is wrong, revoked, or rotated. They pair again with `connect`, or you issue a new token when the user agrees. |
| `send` / `poll`: `<alias> rejected our token` | The peer revoked or rotated the token. Run `connect <url> --alias <alias>`. |
| `connect` exits 1 | The request was denied, it expired, the alias is already connected, or the peer has no device flow. The command prints the next step. |
| Cloudflare error `1042`, `1101`, `1102`, or similar | Follow the setup skill. It names 1042 after the 30-second wait, a data-center or network error, and an account that cannot take the Worker. Error 1102 on `/device` uses `--pbkdf2-iterations`. |
| A newer CLI is announced on stderr | Run `npx -y a2a-exposed@latest deploy`. With a global install, run `npm i -g a2a-exposed@latest` first. `A2A_NO_UPDATE_CHECK=1` silences the notice. |
| Peer says 429 | The peer exceeded 60 requests per minute. |
| Peer says -32001 | The task is unknown, or another peer owns it. |
| Proxy mode: peers get HTTP 502 | Run `upstream verify`. It names the layer. A peer 401 is that peer's own token. |
| `status` warns `PEER_<ALIAS>_TOKEN` overrides the saved token | A stale environment variable shadows the saved token. Unset it where it is set. |
| `send` fails with `peer returned HTTP 4xx/5xx` | Check the alias URL and token with `peers list`. Try `--proto 0.3` for an older agent. |
| Push FAILED | The peer push URL must be public HTTPS. The reply stays available through `GetTask`. |
| Worker logs | Live logs are in the Cloudflare dashboard. Persisted logs follow `deploy --workers-logs on`. Lines include `message_received`, `wake_sent`, `wake_failed`, `auth_failed`, and `upstream_error`. |
| Redeploy after an upgrade | Run `npx -y a2a-exposed@latest deploy`. Secrets on the Worker stay. |

Cloudflare-side problems (Worker logs, D1, DNS, the wake tunnel, Access): the optional **cloudflare** skill helps. Offer it, and install it only if the user agrees: `npx -y skills add https://github.com/cloudflare/skills --skill cloudflare`.

## CLI and configuration

Installing this skill gives the agent the workflow documentation. Run every command as `npx -y a2a-exposed@latest <cmd>` (Node 22.18+; how to get Node: setup skill §1, or `mise exec node@22 -- ...`). Don't `npm i -g` it inside an agent sandbox: global installs there are often blocked as untrusted code. `@latest` always runs the newest release. A global install is only an optional speed-up on the user's own machine (`npm i -g a2a-exposed@latest`, then `a2a-exposed <cmd>`); it never upgrades itself, so the CLI prints a one-line notice on stderr when a newer version is out. Config lives in `~/.config/a2a-exposed/config.env` (chmod 600). Environment variables always override the file. Development from a checkout: `node <checkout>/cli/bin/a2a-exposed.mjs <command>`, and pass the same path as `--cli-command` on `init` if the wake hint should use it (default wake hint is `npx -y a2a-exposed@latest`).

## Other commands

- One A2A endpoint has one owner token, from `init`. `GET /` in a browser shows the agent card. `/device` approves or denies a pairing request. `pair set-password` sets the approval password. `pair set-oidc` adds OpenID Connect on `/device` and the MCP consent page when the issuer, client id, client secret, and allowlist are all set.
- `npx -y a2a-exposed@latest contexts` lists recent conversations.
- `npx -y a2a-exposed@latest export` prints a JSON dump of the A2A endpoint (peer-token hashes are in the dump; outbound peer tokens are ciphertext under this deployment's sealing key; the owner token stays a Worker secret). `export --sql` prints SQL.
- `npx -y a2a-exposed@latest status` checks the setup: the agent card (fetched by the CLI; it advertises the A2A endpoint's own base URL), the wake mode (webhook, tunnel, or none, meaning polling), the tunnel state, and a `next step:` line. When the Worker reports MCP enabled and the agent card is reachable, it prints `claude mcp add --transport http a2a-exposed <base URL>/mcp`. Use `status` rather than `curl`: some sandboxes hold a `.dev` URL for approval.
- Proxy mode (`deploy --upstream ...`, see the setup skill): this deployment is a public façade for an agent that already speaks A2A. Peer messages go straight to that agent, so `inbox` stays empty; pairing, `token ...` and `status` (with `upstream`, `upstream Access`, `upstream bearer` and `upstream check` rows) work as usual. `npx -y a2a-exposed@latest upstream verify` checks the whole path to the agent without creating a task. Push notification configs are refused through a façade (`-32003`; peers poll `GetTask`), and peers can't reach each other's tasks or contexts.
- `npx -y a2a-exposed@latest url` prints the public base URL.
- `npx -y a2a-exposed@latest config` prints the config with secrets masked.
- `npx -y a2a-exposed@latest wake preview` shows the rendered wake request (a credential is `Bearer ••••` or `••••`, none of the secret) and short SHA-256 fingerprints of the uploaded URL/key. Export `WAKE_WEBHOOK_URL`, `WAKE_WEBHOOK_KEY`, and `WAKE_HMAC_SECRET` in that shell. `DIFFERENT` means the exported value and the Worker differ (absent here, or still propagating, about 15 to 40 seconds). `wake fingerprint` prints the local fingerprints; `wake test` sends a test wake. On a public webhook, Cloudflare error 1016 means that host failed to resolve.
