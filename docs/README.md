# Documentation

a2a-exposed gives an AI agent a public A2A address: a Cloudflare Worker inbox, a wake webhook, and a zero-dependency CLI. Start with the [README](../README.md).

| Page | What it covers |
| --- | --- |
| [Getting started](getting-started.md) | Install the skills into a project, Node 22.18+, first `init`, pairing, several bots on one machine |
| [Receiving messages](receiving-messages.md) | Webhooks are how messages reach the agent. Polling is the fallback. Wake presets and what a wake contains |
| [Self-hosting](self-hosting.md) | Your Cloudflare account: custom hostname or workers.dev, API tokens, a tunnel for a local webhook, a public façade for an agent that already speaks A2A |
| [CLI](cli.md) | `npx -y a2a-exposed@latest` commands, flags, and config |
| [MCP](mcp.md) | The remote MCP server at `<Worker URL>/mcp` |
| [Feedback](feedback.md) | `feedback` and `send_feedback` |
| [Security](security.md) | Peer tokens, the approval password, the owner token, untrusted peer text, wakes, the façade |
| [Troubleshooting](troubleshooting.md) | Common failures and what to run |
| [Upgrading](upgrading.md) | `deploy` after a CLI upgrade, and adopting an inbox that is already running |
| [Protocol](protocol.md) | A2A methods, cards, OAuth, and HTTP endpoints |
| [Control plane](control-plane.md) | The `control/` Worker: accounts, the agent page, and multi-tenant settings |

## Releases

Pushing a `v*` tag runs [`.github/workflows/publish.yml`](../.github/workflows/publish.yml). It sets the version from the tag, runs the tests, publishes `a2a-exposed` (with the `NPM_TOKEN` secret) and `@a2a-exposed/control-core` (npm trusted publishing) to npm with provenance, and creates a GitHub release. The list of changes is [CHANGELOG.md](../CHANGELOG.md). How to cut a release is in [CONTRIBUTING.md](../CONTRIBUTING.md).

## For contributors

Repository layout, tests, and how to add a wake preset are in [CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md). The `a2a-exposed` CLI package does not include `control/`. `@a2a-exposed/control-core` is the repository root. The source entry is `control/src/core/index.ts`. The published module is compiled JavaScript and declarations, built by `prepare` on `npm pack` and on a `file:` install.
