# a2a-exposed (CLI)

Command-line companion for [a2a-exposed](https://github.com/telegraphic-dev/a2a-exposed). It gives any AI agent a public A2A endpoint: a Cloudflare Worker inbox plus a wake webhook.

```bash
npx -y a2a-exposed@latest --help      # no install needed; @latest always runs the newest release
```

Optional speed-up on your own machine: `npm i -g a2a-exposed@latest`, then `a2a-exposed <command>` (re-run the install to upgrade; the CLI prints a notice when a newer version is out). Agent sandboxes often block global installs as untrusted code, so docs, skills and wake hints always use the npx form. The agent skills (`npx -y skills add telegraphic-dev/a2a-exposed`, into the current project) document the workflows; they do not install this CLI.

- Node 22.18+ and zero dependencies. `init` installs Cloudflare's `cf` CLI into the Worker folder and uses that; you only need a one-time login (`npx cf auth login --no-browser`). No domain? Omit `--hostname` and `init` deploys to `https://<worker>.<account-subdomain>.workers.dev` (`--workers-dev-subdomain <name>` registers the account subdomain if missing).
- **Setup:** `init`, `deploy`, `wake set|unset|test|preview|fingerprint`, `tunnel create|status|rm` (secure Cloudflare Tunnel + Access for local-only webhooks; needs any zone on the account, the inbox can be on workers.dev), `status` (read-only setup check with a next step), `url`, `config`. Use `--cli-command` to set the command shown in wake hints (default `npx -y a2a-exposed@latest`; e.g. a `node <checkout>/cli/bin/a2a-exposed.mjs` path for development).
- **Inbox:** `inbox`, `show`, `working`, `reply`, `history`, `contexts`
- **Pairing (OAuth 2.0 device flow, RFC 8628):** `connect <url>` (ask another inbox for a token; its owner approves), `pair set-password|list|approve|deny` (approve agents that connect to you; human approval by default)
- **Peer tokens:** `token issue|list|revoke|rotate` (manual fallback; `list` also shows tokens created by pairing)
- **Outbound:** `peers add|list|rm`, `send`, `poll`, `outbound`
- **Config:** `~/.config/a2a-exposed/config.env` (chmod 600; override the directory with `A2A_CONFIG_DIR`). Environment variables override file values; a peer token (`PEER_<ALIAS>_TOKEN`) that differs between the two prints a warning on stderr.

See the repository README and the skills in `skills/` for full documentation. License: MIT.
