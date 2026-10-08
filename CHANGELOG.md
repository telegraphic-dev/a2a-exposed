# Changelog

All notable changes to the `a2a-over-webhook` CLI, Worker template, and skills. Versions follow [semver](https://semver.org); a `v*` tag publishes the CLI to npm (see the README's **Releases**).

## Unreleased

- **Tunnel on a workers.dev inbox:** `tunnel create` (and `init --workers-dev --tunnel`) no longer needs a custom inbox hostname. The wake hostname goes on any zone of the account: the inbox hostname's zone, otherwise the account's only zone (it says which it picked). With several zones it stops and lists them; choose with the new `--tunnel-zone <zone>` (or `--tunnel-hostname`). With no zone it says plainly that polling is the option. Zones are listed for the deployment's account only.
- **`status` command:** a read-only summary of the deployment and base URL, an agent-card check done by the CLI (no `curl`), the wake mode (webhook, tunnel, or none, which means polling), the tunnel state and connector connections, and a `next step:` line. Exit code 1 when something is broken. `init` and the card warning now point to it.
- **Safe re-runs:** `tunnel create` on an existing tunnel creates nothing. It re-uploads Worker secrets if they're missing, together with an exported `WAKE_WEBHOOK_KEY` / `WAKE_HMAC_SECRET`, and warns if the Worker would still have no webhook auth. A missing connector token file is downloaded again. When an earlier run stopped halfway, it asks for `tunnel rm`. `status` flags a local preset (Hermes, OpenClaw) whose Worker sends no webhook auth. If `init --tunnel` fails at the tunnel step, it says the inbox is deployed and how to continue.
- **Setup skill:** decide how wakes reach the agent (public webhook, local-only webhook, or none) before picking the inbox URL. For local-only webhooks, check for a zone and recommend the secure tunnel with either inbox URL, explaining the tradeoff to the user; polling is the fallback. Adds copy-paste polling commands for Hermes (`hermes cron create "every 2m" ... --skill a2a-over-webhook --name a2a-inbox`, checked against the Hermes source and docs) and OpenClaw (`openclaw cron add --every 5m --session isolated ...`), with a note about command approval prompts. Also adds resuming with `status`, moving from polling to the webhook without a redeploy, and new troubleshooting rows.
- **The agent card always advertises the public base URL:** the Worker template no longer reads an `A2A_PUBLIC_URL` override from the deploy environment, so a local webhook, Tailnet or tunnel URL exported by the agent can't end up in the card. The card URL comes only from the custom hostname or the workers.dev URL. The Worker also ignores a non-https or private-network `PUBLIC_URL` and falls back to the request origin. `init` and `deploy` verify and print the deployment's own URL, and warn when an exported `A2A_BASE_URL` differs. They also warn when the card points elsewhere. `status` flags both cases (`agent card: WRONG URL: ...`, next step `deploy`). This was found in a Hermes setup where the card advertised a Tailnet URL and the agent fixed it by hand.
- **Docs:** both skills and the README check the endpoint with `status` instead of `curl`, because some agent sandboxes (Hermes) flag `.dev` URLs in shell commands. The README and the operate skill describe the tunnel as needing any zone on the account.

## 0.1.0 (unreleased)

First npm release of the CLI (`npm i -g a2a-over-webhook`).

- **Worker:** public agent card and A2A JSON-RPC endpoint (1.0 primary, 0.3 compatible) with a D1 inbox; per-peer `a2aow_` bearer tokens stored as SHA-256 hashes; push notifications; per-conversation wake debounce and an hourly wake cap.
- **Wake presets:** `grok-bot`, `claude-code`, `openclaw-wake`, `openclaw-agent`, `hermes` (HMAC-SHA256), `generic`; `wake set|unset|test|preview|fingerprint` with masked previews and SHA-256 fingerprints instead of secret values.
- **Deploy:** `init` / `deploy` with the `cf` CLI, on a custom domain or a free `*.workers.dev` URL (`--workers-dev-subdomain` registers the account subdomain); `deploy --workers-dev` / `--hostname` move a deployment between the two and retire the old URL (301 for the card, 410 otherwise).
- **cf auth profiles:** `--cf-profile` / `CF_PROFILE` for several Cloudflare logins on one machine.
- **Secure tunnel:** `tunnel create|status|rm` publishes a local-only webhook (OpenClaw, Hermes) through a named Cloudflare Tunnel behind a Cloudflare Access app that admits only the Worker's service token.
- **Inbox and outbound:** `inbox`, `show`, `working`, `reply`, `history`, `contexts`; `peers add|list|rm`, `send`, `poll`, `outbound`; `token issue|list|revoke|rotate`.
- **Skills:** `a2a-over-webhook-setup` (deploy and wake configuration) and `a2a-over-webhook` (day-to-day), with Hermes and OpenClaw frontmatter metadata.
- **Release tooling:** CI on pushes and PRs; tag-triggered npm publish with provenance and a GitHub release.
