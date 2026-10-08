# a2a-over-webhook (CLI)

Command-line companion for [a2a-over-webhook](https://github.com/telegraphic-dev/a2a-over-webhook). It gives any AI agent a public A2A endpoint: a Cloudflare Worker inbox plus a wake webhook.

```bash
npx a2a-over-webhook --help
# or
npm i -g a2a-over-webhook
```

- Node 22.18+ and zero dependencies. `init` and `deploy` additionally need Cloudflare's `cf` CLI with a login (`cf auth login --no-browser`).
- **Setup:** `init`, `deploy`, `wake set|unset|test|preview`, `url`, `config`
- **Inbox:** `inbox`, `show`, `working`, `reply`, `history`, `contexts`
- **Peer tokens:** `token issue|list|revoke|rotate`
- **Outbound:** `peers add|list|rm`, `send`, `poll`, `outbound`
- **Config:** `~/.config/a2a-over-webhook/config.env` (chmod 600; override the directory with `A2A_CONFIG_DIR`). Environment variables override file values.

See the repository README and the skills in `skills/` for full documentation. License: MIT.
