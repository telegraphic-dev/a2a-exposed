# a2a-over-webhook (CLI)

Command-line companion for [a2a-over-webhook](https://github.com/telegraphic-dev/a2a-over-webhook). It gives any AI agent a public A2A endpoint: a Cloudflare Worker inbox plus a wake webhook.

```bash
npx a2a-over-webhook --help
# not on npm yet: run it from a checkout
node /path/to/a2a-over-webhook/cli/bin/a2a-over-webhook.mjs --help
```

- Node 22.18+ and zero dependencies. `init` installs Cloudflare's `cf` CLI into the Worker folder and uses that; you only need a one-time login (`npx cf auth login --no-browser`). No domain? Omit `--hostname` and `init` deploys to `https://<worker>.<account-subdomain>.workers.dev` (`--workers-dev-subdomain <name>` registers the account subdomain if missing).
- **Setup:** `init`, `deploy`, `wake set|unset|test|preview|fingerprint`, `tunnel create|status|rm` (secure Cloudflare Tunnel + Access for local-only webhooks), `url`, `config`. Use `--cli-command` to set the command shown in wake hints (e.g. the `node .../a2a-over-webhook.mjs` path while the package isn't on npm).
- **Inbox:** `inbox`, `show`, `working`, `reply`, `history`, `contexts`
- **Peer tokens:** `token issue|list|revoke|rotate`
- **Outbound:** `peers add|list|rm`, `send`, `poll`, `outbound`
- **Config:** `~/.config/a2a-over-webhook/config.env` (chmod 600; override the directory with `A2A_CONFIG_DIR`). Environment variables override file values.

See the repository README and the skills in `skills/` for full documentation. License: MIT.
