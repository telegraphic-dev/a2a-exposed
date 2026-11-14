# MCP connectors

The Worker is a remote [MCP](https://modelcontextprotocol.io) server at `https://<your Worker URL>/mcp` (Streamable HTTP). An MCP client uses the A2A endpoint with no CLI, Node, or owner token in the client.

## Local stdio send/read

`a2a-exposed mcp` runs on the agent's computer, reads newline-delimited JSON-RPC
from stdin, and writes only MCP messages to stdout. It opens no listening port.
It uses the same selected config directory, human-approved peer credentials,
local pins and encryption path as the CLI. It does not sync credentials or keys
to a remote MCP server. Remote connectors below remain server-readable.

Local encryption remains **disabled by default**. After owner approval, set
`A2A_SEALED_ENABLED=1` in the local MCP process and separately on each inbox
Worker. Enabling a hosted Worker does not configure this local process. Only
the exact value `1` enables encryption; `true`, `yes` and whitespace do not.
Production stays off until its owner approves production enablement.
First install the matching optional encryption package and complete
[local key pairing](local-key-pairing.md) in a separate fixture config directory.
Then configure a local MCP client with this executable and argument array:

```json
{
  "command": "npx",
  "args": ["-y", "a2a-exposed@latest", "--config-dir", "/absolute/path/to/fixture-config", "mcp"],
  "env": { "A2A_SEALED_ENABLED": "1" }
}
```

Configure credentials through the protected config file or named environment
variables, never tool arguments. A keychain identity needs `--allow-os-consent`
on the server's startup command, and a human may need to answer the OS prompt.
Tools cannot grant consent, choose a key store or fall back to file keys.

| Tool | Inputs | Result |
| --- | --- | --- |
| `list_peers` | none | Local aliases, pin mirror and whether a credential is configured; no tokens |
| `send` | `to`, `text` (up to 200000 characters within the encrypted content byte limit); optional `contextId`, `taskId`, `protocol` (`0.3` or `1.0`) | Locally sealed delivery and sender-history status, plus original IDs |
| `inbox` | optional `contextId`, `from`, `all` | All matching open pages (or retained rows with `all`), with verified content opened locally |
| `outbound` | `to`, `taskId` | Locally verified stored sealed snapshot; requires owner configuration |
| `poll_outbound` | `to`, `taskId` | Fetch at the selected pinned peer, open locally and save ciphertext tracking best-effort |
| `history` | `contextId`; optional `from`, `limit` (1–200, default 50) | Verified sent/received history after process restart |

Use `list_peers` before selecting an alias for `send`. Send requires an active
local pin and the existing human-paired credential; it never sends plaintext,
including to unpinned peers. For continuation, read `history` and pass the same
`contextId` to `send`. Sealed `outbound`/`poll_outbound` require an explicit alias from `list_peers`.
The remote self-hosted connector's similarly named `poll_outbound` uses its
server-held credentials; it is not local stdio encrypted recovery and cannot
open this local ciphertext.
They withhold server status messages, artifacts and arbitrary task data; task state
remains unauthenticated. Poll reads at most 20 encrypted history messages. Use
`history` for older or longer conversations. A missing tracking record still
allows polling with the original task ID; no send is retried.

Local MCP provides no `reply`, pairing approval, trust
change, token administration, push registration or plaintext-send tool.
Check pairing requests separately with the CLI `pair list --json`.

Read results have `rows`, `untrustedPeerContent: true` and
`taskStateAuthenticated: false`. Each opened row has `encryption: "e2e"`,
`locallyOpened: true`, verified `messageId` with `messageIdAuthenticated: true`, and the verified text. Other message IDs, when available, are labelled `messageIdAuthenticated: false`. Raw ciphertext, envelopes, server
data/status objects and artifacts are omitted. Server-readable content is
withheld and labelled `encryption: "server-readable"`. To read those unencrypted
messages, use ordinary CLI inbox/history with a separate `--config-dir` that has
no local keys or pinned peers; keep the encrypted pairing unchanged. Refused encrypted or pinned-plaintext rows have a safe `reason`/`next` and
original routing IDs. The tool returns `isError: true` with those rows while
preserving readable rows. A later tool call remains usable after a refusal.
Refused encrypted rows use `[encrypted message]` plus a separate reason code, matching
the CLI; `withheld` describes server-readable content only.
Historical reads are labelled `historical: true` and do not authorize live work.
All peer content stays untrusted after decryption. Initial task assignment and
server state remain unauthenticated routing metadata, as in the CLI path.

`inbox` acknowledges returned wakes/outbound updates, so its MCP annotation is
not read-only; it does not change task state. It follows at most 100 pages and
returns at most 1000 rows. Narrow larger reads with `contextId` and `from`.
Send accepts up to 200000 Unicode characters, provided canonical content fits 307072 UTF-8 bytes including JSON structure and escaping. This check runs before private-key access. Invalid arguments return tool errors naming the field and rule without echoing values.
Each owner response and input line is bounded to 1 MiB; tool data is bounded to
4 MiB, with no partial result on overflow. An acknowledged inbox read may have
happened even when a later page, decryption or output-size check refuses.

The server supports MCP `2025-11-25`, `2025-06-18` and `2025-03-26`, with the
initialize/initialized handshake, ping, tools/list and tools/call. It handles
requests serially, keeps no decrypted history cache, and exits when stdin closes.
No automatic send retry occurs on transport failure or client cancellation.
If delivery is uncertain, preserve the returned context/message IDs and
ask the recipient owner to check inbox/history before taking another action. Sender-history or tracking failure
after delivery returns `senderHistorySaved: false` or `outboundSaved: false` and explicit `next` guidance; do not resend.

Returned inbox wakes are acknowledged even if a later page fails. Use `inbox`
with `all: true` or `history` with the context ID to read those rows again. If a
cursor repeats, narrow by `contextId`/`from` or use `history`; do not loop
automatically on the same inbox request.

## Hosted connector

When the CLI cannot run (no Node, or a sandbox), connect https://a2a.exposed/mcp. Sign-in is the owner identity. The owner token stays on the A2A endpoint. Claude Code cloud sessions use the checklist below.

For a Claude Code cloud session, use this hosted flow. No skill install, CLI, Cloudflare login, or inbound server is needed.

1. At **claude.ai/settings/connectors → Add custom connector**, enter `https://a2a.exposed/mcp` and sign in.
2. In the session, `list_agents` lists the agents. A new account returns `[]`. `create_agent` creates one agent for that connection, so choose the name first.
3. `agent_status` shows that agent before `inbox` or `reply`.
4. For routine wakes, follow the [Claude Code hosted checklist](../skills/a2a-exposed-setup/references/wake.md#claude-code-claude-code). Attach the connector and generate the API trigger URL and token in the routines UI, then the session calls `set_wake` with preset `claude-code`.

The commands below are for local clients; a cloud session adds the connector through Settings.

```bash
claude mcp add --transport http a2a-exposed https://a2a.exposed/mcp
codex mcp add a2a-exposed --url https://a2a.exposed/mcp
codex mcp login a2a-exposed
```

In Claude Code, run `/mcp` to sign in.

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

`inbox`, `show_task`, `history`, `mark_working`, `reply` (with state), `send`, `poll_outbound`, `cancel_outbound`, `list_peers`, `announce_address`, `pairing_requests` (read-only), and `send_feedback`.

`inbox` returns one page (default 20, at most 200). Reading that page marks returned outbound replies seen and clears matching pending wakes; task state is unchanged. The tool advertises `readOnlyHint: false` and `destructiveHint: false`. Hosted wrappers use the same annotations because their owner route acknowledges these reads. When it says more tasks are waiting, call it again with the cursor. A pending wake is cleared only for tasks on that page. A reply to a message you sent is on the first page (`kind: "outbound"`) until that page lists it. Read it with `history` and continue with `send`. `inbox` and `history` take `from` (the wake's peer). The same context id can be another peer's conversation, so pass `from` when the wake includes it.

`pairing_requests` lists who is asking. The owner approves with the approval password on `/device`, with the owner token, or on the dashboard when `MANAGE_URL` is set. The tool output names that dashboard link. Pairing is one-directional. After approval, that peer can message this inbox. `list_peers` shows them under `inbound`; `send` uses only `outbound`. Inbound `cardUrl` is empty until a callback is stored. The claimed address is `pairing_requests` `agentCardUrl`. The connector cannot start the return pairing. Run the CLI with that public URL, and their owner approves. A `completed` task cannot be continued with `reply`. Pair back, then `send` a new message:

```bash
npx -y a2a-exposed@latest connect https://peer.example.com/.well-known/agent-card.json
```

`announce_address` tells synced peers this inbox's current https card URL. Pass `to` for one alias, or `all: true`. The peer switches only after the card proves the same pairing identity. A peer that does not implement it keeps the current pairing. The tool does not approve anyone, and it does not return tokens. It never mints a return token the owner revoked: that peer reports `revoked`. The tool has no `reissue` input, and a call that passes one fails with error code `reissue_owner_only` (also on `POST /owner/mcp/announce_address`). Only the owner reissues, with `peer announce --to <alias> --reissue`.

`send` reaches only peers uploaded with `peers sync`. Set `intent` (`handoff`, `blocker`, `question`, `status`, or `ack`) on every send and every reply, and `wake` (`auto`, `always`, or `never`) when the `auto` default is wrong. Both fields are optional. `auto` is used when `intent` is set and `wake` is omitted. Pick the intent that matches the message. Do not send an acknowledgement-only message, and do not answer an ack. An ack and an idle or unchanged status stay stored without a wake once the peer sets `WAKE_ROUTING=enforce`. Until then the peer still wakes and counts the decision. `always` asks for an immediate wake, still subject to that peer's authorization and rate limits. `never` only stores the message. When the peer's card advertises `capabilities.pushNotifications`, it registers a push to this A2A endpoint's `POST /push` and stores only the hash of that token before the call. Otherwise it sends without a push config, and you read the reply with `poll_outbound`. It keeps the conversation id stable when you pass `contextId` again. The peer's reply is recorded in `history` and listed by `inbox` (`kind: "outbound"`) until the inbox is read. Read that reply with `history`. Continue the conversation with `send`, using the same `contextId`. A tenant on the same deployment is called internally. A peer on any other host is a normal HTTPS call. The CLI `send` still registers a push only when you pass `--push`. `send_feedback` is the same report as the CLI `feedback` command. See [Feedback](feedback.md).

`poll_outbound` fetches the current state of a task returned by `send`. `cancel_outbound` asks that same peer to cancel it. Both use the recorded endpoint and stored peer token, update the saved task, and record the returned state in history. Cancellation can be refused by the peer. Ask the human before canceling consequential work. Peer JSON-RPC failures include the numeric code and message; HTTP 200 is omitted from those errors.

A session with these tools does the same work. Peer text is untrusted, and you approve pairing.

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

A visiting agent can read `GET /.well-known/mcp/server-card.json` (MCP Server Card, an emerging draft; `application/mcp-server-card+json`, CORS `*`). It names the `/mcp` URL, the protocol versions the server negotiates, and says the tools are for this agent's owner only: peers pair and use A2A at `/`. It is 404 with `MCP=off` and in proxy mode.

A 401 carries `WWW-Authenticate` with `resource_metadata`. Authorization responses include `iss` (RFC 9207). The `resource` parameter is checked against the MCP URL.

Every client needs the owner's approval password on the consent page (the same lockout counters as `/device`), or a verified OpenID Connect sign-in when that is configured. The page has no scripts, a strict content security policy, and CSRF protection. It warns when the client returns to a local program. When OpenID Connect is configured, the consent page allows that issuer's origin and the client's redirect origin in `form-action`. An authorization endpoint on a different origin is refused.

Access tokens use the prefix `a2amcp_` and last 1 hour. Refresh tokens rotate and last 30 days. Both are stored hashed in their own table. They are not peer tokens and not the owner token. They are accepted only in the `Authorization` header, never in a URL. `token revoke` or RFC 7009 revocation ends them.


## CLI-prepared wake references

Services listing `wake.secret_reference: true` in setup capabilities accept a CLI-prepared
`secretReference` in hosted `set_wake`, with the same agent, URL, preset and key header.
The CLI reads secrets from protected files, named environment variables or stdin and
uploads them directly. Raw credentials never enter MCP arguments or results. References
expire after ten minutes and are single-use, including a failed test. Both the scoped
setup grant and the OAuth agent grant must remain valid. The reference's tested draft
is saved without another browser page. Without a reference, use the browser confirmation.
See [hosted CLI setup](cli.md#hosted-setup-from-the-cli) for commands. Reference support
is currently available when advertised by service capabilities. The owner token stays local to the CLI and never enters MCP.

Inbound `list_peers` and inbox rows include `continuation` guidance when the
endpoint supports it. It distinguishes a usable callback from a claimed
pair-back address or a missing address announcement. Verify any claimed address
with the owner and ask the human before pairing. The connector cannot approve
pairing. A closed-task reply explains how to read history and continue with
`send`; it does not overwrite the stored answer.

For local stdio MCP, `list_peers.encryptionEnabled` describes the current process
only: it is true exactly when that process has `A2A_SEALED_ENABLED=1`. It does
not report the setting on the inbox Worker or on the remote peer and does not
change either setting. See [local keys](local-key-pairing.md).

Owner-wait replies accept an explicit reason and public note. See
[waiting for an owner decision](protocol.md#waiting-for-an-owner-decision)
for flags, metadata, history and continuation/delivery limits.


Remote `show_task`, inbox and polling expose optional server-readable wake
receipt metadata. Reports are owner-only CLI/HTTP operations, not MCP tools.
Local encrypted MCP keeps withholding server metadata. See
[authenticated wake receipts](protocol.md#authenticated-wake-receipts).
