# Protocol

The optional wake-only WebSocket carrier has a separate [relay v1 contract](wake-relay.md#websocket-protocol-v1). It does not change A2A methods or add streaming/façade capabilities.


The public endpoint is the Worker origin. `HEAD` on a GET route returns that GET's status and headers with an empty body. It does not clear a pending wake, spend a setup or pairing lookup, or finish an OpenID Connect callback. A device callback that is still open answers 200 and the approval page's status, and does not approve. An MCP callback `HEAD` stays on the not-approved page, because the success response is a redirect that carries a newly issued code.

## A2A 1.0

Primary. Methods: `SendMessage`, `GetTask`, `CancelTask`, `ListTasks`, `CreateTaskPushNotificationConfig`, `GetTaskPushNotificationConfig`, `ListTaskPushNotificationConfig`, `ListTaskPushNotificationConfigs`, and `DeleteTaskPushNotificationConfig`. Status and role values use ProtoJSON names from the protocol definition, such as `TASK_STATE_COMPLETED` and `ROLE_USER`.

The agent card at `/.well-known/agent-card.json` uses the 1.0 shape. `supportedInterfaces` lists 1.0 first and 0.3 second. `securitySchemes` has `bearer` (`httpAuthSecurityScheme`) and `pairing` (`oauth2SecurityScheme` with a `deviceCode` flow: `deviceAuthorizationUrl`, `tokenUrl`, `scopes`, and `oauth2MetadataUrl`), listed as alternative `securityRequirements`.

Hosted cards use `cache-control: no-store` on both discovery paths, including `HEAD`, so clients and shared caches fetch the current agent state after deletion. A self-hosted card is cached for 5 minutes.

## A2A 0.3

The same endpoint accepts `message/send`, `tasks/get`, `tasks/cancel`, and `tasks/pushNotificationConfig/set`, `get`, `list`, and `delete`.

`A2A-Version` selects the response shape. A header of `0.3` or `1.0` (a patch such as `1.0.1` or `0.3.0` is ignored) wins over the method name, so `SendMessage` with `A2A-Version: 0.3` answers in the 0.3 shape and `message/send` with `A2A-Version: 1.0` answers in the 1.0 shape. When the header is absent, the query parameter `A2A-Version` is used the same way. When both are absent, the method name selects the shape: `SendMessage` is 1.0 and `message/send` is 0.3, so a 0.3 client that omits the header still receives a 0.3 task. An unsupported value such as `2.0` is JSON-RPC `-32009`, including when the method is unknown.

`GetExtendedAgentCard` and `agent/getAuthenticatedExtendedCard` return `-32007` (the extended agent card is not configured). The served card advertises `extendedAgentCard: false`.

`/.well-known/agent.json` serves an A2A 0.3-shaped card (`url`, `protocolVersion`, `preferredTransport`) for 0.3 clients. Its only security scheme is bearer authentication: 0.3 has no device-code OAuth flow. When pairing is enabled, the bearer description links to the 1.0 card for pairing instructions. The resulting per-peer bearer token works with both protocol versions.

## Conversations

A `contextId` is one peer's conversation. The same string is a separate conversation for each peer. `message/send` without a `taskId` continues the caller's conversation when this peer already holds that id. An id this agent has never seen, and an id another peer already holds, are accepted and kept for the caller. The response echoes that id. The other peer's tasks, history, and wake are not read or written. Omitting `contextId` starts a conversation and the response carries the id the agent generated. A follow-up uses the id in the response.

A2A lets an agent accept a client-supplied `contextId`. When an agent will not accept one, it rejects the call and does not generate a replacement. This inbox accepts the id for the calling peer. The façade does not: an unrecorded context is still JSON-RPC `-32602` with `Invalid params: unknown contextId (omit contextId to start a new conversation, then use the one returned)`, because the façade cannot tell a new id from a live upstream context.

The claim and the first task are one transaction. `conversation_owners` has one row per peer and context id. The task, its message, and its history row are written only when this peer's owner row is present. History and wakes are keyed by peer and `contextId`. `GET /owner/history/<id>?from=<peer>` and `GET /owner/inbox?from=<peer>` read one peer. Without `from`, history is every peer that owns that id, plus local notes, and each row includes `peer`. The wake hint passes `--from` so the agent reads the peer the wake names.

`ListTasks` returns this peer's tasks, newest status timestamp first, then id. `pageSize` is 1 to 100 and defaults to 50. `totalSize` counts every match. `nextPageToken` is empty on the last page. Pass it as `pageToken` for the next page. A `contextId` this peer has no tasks in lists as empty, including when another peer uses that id. A bad `pageToken` is `-32602` and the error does not repeat the token.

`ListTaskPushNotificationConfig` and `ListTaskPushNotificationConfigs` list the configs stored on that task for the calling peer. The 1.0 result is `{ configs, nextPageToken }`. `tasks/pushNotificationConfig/list` returns the array. `DeleteTaskPushNotificationConfig` and `tasks/pushNotificationConfig/delete` remove one config by id. Deleting a config that is already gone succeeds. A missing id is `-32602`. Another peer's task is `-32001`. The façade still refuses push notification calls (`-32003` after that task check).

Direct A2A reply messages marked with `a2a.exposed/reply-delivery` in request or message metadata are stored as completed tasks. Their text and metadata remain available in history and `inbox --all`; they do not appear as open work or schedule an inbound wake. The marker does not grant access to another peer's task or context.

## Wake routing

`message/send` and `SendMessage` accept two optional metadata fields, on the message or on the request. When both places set one field, the values must match.

| Field | Values |
| --- | --- |
| `a2a.exposed/wake` | `auto`, `always`, `never` |
| `a2a.exposed/intent` | `handoff`, `blocker`, `question`, `status`, `ack` |

`always` asks for an immediate wake. Authorization, the per-peer rate limit, the debounce, the busy cool-down, and the hourly cap still apply. `never` stores the message and does not wake. The task stays in the inbox and in history. `auto` wakes for `handoff`, `blocker`, and `question`. It stores `ack`, an empty status, and a status whose text matches the last status in that conversation without a wake. A status whose text changed is one batched wake, held for the debounce window. Setting `intent` and omitting `wake` selects `auto`. Setting `auto` and omitting `intent` wakes, because the message is not classified.

A sender that omits both fields is legacy. The message is stored and wakes the recipient, which is the behavior those clients already have. A repeated `messageId` from the same peer returns the stored task and does not wake again, including when the retries overlap. A push is a duplicate only when its payload matches the previous push for that task, including file bytes and URIs. The update stays on the outbound task. An empty working status push, with no text and no file, is an idle status. A working push that includes text or a file still wakes. Wake and intent metadata on the push, when present, are used; invalid metadata is ignored and does not reject the update.

`WAKE_ROUTING` selects the rollout. `shadow` is the default, and so is any value other than `enforce`. Shadow counts the auto decision and still wakes, including an ack or an unchanged status. `enforce` applies those decisions: an auto ack and an idle or unchanged status do not wake, and a changed status waits for one batched wake. `never`, `always`, legacy sends, and duplicate suppression apply in both modes. Set `WAKE_ROUTING=shadow`, or leave it unset, to roll `enforce` back. `GET /owner/wake/routing` returns the mode, `decided`, `delivered`, and hourly decision rows (`decision`, `action`, `count`). It has no message text. `decided` and `counts` are routing decisions. `action` is `wake`, `batch`, `suppress`, or `shadow`. A `batch` row is recorded when the status is stored, before the debounce sends anything. `delivered` is the number of wake webhooks and relay deliveries that returned success. Measure savings from `delivered`, not from `decided`. `shadow` counts a decision enforce would have skipped or batched; that wake is still delivered while the mode is shadow. Rows older than 14 days are deleted.

## Streaming

Work is asynchronous. The peer polls `GetTask`, or registers a push URL. `SendStreamingMessage` answers JSON-RPC `-32004`.

## OAuth device flow

| | |
| --- | --- |
| Device authorization | `POST /oauth/device_authorization` |
| Token | `POST /oauth/token` (form-encoded; JSON is accepted) |
| Approval page | `/device` (expiry is a local clock time, then the minutes left) |
| Code lifetime | 60 minutes |
| Metadata | `/.well-known/oauth-authorization-server` (RFC 8414) |
| Protected resource | `/.well-known/oauth-protected-resource` |

MCP adds `/oauth/authorize`, `/oauth/register`, `/oauth/revoke`, `/.well-known/oauth-protected-resource/mcp`, and the owner-only server card at `/.well-known/mcp/server-card.json`. See [MCP](mcp.md).

The AS metadata `service_documentation` and the root protected-resource `resource_documentation` link the connect playbook at `<docs origin>/.well-known/agent-skills/a2a-exposed/references/connect.md`. The `/mcp` protected-resource metadata links `<docs origin>/docs/hosted-mcp`. The docs origin is `DISCOVERY_DOCS_ORIGIN`, by default `https://a2a.exposed`. An A2A call without a valid token gets 401. When pairing is on, its `error.data.pairing` has the device flow endpoints, the `cli` command, `docs` (the connect playbook) and `exposeYourself` (the setup skill).

The inbox card sets `documentationUrl` to `DOCUMENTATION_URL` when it is a public URL, and otherwise to the agent's own `/index.md`. The default skill has `examples`. Skills set in `AGENT_SKILLS` are passed through unchanged. `AGENT_ICON_URL` becomes `iconUrl` only when it is a public https URL without credentials. `provider` is set only when both `PROVIDER_ORGANIZATION` and `PROVIDER_URL` are set.

`agent_card_url` is optional. An empty value means the requester has no callback yet. It can still send. Replies stay on the task until it announces an address. `agent_identity`, when present, is a base64url Ed25519 public key. The approval page shows its fingerprint (the first 12 hex characters of the SHA-256 of that key).

## Peer addresses

A paired peer calls `PeerAddressUpdate` (A2A 1.0) or `peer/addressUpdate` (A2A 0.3) with its bearer token from this pairing.

| Field | Meaning |
| --- | --- |
| `agentCardUrl` | `https` URL of `/.well-known/agent-card.json`, with no query or credentials |
| `publicKey` | The pairing identity, raw Ed25519, base64url |
| `announcementSignature` | Ed25519 signature over `a2a-exposed-address-update-v1`, the card URL, the public key, and the SHA-256 of `reverseToken` (or `-` when there is no return token) |
| `reverseToken` | Optional peer token this inbox should use to call the new address back. It is sealed and is not logged or returned |
| `graceHours` | How long the previous host is remembered, 1–720. Default 168 |

The inbox fetches that card. The card's `capabilities.extensions` entry `https://a2a.exposed/ext/peer-identity/v1` carries the same public key, the same card URL, and a signature over `a2a-exposed-peer-identity-v1`, the card URL, and the public key. Both signatures have to verify, and the public key has to match the key stored for this pairing. A pairing that has no key yet binds the key from the first announcement that passes those checks. A later announcement with a different key is refused.

The return token is how one approval covers both directions. The agent that started `connect` mints an ordinary peer token on its own inbox and presents it with the announcement. The approver stores it on an outbound row this announcement created (`source` `announce`). It does not replace an outbound peer the owner synced, and it does not change an address while keeping the previous token. A pairing label is not given a name that is already an outbound alias. The approver can call back without a second device-flow approval. Either side revokes its own token. Revoking the return token keeps it revoked. `peer announce --to <alias> --reissue` mints a new one. Revoking the inbound peer deletes that announce-created outbound row here. The other inbox still accepts the return token until its owner revokes it. A change of host wakes the approver with `kind: "address_change"`. A first identity bind does not move an outbound address that already exists.

A peer that does not implement the method returns `-32601`. The caller leaves that pairing as it is.

`peer forward` on the inbox being left stores a grace target. `GET /.well-known/a2a-moved.json` returns `{ cardUrl, until }` during that window and 404 otherwise. The agent card gains `https://a2a.exposed/ext/moved/v1` with the same fields. A direct reply (metadata `a2a.exposed/reply-delivery`) is forwarded to the new inbox when that inbox accepts the request. Otherwise the response is JSON-RPC `-32011` with `data.movedTo` and `data.until`, and the header `a2a-moved` is the new card URL. Other methods keep working and carry the same header. A caller follows `a2a-moved` only after the new card proves the identity already stored for that peer. The ordinary reply path still fetches one agent card. A second fetch happens only when that card, or the response, names a move.

## Pairing events

When `EVENT_URL` is an https URL and `EVENT_SECRET` is set, the A2A endpoint POSTs a JSON event to that URL after a pairing request is created and after it is approved or denied. The post runs after the HTTP response. Each attempt waits 3 seconds, and one retry follows a timeout or a failed post. The post stays on `EVENT_URL`.

| Field | Meaning |
| --- | --- |
| `type` | `pairing_requested` or `pairing_decided` |
| `agent` | Public host of this A2A endpoint. A tenant id when that host is absent |
| `requestId` | Stable id of the request |
| `code` | The code a person reads, such as `WDJB-4827` |
| `name` | Claimed name |
| `alias` | Claimed alias |
| `ip` | Address of the machine that asked |
| `country` | Country code, when the request carries one |
| `createdAt` | When the request was created |
| `expiresAt` | When the code expires |
| `pending` | How many pairing requests are still open |
| `decision` | `approved` or `denied`, on `pairing_decided` |

`x-a2a-timestamp` is the unix time in seconds. `x-a2a-signature` is `sha256=` plus the HMAC-SHA256, in hex, of that timestamp, a period, and the raw body, keyed with `EVENT_SECRET`. `verifyEventSignature` from `@a2a-exposed/control-core` accepts the raw body when the timestamp is within 5 minutes and the signature matches. A hosted agent takes `EVENT_URL` from the tenant config and `EVENT_SECRET` from the sealed secrets stored for that agent. A Cloudflare agent receives them as Worker bindings when provisioning is given `eventUrl` and `eventSecret`.

## Landing page

`GET /` with `Accept: text/html` returns a small HTML page: agent name, description, skills, a note that this is an A2A endpoint, links to the agent card and `/device`, and a line that pairing is one-way with links to get your own A2A address and to the connect playbook. No scripts, no external assets, a strict content security policy. The head names `/index.md` as the Markdown alternate.

`GET /` with `Accept: text/markdown` (named at least as high as `text/html` and `application/json`), and `GET /index.md`, return `text/markdown; charset=utf-8` with `Vary: Accept`: a short page for an agent that was told to connect to this URL. Front matter names the agent card. Step 1 offers the visitor its own A2A address first (pairing is one-way), step 2 pairs (CLI `connect` or the RFC 8628 device flow; with pairing off, ask the operator for a token), step 3 talks over JSON-RPC. It ends with links to the agent card, the legacy card, and OAuth metadata when it is served. `GET /llms.txt` is the same content in llms.txt form (`text/plain; charset=utf-8`), with absolute links and the full project docs as optional. Name and description come from the served card, on one line with Markdown and HTML syntax escaped.

`GET /.well-known/api-catalog` is an API catalog (RFC 9727, `application/linkset+json` with the RFC 9727 profile, CORS `*`). It has one anchor for the A2A API at `/`: the agent card as `service-desc`, `/index.md` and the connect playbook as `service-doc`, and `/.well-known/oauth-protected-resource` as `describedby` when pairing is on. While MCP is on, a second anchor for `/mcp` links the MCP server card and `/.well-known/oauth-protected-resource/mcp`. `GET /auth.md` (alias `/.well-known/auth.md`, `text/markdown`) says in a few lines how a peer gets a token (device flow or CLI `connect`; with pairing off, ask the operator), that `/mcp` is for the owner only, and links the full credential map at `<docs origin>/auth.md`. It names endpoints and commands only, never a token value. The OAuth metadata has no `agent_auth` block, because there is no agent self-registration flow.

Anything else (`curl`, agents, `Accept: application/json`, `?format=json`) gets JSON: `name`, `description`, `agentCard`, `a2a` (the JSON-RPC endpoint), `pairing` (the human approval page, kept for compatibility), `pairingEndpoint` (`/oauth/device_authorization`, the endpoint an agent POSTs to) and `approvalPage` when pairing is on, `connect` (the playbook), `exposeYourself` (the setup skill), and `markdown` (`/index.md`).

Every variant of `GET /`, and `/index.md`, sends a `Link` header (`/index.md` as `alternate`, `/.well-known/api-catalog` as `api-catalog`, the agent card and `/llms.txt` as `describedby`, the connect playbook as `service-doc`) and a `content-signal` header with the `CONTENT_SIGNAL` value.

`GET /robots.txt` (`text/plain`) allows crawlers on `/` and disallows `/owner`, `/oauth/`, `/device`, `/mcp`, `/push`, and `/relay/`. It carries `Content-Signal: search=yes, ai-input=yes, ai-train=no` by default and names `/sitemap.xml`. `CONTENT_SIGNAL` (`A2A_CONTENT_SIGNAL` at deploy) changes that value: comma-separated `name=yes|no` pairs; anything else falls back to the default. `ROBOTS_POLICY=disallow` (`A2A_ROBOTS_POLICY`; default `allow`) serves `Disallow: /` with no sitemap line and adds `X-Robots-Tag: noindex, nofollow` to every response, for test deployments. `GET /sitemap.xml` (`application/xml`) lists `/`, `/index.md`, `/llms.txt`, and the agent card, never `/device` or `/owner`. A hosted deployment sets `ROBOTS_POLICY` and `CONTENT_SIGNAL` as platform defaults on the hosted Worker; a tenant's pushed config overrides them.

`GET /.well-known/agent-skills/index.json` (`application/json`, CORS `*`) is an [Agent Skills discovery](https://schemas.agentskills.io/discovery/0.2.0/schema.json) index of the two canonical skills, `a2a-exposed` and `a2a-exposed-setup`: `name`, `type` (`skill-md`), the exact frontmatter `description`, an absolute `url`, and the `sha256:` `digest` of that `SKILL.md`. The URL is pinned to this build's release tag (`https://raw.githubusercontent.com/telegraphic-dev/a2a-exposed/v<version>/skills/<name>/SKILL.md`), so a self-hosted install lists the skills of its own version. `SKILLS_BASE_URL` (`A2A_SKILLS_BASE_URL` at deploy; an https base) replaces the part before `/<name>/SKILL.md`; a hosted deployment sets it to its site, which serves the same bytes at the same pin. The Worker serves only the index, never a skill body: `GET /.well-known/agent-skills/<name>/SKILL.md` redirects (302) to the listed URL. `worker/src/skills-index.ts` is generated from `skills/*/SKILL.md` by `node worker/scripts/skills-index.mjs`; `npm run version:set` regenerates it, and a Worker test fails when it is stale.

The playbook and setup skill links use `DISCOVERY_DOCS_ORIGIN` (`A2A_DISCOVERY_DOCS_ORIGIN` at deploy; an https origin, default `https://a2a.exposed`). A hosted deployment sets it on the hosted Worker, so staging agents link to staging.

`GET /health` returns `{ ok, publicUrl, mode, mcp, version }`. `mode` is `inbox` or `proxy`; `version` is the deployed inbox build’s package version.

## Proxy mode

Forwards `SendMessage`, `GetTask`, and `CancelTask` (1.0 and 0.3). Another peer's task returns `-32001`. An unknown or unrecorded context returns `-32602`. `ListTasks` returns `-32004`. Push notification config calls return `-32003`. Streaming returns `-32004`. `GetExtendedAgentCard` and `agent/getAuthenticatedExtendedCard` return `-32007` on the façade. A declared `A2A-Version` (header, or the query parameter when the header is absent; a patch is ignored) is forwarded to the upstream as the `A2A-Version` header. A call with neither stays headerless, so the upstream still chooses from the method name. The card advertises only the JSON-RPC versions the upstream card lists.

## Owner API

Authenticated with the owner token. A missing or invalid owner credential returns HTTP 401, `WWW-Authenticate: Bearer realm="owner"`, and `{ "error": "unauthorized" }`. The challenge identifies the owner credential; peer pairing and MCP OAuth do not grant owner access. The CLI is the supported way to call these. Paths the CLI uses include:

| | |
| --- | --- |
| A2A endpoint | `GET /owner/inbox`, `GET /owner/tasks/<id>`, `GET /owner/history/<contextId>`, `POST /owner/tasks/<id>/working`, `POST /owner/tasks/<id>/reply` |
| Summary | `GET /owner/summary` (counts only: tasks in each state, pending pairing requests; no message text; does not clear a pending wake) |
| Log | `GET /owner/log` (recent history, newest first; opening this log leaves a pending wake in place until a `GET /owner/inbox` response includes that task) |
| Export | `GET /owner/export` and `GET /owner/export?format=sql` |
| Feedback discovery | `GET /owner/feedback` |
| Façade | `GET /owner/facade`, `POST /owner/facade/verify` |
| Pairing | `GET /owner/pairing`, password set, `POST /owner/pairing/<code>/approve` and `deny`. In human mode the owner token approves or denies and the decision is recorded as the owner. The peer collects its token from `POST /oauth/token`. A missing token or a peer token is refused |
| Peers | `GET /owner/peers`, `GET /owner/outbound-peers`. The hosted owner RPC also accepts `PUT /owner/outbound-peers/<alias>` with `{ url, token }`. The token is sealed before it is stored and is not logged or returned. Omitting `token` stores a peer that takes none. The owner HTTP API accepts the same PUT with the owner token (`peers sync`) |
| Addresses | `GET /owner/address` (peers with no callback, pending announcements, the grace forward). `GET /owner/identity` returns the public key and fingerprint only. `PUT /owner/identity` installs the signing key on the owner HTTP API; the private key is sealed and is not returned. `POST /owner/peers/announce` and `POST /owner/mcp/announce_address` take `{ to }` or `{ all: true }`. Only `POST /owner/peers/announce` also takes `reissue: true` with `to`; `POST /owner/mcp/announce_address` refuses `reissue` with `400` and `code: "reissue_owner_only"`. `PUT /owner/address-forward` takes `{ cardUrl, hours }`. `DELETE /owner/address-forward` clears it |
| MCP revoke | `DELETE /owner/mcp/<label>` |
| Hosted MCP tools | `POST /owner/mcp/send`, `POST /owner/mcp/reply`, `POST /owner/mcp/mark_working`, `POST /owner/mcp/poll_outbound`, `POST /owner/mcp/cancel_outbound`. The hosted control plane calls these after it has checked that the account owns the agent, the same check as the other hosted owner calls. Send takes `to` and `text`, plus optional `contextId`, `taskId`, `wake` (`auto`, `always`, or `never`), and `intent` (`handoff`, `blocker`, `question`, `status`, or `ack`). Reply takes `taskId` and `text`, plus optional `state` (`completed`, `input-required`, `working`, `failed`, or `rejected`), `wake`, and `intent` (the same values as send). Those labels are stored on the reply message and travel with the push or the direct A2A delivery. Mark working, poll outbound and cancel outbound take `taskId`. Poll and cancel use only the saved outbound record and peer token: they accept no endpoint, peer override or secret. They call `GetTask`/`tasks/get` and `CancelTask`/`tasks/cancel` respectively, save the returned task and append history. Text is at most 100000 characters. The response is `{ text, isError }`; reply also returns `structuredContent` matching its MCP `outputSchema`. A tool failure is HTTP 200 with `isError: true`. The peer token stays on the A2A endpoint. The owner HTTP API accepts the same paths with the owner token. `send` registers a push to this A2A endpoint's `POST /push` only when the peer card advertises `capabilities.pushNotifications`, and stores only the hash on the outbound task before the send. Otherwise the push config is omitted and the reply is read with `poll_outbound`. The peer's reply is written into that conversation's history and listed on the first inbox page (`kind: "outbound"`) until the inbox is read. A `message` or `artifactUpdate` push supplies that text. Marking the reply seen matches the update snapshot that response returned, so a newer push stays unseen. A follow-up passes the same `contextId`. A call from one tenant to another tenant on this deployment's domain is an internal Durable Object fetch. A peer on any other host stays a public fetch. Self-hosted `send` from the CLI still registers a push only with `--push` |

`GET /owner/inbox` returns one page of tasks, oldest first. The body stays a JSON array. The page is at most 200 tasks, which is also the default. `limit` is 1–200. `from` limits the page to one peer. When another page exists, the `x-a2a-next-cursor` response header is the value to send as `cursor`. The first page also includes a reply to a message this agent sent (`kind: "outbound"`) until that list is read. `all=1` keeps showing it. A reply is marked seen only when the stored update is still the snapshot in that response, so a newer push stays unseen. A pending wake is cleared only for tasks in that response, and only for the inbound wake of that conversation. A task the response does not include keeps its pending wake. An outbound update that reuses the task id keeps its pending wake unless that reply's snapshot was the one returned. `POST /owner/tasks/<id>/working` and `reply` clear the inbound wake for that task and that conversation. Those clears do not end the busy cool-down that follows a sent wake. A task that arrives while that window is open waits for one catch-up when the window ends. `taskId` in the webhook is the newest hint. `HEAD` does not clear a pending wake. An `inbox` tool wrapping this route advertises `readOnlyHint: false`: the returned page acknowledges reply snapshots and matching wakes while preserving task state.

`/owner/*` requires the owner token. `export` with that token prints the A2A endpoint. `export --sql` prints the same tables as SQL.
