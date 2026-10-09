# Prerequisites

- **Node 22.18+** (`node -v`). `init`, `deploy` and `wake set` stop on older Node, because Cloudflare's `cf` CLI needs 22.18+. On Node 20, `npx -y a2a-exposed@latest` and `npx -y skills add` only print an `EBADENGINE` warning and still run (the skills CLI asks for >=22.20), so getting past the install does not mean the Node is new enough. To get Node 22 without root and without replacing the system Node, pick one:
  - **mise** (recommended; the optional **mise** companion skill walks through it, see **Recommended companion skills** in this file):
    ```bash
    mise exec node@22 -- npx -y a2a-exposed@latest init ...   # one command on Node 22
    mise use node@22                                      # or: node/npx are Node 22 in this directory from now on
    ```
    To install that skill on old Node, use `mise exec node@22 -- npx -y skills add https://github.com/telegraphic-dev/mise-skill --skill mise` once mise is installed, or save its [`SKILL.md`](https://github.com/telegraphic-dev/mise-skill/blob/master/SKILL.md) by hand.
  - **nvm:** `nvm install 22 && nvm use 22`. **fnm:** `fnm install 22 && fnm use 22`.
  - **Official installer or binaries:** [nodejs.org/en/download](https://nodejs.org/en/download) (a tarball unpacked under `~/.local/opt`, with its `bin/` put first on `PATH`, needs no root).

  Then `node --version` must print v22.18.0 or newer. The CLI's version error prints the same list.
- **Cloudflare login, device-code flow.** No global `cf` is required: `npx cf` works, and the login is stored per user (`~/.config/cloudflare`), so every `cf` binary sees it.
  ```bash
  npx cf auth login --no-browser     # npx fetches Cloudflare's cf CLI; no global install
  ```
  It prints a URL (`https://dash.cloudflare.com/oauth2/device/verify`) and a code. Give both to the user and ask them to approve. The code expires in about 5 minutes. Check with `npx cf auth whoami` (or `cf auth whoami`): it must show `"authenticated": true`. CI can use `CLOUDFLARE_API_TOKEN` instead. If the login fails with `OAuth error: HTTP 403 Forbidden` (or a "Just a moment..." page) **before any code is shown**, that is Cloudflare's bot mitigation for datacenter / VPS IPs: don't retry, use an API token (Troubleshooting: API token).
  `init`/`deploy`/`wake set` run `npm install` in the Worker folder (`<config dir>/worker`) and use the `cf` from its `node_modules/.bin`; a global `cf` only saves typing `npx` for the login.
- **First decide how wakes will reach the agent.** This shapes the rest of the setup, so settle it before choosing the inbox URL:

  | Wake path | Agents | Setup |
  |---|---|---|
  | Public webhook | Grok Bot, Claude Code, hosted n8n/Zapier/Make | `wake set` ([wake](wake.md)); either inbox URL |
  | Local-only webhook | Hermes, OpenClaw, a local n8n | The **secure tunnel** if the account has a zone, else polling |
  | No webhook | Codex, Meta Muse, others | Polling ([wake](wake.md)) |

  For a local-only webhook, check whether the account has a zone (a domain): `npx cf zones list --status active` (add `--profile <name>` for a separate login). An empty list (`[]`) means no domain. Otherwise each entry's top-level `name` is a zone; check that its `account` is the one you deploy to. With a zone, recommend the secure tunnel. It works with **either** inbox URL, workers.dev or a custom hostname, because the wake hostname is separate (`wake-<random>.<zone>`). Explain the tradeoff to the user before going ahead. The tunnel gives immediate wakes. In return, it creates a DNS record, a Cloudflare Tunnel and an Access app on their account, and `cloudflared` has to run on the agent's machine with outbound port 7844 open. Without a zone, or if the user prefers to skip the tunnel, use polling. Polling is the fallback, not the default for a workers.dev inbox.
- **A public URL: workers.dev or your own hostname.**
  - **No domain? Use workers.dev.** Omit `--hostname` (or pass `--workers-dev`): the Worker is served at `https://<worker-name>.<account-subdomain>.workers.dev` ([workers.dev routing](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/), works on the [free plan](https://developers.cloudflare.com/workers/platform/limits/)). `init` learns the URL from the deploy and saves it as `A2A_BASE_URL`. The worker name becomes a DNS label: lowercase letters, digits, hyphens. An account has one workers.dev subdomain; if it has none, `init` stops with instructions. Ask the user for a name and rerun with `--workers-dev-subdomain <name>` (init answers cf's registration prompt through a pseudo-terminal, which needs the `script` command on Linux/macOS; the subdomain is account-level and stays afterwards; its DNS takes 1–5 minutes, and init waits for it), or have them open **Workers & Pages** in the dashboard once, or call `PUT /accounts/<account-id>/workers/subdomain` with `{"subdomain":"<name>"}`. No DNS changes are needed.
  - **Own hostname:** a hostname on a zone the user owns in that account, e.g. `agent.example.com`. The Worker attaches it as a custom domain, and Cloudflare creates the DNS record and certificate. The hostname must not already have a DNS record. Confirm it before `init` (some sandboxes fake DNS answers):
    ```bash
    getent hosts agent.example.com || true
    # DNS-over-HTTPS fallback, for sandboxes whose resolver fakes answers:
    curl -s 'https://cloudflare-dns.com/dns-query?name=agent.example.com&type=A' -H 'accept: application/dns-json'
    ```
    Expect no `Answer` in the JSON (`"Status":3` means NXDOMAIN). If an A/AAAA/CNAME already exists on a zone you care about, stop and ask the user.
- The free Workers plan is enough. D1 free tier: 5 GB.

### Recommended companion skills (optional)

Two separate skills help with this setup. Offer them to the user, and install one only if the user agrees or your platform lets you add skills yourself. Setup works without them.

| Skill | Install | Why |
|---|---|---|
| `mise` | `npx -y skills add https://github.com/telegraphic-dev/mise-skill --skill mise` | Guides installing mise and getting a Node 22.18+ runtime (`mise use node@22`, or one-off `mise exec node@22 -- <cmd>`) without replacing the system Node |
| `cloudflare` | `npx -y skills add https://github.com/cloudflare/skills --skill cloudflare` | Cloudflare's guide to Workers, D1, DNS, Tunnel and Access; for `cloudflare.config.ts` projects like this Worker it sends the agent to the current `cf` CLI docs |

The `-g` / `--agent` / `-y` flags from **Installing these skills** above apply. Like these skills, they install guidance only; the mise binary is installed separately.

### Using a separate Cloudflare account / profile

The default login lives in the `default` cf auth profile (`npx cf auth login --no-browser`). For a second account (e.g. a bot's own Cloudflare account on the same machine), create a named profile and pass it to every `init` / `deploy` / `wake set`:

```bash
npx cf auth create my-bot --no-browser   # device code; approve as the bot account
npx -y a2a-exposed@latest init --cf-profile my-bot --agent-name "My Bot" ...
```

`--cf-profile` is saved as `CF_PROFILE` in `config.env` and passed as `--profile` to every `cf` call for that deployment. Combine it with a separate `A2A_CONFIG_DIR` when several bots share one machine. Re-authenticate with `npx cf auth create my-bot --no-browser` (same name). `npx cf auth list` shows profiles; `npx cf auth activate my-bot <worker-dir>` binds a profile to a directory instead of using `--cf-profile`.
