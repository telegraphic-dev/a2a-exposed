# Teardown (remove an inbox)

There is no teardown command, on purpose: it deletes data. Ask the user first. `npx a2a-exposed config` shows the config dir and the saved `A2A_WORKER_NAME`, `A2A_D1_NAME` and `CF_PROFILE` (add `--profile <name>` to the `cf` calls for a separate login):

```bash
npx a2a-exposed tunnel rm             # only if a wake tunnel exists: wake secrets, DNS record, tunnel, Access app
cd <config dir>/worker                     # the Worker project; its node_modules has the cf CLI
npx cf workers delete <A2A_WORKER_NAME>    # the Worker (agent card and endpoint stop answering)
npx cf d1 delete <A2A_D1_NAME>             # the inbox, conversation history and every token hash
rm -rf <config dir>                        # owner token, stored peer tokens, the Worker project
```

The `cf` CLI is young: check the exact subcommands and confirmation flags with `npx cf workers --help` and `npx cf d1 --help`. Afterwards check the zone's DNS for a leftover record of a custom inbox hostname; the account's workers.dev subdomain stays (it is account-wide). Peers lose access immediately, so tell them if it matters. Never run these against an inbox that isn't the user's to delete.
