# Protocol

The public endpoint is the Worker origin. `HEAD` on a GET route returns that GET's status and headers with an empty body. It does not clear a pending wake, spend a setup or pairing lookup, or finish an OpenID Connect callback. A device callback that is still open answers 200 and the approval page's status, and does not approve. An MCP callback `HEAD` stays on the not-approved page, because the success response is a redirect that carries a newly issued code.

## A2A 1.0

Primary. Methods: `SendMessage`, `GetTask`, `CancelTask`, `ListTasks`, `CreateTaskPushNotificationConfig`, and `GetTaskPushNotificationConfig`. Enums are ProtoJSON (`TASK_STATE_*`, `ROLE_*`).

The agent card at `/.well-known/agent-card.json` uses the 1.0 shape. `supportedInterfaces` lists 1.0 first and 0.3 second. `securitySchemes` has `bearer` (`httpAuthSecurityScheme`) and `pairing` (`oauth2SecurityScheme` with a `deviceCode` flow: `deviceAuthorizationUrl`, `tokenUrl`, `scopes`, and `oauth2MetadataUrl`), listed as alternative `securityRequirements`.

A hosted card is cached for 60 seconds (`cache-control: public, max-age=60`). A self-hosted card is cached for 5 minutes.

## A2A 0.3

The same endpoint accepts `message/send`, `tasks/get`, `tasks/cancel`, and `tasks/pushNotificationConfig/set` and `get`. The version is chosen by the `A2A-Version` header or the method name.

`/.well-known/agent.json` serves an A2A 0.3-shaped card (`url`, `protocolVersion`, `preferredTransport`) for 0.3 clients.

## Streaming

`SendStreamingMessage` is not supported. The error is JSON-RPC `-32004`. Work is asynchronous: the peer polls `GetTask`, or registers a push URL.

## OAuth device flow

| | |
| --- | --- |
| Device authorization | `POST /oauth/device_authorization` |
| Token | `POST /oauth/token` (form-encoded; JSON is accepted) |
| Approval page | `/device` |
| Metadata | `/.well-known/oauth-authorization-server` (RFC 8414) |
| Protected resource | `/.well-known/oauth-protected-resource` |

MCP adds `/oauth/authorize`, `/oauth/register`, `/oauth/revoke`, and `/.well-known/oauth-protected-resource/mcp`. See [MCP](mcp.md).

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
| Inbox | `GET /owner/inbox`, `GET /owner/tasks/<id>`, `GET /owner/history/<contextId>`, `POST /owner/tasks/<id>/working`, `POST /owner/tasks/<id>/reply` |
| Summary | `GET /owner/summary` (counts only: tasks in each state, pending pairing requests; no message text; does not clear a pending wake) |
| Log | `GET /owner/log` (recent history, newest first, no `data_json`; does not mark tasks seen) |
| Export | `GET /owner/export` and `GET /owner/export?format=sql` |
| Feedback discovery | `GET /owner/feedback` |
| Façade | `GET /owner/facade`, `POST /owner/facade/verify` |
| Pairing | `GET /owner/pairing`, password set, `POST /owner/pairing/<code>/approve` and `deny` |
| Peers | `GET /owner/peers`, `GET /owner/outbound-peers` |
| MCP revoke | `DELETE /owner/mcp/<label>` |

On a hosted tenant, the control plane calls an allowlisted subset through `TenantStore.owner()`. That RPC does not return a peer token or a decrypted secret. `/owner/*` on the tenant host still requires the owner token. A self-hosted inbox has no such RPC.

A hosted dashboard download of SQL is the same tables, then redacted: stored token hashes do not authenticate, and ciphertext, push tokens, re-pair hashes, requester IP addresses and countries, OAuth codes, the approval-password hash, password-setup hashes, and OpenID Connect sign-in rows are left out. A pasted peer token or hosted owner token (`a2aot_`) is replaced. That file is not a backup. `export` with the owner token is the full dump.
