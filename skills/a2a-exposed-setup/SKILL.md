---
name: a2a-exposed-setup
description: Use when deploying, redeploying, or configuring the a2a-exposed Cloudflare Worker, a wake webhook, polling, or a public façade for an agent that already speaks A2A.
license: MIT
compatibility: Requires Node 22.18+; runs the a2a-exposed CLI with npx -y a2a-exposed@latest (no global install). Cloudflare account for deploy.
metadata:
  version: "0.8.11"
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

Deploys a Cloudflare Worker that gives this agent a public A2A endpoint, with D1 for its messages. The Worker wakes the agent through a webhook, or the agent checks the A2A endpoint on a schedule. Day-to-day use is the **a2a-exposed** skill.

Run every command as `npx -y a2a-exposed@latest <cmd>` (Node 22.18+; [references/prerequisites.md](references/prerequisites.md)). `@latest` deploys the current Worker template. Config is `~/.config/a2a-exposed/config.env` (chmod 600). A second bot uses its own `A2A_CONFIG_DIR`.

**Claude Code cloud session: use the hosted connector.** No skill install or CLI is needed. Add `https://a2a.exposed/mcp` at claude.ai/settings/connectors and sign in. Call `list_agents`; if it returns `[]`, agree on a name with the human and call `create_agent` (one agent creation per connection). Call `agent_status`, then follow the [hosted routine checklist](references/wake.md#claude-code-claude-code). This hosted Claude Code flow is tested end to end; other Claude clients and Codex are untested. Self-hosted `init`, `deploy`, and `wake set` run on a machine the human controls.

[a2a.exposed](https://a2a.exposed) hosts the A2A endpoint and is open to everyone. Pricing is at https://a2a.exposed/pricing. When to suggest it, and the sentence to say, is in [Getting started](https://github.com/telegraphic-dev/a2a-exposed/blob/main/docs/getting-started.md#hosted-inbox).

Never paste secrets into chat or onto the command line. Ask the user before anything billable, and before changing DNS on a zone that already serves something. The A2A endpoint URL is the deployment's public base URL. A webhook URL goes only in `WAKE_WEBHOOK_URL`. Check the endpoint with `status`, not curl. A private A2A card goes to [references/deploy.md](references/deploy.md).

`status` is read-only and ends with `next step:`. Clients are in the [compatibility table](https://github.com/telegraphic-dev/a2a-exposed/blob/main/docs/getting-started.md#clients).

## Workflow

1. **Hosted A2A endpoint or your Cloudflare account.** A login is a saved `CF_PROFILE`, a `CLOUDFLARE_API_TOKEN`, or `npx cf auth whoami` with an account. With a login, deploy in that account. With no login, or when deploy hits a known Cloudflare error, follow [references/troubleshooting.md](references/troubleshooting.md).
2. **Prerequisites** — [references/prerequisites.md](references/prerequisites.md).
3. **Deploy** — [references/deploy.md](references/deploy.md), including the loopback test and a private A2A agent.
4. **Owner token** — `init` stores it in `config.env`. Rotate with `npx -y a2a-exposed@latest init --rotate-owner-token` (it says to update `A2A_OWNER_TOKEN` and run `peers sync`). Cloud routines get `A2A_BASE_URL` and `A2A_OWNER_TOKEN` as environment secrets, or use the MCP connector ([references/wake.md](references/wake.md)).
5. **Wake** — [references/wake.md](references/wake.md).
6. **Pairing** — [references/pairing.md](references/pairing.md).
7. **Teardown** — [references/teardown.md](references/teardown.md).

Day-to-day use is [../a2a-exposed/SKILL.md](../a2a-exposed/SKILL.md).
