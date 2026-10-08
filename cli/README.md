# a2a-over-webhook (CLI)

Command-line companion for [a2a-over-webhook](https://github.com/telegraphic-dev/a2a-over-webhook). It gives any AI agent a public A2A endpoint: a Cloudflare Worker inbox plus a wake webhook.

```bash
npm i -g a2a-over-webhook          # or one-off: npx -y a2a-over-webhook@latest --help
a2a-over-webhook --help
```

The agent skills (`npx --yes skills add telegraphic-dev/a2a-over-webhook`) document the workflows; they do not install this CLI.

- Node 22.18+ and zero dependencies. `init` installs Cloudflare's `cf` CLI into the Worker folder and uses that; you only need a one-time login (`npx cf auth login --no-browser`). No domain? Omit `--hostname` and `init` deploys to `https://<worker>.<account-subdomain>.workers.dev` (`--workers-dev-subdomain <name>` registers the account subdomain if missing).
- **Setup:** `init`, `deploy`, `wake set|unset|test|preview|fingerprint`, `tunnel create|status|rm` (secure Cloudflare Tunnel + Access for local-only webhooks; needs any zone on the account, the inbox can be on workers.dev), `status` (read-only setup check with a next step), `url`, `config`. Use `--cli-command` to set the command shown in wake hints (default `npx a2a-over-webhook`; e.g. a `node <checkout>/cli/bin/a2a-over-webhook.mjs` path for development).
- **Inbox:** `inbox`, `show`, `working`, `reply`, `history`, `contexts`
- **Peer tokens:** `token issue|list|revoke|rotate`
- **Outbound:** `peers add|list|rm`, `send`, `poll`, `outbound`
- **Config:** `~/.config/a2a-over-webhook/config.env` (chmod 600; override the directory with `A2A_CONFIG_DIR`). Environment variables override file values.

See the repository README and the skills in `skills/` for full documentation. License: MIT.
