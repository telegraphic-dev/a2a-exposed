# Hermes wake recipe

Use this recipe for a self-hosted A2A endpoint and a local Hermes gateway.
The route name is `a2a-wake`, its path is `/webhooks/a2a-wake`, and the
fallback cron job is `a2a-inbox`. For another route, pass `--hermes-route NAME`
and use that same name in the Hermes subscription. The default local origin
is `http://127.0.0.1:8644`.

## Prepare the receiver

Enable `WEBHOOK_ENABLED=true` in the Hermes environment and start the gateway.
The cron toolset needs `terminal`; webhook sessions normally have restricted
tools, so route wakes into a cron job with the `a2a-exposed` skill.
Choose the owner's handling mode (`autonomous`, `review-all` or `escalate`)
and substitute it for `<chosen-mode>`:

```bash
hermes cron create "every 6h" \
  "Use the a2a-exposed skill. Handling mode: <chosen-mode>. Run 'npx -y a2a-exposed@latest inbox'; handle tasks and pairing requests under the skill's approval rules. Report peer, task and outcome without peer text or secrets. If empty, respond only [SILENT]." \
  --skill a2a-exposed --name a2a-inbox --deliver origin
hermes webhook subscribe a2a-wake --events a2a_wake --cron-job a2a-inbox \
  --prompt "A2A wake: {kind} from {from}, context {contextId}. Run: {hint}"
```

The subscription generates a signing secret. The human stores it directly in a
protected file outside the repository (mode 600); keep it out of chat, command
arguments, shell history and captured output. Do not recreate an existing
subscription: use its existing secret. Keep the slow cron fallback enabled.
See the [Hermes webhook documentation](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks).

## Publish only the wake route

The human authorizes Cloudflare account, DNS, Tunnel and Access changes.
Start with an existing self-hosted deployment and the Hermes preset. If its
preset differs, configure it first with `wake set --preset hermes`.
Inspect the current settings and available zones, then select a zone explicitly:

```bash
npx -y a2a-exposed@latest wake preview
npx -y a2a-exposed@latest tunnel zones --json
npx -y a2a-exposed@latest tunnel create --preset hermes \
  --hermes-route a2a-wake --tunnel-zone example.com \
  --hmac-secret-stdin < /protected/hermes-hmac-secret
```

`--preset` selects the tunnel defaults and must match the deployed preset.
`--hermes-route` accepts 1–64 letters, digits, underscores or hyphens, starting
with a letter or digit. It cannot be combined with `--tunnel-path`.
`--hmac-secret-stdin` reads one non-empty printable line, never prompts, and
uploads it as `WAKE_HMAC_SECRET` through a temporary protected file. It does
not save the secret in `config.env` or print it. Alternatively, load
`WAKE_HMAC_SECRET` from your secret manager into the environment.
A completed tunnel can be resumed with the same secret input. To change its
origin or path, remove and recreate it with the human's authorization.

Install `cloudflared` on the receiver machine and start the connector using
the printed `--token-file` command. The public path is protected by Access;
only the Worker's service token reaches the gateway. Allow about 30 seconds
for Worker secrets to propagate. [Tunnel details](self-hosting.md).

## Check delivery

```bash
npx -y a2a-exposed@latest wake check --json
# Explicit override when the receiver uses another local address/path:
npx -y a2a-exposed@latest wake check --local-url http://127.0.0.1:8644/webhooks/a2a-wake --json
```

The check sends an unsigned POST to the local route with redirects disabled.
Only HTTP 401 or 403 counts as authentication refusal; an unreachable route,
404 or redirect fails. If refusal passes, it asks the Worker to deliver its
signed test wake and requires a 2xx response. A failed check exits 1.
The default local URL uses the saved tunnel origin and path; an override must
be loopback HTTP(S), without credentials, query or fragment.

This verifies unsigned rejection and signed delivery. It does not prove the
Hermes handler executed: a `kind=test` wake creates no inbox task and there is
no receiver execution receipt. Inspect the Hermes cron output to confirm
handler execution. `wake test` performs only the signed delivery step;
`tunnel status` diagnoses Access and connector problems.

The Worker uses Hermes generic HMAC V2: `X-Webhook-Timestamp` (Unix seconds),
`X-Webhook-Signature-V2` (hex HMAC-SHA256 of `<timestamp>.<raw body>`), and
`X-Request-ID`. Hermes requires the timestamp within ±300 seconds. The event
name is `a2a_wake`. Peer text and wake metadata remain untrusted after signature
verification; the skill's human approval rules still apply.
