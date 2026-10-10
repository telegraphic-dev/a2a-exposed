# Deploy

The wake target can be configured later. If the user already has it, export the secrets first (see [wake](wake.md)). `init` never takes secrets as arguments.

```bash
export WAKE_WEBHOOK_URL='...'      # optional now
export WAKE_WEBHOOK_KEY='...'      # optional (bearer/API key)
export WAKE_HMAC_SECRET='...'      # optional (hermes / signed generic webhooks)
# omit --hostname to deploy to https://<worker-name>.<account-subdomain>.workers.dev
npx -y a2a-exposed@latest init \
  --hostname agent.example.com \
  --agent-name "My Agent" \
  --agent-description "What this agent does, for other agents" \
  --preset grok-bot                # grok-bot | claude-code | openclaw-wake | openclaw-agent | hermes | generic
```

`init` is non-interactive and idempotent. It:

1. Checks Node and the cf login, and resolves the account. If the login can see several accounts, pass `--account-id`.
2. Copies the Worker template to `<config dir>/worker` and runs `npm install` there (this provides the local `cf`).
3. Creates the D1 database (`--d1-name`, default: the Worker name `a2a-exposed`), or reuses an existing one with that name, and applies migrations.
4. Generates the **owner token** and uploads it with any wake secrets via a temporary chmod-600 secrets file, which is deleted afterwards.
5. Deploys with the custom domain (or to workers.dev, redeploying once so the card advertises the learned URL), saves `A2A_BASE_URL` and `A2A_OWNER_TOKEN`, and checks the agent card. Right after a first deploy the workers.dev edge can answer Cloudflare error 1042 ("no Worker for this host") for up to ~30 s, sometimes after one good answer, so `init` waits until the card is served twice in a row and says when it is still propagating.

Optional flags:

| Flag | Purpose |
|---|---|
| `--agent-skills '<JSON array of A2A AgentSkill>'` | Skills advertised on the card |
| `--provider-organization`, `--provider-url` | Provider shown on the card |
| `--worker-name` | Worker name (also the default D1 name) |
| `--d1-name` | D1 database to create or reuse (default: worker name). Useful when several bots share an account |
| `--cli-command` | Command shown in wake hints (`hint` / summaries). Default `npx -y a2a-exposed@latest`. For a checkout, pass e.g. `node /path/to/repo/cli/bin/a2a-exposed.mjs`. Saved as `WAKE_CLI_COMMAND` |
| `--debounce <s>` | Wake debounce window |
| `--pairing-approval human\|agent\|off` | Who approves device-flow pairing requests ([pairing](pairing.md)). `human` (default): your human, on the `/device` page, with an approval password only they know. `agent`: also `pair approve <code>` by the agent after asking its human in chat. `off`: no pairing endpoints; `token issue` only. Change it later with `deploy --pairing-approval ...` |
| `--max-per-hour <n>` | Hourly wake cap |
| `--cf-profile <name>` | Use a named cf auth profile (separate Cloudflare login). Saved as `CF_PROFILE` |
| `--workers-dev` | Move to workers.dev: clears the saved hostname, so the base URL, agent card and printed URLs become `https://<worker>.<subdomain>.workers.dev`. The old custom domain then answers 410 (its agent card redirects 301 to the new card) until you detach it in the dashboard; peers must update their URL. `--hostname <host>` on a workers.dev deployment moves it back (the workers.dev route is switched off). A wake tunnel keeps working (it has its own hostname on a zone) |
| `--workers-dev-subdomain <name>` | Register the account's workers.dev subdomain if it has none |
| `--pbkdf2-iterations <n>` | Cost of hashing the approval password, 50000 to 100000 (default 100000, the Workers maximum). Lower it only if approving on `/device` fails with Cloudflare error 1102 (CPU limit; see **Pairing security**), then set the password again |
| `--workers-logs on\|off` | Persisted Cloudflare Workers Logs (searchable in the dashboard under the Worker's **Logs**; query strings redacted). Off by default: only real-time logs (`npx cf workers tail`, if your cf version has it, or the dashboard's live view) |
| `--worker-dir <dir>` | Where the Worker project (template copy) lives; default `<config dir>/worker`. `--dir` is the old name. Not the config dir: that is the global `--config-dir <dir>` (same as `A2A_CONFIG_DIR`) |
| `--cron` | Adds a one-minute cron flush. Needs a workers.dev subdomain on the account (works with workers.dev deployments); not required, because pending wakes are also flushed on every request |

To redeploy later (after an upgrade or settings change), run `npx -y a2a-exposed@latest deploy`. Existing secrets persist.

Verify:

```bash
npx -y a2a-exposed@latest status     # agent card: OK: "<agent name>" (A2A 1.0, 0.3), then the next step
```

The card name should match `--agent-name`, and the versions should list 1.0 first, then 0.3. `status` fetches the card itself, so no `curl` is needed. A new workers.dev subdomain or custom domain can take a few minutes; if the card check fails, run `status` again. `status` names Cloudflare errors (1042 right after a deploy means the Worker is still propagating: retry in 30 s). `/.well-known/agent-card.json` is the A2A 1.0 card (with 0.3 interfaces listed); `/.well-known/agent.json` serves the same agent as an A2A 0.3-shaped card (`url`, `protocolVersion`, `preferredTransport`) for 0.3 clients.

### Adopting an existing deployment (same Worker, D1 and hostname)

There is no `adopt` command yet. To move a Worker that runs an earlier build of this code (same D1 schema, e.g. the s2a2a prototype) onto the CLI without losing data, peers or wake secrets:

1. Back up the D1 database first (for example, export every table with `npx cf d1 query <db-id> --sql ...`, and note the time-travel bookmark from `npx cf d1 time-travel get-bookmark <db-id>`).
2. Write `config.env` yourself (chmod 600) with `CLOUDFLARE_ACCOUNT_ID`, `A2A_WORKER_NAME`, `A2A_D1_NAME`, `A2A_D1_ID`, `A2A_HOSTNAME` (a workers.dev Worker: leave it out and set `A2A_WORKERS_DEV_SUBDOMAIN`), `A2A_BASE_URL`, the **existing** owner token as `A2A_OWNER_TOKEN`, and the agent-card settings (`A2A_AGENT_NAME`, `A2A_AGENT_DESCRIPTION`, `A2A_AGENT_SKILLS`, ...). With `A2A_D1_ID` already saved, the saved hostname (or workers.dev) is not treated as a move.
3. Run `npx -y a2a-exposed@latest deploy --preset <preset>` with **no** `WAKE_*` (or `UPSTREAM_*`) variables exported. `deploy` (unlike `init`) uploads no secrets file when none are exported, so `OWNER_TOKEN` and the wake secrets already on the Worker are kept. It also applies the pending D1 migrations (`0002_wake_budget`, `0003_device_pairing`, `0004_pairing_replace`, `0005_facade_owners`) and prints `applied: ...`.
4. Run `npx -y a2a-exposed@latest status`. The agent card should show the existing name and base URL, and the wake mode should match the wake the Worker already had. Continue from its `next step:` line.
5. Peer tokens live in D1 as SHA-256 hashes, and lookups are by hash, so existing tokens (including the older `s2a_` prefix) keep working; nothing needs reissuing.
6. Device-flow pairing ([pairing](pairing.md)) is on after the deploy, with `human` approval: run `pair set-password --web` and send your human the one-time link (or they run `pair set-password` in a terminal). To keep tokens manual only, deploy with `--pairing-approval off`.

Migrations are tracked by file name, and `deploy` applies every file not yet recorded in `d1_migrations`, in numeric order, including a lower number added later. So an older `0001_init.sql` that is already recorded is not re-run. `0002_wake_budget.sql` adds the one table the earlier schema lacked (on newer databases it does nothing), `0003_device_pairing.sql` adds pairing, and `0004_pairing_replace.sql` adds one column for re-pairing (`connect --replace`). A database that already recorded `0003` under v0.2.0 still gets `0002` (and `0004`) on its next `deploy`.

### Already have A2A on a Tailnet or LAN: expose it through a public façade

Use this when the agent **already serves A2A JSON-RPC** (1.0 or 0.3) on a private address: a Tailnet name (`https://jean.tail1234.ts.net/a2a`), a LAN IP, or `localhost`. Don't fall back to the webhook inbox or polling, and never advertise the private card: its URLs are unreachable for everyone else, and they leak your network layout. Instead the Worker becomes a **public façade** (proxy mode, `--upstream`):

```
peer ──HTTPS + per-peer bearer──> https://agent.example.com            (Worker: rewritten card, device-flow pairing,
                                                                          token check, per-peer task isolation)
      ──Access service token + UPSTREAM_TOKEN──> https://agent-upstream.example.com/a2a   (Cloudflare Tunnel hostname,
                                                                                         Access admits only the Worker)
      ──cloudflared on the agent's machine──> http://127.0.0.1:8080/a2a  (or the Tailnet / LAN address)
```

A Worker can't reach a Tailnet or LAN address, so the upstream is published through a **named Cloudflare Tunnel** whose hostname is locked by a **Cloudflare Access** app that admits only one service token, held by the Worker (the same pattern as the wake tunnel). The CLI refuses a private `--upstream`.

1. **Tunnel + Access for the upstream** (manual for now; a `tunnel create --upstream` helper is planned). Ask the user first: this creates DNS, a tunnel, and Access objects. Needs Zero Trust (free) and a zone on the account. On the agent's machine:

   ```bash
   cloudflared tunnel login                       # once, picks the zone
   cloudflared tunnel create agent-upstream
   cloudflared tunnel route dns agent-upstream agent-upstream.example.com
   # ~/.cloudflared/config.yml
   #   tunnel: <tunnel id>
   #   credentials-file: ~/.cloudflared/<tunnel id>.json
   #   ingress:
   #     - hostname: agent-upstream.example.com
   #       service: http://127.0.0.1:8080          # the agent's A2A server (cloudflared inside the Tailnet can use its ts.net name)
   #       originRequest:
   #         access: { required: true, teamName: <team>, audTag: [<Access app AUD>] }
   #     - service: http_status:404
   cloudflared tunnel run agent-upstream
   ```

   In Zero Trust: **Access → Service credentials**, create a service token (copy the client id and secret once); **Access → Applications**, add a self-hosted app on `agent-upstream.example.com` with exactly **one policy: Service Auth** for that token (no email or everyone rules). Check that a bare `GET https://agent-upstream.example.com/.well-known/agent-card.json` is refused (401/403 or a redirect to `<team>.cloudflareaccess.com`).

2. **Deploy the façade** (new or existing deployment). Credentials come from the environment only, never argv:

   ```bash
   export UPSTREAM_ACCESS_CLIENT_ID='<service token client id>' UPSTREAM_ACCESS_CLIENT_SECRET='<secret>'
   export UPSTREAM_TOKEN='<bearer the agent expects>'     # the agent's own token (Hermes: the bearer its A2A server checks)
   npx -y a2a-exposed@latest init --hostname agent.example.com --upstream https://agent-upstream.example.com/a2a
   #   existing deployment: npx -y a2a-exposed@latest deploy --upstream https://agent-upstream.example.com/a2a
   #   card elsewhere:      --upstream-card-url https://agent-upstream.example.com/.well-known/agent-card.json  # same origin as --upstream (credentials ride with the fetch)
   #   back to the inbox:   deploy --upstream none
   npx -y a2a-exposed@latest status        # upstream card ok; Access credential and upstream bearer configured; upstream check OK; next step
   ```

   The two credentials do different jobs: the **Access service token** only gets the Worker through the tunnel; the **`UPSTREAM_TOKEN`** is what the agent itself checks. Setup reads the upstream's agent card and, unless it declares no bearer auth, needs `UPSTREAM_TOKEN`. Not exported? On a terminal it asks (hidden input); otherwise it exits 1 and says what to do. Other ways to pass it (never as an argument): `<command that prints it> | npx -y a2a-exposed@latest deploy --upstream-token-stdin`. An agent that really takes no bearer: `--no-upstream-token` (saved). Then check the whole path once: `npx -y a2a-exposed@latest upstream verify` (it creates no task; details in Troubleshooting).

3. **Pairing** is unchanged and stays on the façade: set the approval password ([pairing](pairing.md)), then peers run `connect https://agent.example.com`. A wake webhook is optional (it only announces pairing requests); messages go to the upstream, so the inbox stays empty.

**Agent card rewrite (always on in proxy mode).** The façade fetches the upstream's card (cached 5 minutes, with the Access token and `UPSTREAM_TOKEN`; so `--upstream-card-url` must be on the `--upstream` origin, anything else is refused by `deploy` and by the Worker), and serves a rewritten copy at `/.well-known/agent-card.json` (A2A 1.0) and `/.well-known/agent.json` (0.3 shape):

- `supportedInterfaces`: one JSONRPC interface per version the upstream advertises (1.0 and/or 0.3), every one at `https://agent.example.com/`. Upstream interface URLs, gRPC / HTTP+JSON interfaces, `url`, `additionalInterfaces` and `preferredTransport` are never copied.
- `securitySchemes` / `securityRequirements`: the façade's (per-peer `bearer` + device-flow `pairing` with `/oauth/*` URLs on the façade). The upstream's own schemes describe the credential the façade holds, not what callers need.
- `capabilities`: `extensions` from the upstream; `streaming` and `extendedAgentCard` are `false` (not proxied yet), and `pushNotifications` is `false` (push configs are refused, see below).
- name, description, version, skills, default modes, provider, `documentationUrl`, `iconUrl`: `--agent-*` / `--provider-*` / `A2A_DOCUMENTATION_URL` settings win, then the upstream card, then defaults. Every string is scrubbed: a private or upstream URL (localhost, RFC 1918, 100.64/10, private IPv6 literals like `[::1]` / `[fd..]` / `[fe80..]` / IPv4-mapped, `*.ts.net`, `*.local`, single-label hosts, plain `http`, URLs that don't parse, the tunnel hostname) becomes `[private URL removed]`, a bare upstream or `*.ts.net` host name `[private host removed]`. `documentationUrl`, `iconUrl` and `provider.url` are dropped instead when private.
- `signatures` are dropped (they no longer match), and unknown top-level fields are not copied.
- If the upstream card can't be fetched, the façade serves a card from the settings (1.0 and 0.3 interfaces, still only public URLs) and `status` says why.

The inbox card (no `--upstream`) uses the same scrubbing for `--agent-description`, `--agent-skills`, `--provider-url` and `A2A_DOCUMENTATION_URL`, so a pasted Tailnet link never reaches peers.

**Upstream credential model.** The façade holds **one** upstream identity (`UPSTREAM_TOKEN` + the Access service token) and calls the agent for every paired peer; the peer's own token never leaves the façade. The peer label goes upstream in `X-A2A-Peer` (trustworthy only because Access admits nothing but the Worker). Because peers share that identity, the façade keeps them apart itself: it records which peer created each task and context (D1 `facade_owners`), and refuses `GetTask` / `CancelTask` / push-config calls on another peer's task (also as a message's `taskId` or `referenceTaskIds`), or a message into a context the peer didn't get from the agent through the façade, before they reach the agent. That check fails closed: a client-chosen or otherwise unrecorded `contextId` is refused (the façade can't tell a new id from someone else's live context), so a peer starts a conversation without `contextId` and reuses the one returned. `ListTasks` is refused (it would list everyone's tasks), streaming returns `-32004`, and push notification configs are refused with `-32003`: the agent would call the peer's URL from inside your private network, where even a public-looking name (`127.0.0.1.nip.io`, split-horizon DNS) can resolve to a private address, so no check at the façade makes that safe. Peers poll `GetTask` instead. A relay through the Worker is a planned follow-up. An upstream 401/403 or a non-JSON answer becomes a generic `502` JSON-RPC error (`-32603`, naming no secret, lock or upstream host), never a 401 to the peer; the operator gets the reason from `status` / `upstream verify` and the Worker log line `upstream_error` (`reason`: see Troubleshooting).

**Threat model (proxy mode).** Two locks guard the upstream: Access (only the Worker's service token gets through the tunnel hostname) and `UPSTREAM_TOKEN` (the agent's own check; keep it on). Public callers need a per-peer token from pairing (human approval) or `token issue`, and `token revoke` cuts one off at the façade immediately. Unchanged caveats: whoever holds the owner token (the agent's `config.env`) can issue tokens and replace the approval password, so a compromised agent with the owner token can let anyone in; and whoever controls the Cloudflare account can read the Worker's secrets and call the agent as the façade. The owner API never returns the upstream secrets (fingerprints only). The façade passes task contents through verbatim: it does not rewrite URLs inside replies or artifacts, so the agent must not put private links in what it sends back.

**Pairing out while you build the façade.** A Tailnet agent can already connect to other inboxes: `connect https://b.example.com --card-url https://jean.tail1234.ts.net/.well-known/agent-card.json`. A private https card is sent as informational, and the other owner's approval page and wake flag it as "not publicly reachable"; a non-https card is left out (as before). Replies reach you by polling (`poll`) until the façade is up.

## Multi-tenant settings (leave unset)

`init` and `deploy` do not set these, and a self-hosted inbox should leave them unset. Unset is the single-tenant Worker on your D1 database, with `OWNER_TOKEN` as the owner credential and as the key that encrypts synced peer tokens. There is no default hostname to fill in.

Setting `TENANCY=host` changes the built Worker: the entry becomes the multi-tenant router, with a SQLite Durable Object binding (`TENANT_DO`) and a KV name directory (`TENANT_DIRECTORY`). A request to `https://<name>.<TENANT_DOMAIN>` is served from that tenant's object after control pushes its config. `TENANCY=host` without the binding (or the binding without `TENANCY=host`) still uses `env.DB` and `OWNER_TOKEN`. `DATA_REGION=eu` or `fedramp` is copied onto a directory entry the first time that entry has no region (`default` when this is unset). After that the stored region places the tenant, and changing `DATA_REGION` does not move it. `QUOTAS`, `USAGE_SINK`, `WAKE_TARGET_POLICY`, `SIGNUP_URL` and `BRANDING` are reserved (the Worker reads them and does not change requests yet). `APPROVAL_OIDC_*` turns on OpenID Connect approval on `/device` and the MCP consent page when the issuer, client id, client secret and allowlist are all set; unset, those pages stay password-only. `npx -y a2a-exposed@latest pair set-oidc` writes the non-secret settings. The client secret is `APPROVAL_OIDC_CLIENT_SECRET` in the environment (or `--secret-stdin`) and is uploaded on the next `npx -y a2a-exposed@latest deploy`, not stored in `config.env`. With `TENANCY=host`, debounced wakes (including a window longer than the in-request wait) and the minute cron's housekeeping (old rate rows, wake budget, pairing rows, expired OAuth codes) run from a Durable Object alarm per tenant. `--cron` still flushes a self-hosted inbox on `env.DB`. `A2A_BACKUP_BUCKET=1` adds a daily R2 snapshot of each inbox, kept 30 days; that cron returns before the flush. Leave it unset and the deploy has no backup bucket and no extra cron. Names and values are listed in `worker/deploy.env.example`.
