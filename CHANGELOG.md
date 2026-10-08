# Changelog

All notable changes to the `a2a-over-webhook` CLI, Worker template, and skills. Versions follow [semver](https://semver.org); a `v*` tag publishes the CLI to npm (see the README's **Releases**).

## Unreleased

- **Skills:** the setup skill suggests two optional companion skills near its prerequisites, with install commands: `mise` ([telegraphic-dev/mise-skill](https://github.com/telegraphic-dev/mise-skill), for Node 22.18+) and `cloudflare` ([cloudflare/skills](https://github.com/cloudflare/skills), for Workers, D1, the `cf` CLI, DNS, Tunnel and Access). The operate skill points to `cloudflare` for Cloudflare-side troubleshooting. `related_skills` lists them; the README's install section names both.

## 0.1.0

First npm release of the CLI (`npm i -g a2a-over-webhook`).

- **Worker:** public agent card and A2A JSON-RPC endpoint (1.0 primary, 0.3 compatible) with a D1 inbox; per-peer `a2aow_` bearer tokens stored as SHA-256 hashes; push notifications; per-conversation wake debounce and an hourly wake cap.
- **Wake presets:** `grok-bot`, `claude-code`, `openclaw-wake`, `openclaw-agent`, `hermes` (HMAC-SHA256), `generic`; `wake set|unset|test|preview|fingerprint` with masked previews and SHA-256 fingerprints instead of secret values.
- **Deploy:** `init` / `deploy` with the `cf` CLI, on a custom domain or a free `*.workers.dev` URL (`--workers-dev-subdomain` registers the account subdomain); `deploy --workers-dev` / `--hostname` move a deployment between the two and retire the old URL (301 for the card, 410 otherwise).
- **cf auth profiles:** `--cf-profile` / `CF_PROFILE` for several Cloudflare logins on one machine.
- **Secure tunnel:** `tunnel create|status|rm` publishes a local-only webhook (OpenClaw, Hermes) through a named Cloudflare Tunnel behind a Cloudflare Access app that admits only the Worker's service token.
- **Inbox and outbound:** `inbox`, `show`, `working`, `reply`, `history`, `contexts`; `peers add|list|rm`, `send`, `poll`, `outbound`; `token issue|list|revoke|rotate`.
- **Skills:** `a2a-over-webhook-setup` (deploy and wake configuration) and `a2a-over-webhook` (day-to-day), with Hermes and OpenClaw frontmatter metadata.
- **Release tooling:** CI on pushes and PRs; tag-triggered npm publish with provenance and a GitHub release.
