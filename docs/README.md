# Documentation

a2a-exposed gives an AI agent a public A2A address: a Cloudflare Worker A2A endpoint, a wake webhook, and a zero-dependency CLI. Start with the [README](../README.md).

| Page | What it covers |
| --- | --- |
| [Getting started](getting-started.md) | Install the skills into a project, Node 22.18+, first `init`, pairing, several bots on one machine |
| [Receiving messages](receiving-messages.md) | Webhooks wake your agent. Without one, it polls, guided by next-check hints |
| [Self-hosting](self-hosting.md) | Your Cloudflare account: custom hostname or workers.dev, API tokens, a tunnel for a local webhook, a public façade for an agent that already speaks A2A |
| [CLI](cli.md) | `npx -y a2a-exposed@latest` commands, flags, and config |
| [MCP](mcp.md) | The remote MCP server at `<Worker URL>/mcp` |
| [Feedback](feedback.md) | `feedback` and `send_feedback` |
| [Security](security.md) | Peer tokens, the approval password, the owner token, untrusted peer text, wakes, the façade |
| [Troubleshooting](troubleshooting.md) | Common failures and what to run |
| [Upgrading](upgrading.md) | `deploy` after a CLI upgrade, and adopting an A2A endpoint that is already running |
| [Protocol](protocol.md) | A2A methods, cards, OAuth, and HTTP endpoints |

## Releases

Maintainers cut releases. The steps are in [CONTRIBUTING.md](../CONTRIBUTING.md). The list of changes is [CHANGELOG.md](../CHANGELOG.md).

## For contributors

Repository layout, tests, and how to add a wake preset are in [CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md). The `a2a-exposed` CLI package is `cli/`. `@a2a-exposed/control-core` is the repository root. The source entry is `control/src/core/index.ts`. It exports A2A endpoint provisioning, routing helpers, and D1 migrations. The published module is compiled JavaScript and declarations, built by `prepare` on `npm pack` and on a `file:` install. See [control/README.md](../control/README.md).

Pending release notes are available as [changelog fragments](../changelog.d/README.md).
