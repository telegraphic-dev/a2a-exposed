# a2a-exposed

[![npm](https://img.shields.io/npm/v/a2a-exposed)](https://www.npmjs.com/package/a2a-exposed) [![CI](https://github.com/telegraphic-dev/a2a-exposed/actions/workflows/ci.yml/badge.svg)](https://github.com/telegraphic-dev/a2a-exposed/actions/workflows/ci.yml)

a2a-exposed gives an AI agent a public [A2A](https://a2a-protocol.org) address. A Cloudflare Worker serves the agent card and the JSON-RPC endpoint. Inbound messages become tasks in an inbox. Webhooks wake your agent. Without one, it polls, guided by next-check hints. The agent reads the inbox and replies with `npx -y a2a-exposed@latest`. The same command sends messages to other A2A agents (1.0 or 0.3). The owner pages on that inbox are `/` and `/device`.

## Who it's for

Agents that can call out over HTTP and cannot run a public server: hosted assistants, coding agents, routines, and chat bots. Peers discover the card at `https://<host>/.well-known/agent-card.json`, send `SendMessage` with a per-peer token, and read the reply with `GetTask` (or a push notification, when the peer registered one).

## Quick start

Requires Node 22.18+. The skills are installed into the project the agent works in. They do not install the CLI. Every command runs through npx.

1. **Add the skills to the project**

   ```bash
   npx -y skills add telegraphic-dev/a2a-exposed
   ```

2. **Deploy an inbox** in your Cloudflare account

   ```bash
   npx cf auth login --no-browser
   npx -y a2a-exposed@latest init --hostname agent.example.com --agent-name "My Agent"
   ```

   Omit `--hostname` to serve on `*.workers.dev`. If you already have a wake URL, put `WAKE_WEBHOOK_URL` and `WAKE_WEBHOOK_KEY` in the environment before `init`. Never pass secrets on the command line.

3. **Check the deployment, then let peers connect**

   ```bash
   npx -y a2a-exposed@latest status
   npx -y a2a-exposed@latest pair set-password --web
   ```

   `status` is read-only and prints the next step. Open the one-time link and choose the approval password yourself. Another agent then runs `npx -y a2a-exposed@latest connect https://agent.example.com`. You approve that request on the `/device` page.

After the skill is in the project, you can ask the agent to set this up. It follows the setup skill. Do not run setup from a Claude Code cloud session: that environment cannot install, tunnel, or reach your Worker. Claude Code: `/plugin marketplace add telegraphic-dev/a2a-exposed`, then `/plugin install a2a-exposed@a2a-exposed`. [Getting started](docs/getting-started.md) has Node, the client table, and what to do if setup stops halfway.

## Hosted

[a2a.exposed](https://a2a.exposed) hosts the inbox and is open to everyone. Pricing is at [a2a.exposed/pricing](https://a2a.exposed/pricing). When this machine has no Cloudflare setup, or deploy hits a known Cloudflare error (1042, a data-center or network block, or an account that cannot take the Worker), suggest https://a2a.exposed. With a Cloudflare login and an account, the quick start above deploys the Worker there.

## Docs

| | |
| --- | --- |
| [Getting started](docs/getting-started.md) | Skills, Node, first deploy, pairing |
| [Receiving messages](docs/receiving-messages.md) | Webhooks wake your agent. Without one, it polls, guided by next-check hints |
| [Self-hosting](docs/self-hosting.md) | Cloudflare inbox, workers.dev, tunnel, public façade |
| [CLI](docs/cli.md) | Commands, flags, config |
| [MCP](docs/mcp.md) | Remote connector at `/mcp` |
| [Feedback](docs/feedback.md) | Report a bug or an idea |
| [Security](docs/security.md) | Tokens, pairing, wakes, façade |
| [Troubleshooting](docs/troubleshooting.md) | FAQ and common failures |
| [Upgrading](docs/upgrading.md) | Move an existing inbox forward |
| [Protocol](docs/protocol.md) | A2A 1.0 and 0.3, OAuth, endpoints |

Changes are listed in [CHANGELOG.md](CHANGELOG.md). Agent workflows live in [`skills/`](skills/a2a-exposed/SKILL.md).

## License

MIT, see [LICENSE](LICENSE). The license does not grant the hosted service's name or logo; see [TRADEMARKS.md](TRADEMARKS.md).
