# Teardown (remove an inbox)

`npx -y a2a-exposed@latest config` shows the config directory and the saved `A2A_WORKER_NAME`, `A2A_D1_ID`, `A2A_D1_NAME`, `A2A_TUNNEL_TOKEN_FILE` (the path), and `CF_PROFILE`.

`uninstall` prints that plan before it asks. `--dry-run` prints the plan and changes nothing. Off a terminal, pass `--yes`.

```bash
npx -y a2a-exposed@latest uninstall --yes
rm -rf <config dir>                        # owner token, WAKE_* values, stored peer tokens, the Worker project
```

`uninstall` removes the Worker, then the wake tunnel when the config has one (same objects as `tunnel rm`, one line each; Worker secrets are skipped once the Worker is gone), then the D1 database. A missing object is already gone. The config directory stays until you remove it. The owner token and `WAKE_*` values stay in `config.env`. A later `init` reuses the owner token.

Stop `cloudflared` afterwards (`cloudflared service uninstall` when it runs as a service). After you delete the Worker, check Workers & Pages → Settings → Domains & Routes, and the zone's DNS, and remove a custom domain that is still listed. `tunnel rm` deletes the wake hostname's DNS record. The account's workers.dev subdomain stays. A Zero Trust organization created with `--zero-trust-org` is permanent. Peers lose access immediately.

To call `cf` yourself, run it from `<config dir>/worker`, or create a writable cache first (`mkdir -p .cloudflare/cache`). Otherwise `cf` exits with `EACCES: mkdir '.../node_modules/.cache/cloudflare'`. Add `--profile <name>` for a named login.

```bash
npx cf workers delete <A2A_WORKER_NAME> --force
npx cf d1 delete <A2A_D1_ID> --force
```

When the config is gone, the tunnel, Access application, service token, and DNS record are still named `a2a-exposed wake <worker>`.

Dashboard: Zero Trust → Networks → Tunnels; Zero Trust → Access → Applications; Zero Trust → Access → Service credentials; the zone → DNS → Records. Also check Workers & Pages → Domains & Routes.

```bash
npx cf tunnels list
npx cf tunnels delete <tunnel-id> --force
npx cf zero-trust access applications list
npx cf zero-trust access applications delete <app-id> --force
npx cf zero-trust access service-tokens list
npx cf zero-trust access service-tokens delete <token-id> --force
npx cf dns records list -z <zone-id>
npx cf dns records delete <record-id> -z <zone-id> --force
```
