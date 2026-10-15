# Teardown (remove an inbox)

Ask the user first. `npx -y a2a-exposed@latest config` shows the config dir and the saved `A2A_WORKER_NAME`, `A2A_D1_ID`, `A2A_D1_NAME`, and `CF_PROFILE`.

```bash
npx -y a2a-exposed@latest uninstall --yes
rm -rf <config dir>                        # owner token, stored peer tokens, the Worker project
```

`uninstall` removes the wake tunnel when the config has one (same objects as `tunnel rm`, one line each), then the Worker, then the D1 database. A missing object is already gone. Off a terminal, `--yes` is required. The config directory stays until you remove it.

Stop `cloudflared` afterwards (`cloudflared service uninstall` when it runs as a service). Deleting the Worker also removes its custom domain and that domain's DNS record. The account's workers.dev subdomain stays. A Zero Trust organization created with `--zero-trust-org` is permanent. Peers lose access immediately, so tell them when it matters. Run this only on the user's own inbox.

To call `cf` yourself, run it from `<config dir>/worker`, or create a writable cache first (`mkdir -p .cloudflare/cache`). Otherwise `cf` exits with `EACCES: mkdir '.../node_modules/.cache/cloudflare'`. Add `--profile <name>` for a named login.

```bash
npx cf workers delete <A2A_WORKER_NAME> --force
npx cf d1 delete <A2A_D1_ID> --force
```
