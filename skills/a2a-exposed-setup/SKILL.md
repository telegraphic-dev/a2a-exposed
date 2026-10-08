---
name: a2a-exposed-setup
description: Use when the user wants to give this agent a public A2A (Agent2Agent) endpoint, deploy or redeploy the a2a-exposed Cloudflare Worker, connect a wake webhook (Grok Bot, Claude Code, OpenClaw, Hermes, n8n/Zapier/generic), set up scheduled inbox polling, or securely expose an agent that already speaks A2A on a Tailnet, LAN or localhost through a public façade.
license: MIT
compatibility: Requires Node 22.18+ and the a2a-exposed CLI (npm i -g a2a-exposed or npx -y a2a-exposed@latest). Cloudflare account for deploy.
metadata:
  version: "0.4.1"
  author: Telegraphic Developer
  homepage: https://github.com/telegraphic-dev/a2a-exposed
  hermes:
    tags:
      - a2a
      - agent2agent
      - cloudflare
      - workers
      - webhook
      - deploy
      - openclaw
      - hermes
    related_skills:
      - a2a-exposed
      - mise
      - cloudflare
  openclaw:
    emoji: "🛠️"
    requires:
      bins:
        - node
    envVars:
      A2A_CONFIG_DIR:
        description: Override the config directory (default ~/.config/a2a-exposed). Use one per bot on a shared machine.
        required: false
      A2A_BASE_URL:
        description: Public base URL of the deployed Worker (saved by init/deploy; usually not set by hand).
        required: false
      A2A_OWNER_TOKEN:
        description: Owner API token for inbox/reply/token commands (saved by init; usually not set by hand).
        required: false
        sensitive: true
      A2A_HOSTNAME:
        description: Custom hostname for the Worker (omit for workers.dev).
        required: false
      CF_PROFILE:
        description: Named cf auth profile (saved as CF_PROFILE in config.env).
        required: false
      CLOUDFLARE_ACCOUNT_ID:
        description: Cloudflare account id (saved by init when the login has exactly one account).
        required: false
      WAKE_WEBHOOK_URL:
        description: Wake webhook URL (Worker secret; put in the environment, never on the command line).
        required: false
        sensitive: true
      WAKE_WEBHOOK_KEY:
        description: Wake webhook bearer or API key (Worker secret).
        required: false
        sensitive: true
      WAKE_HMAC_SECRET:
        description: Wake HMAC secret for Hermes / signed presets (Worker secret).
        required: false
        sensitive: true
      WAKE_ACCESS_CLIENT_ID:
        description: Cloudflare Access service-token client id for a wake tunnel (set by tunnel create).
        required: false
        sensitive: true
      WAKE_ACCESS_CLIENT_SECRET:
        description: Cloudflare Access service-token client secret for a wake tunnel (set by tunnel create).
        required: false
        sensitive: true
      UPSTREAM_TOKEN:
        description: Proxy mode (--upstream) only. The one bearer credential the façade presents to the private A2A agent (Worker secret).
        required: false
        sensitive: true
      UPSTREAM_ACCESS_CLIENT_ID:
        description: Proxy mode only. Cloudflare Access service-token client id for the upstream's tunnel hostname (Worker secret).
        required: false
        sensitive: true
      UPSTREAM_ACCESS_CLIENT_SECRET:
        description: Proxy mode only. Cloudflare Access service-token client secret for the upstream's tunnel hostname (Worker secret).
        required: false
        sensitive: true
---

# a2a-exposed: setup

Deploys a Cloudflare Worker that gives this agent a public A2A endpoint with a D1 inbox. The Worker then wakes the agent through a webhook, or the agent checks the inbox on a schedule. Day-to-day use is covered by the **a2a-exposed** skill.

Installing this skill gives the agent the workflow documentation. It does **not** install the CLI. Install it, or upgrade an older one, first (Node 22.18+; no Node 22 yet? see [references/prerequisites.md](references/prerequisites.md)):

```bash
npm i -g a2a-exposed@latest      # installs, or upgrades an older copy already on PATH
a2a-exposed --version            # compare: npm view a2a-exposed version
```

A bare `command -v a2a-exposed || npm i -g a2a-exposed` never upgrades: an old copy on PATH (for example 0.1.0, which has no pairing commands) would stay. The CLI itself prints a one-line notice on stderr when a newer version is out (checked at most once a day in the background; `A2A_NO_UPDATE_CHECK=1` or `DO_NOT_TRACK=1` turns it off). After upgrading, run `a2a-exposed deploy` so the Worker gets the new template and D1 migrations.

For one-off use without a global install: `npx -y a2a-exposed@latest <command>`. The docs write commands as `npx a2a-exposed <command>`; with a global install, `a2a-exposed <command>` is the same thing without the npm round-trip. Config lives in `~/.config/a2a-exposed/config.env` (chmod 600). Environment variables always override the file. Development from a checkout: `node <checkout>/cli/bin/a2a-exposed.mjs <command>`, and pass the same path as `--cli-command` on `init` if the wake hint should use it (default wake hint is `npx a2a-exposed`).

All commands use the CLI as `npx a2a-exposed <cmd>`.

The domain a2a.exposed is reserved for future project pages; it is not part of any deployment.

**Config location and several bots on one machine.** The config directory is `~/.config/a2a-exposed` (or `$XDG_CONFIG_HOME/a2a-exposed`). It holds one deployment: `config.env` (base URL, owner token, deploy settings, stored peer tokens), `peers.json`, and `worker/` (the deployable Worker project). For a second bot on the same machine, set a different `A2A_CONFIG_DIR` for **every** command of that bot (e.g. `export A2A_CONFIG_DIR=~/.config/a2a-exposed-bot2`) and give it its own `--hostname`, `--worker-name`, and optionally `--d1-name`. `npx a2a-exposed config` prints which file is in use.

**Installing these skills.** `npx skills add telegraphic-dev/a2a-exposed` installs into the current project (e.g. `.claude/skills/`, `.agents/skills/`); run it in the repo or folder the agent works from. `-g` installs user-level, `--agent <id...>` picks agents (`claude-code`, `codex`, `openclaw`, `hermes-agent`, `cursor`, ...), `--skill <name...>` picks skills, `-y` skips prompts. Grok Bot isn't a skills-CLI target (`grok` there is Grok Build): save the `SKILL.md` files to its skill library or reference their path in the routine prompt.

**Rules:** never paste secrets (owner token, peer tokens, webhook URL/key) into chat or onto the command line. Put them in the environment (`export WAKE_WEBHOOK_URL=...`) or a chmod-600 file loaded with `set -a; . ./wake.secrets.env; set +a`, and pass peer tokens on stdin. Ask the user before creating anything billable, and before changing DNS on a zone that already serves something.

**Interrupted? Resume with `status`.** `npx a2a-exposed status` is read-only. It prints the deployment and base URL, fetches the agent card itself, and shows the wake mode (webhook, tunnel, or none, which means polling) and the tunnel state. It ends with a `next step:` line: do that step and run `status` again. Every setup step is safe to re-run. `init`, `deploy` and `wake set` reuse the saved D1 database, owner token and settings. When a tunnel exists, `tunnel create` creates nothing new. It re-uploads any Worker secrets that are missing, so export the webhook's own `WAKE_WEBHOOK_KEY` or `WAKE_HMAC_SECRET` again first, as on the first run. A missing connector token file (`tunnel-token` in the config dir) is downloaded again. If an earlier run stopped halfway, it tells you to run `tunnel rm` first.

**Agent already speaks A2A, but its card is on a Tailnet, LAN, localhost or plain http?** Peers can't reach that card (pairing requests only carry public https cards), so don't advertise it: go straight to "Already have A2A on a Tailnet or LAN" in [references/deploy.md](references/deploy.md).

**The inbox URL is the deployment's.** The agent card always advertises the inbox's public base URL (the custom hostname or the workers.dev URL). The agent's own webhook URL, whether local, Tailnet or tunnel, goes only in `WAKE_WEBHOOK_URL`. Never put it in `A2A_BASE_URL`, and don't edit the card. `status` flags a card that points anywhere else.

**Don't curl the endpoint.** Check it with `status` (or `url`), not a raw `curl` of the agent card. Some agent sandboxes (Hermes) flag `.dev` URLs in shell commands, such as `*.workers.dev`, and hold the command for user approval. If that approval times out, setup stops halfway.

## Workflow

1. **Prerequisites** — Node 22.18+, Cloudflare login, decide how wakes reach the agent. Read [references/prerequisites.md](references/prerequisites.md).
2. **Deploy** — `init` / `deploy`, hostname or workers.dev, optional public façade for a private A2A agent. Read [references/deploy.md](references/deploy.md) (includes "Already have A2A on a Tailnet or LAN").
3. **Owner token** — saved by `init`; see **Owner token** below.
4. **Wake** — pick a preset (Grok Bot, Claude Code, OpenClaw, Hermes, generic) or polling. Read [references/wake.md](references/wake.md).
5. **Pairing** — approval password and device-flow `connect`. Read [references/pairing.md](references/pairing.md).
6. **Loopback test** — see **Loopback test** below.
7. **Teardown** — [references/teardown.md](references/teardown.md). **Troubleshooting** — [references/troubleshooting.md](references/troubleshooting.md).

Day-to-day inbox / reply / outbound use is the **a2a-exposed** skill ([../a2a-exposed/SKILL.md](../a2a-exposed/SKILL.md)).

## Owner token

- `init` stores it in `config.env`. Keep that file private.
- To rotate: `npx a2a-exposed init --rotate-owner-token` (hostname and other settings come from `config.env`).
- Hosted agents (cloud routines and similar) have no access to the local config file. Give them `A2A_BASE_URL` and `A2A_OWNER_TOKEN` as environment secrets in their own settings, never in a prompt.

## Loopback test (end to end)

```bash
npx a2a-exposed token issue self-test | npx a2a-exposed peers add self "$(npx a2a-exposed url)" --token-stdin
npx a2a-exposed send --to self --text "loopback test"        # TASK_STATE_SUBMITTED (A2A 1.0)
npx a2a-exposed inbox                                         # the task appears; a wake should fire
npx a2a-exposed reply <taskId> --text "pong"
npx a2a-exposed poll --to self <taskId>                       # TASK_STATE_COMPLETED, artifact "pong"
npx a2a-exposed token revoke self-test && npx a2a-exposed peers rm self
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
