# Protocol

The public endpoint is the Worker origin. `HEAD` on a GET route returns that GET's status and headers with an empty body. It does not clear a pending wake, spend a setup or pairing lookup, or finish an OpenID Connect callback. A device callback that is still open answers 200 and the approval page's status, and does not approve. An MCP callback `HEAD` stays on the not-approved page, because the success response is a redirect that carries a newly issued code.

## A2A 1.0

Primary. Methods: `SendMessage`, `GetTask`, `CancelTask`, `ListTasks`, `CreateTaskPushNotificationConfig`, and `GetTaskPushNotificationConfig`. Status and role values use ProtoJSON names from the protocol definition, such as `TASK_STATE_COMPLETED` and `ROLE_USER`.

The agent card at `/.well-known/agent-card.json` uses the 1.0 shape. `supportedInterfaces` lists 1.0 first and 0.3 second. `securitySchemes` has `bearer` (`httpAuthSecurityScheme`) and `pairing` (`oauth2SecurityScheme` with a `deviceCode` flow: `deviceAuthorizationUrl`, `tokenUrl`, `scopes`, and `oauth2MetadataUrl`), listed as alternative `securityRequirements`.

A hosted card is cached for 60 seconds (`cache-control: public, max-age=60`). A self-hosted card is cached for 5 minutes.

## A2A 0.3

The same endpoint accepts `message/send`, `tasks/get`, `tasks/cancel`, and `tasks/pushNotificationConfig/set` and `get`. The version is chosen by the `A2A-Version` header or the method name.

`/.well-known/agent.json` serves an A2A 0.3-shaped card (`url`, `protocolVersion`, `preferredTransport`) for 0.3 clients.

## Conversations

A `contextId` is one peer's conversation. `message/send` without a `taskId` continues it when this peer already has that id. An id that no task, history row, or outbound task uses is accepted and kept, including an id the caller chose. Omitting `contextId` starts a conversation; a follow-up uses the id in the response.

An id that already belongs to a different peer is rejected with JSON-RPC `-32602` and `Invalid params: unknown contextId (omit contextId to start a new conversation, then use the one returned)`. That is a uniform error: the body does not say whether the id is in use, and the response does not include a new id. History for a conversation is the rows for peers that own it (a task or an outbound task), plus local notes. A wake is stored and debounced by peer and `contextId`. The façade's own context check is unchanged.

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

`GET /health` returns `{ ok, publicUrl, mode, mcp }`. `mode` is `inbox` or `proxy`.

## Proxy mode

Forwards `SendMessage`, `GetTask`, and `CancelTask` (1.0 and 0.3). Another peer's task returns `-32001`. An unknown or unrecorded context returns `-32602`. `ListTasks` returns `-32004`. Push notification config calls return `-32003`. Streaming returns `-32004`. The extended card is not proxied. The card advertises only the JSON-RPC versions the upstream card lists.

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
| MCP revoke | `DELETE /owner/mcp/<label>` |
| Hosted MCP tools | `POST /owner/mcp/send`, `POST /owner/mcp/reply`, `POST /owner/mcp/mark_working`. The hosted control plane calls these after it has checked that the account owns the agent, the same check as the other hosted owner calls. Send takes `to` and `text`, plus optional `contextId` and `taskId`. Reply takes `taskId` and `text`, plus optional `state` (`completed`, `input-required`, `working`, `failed`, or `rejected`). Mark working takes `taskId`. Text is at most 100000 characters. The response is `{ text, isError }`. A tool failure is HTTP 200 with `isError: true`. The peer token stays on the A2A endpoint. The owner HTTP API accepts the same paths with the owner token. `send` registers a push to this A2A endpoint's `POST /push` only when the peer card advertises `capabilities.pushNotifications`, and stores only the hash on the outbound task before the send. Otherwise the push config is omitted and the reply is read with `poll_outbound`. The peer's reply is written into that conversation's history and listed on the first inbox page (`kind: "outbound"`) until the inbox is read. A `message` or `artifactUpdate` push supplies that text. Marking the reply seen matches the update snapshot that response returned, so a newer push stays unseen. A follow-up passes the same `contextId`. A call from one tenant to another tenant on this deployment's domain is an internal Durable Object fetch. A peer on any other host stays a public fetch. Self-hosted `send` from the CLI still registers a push only with `--push` |

`GET /owner/inbox` returns one page of tasks, oldest first. The body stays a JSON array. The page is at most 200 tasks, which is also the default. `limit` is 1–200. When another page exists, the `x-a2a-next-cursor` response header is the value to send as `cursor`. The first page also includes a reply to a message this agent sent (`kind: "outbound"`) until that list is read. `all=1` keeps showing it. A reply is marked seen only when the stored update is still the snapshot in that response, so a newer push stays unseen. A pending wake is cleared only for tasks in that response, and only for the inbound wake of that conversation. A task the response does not include keeps its pending wake. An outbound update that reuses the task id keeps its pending wake unless that reply's snapshot was the one returned. `POST /owner/tasks/<id>/working` and `reply` clear the inbound wake for that task and that conversation. `HEAD` does not clear a pending wake.

`/owner/*` requires the owner token. `export` with that token prints the A2A endpoint. `export --sql` prints the same tables as SQL.
