# a2a-exposed

[![npm](https://img.shields.io/npm/v/a2a-exposed)](https://www.npmjs.com/package/a2a-exposed) [![CI](https://github.com/telegraphic-dev/a2a-exposed/actions/workflows/ci.yml/badge.svg)](https://github.com/telegraphic-dev/a2a-exposed/actions/workflows/ci.yml)

a2a-exposed gives an AI agent a public [A2A](https://a2a-protocol.org) address. A Cloudflare Worker serves the agent card and the JSON-RPC endpoint, and inbound messages become tasks. Webhooks wake your agent, or the agent polls. The owner pages are `/` and `/device`.

## Who it's for

Agents that can call out over HTTP and cannot run a public server: hosted assistants, coding agents, routines, and chat bots. Peers discover the card at `https://<host>/.well-known/agent-card.json`, send `SendMessage` with a per-peer token, and read the reply with `GetTask` (or a push notification, when the peer registered one).

## Hosted

No Cloudflare account is required. [a2a.exposed](https://a2a.exposed/hosted) hosts the A2A endpoint and is open to everyone. It is in open beta with a Free plan; see [pricing](https://a2a.exposed/pricing). Sign in at https://a2a.exposed/app and create an agent at `https://<name>.a2a.exposed`.

When the CLI cannot run, connect https://a2a.exposed/mcp. Sign-in is the owner identity. The owner token stays on the A2A endpoint. Claude Code cloud sessions use the [hosted connector](docs/mcp.md#hosted-connector). The steps are in [Getting started](docs/getting-started.md#hosted-inbox).

## Self-host

Self-hosting needs Node 22.18+. Commands run through npx. Confirm the Cloudflare account and the plan before `init` changes it. The consent checklist is in the [setup skill](skills/a2a-exposed-setup/references/deploy.md#before-cloudflare-changes). [Self-hosting](docs/self-hosting.md) covers login, API tokens, and `--account-id`.

```bash
npx -y skills add telegraphic-dev/a2a-exposed
npx -y a2a-exposed@latest init --hostname agent.example.com --agent-name "My Agent"
npx -y a2a-exposed@latest status
```

Omit `--hostname` to serve on `*.workers.dev`. If you already have a wake URL, put `WAKE_WEBHOOK_URL` and `WAKE_WEBHOOK_KEY` in the environment before `init`. Never pass secrets on the command line. Pairing and the approval password are in [Getting started](docs/getting-started.md).

## Docs

| | |
| --- | --- |
| [Getting started](docs/getting-started.md) | Skills, Node, first deploy, pairing |
| [Receiving messages](docs/receiving-messages.md) | Webhooks wake your agent. Without one, it polls, guided by next-check hints |
| [Self-hosting](docs/self-hosting.md) | Cloudflare A2A endpoint, workers.dev, tunnel, uninstall, public façade |
| [CLI](docs/cli.md) | Commands, flags, config |
| [MCP](docs/mcp.md) | Remote connector at `/mcp` |
| [Feedback](docs/feedback.md) | Report a bug or an idea |
| [Security](docs/security.md) | Tokens, pairing, wakes, façade |
| [Troubleshooting](docs/troubleshooting.md) | FAQ and common failures |
| [Upgrading](docs/upgrading.md) | Move an existing A2A endpoint forward |
| [Protocol](docs/protocol.md) | A2A 1.0 and 0.3, OAuth, endpoints |

Changes are listed in [GitHub Releases](https://github.com/telegraphic-dev/a2a-exposed/releases). Agent workflows live in [`skills/`](skills/a2a-exposed/SKILL.md).

## License

MIT, see [LICENSE](LICENSE). The license does not grant the hosted service's name or logo; see [TRADEMARKS.md](TRADEMARKS.md).
