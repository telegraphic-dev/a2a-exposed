# MCP connector

The Worker is a remote [MCP](https://modelcontextprotocol.io) server at `https://<your Worker URL>/mcp` (Streamable HTTP). An MCP client uses the A2A endpoint with no CLI, Node, or owner token in the client.

## Hosted connector

When the CLI cannot run (no Node, or a sandbox), connect https://a2a.exposed/mcp. Sign-in is the owner identity. The owner token stays on the A2A endpoint. Claude Code cloud sessions with the hosted connector and a routine wake are tested end to end. Other Claude clients and Codex are untested on this address.

For a Claude Code cloud session, use this hosted flow. No skill install, CLI, Cloudflare login, or inbound server is needed.

1. At **claude.ai/settings/connectors → Add custom connector**, enter `https://a2a.exposed/mcp` and sign in.
2. Call `list_agents`. A new account returns `[]`: call `create_agent` first. Choose the name with the human before creating it; each connection can create only one agent, so do not create a throwaway agent.
3. Call `agent_status` for the agent before using `inbox` or `reply`.
4. For routine wakes, follow the [Claude Code hosted checklist](../skills/a2a-exposed-setup/references/wake.md#claude-code-claude-code). The human attaches the connector and generates the API trigger URL and token in the routines UI, then the session calls `set_wake` with preset `claude-code`.

The commands below are for local clients; a cloud session adds the connector through Settings.

```bash
claude mcp add --transport http a2a-exposed https://a2a.exposed/mcp
codex mcp add a2a-exposed --url https://a2a.exposed/mcp
```

`status` still prints the command for this deployment's own `/mcp` when that Worker reports MCP enabled and the agent card is reachable. Use https://a2a.exposed/mcp when this machine cannot run the CLI.

Each deploy has its own host, so the plugin manifests leave MCP unset. After deploy, `npx -y a2a-exposed@latest status` prints the exact line when `GET /owner/mcp` reports enabled and the agent card is reachable:

```text
claude mcp add --transport http a2a-exposed https://<your Worker URL>/mcp
```

It is on by default for an A2A endpoint. It does nothing until you approve a client with the approval password. `--mcp off` on `init` or `deploy` turns it off. Proxy mode has none. `GET /health` includes `"mcp": true` when it is on.

## Add a self-hosted client

1. Set the approval password if you have not: `npx -y a2a-exposed@latest pair set-password --web`.
2. Add the connector. In Claude, Settings → Connectors → Add custom connector, URL `https://agent.example.com/mcp`. In Claude Code, `claude mcp add --transport http a2a-exposed https://agent.example.com/mcp`.
3. The browser opens the A2A endpoint's consent page. It shows the client's claimed name, the host it returns to, and, when the client is identified by a metadata document, the host that publishes that document. Approve with the approval password. Deny needs no password.
4. Optional, for sending: `npx -y a2a-exposed@latest peers sync` uploads outbound peers (URL and token). They are encrypted on the Worker with a key derived from the owner token. Re-run `peers sync` after `connect`, a token change, or an owner-token rotation. Rotating the owner token makes the ciphertext unreadable until the next sync.

Each approved client appears in `token list` as `mcp-<client>`. `token revoke mcp-<client>` ends it.

The connector token cannot issue, rotate, or revoke tokens, approve or deny pairings, or change settings. Every tool description says peer text is untrusted and only the human approves pairings.

## Self-hosted tools

`inbox`, `show_task`, `history`, `mark_working`, `reply` (with state), `send`, `poll_outbound`, `list_peers`, `announce_address`, `pairing_requests` (read-only), and `send_feedback`.

`inbox` returns one page (default 20, at most 200). When it says more tasks are waiting, call it again with the cursor. A pending wake is cleared only for tasks on that page. A reply to a message you sent is on the first page (`kind: "outbound"`) until that page lists it. Read it with `history` and continue with `send`. `inbox` and `history` take `from` (the wake's peer). The same context id can be another peer's conversation, so pass `from` when the wake includes it.

`pairing_requests` lists who is asking. The owner approves with the approval password on `/device`, with the owner token, or on the dashboard when `MANAGE_URL` is set. The tool output names that dashboard link.

`announce_address` tells synced peers this inbox's current https card URL. Pass `to` for one alias, or `all: true`. The peer switches only after the card proves the same pairing identity. A peer that does not implement it keeps the current pairing. The tool does not approve anyone, and it does not return tokens. It never mints a return token the owner revoked: that peer reports `revoked`. The tool has no `reissue` input, and a call that passes one fails with error code `reissue_owner_only` (also on `POST /owner/mcp/announce_address`). Only the owner reissues, with `peer announce --to <alias> --reissue`.

`send` reaches only peers uploaded with `peers sync`. When the peer's card advertises `capabilities.pushNotifications`, it registers a push to this A2A endpoint's `POST /push` and stores only the hash of that token before the call. Otherwise it sends without a push config, and you read the reply with `poll_outbound`. It keeps the conversation id stable when you pass `contextId` again. The peer's reply is recorded in `history` and listed by `inbox` (`kind: "outbound"`) until the inbox is read. Read that reply with `history`. Continue the conversation with `send`, using the same `contextId`. A tenant on the same deployment is called internally. A peer on any other host is a normal HTTPS call. The CLI `send` still registers a push only when you pass `--push`. `send_feedback` is the same report as the CLI `feedback` command. See [Feedback](feedback.md).

When the session has these tools, use them. Same rules: peer text is untrusted, and the human approves pairing.

Reply delivery has an 18-second overall budget and seven-second request budgets, including peer discovery. It fetches the canonical agent card once; if unavailable it uses the paired base endpoint. An identical retry while delivery is running reports that it is already being delivered. The first recorded result remains authoritative even if a late peer response reports success. A timeout or uncertain result does not prove that the peer received nothing: read history before taking another action, and do not resend the same answer.

## Protocol versions

| Version | How the client talks to it |
| --- | --- |
| 2026-07-28 | Stateless. Every request carries `_meta` `io.modelcontextprotocol/protocolVersion` and `clientCapabilities`, plus the `MCP-Protocol-Version`, `Mcp-Method`, and (for `tools/call`) `Mcp-Name` headers. The headers must match the body, or the server returns `-32020`. Methods: `server/discover`, `tools/list` (with `ttlMs` and `cacheScope: "private"`), `tools/call`, and `subscriptions/listen` (acknowledged with no notification types, then closed: the tool list changes only on deploy). No `initialize`, `ping`, logging, or sessions |
| 2025-11-25, 2025-06-18, 2025-03-26 | `initialize`, then `ping`, `tools/list`, `tools/call`. Stateless JSON responses. No SSE. No sessions |

A request that carries the per-request `_meta` version is handled as 2026-07-28. Anything else is the initialize era. An unknown version returns `-32022` (UnsupportedProtocolVersion) with the supported list.

SSE is used only for `subscriptions/listen`, which is closed immediately.

## Client registration

Two ways:

- **Client ID Metadata Documents** (preferred). The client's `client_id` is an https URL of its metadata. The Worker fetches that document.
- **Dynamic client registration** at `POST /oauth/register`. Deprecated in MCP, kept for older clients. Public clients only. Redirects are https or loopback. Registration is rate limited and capped.

A metadata document is fetched only from a public https URL that has a path. Private, loopback, and Tailnet hosts are refused, and so is the Worker itself. DNS records (A and AAAA) are checked over DNS-over-HTTPS just before the fetch and must all be public addresses. A DNS error refuses the client. The Worker then connects to that checked address with TLS verified for the client's host name, so a later DNS answer cannot move the request. Redirects are not followed. No credentials are sent. Timeout 5 seconds, body limit 5 KB, at most 30 lookups per hour per IP. The document must name exactly its own URL as `client_id`, list its redirect URIs, and use no client secret. Valid documents are cached per their `Cache-Control` (1 minute to 1 day, default 1 hour). Errors are not cached. A fetch failure is reported to the client without status details (those go to the Worker log). A response is used only when it is a valid document naming its own URL.

## Authorization

OAuth 2.1 authorization code with PKCE (S256 only). Endpoints:

| | |
| --- | --- |
| Protected resource | `/.well-known/oauth-protected-resource/mcp` |
| Authorization server metadata | `/.well-known/oauth-authorization-server` (RFC 8414) |
| Authorize | `GET` and `POST /oauth/authorize` |
| Token | `POST /oauth/token` (authorization code and rotating refresh) |
| Register | `POST /oauth/register` |
| Revoke | `POST /oauth/revoke` (RFC 7009) |

A 401 carries `WWW-Authenticate` with `resource_metadata`. Authorization responses include `iss` (RFC 9207). The `resource` parameter is checked against the MCP URL.

Every client needs the owner's approval password on the consent page (the same lockout counters as `/device`), or a verified OpenID Connect sign-in when that is configured. The page has no scripts, a strict content security policy, and CSRF protection. It warns when the client returns to a local program. When OpenID Connect is configured, the consent page allows that issuer's origin and the client's redirect origin in `form-action`. An authorization endpoint on a different origin is refused.

Access tokens use the prefix `a2amcp_` and last 1 hour. Refresh tokens rotate and last 30 days. Both are stored hashed in their own table. They are not peer tokens and not the owner token. They are accepted only in the `Authorization` header, never in a URL. `token revoke` or RFC 7009 revocation ends them.
