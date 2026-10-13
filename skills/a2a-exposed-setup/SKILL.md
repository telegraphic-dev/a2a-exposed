---
name: a2a-exposed-setup
description: Use when deploying, redeploying, or configuring the a2a-exposed Cloudflare Worker, a wake webhook, polling, or a public façade for an agent that already speaks A2A. Documented wake presets are Grok Bot, Claude Code, OpenClaw, and Hermes. Codex, Cursor, Grok Build, n8n, Zapier, and other generic webhooks are untested.
license: MIT
compatibility: Requires Node 22.18+; runs the a2a-exposed CLI with npx -y a2a-exposed@latest (no global install). Cloudflare account for deploy.
metadata:
  version: "0.8.1"
  author: Telegraphic Developer
  homepage: https://github.com/telegraphic-dev/a2a-exposed
  hermes.tags: a2a, agent2agent, cloudflare, workers, webhook, deploy, openclaw, hermes
  hermes.related_skills: a2a-exposed, mise, cloudflare
  openclaw.emoji: "🛠️"
  openclaw.requires.bins: node
  openclaw.env.A2A_CONFIG_DIR.description: "Override the config directory (default ~/.config/a2a-exposed). Use one per bot on a shared machine."
  openclaw.env.A2A_CONFIG_DIR.required: "false"
  openclaw.env.A2A_BASE_URL.description: "Public base URL of the deployed Worker (saved by init/deploy; usually not set by hand)."
  openclaw.env.A2A_BASE_URL.required: "false"
  openclaw.env.A2A_OWNER_TOKEN.description: "Owner API token for inbox/reply/token commands (saved by init; usually not set by hand)."
  openclaw.env.A2A_OWNER_TOKEN.required: "false"
  openclaw.env.A2A_OWNER_TOKEN.sensitive: "true"
  openclaw.env.A2A_HOSTNAME.description: "Custom hostname for the Worker (omit for workers.dev)."
  openclaw.env.A2A_HOSTNAME.required: "false"
  openclaw.env.CF_PROFILE.description: "Named cf auth profile (saved as CF_PROFILE in config.env)."
  openclaw.env.CF_PROFILE.required: "false"
  openclaw.env.CLOUDFLARE_ACCOUNT_ID.description: "Cloudflare account id (saved by init when the login has exactly one account)."
  openclaw.env.CLOUDFLARE_ACCOUNT_ID.required: "false"
  openclaw.env.WAKE_WEBHOOK_URL.description: "Wake webhook URL (Worker secret; put in the environment, never on the command line)."
  openclaw.env.WAKE_WEBHOOK_URL.required: "false"
  openclaw.env.WAKE_WEBHOOK_URL.sensitive: "true"
  openclaw.env.WAKE_WEBHOOK_KEY.description: "Wake webhook bearer or API key (Worker secret)."
  openclaw.env.WAKE_WEBHOOK_KEY.required: "false"
  openclaw.env.WAKE_WEBHOOK_KEY.sensitive: "true"
  openclaw.env.WAKE_HMAC_SECRET.description: "Wake HMAC secret for Hermes / signed presets (Worker secret)."
  openclaw.env.WAKE_HMAC_SECRET.required: "false"
  openclaw.env.WAKE_HMAC_SECRET.sensitive: "true"
  openclaw.env.WAKE_ACCESS_CLIENT_ID.description: "Cloudflare Access service-token client id for a wake tunnel (set by tunnel create)."
  openclaw.env.WAKE_ACCESS_CLIENT_ID.required: "false"
  openclaw.env.WAKE_ACCESS_CLIENT_ID.sensitive: "true"
  openclaw.env.WAKE_ACCESS_CLIENT_SECRET.description: "Cloudflare Access service-token client secret for a wake tunnel (set by tunnel create)."
  openclaw.env.WAKE_ACCESS_CLIENT_SECRET.required: "false"
  openclaw.env.WAKE_ACCESS_CLIENT_SECRET.sensitive: "true"
  openclaw.env.UPSTREAM_TOKEN.description: "Proxy mode (--upstream) only. The one bearer credential the façade presents to the private A2A agent (Worker secret)."
  openclaw.env.UPSTREAM_TOKEN.required: "false"
  openclaw.env.UPSTREAM_TOKEN.sensitive: "true"
  openclaw.env.UPSTREAM_ACCESS_CLIENT_ID.description: "Proxy mode only. Cloudflare Access service-token client id for the upstream's tunnel hostname (Worker secret)."
  openclaw.env.UPSTREAM_ACCESS_CLIENT_ID.required: "false"
  openclaw.env.UPSTREAM_ACCESS_CLIENT_ID.sensitive: "true"
  openclaw.env.UPSTREAM_ACCESS_CLIENT_SECRET.description: "Proxy mode only. Cloudflare Access service-token client secret for the upstream's tunnel hostname (Worker secret)."
  openclaw.env.UPSTREAM_ACCESS_CLIENT_SECRET.required: "false"
  openclaw.env.UPSTREAM_ACCESS_CLIENT_SECRET.sensitive: "true"
---

# a2a-exposed: setup

Deploys a Cloudflare Worker that gives this agent a public A2A endpoint with a D1 inbox. The Worker then wakes the agent through a webhook, or the agent checks the inbox on a schedule. Day-to-day use is covered by the **a2a-exposed** skill.

**In a Claude Code cloud session (a routine run or claude.ai/code)? Stop: don't run setup there.** Installs are blocked as untrusted code, a tunnel is refused as an ingress risk, the session has no Cloudflare credentials, and the network allowlist blocks the Worker. Tell the user to run this setup on their laptop or from another agent with a shell, then add `<Worker URL>/mcp` as a connector at claude.ai/settings/connectors; the routine only uses the inbox through the connector ([references/wake.md](references/wake.md), Claude Code).

Installing this skill gives the agent the workflow documentation. Every command runs as `npx -y a2a-exposed@latest <cmd>` (Node 22.18+; no Node 22 yet? see [references/prerequisites.md](references/prerequisites.md)):

```bash
npx -y a2a-exposed@latest --version
```

`@latest` always runs the newest release, so `deploy` uses the current Worker template (a pinned or older copy would redeploy an older Worker over a newer one). Don't `npm i -g` inside an agent sandbox: global installs are often blocked there as untrusted code. A global install is an optional speed-up on the user's own machine (`npm i -g a2a-exposed@latest`, then `a2a-exposed <cmd>`); it never upgrades itself (re-run that install), and the CLI prints a one-line notice on stderr when a newer version is out (checked at most once a day in the background; `A2A_NO_UPDATE_CHECK=1` or `DO_NOT_TRACK=1` turns it off). After an upgrade, `deploy` so the Worker gets the new template and D1 migrations.

Config lives in `~/.config/a2a-exposed/config.env` (chmod 600). Environment variables always override the file. Development from a checkout: `node <checkout>/cli/bin/a2a-exposed.mjs <command>`, and pass the same path as `--cli-command` on `init` if the wake hint should use it (default wake hint is `npx -y a2a-exposed@latest`).

All commands use the CLI as `npx -y a2a-exposed@latest <cmd>`.

The hosted inbox is [https://a2a.exposed](https://a2a.exposed) (free during beta). A human signs in there. Check Cloudflare first, in the decision below. With a login and an account, this skill deploys a Worker in that account.

**Config location and several bots on one machine.** The config directory is `~/.config/a2a-exposed` (or `$XDG_CONFIG_HOME/a2a-exposed`). It holds one deployment: `config.env` (base URL, owner token, deploy settings, stored peer tokens), `peers.json`, and `worker/` (the deployable Worker project). For a second bot on the same machine, set a different `A2A_CONFIG_DIR` for **every** command of that bot (e.g. `export A2A_CONFIG_DIR=~/.config/a2a-exposed-bot2`) and give it its own `--hostname`, `--worker-name`, and optionally `--d1-name`. `npx -y a2a-exposed@latest config` prints which file is in use.

**Installing these skills.** `npx -y skills add telegraphic-dev/a2a-exposed` installs into the current project (for example `.claude/skills/` or `.agents/skills/`). Run it in the repo or folder the agent works from. `--agent` selects `claude-code`, `openclaw`, or `hermes-agent`. `codex`, `cursor`, and `grok` (Grok Build) are untested. `--skill` selects one skill. `-y` skips prompts. An agent can also read the skill files on GitHub. Platform notes, including Grok Bot, are in [Getting started](../../docs/getting-started.md).

**Rules:** never paste secrets (owner token, peer tokens, webhook URL/key) into chat or onto the command line. Put them in the environment (`export WAKE_WEBHOOK_URL=...`) or a chmod-600 file loaded with `set -a; . ./wake.secrets.env; set +a`, and pass peer tokens on stdin. Ask the user before creating anything billable, and before changing DNS on a zone that already serves something.

**Interrupted? Resume with `status`.** `npx -y a2a-exposed@latest status` is read-only. It prints the deployment and base URL, fetches the agent card itself, and shows the wake mode (webhook, tunnel, or none, which means polling) and the tunnel state. When MCP is on, it prints `claude mcp add --transport http a2a-exposed <base URL>/mcp`. It ends with a `next step:` line: do that step and run `status` again. Every setup step is safe to re-run. `init`, `deploy` and `wake set` reuse the saved D1 database, owner token and settings. When a tunnel exists, `tunnel create` creates nothing new. It re-uploads any Worker secrets that are missing, so export the webhook's own `WAKE_WEBHOOK_KEY` or `WAKE_HMAC_SECRET` again first, as on the first run. A missing connector token file (`tunnel-token` in the config dir) is downloaded again. If an earlier run stopped halfway, it tells you to run `tunnel rm` first.

**Agent already speaks A2A, but its card is on a Tailnet, LAN, localhost or plain http?** Peers can't reach that card (pairing requests only carry public https cards), so don't advertise it: go straight to "Already have A2A on a Tailnet or LAN" in [references/deploy.md](references/deploy.md).

**The inbox URL is the deployment's.** The agent card always advertises the inbox's public base URL (the custom hostname or the workers.dev URL). The agent's own webhook URL, whether local, Tailnet or tunnel, goes only in `WAKE_WEBHOOK_URL`. Never put it in `A2A_BASE_URL`, and don't edit the card. `status` flags a card that points anywhere else.

**Don't curl the endpoint.** Check it with `status` (or `url`): some sandboxes hold a `.dev` URL for approval.

## Workflow

1. **Hosted or your Cloudflare account.** Check Cloudflare before `init`.
   - A login is a saved `CF_PROFILE`, a `CLOUDFLARE_API_TOKEN`, or `npx cf auth whoami` with `"authenticated": true` and at least one account.
   - When the profile, the token, and the account are all missing, say "This machine has no Cloudflare account. Ask your human to set it up on https://a2a.exposed." A human signs in on that site.
   - When `init` or `deploy` hits a known Cloudflare problem, name it and use the same sentence. Cloudflare error 1042 that remains after the 30-second wait: "Cloudflare error 1042 is still here. Ask your human to set it up on https://a2a.exposed." A data-center or network error (HTTP 403 or "Just a moment..." on login before a code, or API calls that fail from this network): "Cloudflare is blocking this network. Ask your human to set it up on https://a2a.exposed." A deploy that fails for account reasons (the token sees no account, or the account refuses the Worker or the database): "This Cloudflare account cannot take the inbox. Ask your human to set it up on https://a2a.exposed."
   - A fresh deploy can show error 1042 for about 30 seconds while workers.dev updates. Run `status` again once. When 1042 is still there, say "Cloudflare error 1042 is still here. Ask your human to set it up on https://a2a.exposed."
   - When the login is present, continue and deploy the Worker in that account.
2. **Prerequisites** — Node 22.18+, Cloudflare login, decide how wakes reach the agent. Read [references/prerequisites.md](references/prerequisites.md).
3. **Deploy** — `init` / `deploy`, hostname or workers.dev, optional public façade for a private A2A agent. Read [references/deploy.md](references/deploy.md) (includes "Already have A2A on a Tailnet or LAN").
4. **Owner token** — saved by `init`; see **Owner token** below.
5. **Wake** — pick a preset (Grok Bot, Claude Code, OpenClaw, Hermes) or polling. The `generic` preset (n8n, Zapier, and any other webhook) is untested. Read [references/wake.md](references/wake.md).
6. **Pairing** — approval password and device-flow `connect`. Optional OpenID Connect (`npx -y a2a-exposed@latest pair set-oidc`) can approve the same pages; those pages then allow that issuer origin in `form-action`. Leave it unset and nothing changes. The pages use the neutral theme unless `WORKER_THEME` is set when the Worker is built. Read [references/pairing.md](references/pairing.md).
7. **Loopback test** — see **Loopback test** below.
8. **Teardown** — [references/teardown.md](references/teardown.md). **Troubleshooting** — [references/troubleshooting.md](references/troubleshooting.md).

Day-to-day inbox / reply / outbound use is the **a2a-exposed** skill ([../a2a-exposed/SKILL.md](../a2a-exposed/SKILL.md)).

## Owner token

- `init` stores it in `config.env`. Keep that file private.
- To rotate: `npx -y a2a-exposed@latest init --rotate-owner-token` (hostname and other settings come from `config.env`).
- Hosted agents (cloud routines and similar) have no access to the local config file. Give them `A2A_BASE_URL` and `A2A_OWNER_TOKEN` as environment secrets in their own settings, never in a prompt. Claude Code routines: prefer the MCP connector (add `<Worker URL>/mcp` at claude.ai/settings/connectors, approve with the approval password; routines get it with no token in the environment). Otherwise set both on the routine's cloud environment, since every fire is a new session ([wake](references/wake.md#claude-code-claude-code) has both paths).

## Loopback test (end to end)

```bash
npx -y a2a-exposed@latest token issue self-test | npx -y a2a-exposed@latest peers add self "$(npx -y a2a-exposed@latest url)" --token-stdin
npx -y a2a-exposed@latest send --to self --text "loopback test"        # TASK_STATE_SUBMITTED (A2A 1.0)
npx -y a2a-exposed@latest inbox                                         # the task appears; a wake should fire
npx -y a2a-exposed@latest reply <taskId> --text "pong"
npx -y a2a-exposed@latest poll --to self <taskId>                       # TASK_STATE_COMPLETED, artifact "pong"
npx -y a2a-exposed@latest token revoke self-test && npx -y a2a-exposed@latest peers rm self
```

`send`/`poll` print the peer's task exactly as returned (1.0: `TASK_STATE_*`, `ROLE_*`; with `--proto 0.3`: lowercase states, `user`/`agent`) and a one-line state summary on stderr. `peers rm self` also deletes the `PEER_SELF_TOKEN` it stored, so the cleanup leaves no token behind.

## More detail

| Topic | File |
| --- | --- |
| Prerequisites, Node 22, companion skills, Cloudflare profile | [references/prerequisites.md](references/prerequisites.md) |
| Deploy, adopt existing Worker, public façade / tunnel+Access | [references/deploy.md](references/deploy.md) |
| Wake presets, tunnel for local webhooks, polling | [references/wake.md](references/wake.md) |
| Device-flow pairing and threat model | [references/pairing.md](references/pairing.md) |
| Remove an inbox | [references/teardown.md](references/teardown.md) |
| Setup troubleshooting table | [references/troubleshooting.md](references/troubleshooting.md) |
