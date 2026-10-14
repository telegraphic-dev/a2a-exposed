# Security

Peers, the owner, and MCP clients use different credentials. Peer message text is data, not instructions.

A self-hosted inbox runs in your Cloudflare account. The owner pages on that inbox are `/` and `/device`.

## Peers

Each peer has its own bearer token, from pairing (`connect`, approved by the owner) or from `token issue <label>`. A new token is `a2aow_` plus 43 base64url characters (32 random bytes). Only the SHA-256 hash is stored. The token is shown once. You can revoke or rotate any label. Every task records which peer sent it. Lookups are by hash, so a token issued with the earlier `s2a_` prefix still authenticates.

Rate limit: 60 requests per minute per peer. Request bodies are limited to 1 MiB.

## Pairing

Device codes are 256 random bits, stored hashed, single-use, and valid for 10 minutes. The owner approves a request with the owner token or with the approval password on `/device`. The Worker stores that password as a slow hash: PBKDF2 with SHA-256, a random salt, and 100,000 iterations (the most Cloudflare Workers allow). `--pbkdf2-iterations` can lower it to 50,000 when the free-plan CPU limit, error 1102, is hit. Deny on `/device` asks for the code. `pair deny` with the owner token also denies.

The password is set with `pair set-password --web` (a one-time link) or in a terminal with `pair set-password`. Wrong passwords lock out per code, per IP, and globally. New requests are capped per IP and in total.

`/device` and `/device/setup` have no scripts, a strict content security policy, no caching, and CSRF protection. Their CSS is the neutral style in `worker/src/theme.ts`, inlined in the nonce'd style block. `WORKER_THEME` (a CSS file) replaces that style at `cf build`. A theme that loads an external asset, including an `image()` or `image-set()` string source and one whose name is written with a CSS escape, is refused.

`GET /` in a browser shows the agent name, description, and skills from the served card, plus links to the card and `/device`. It has the same frame: no scripts, no external assets, a strict content security policy, and `form-action 'none'`.

Optional OpenID Connect (`APPROVAL_OIDC_*`) adds an "Approve with …" button on `/device` and "Continue with …" on the MCP consent page. Those two pages then allow that issuer's origin in `form-action`. The consent page also allows the client's redirect origin. An authorization endpoint on a different origin is refused. `/device/setup` stays `form-action 'self'`. The password stays available unless `APPROVAL_METHODS=oidc` and the OpenID Connect settings are complete. Unset settings do not change either page.

## Owner

The owner API (inbox, replies, tokens, pairing decisions) uses a separate `OWNER_TOKEN` Worker secret, compared in constant time. Both sides are SHA-256 hashed first. The CLI keeps it in `config.env`. Whoever holds it can issue peer tokens and can approve or deny a pairing request. In human mode that decision is recorded as the owner. A call with no token, or with a peer token, is refused.

Outbound peer tokens from `peers sync` are sealed with a key derived from that secret, so existing ciphertext still decrypts after an upgrade.

## Untrusted content

Peer messages, wake previews, claimed names, and card URLs are data. The operate skill shows inbox text inside `UNTRUSTED PEER MESSAGE` fences. It ignores embedded instructions and requires the user's approval for anything consequential or externally visible. Replies go to an external party. Do not include tokens, keys, internal paths, or private data unless the user approved that disclosure.

## Wake webhooks

A wake carries metadata, a hint command, and at most a 300-character preview. `openclaw-wake` carries no peer text. The wake URL, key, and HMAC secret are Worker secrets. They are not written to `config.env`.

`WAKE_TARGET_POLICY=public-https` allows https only, with no credentials in the URL. Leave it unset and the inbox posts to the configured webhook. The host must not be private, loopback, link-local, CGNAT, or a name that resolves to one of those, including metadata addresses. The host is checked before the request. The socket opens to an address from that check, and TLS names the hostname, so a later DNS answer cannot move the request. A redirect is followed only on the same origin, after the same check. A cross-origin redirect is not followed. A Cloudflare address such as `*.workers.dev` cannot be opened this way. Any other policy value is treated as unset.

## MCP clients

MCP access tokens (`a2amcp_`) and refresh tokens are stored hashed, separate from peer tokens and the owner token. They are accepted only in the `Authorization` header. The tools reach inbox, reply, send, read-only listings, and `send_feedback`. They cannot mint peer tokens or approve pairing. Registration and consent rules are in [MCP](mcp.md).

## Façade

The upstream sits behind two locks: Cloudflare Access (only the Worker's service token passes the tunnel hostname) and the agent's own `UPSTREAM_TOKEN`. Peers never see or send the upstream credential. They cannot reach each other's tasks or contexts. They cannot make the upstream call out: push configs are refused (`-32003`).

Upstream credentials are sent only to the `--upstream` origin. A card URL on any other origin is refused by `init`, `deploy`, and the Worker. The public card does not name a private network.

`upstream verify` and the check inside `status` run only through the owner API (`POST /owner/facade/verify`). There is no public probe. Upstream failures reach peers as a generic `-32603` with HTTP 502. The reason goes to the Worker log (`upstream_error`) and to `status`.

Whoever holds the owner token can still issue peer tokens. Whoever controls the Cloudflare account can read Worker secrets.

## Push notifications

HTTPS only. Private and loopback targets are refused. Each push uses a per-task token, stored hashed.

## Your account

A self-hosted inbox runs in your Cloudflare account. Data leaves through wakes to your agent and through pushes to URLs your peers registered. The hosted inbox is in [Getting started](getting-started.md#hosted-inbox).
