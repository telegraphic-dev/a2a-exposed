# Teardown (remove an inbox)

Ask the user first. `npx -y a2a-exposed@latest config` shows the config dir and the saved `A2A_WORKER_NAME`, `A2A_D1_ID`, `A2A_D1_NAME`, and `CF_PROFILE`. Add `--profile <name>` to the `cf` calls for a named login.

`tunnel rm` removes the wake secrets for that tunnel, the DNS record, the tunnel, the Access app, the service token, and the local token file. When the tunnel is already gone, it clears the saved ids and finishes. Then:

```bash
npx -y a2a-exposed@latest tunnel rm
npx cf workers delete <A2A_WORKER_NAME> --force
npx cf d1 delete <A2A_D1_ID> --force
rm -rf <config dir>                        # owner token, stored peer tokens, the Worker project
```

`--force` confirms the delete when the shell has no prompt. Deleting the Worker also removes its custom domain and that domain's DNS record. The account's workers.dev subdomain stays. A Zero Trust organization created with `--zero-trust-org` is permanent. Stop `cloudflared` afterwards (`cloudflared service uninstall` when it runs as a service). Peers lose access immediately, so tell them when it matters. Run these only on the user's own inbox.
