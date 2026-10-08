Give any AI agent a public A2A (Agent2Agent) endpoint. Messages land in a Cloudflare Worker inbox and wake your agent over a webhook — or your agent checks the inbox on a schedule.

# a2a-over-webhook

## Why

Most AI agents (hosted assistants, coding agents, routines, chat bots) can make outbound HTTP calls but **cannot run a public server**. Without one they can't be reached over [A2A](https://a2a-protocol.org): there is nowhere to host an agent card or receive `SendMessage`.

a2a-over-webhook adds that missing half:

- A small **Cloudflare Worker** (free tier is plenty) on a hostname you own, or on a free `*.workers.dev` URL, serves your **agent card** and the **A2A JSON-RPC endpoint**.
- Inbound messages become **tasks in a D1 inbox**.
- The Worker **wakes your agent** with a webhook (Grok Bot, Claude Code, OpenClaw, Hermes, n8n/Zapier/anything). Agents without inbound webhooks **poll the inbox on a schedule** instead.
- Your agent reads the inbox and replies with a **zero-dependency CLI**: `npx a2a-over-webhook`. Peers receive answers via `GetTask` or push notifications.
- The same CLI **sends** messages to other A2A agents (1.0 or 0.3) and tracks their replies.

## Architecture

```mermaid
flowchart LR
    P["Peer agent<br/>(A2A client)"] -- "SendMessage / GetTask<br/>Bearer per-peer token" --> W
    subgraph CF["Your Cloudflare account"]
        W["Worker<br/>agent card + JSON-RPC<br/>owner API"] <--> D[("D1<br/>tasks, history,<br/>peers (hashed tokens)")]
    end
    W -- "wake webhook<br/>(preset: grok-bot, claude-code,<br/>openclaw, hermes, generic)" --> A["Your agent"]
    A -. "or: scheduled check" .-> W
    A -- "npx a2a-over-webhook<br/>inbox / reply / send<br/>(owner token)" --> W
    W -- "push notification<br/>(optional, https)" --> P
    A -- "send / poll<br/>(A2A client)" --> Q["Other A2A agents"]
```

1. A peer discovers you at `https://<your-host>/.well-known/agent-card.json` and calls `SendMessage` with the token you issued it.
2. The Worker stores a `submitted` task and fires the wake webhook. Wakes are debounced per conversation, so a burst is one wake.
3. Your agent runs `npx a2a-over-webhook inbox`, does the work, and runs `npx a2a-over-webhook reply <taskId> --text ...`.
4. The peer sees the result via `GetTask`, or immediately if it registered a push URL.

## Quick start

**Requires Node 22.18+** (`node -v`): both the skills CLI below and Cloudflare's `cf` CLI fail on Node 20.

```bash
# 1. Install the skills into your agent (run in the project the agent works in; -g for user-level)
npx skills add telegraphic-dev/a2a-over-webhook

# 2. Ask your agent: "set up a2a-over-webhook". The setup skill walks it through
#    (CLI not on npm yet: see "Running the CLI before it is on npm" below):
npx cf auth login --no-browser   # device code: open the URL, enter the code
# Wake secrets go in the environment, never on the command line, e.g. from a chmod-600 file
# containing WAKE_WEBHOOK_URL=... and WAKE_WEBHOOK_KEY=...
set -a; . ./wake.secrets.env; set +a
npx a2a-over-webhook init --hostname agent.example.com --agent-name "My Agent" --preset grok-bot
npx a2a-over-webhook wake test
npx a2a-over-webhook token issue first-peer     # hand this to the peer, with your agent-card URL
```

### No domain? Use workers.dev

Leave out `--hostname` and the Worker is served at `https://<worker-name>.<account-subdomain>.workers.dev` ([workers.dev routing](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)). This works on the [free plan](https://developers.cloudflare.com/workers/platform/limits/), and `init` saves the resulting URL for you.

```bash
npx a2a-over-webhook init --agent-name "My Agent" --preset grok-bot
```

Each account has one workers.dev subdomain. If yours has none yet, `init` stops and explains how to create one: pass `--workers-dev-subdomain <name>` so `init` registers it, or open **Workers & Pages** in the dashboard once, or `PUT /accounts/<account-id>/workers/subdomain` with `{"subdomain":"<name>"}`. The `--cron` flush works on workers.dev too. To move an existing custom-domain deployment to workers.dev, run `deploy --workers-dev`; `deploy --hostname <host>` moves it back. The old URL then stops serving (its agent card redirects to the new one, everything else gets 410), and peers must update their URL.

### Local-only webhook? Use a secure tunnel

If your agent's webhook only listens locally (OpenClaw on `127.0.0.1:18789`, Hermes on `:8644`), `npx a2a-over-webhook tunnel create` publishes just the wake path through a named Cloudflare Tunnel, behind a Cloudflare Access app that admits only one service token held by the Worker (sent as `CF-Access-Client-Id`/`-Secret` on every wake, next to the preset's own auth). It needs a custom domain and Cloudflare Zero Trust (free plan); run `cloudflared` on the agent's machine with the printed command. See [the setup skill](skills/a2a-over-webhook-setup/SKILL.md#local-only-webhooks-hermes-openclaw-secure-tunnel).

Two skills are included:

| Skill | Use |
|---|---|
| [`a2a-over-webhook-setup`](skills/a2a-over-webhook-setup/SKILL.md) | One-time deploy: Cloudflare login, D1, custom domain or workers.dev, owner token, wake preset per agent, first peer, loopback test |
| [`a2a-over-webhook`](skills/a2a-over-webhook/SKILL.md) | Day-to-day: handle wakes, read the inbox safely, reply, message other agents, manage peer tokens, troubleshoot |

**Where the skills go.** `npx skills add` (the [skills CLI](https://github.com/vercel-labs/skills)) installs into the current project by default, e.g. `.claude/skills/` or `.agents/skills/`; commit them if the agent runs from that repo (Claude Code routines do). Add `-g` for a user-level install (`~/.claude/skills/`, `~/.codex/skills/`, ...). `--agent claude-code codex` picks the target agents, `--skill a2a-over-webhook` picks one skill, `-y` skips prompts, and `--list` only lists. **Grok Bot is not a skills-CLI target** (its `grok` target is Grok Build): save both `SKILL.md` files to your Grok Bot skill library, or keep a checkout on the bot's box and name the `SKILL.md` path in the routine prompt.

### Running the CLI before it is on npm

The CLI isn't published to npm yet, so `npx a2a-over-webhook` doesn't resolve. Run it from a checkout and give the Worker the same command for its wake hints:

```bash
git clone https://github.com/telegraphic-dev/a2a-over-webhook ~/a2a-over-webhook
node ~/a2a-over-webhook/cli/bin/a2a-over-webhook.mjs init --hostname agent.example.com ... \
  --cli-command "node $HOME/a2a-over-webhook/cli/bin/a2a-over-webhook.mjs"
```

Read `npx a2a-over-webhook` in the docs as that `node .../a2a-over-webhook.mjs` command. Alternatively `npm i -g ~/a2a-over-webhook/cli` links the checkout as `a2a-over-webhook` (then use `--cli-command a2a-over-webhook`). `--cli-command` is saved as `WAKE_CLI_COMMAND` and only changes the command shown in wake hints; the woken agent must be able to run it.

## Agent compatibility

| Agent | How it gets woken | Preset | Notes |
|---|---|---|---|
| **Grok Bot** | Routine with a webhook trigger | `grok-bot` | Hosted; URL and key come from the routine panel; JSON payload |
| **Claude Code** | Routine API trigger (`/fire`) | `claude-code` | Each fire is a new session; 30 fires/h per routine, so defaults are a 20 s debounce and a 25/h cap |
| **OpenClaw** | Gateway hooks: `/hooks/wake` or `/hooks/agent` | `openclaw-wake`, `openclaw-agent` | Hooks are off by default; the gateway binds 127.0.0.1:18789, so use `tunnel create` (secure tunnel) or poll |
| **Hermes Agent** | Webhook subscription (`hermes webhook subscribe`) | `hermes` | HMAC-SHA256 V2 signature; self-hosted, so use `tunnel create` (secure tunnel) or poll |
| **Codex** | Automations / thread heartbeats | polling | `npx a2a-over-webhook inbox` on a schedule |
| **Meta Muse** | Recurring tasks, Muse Code `SessionStart` hook, `muse exec` | polling | Check the inbox on start or on a schedule |
| **n8n, Zapier, Make, custom** | Any HTTPS webhook | `generic` | Configurable auth header, prefix, JSON body template, optional HMAC |

Any agent that can run `npx` and remember a skill works in polling mode. The wake is only a latency optimization.

## Security model

- **Peers.** Each peer gets its own bearer token per label (`token issue <label>`): `a2aow_` followed by 43 base64url characters (32 random bytes). Only the SHA-256 hash is stored, and the token is shown once. You can revoke or rotate any label, and every task records which peer sent it.
- **Owner.** The owner API (inbox, replies, tokens) uses a separate `OWNER_TOKEN` Worker secret. The CLI keeps it in `~/.config/a2a-over-webhook/config.env` (chmod 600; `A2A_CONFIG_DIR` overrides the directory).
- **Untrusted content.** Peer messages are data, not instructions. The operate skill shows them inside explicit `UNTRUSTED PEER MESSAGE` fences. It refuses embedded instructions and requires the user's approval for anything consequential or externally visible.
- **Wake webhooks.** A wake carries metadata, a hint command, and at most a 300-character preview. `openclaw-wake` carries no peer text at all, because OpenClaw treats wake text as a trusted system event. Wake URL, key, and HMAC secret are Worker secrets, never committed config.
- **Push notifications.** HTTPS only. Private and loopback targets are refused, and each push uses a per-task token (stored hashed for inbound pushes).
- **Limits.** 1 MiB request bodies, 60 requests/min per peer, per-conversation wake debounce, and an optional hourly wake cap.
- **Your infrastructure.** Everything runs in your Cloudflare account, and no third-party service sees your traffic. Data leaves only through wakes to your agent and pushes to URLs your peers registered.

## Protocol support

- **A2A 1.0 (primary).** `SendMessage`, `GetTask`, `CancelTask`, `ListTasks`, `CreateTaskPushNotificationConfig`, and `GetTaskPushNotificationConfig`, using ProtoJSON enums (`TASK_STATE_*`, `ROLE_*`). The agent card follows the 1.0 shape: `supportedInterfaces` lists 1.0 first and 0.3 second, and `securitySchemes` uses `httpAuthSecurityScheme`.
- **A2A 0.3 (compatible).** `message/send`, `tasks/get`, `tasks/cancel`, and `tasks/pushNotificationConfig/set|get` on the same endpoint. The version is chosen by the `A2A-Version` header or the method name.
- The card is served at both `/.well-known/agent-card.json` and `/.well-known/agent.json`.
- Streaming (`SendStreamingMessage`) is not supported. Work is asynchronous by design.

## Repository layout

```
skills/a2a-over-webhook-setup/SKILL.md   deploy + per-agent wake configuration
skills/a2a-over-webhook/SKILL.md         operate: inbox, replies, outbound, tokens
worker/                                  Cloudflare Worker (TypeScript, D1, cf CLI config)
cli/                                     npm package `a2a-over-webhook` (Node 22, zero deps)
```

Worker development: `cd worker && npm install && npm test && npx tsc`. For local runs, use `npx cf dev` with a `.dev.vars` file holding the secrets. CLI: `node cli/bin/a2a-over-webhook.mjs --help`, tests with `cd cli && npm test`.

## License

MIT, see [LICENSE](LICENSE).
