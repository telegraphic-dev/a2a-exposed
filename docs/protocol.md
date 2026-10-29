# Protocol

The public endpoint is the Worker origin. `HEAD` on a GET route returns that GET's status and headers with an empty body. It does not clear a pending wake, spend a setup or pairing lookup, or finish an OpenID Connect callback. A device callback that is still open answers 200 and the approval page's status, and does not approve. An MCP callback `HEAD` stays on the not-approved page, because the success response is a redirect that carries a newly issued code.

## A2A 1.0

Primary. Methods: `SendMessage`, `GetTask`, `CancelTask`, `ListTasks`, `CreateTaskPushNotificationConfig`, `GetTaskPushNotificationConfig`, `ListTaskPushNotificationConfig`, `ListTaskPushNotificationConfigs`, and `DeleteTaskPushNotificationConfig`. Status and role values use ProtoJSON names from the protocol definition, such as `TASK_STATE_COMPLETED` and `ROLE_USER`.

The agent card at `/.well-known/agent-card.json` uses the 1.0 shape. `supportedInterfaces` lists 1.0 first and 0.3 second. `securitySchemes` has `bearer` (`httpAuthSecurityScheme`) and `pairing` (`oauth2SecurityScheme` with a `deviceCode` flow: `deviceAuthorizationUrl`, `tokenUrl`, `scopes`, and `oauth2MetadataUrl`), listed as alternative `securityRequirements`.

A hosted card is cached for 60 seconds (`cache-control: public, max-age=60`). A self-hosted card is cached for 5 minutes.

## A2A 0.3

The same endpoint accepts `message/send`, `tasks/get`, `tasks/cancel`, and `tasks/pushNotificationConfig/set`, `get`, `list`, and `delete`.

`A2A-Version` selects the response shape. A header of `0.3` or `1.0` (a patch such as `1.0.1` or `0.3.0` is ignored) wins over the method name, so `SendMessage` with `A2A-Version: 0.3` answers in the 0.3 shape and `message/send` with `A2A-Version: 1.0` answers in the 1.0 shape. When the header is absent, the query parameter `A2A-Version` is used the same way. When both are absent, the method name selects the shape: `SendMessage` is 1.0 and `message/send` is 0.3, so a 0.3 client that omits the header still receives a 0.3 task. An unsupported value such as `2.0` is JSON-RPC `-32009`, including when the method is unknown.

`GetExtendedAgentCard` and `agent/getAuthenticatedExtendedCard` return `-32007` (the extended agent card is not configured). The served card advertises `extendedAgentCard: false`.

`/.well-known/agent.json` serves an A2A 0.3-shaped card (`url`, `protocolVersion`, `preferredTransport`) for 0.3 clients.

## Conversations

A `contextId` is one peer's conversation. The same string is a separate conversation for each peer. `message/send` without a `taskId` continues the caller's conversation when this peer already holds that id. An id this agent has never seen, and an id another peer already holds, are accepted and kept for the caller. The response echoes that id. The other peer's tasks, history, and wake are not read or written. Omitting `contextId` starts a conversation and the response carries the id the agent generated. A follow-up uses the id in the response.

A2A lets an agent accept a client-supplied `contextId`. When an agent will not accept one, it rejects the call and does not generate a replacement. This inbox accepts the id for the calling peer. The façade does not: an unrecorded context is still JSON-RPC `-32602` with `Invalid params: unknown contextId (omit contextId to start a new conversation, then use the one returned)`, because the façade cannot tell a new id from a live upstream context.

The claim and the first task are one transaction. `conversation_owners` has one row per peer and context id. The task, its message, and its history row are written only when this peer's owner row is present. History and wakes are keyed by peer and `contextId`. `GET /owner/history/<id>?from=<peer>` and `GET /owner/inbox?from=<peer>` read one peer. Without `from`, history is every peer that owns that id, plus local notes, and each row includes `peer`. The wake hint passes `--from` so the agent reads the peer the wake names.

`ListTasks` returns this peer's tasks, newest status timestamp first, then id. `pageSize` is 1 to 100 and defaults to 50. `totalSize` counts every match. `nextPageToken` is empty on the last page. Pass it as `pageToken` for the next page. A `contextId` this peer has no tasks in lists as empty, including when another peer uses that id. A bad `pageToken` is `-32602` and the error does not repeat the token.

`ListTaskPushNotificationConfig` and `ListTaskPushNotificationConfigs` list the configs stored on that task for the calling peer. The 1.0 result is `{ configs, nextPageToken }`. `tasks/pushNotificationConfig/list` returns the array. `DeleteTaskPushNotificationConfig` and `tasks/pushNotificationConfig/delete` remove one config by id. Deleting a config that is already gone succeeds. A missing id is `-32602`. Another peer's task is `-32001`. The façade still refuses push notification calls (`-32003` after that task check).

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

MCP adds `/oauth/authorize`, `/oauth/register`, `/oauth/revoke`, and `/.well-known/oauth-protected-resource/mcp`. See [MCP](mcp.md).

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

`GET /` with `Accept: text/html` returns a small HTML page: agent name, description, skills, a note that this is an A2A endpoint, and links to the agent card and `/device`. No scripts, no external assets, a strict content security policy.

Anything else (`curl`, agents, `Accept: application/json`, `?format=json`) gets JSON: `name`, `description`, `agentCard`, `a2a` (the JSON-RPC endpoint), and `pairing`.

`GET /health` returns `{ ok, publicUrl, mode, mcp, version }`. `mode` is `inbox` or `proxy`; `version` is the deployed inbox build’s package version.

## Proxy mode

Forwards `SendMessage`, `GetTask`, and `CancelTask` (1.0 and 0.3). Another peer's task returns `-32001`. An unknown or unrecorded context returns `-32602`. `ListTasks` returns `-32004`. Push notification config calls return `-32003`. Streaming returns `-32004`. `GetExtendedAgentCard` and `agent/getAuthenticatedExtendedCard` return `-32007` on the façade. A declared `A2A-Version` (header, or the query parameter when the header is absent; a patch is ignored) is forwarded to the upstream as the `A2A-Version` header. A call with neither stays headerless, so the upstream still chooses from the method name. The card advertises only the JSON-RPC versions the upstream card lists.

## Owner API

Authenticated with the owner token. The CLI is the supported way to call these. Paths the CLI uses include:

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
| Addresses | `GET /owner/address` (peers with no callback, pending announcements, the grace forward). `GET /owner/identity` returns the public key and fingerprint only. `PUT /owner/identity` installs the signing key on the owner HTTP API; the private key is sealed and is not returned. `POST /owner/peers/announce` and `POST /owner/mcp/announce_address` take `{ to }` or `{ all: true }`. `PUT /owner/address-forward` takes `{ cardUrl, hours }`. `DELETE /owner/address-forward` clears it |
| MCP revoke | `DELETE /owner/mcp/<label>` |
| Hosted MCP tools | `POST /owner/mcp/send`, `POST /owner/mcp/reply`, `POST /owner/mcp/mark_working`. The hosted control plane calls these after it has checked that the account owns the agent, the same check as the other hosted owner calls. Send takes `to` and `text`, plus optional `contextId` and `taskId`. Reply takes `taskId` and `text`, plus optional `state` (`completed`, `input-required`, `working`, `failed`, or `rejected`). Mark working takes `taskId`. Text is at most 100000 characters. The response is `{ text, isError }`; reply also returns `structuredContent` matching its MCP `outputSchema`. A tool failure is HTTP 200 with `isError: true`. The peer token stays on the A2A endpoint. The owner HTTP API accepts the same paths with the owner token. `send` registers a push to this A2A endpoint's `POST /push` only when the peer card advertises `capabilities.pushNotifications`, and stores only the hash on the outbound task before the send. Otherwise the push config is omitted and the reply is read with `poll_outbound`. The peer's reply is written into that conversation's history and listed on the first inbox page (`kind: "outbound"`) until the inbox is read. A `message` or `artifactUpdate` push supplies that text. Marking the reply seen matches the update snapshot that response returned, so a newer push stays unseen. A follow-up passes the same `contextId`. A call from one tenant to another tenant on this deployment's domain is an internal Durable Object fetch. A peer on any other host stays a public fetch. Self-hosted `send` from the CLI still registers a push only with `--push` |

`GET /owner/inbox` returns one page of tasks, oldest first. The body stays a JSON array. The page is at most 200 tasks, which is also the default. `limit` is 1–200. `from` limits the page to one peer. When another page exists, the `x-a2a-next-cursor` response header is the value to send as `cursor`. The first page also includes a reply to a message this agent sent (`kind: "outbound"`) until that list is read. `all=1` keeps showing it. A reply is marked seen only when the stored update is still the snapshot in that response, so a newer push stays unseen. A pending wake is cleared only for tasks in that response, and only for the inbound wake of that conversation. A task the response does not include keeps its pending wake. An outbound update that reuses the task id keeps its pending wake unless that reply's snapshot was the one returned. `POST /owner/tasks/<id>/working` and `reply` clear the inbound wake for that task and that conversation. `HEAD` does not clear a pending wake.

`/owner/*` requires the owner token. `export` with that token prints the A2A endpoint. `export --sql` prints the same tables as SQL.
