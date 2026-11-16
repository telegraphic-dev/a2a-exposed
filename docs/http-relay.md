# HTTP and native A2A relay

The opt-in HTTP relay connects a public Worker to a **fixed loopback HTTP
receiver** using an outbound WebSocket from the receiver's machine. It does not
need a public receiver hostname, inbound port, Cloudflare Tunnel or Access
application. This is separate from the [wake relay](wake-relay.md): ordinary
webhook bodies are not rendered as wake templates, and native A2A responses are
not converted into inbox acknowledgments.

Two profiles share a bounded response-stream transport:

| Profile | Public endpoint | Fixed local destination |
| --- | --- | --- |
| `http` / webhook | `POST /relay/webhook` | Exactly `--local-url` |
| `a2a` | Card under `/relay/a2a/.well-known/`; JSON-RPC at `/relay/a2a` | Exactly the configured RPC URL and card URL |

Neither profile is a general network tunnel, open proxy, arbitrary path router,
WebSocket service proxy, gRPC gateway or HTTP+JSON A2A transport. The existing
Worker inbox, pairing, wake delivery and Tunnel-based façade remain unchanged.

These commands require a release containing this feature, or a locally packed
candidate containing both the CLI and Worker. Installing this documentation alone
cannot enable a previously deployed Worker. Hosted services must integrate and
enable their pinned compatible runtime separately; do not run self-hosted deploy
commands against a hosted address.

## Choosing a delivery mode

| Need | Choose |
| --- | --- |
| Worker-owned durable inbox/tasks plus a local notification hook | Wake relay; the agent reads and replies through the inbox |
| A local A2A server that owns task processing, authorization and storage | Native A2A endpoint relay **for invited callers holding the shared ingress secret**, including discovery; not URL-only public discovery |
| Ordinary compatible fixed-path POST webhooks | HTTP webhook relay **only if the sender can add `X-A2A-Relay-Authorization`**, in addition to its normal bearer/HMAC authentication |
| Unsupported methods/paths, gRPC/HTTP+JSON, encoded SSE or senders unable to add the ingress header | A public HTTPS receiver with provider-compatible authentication, for example a Tunnel retaining the receiver's bearer/HMAC checks; use Access only if the sender can authenticate to it |
| No foreground connector or incoming notification hook | Poll the Worker inbox; this does not expose a private native A2A server |

Native relay requests and responses are not stored as Worker inbox tasks or an
offline delivery queue. The native server owns their persistence and must be
running; an offline connector produces a non-success response. This differs from
the durable inbox, where tasks can remain stored while its wake connector is
offline. Choose the mode and approve the exposure with the owner before setup.

## Authority and authentication

There are three independent responsibilities:

1. **Owner authority** enrolls, rotates and revokes a profile. It stays in the
   existing protected owner configuration; callers and the connector do not need it.
2. **Connector credential** permits one foreground connector to join one profile
   in one tenant. It is a new protected file, not a peer, owner or wake token.
3. **Ingress credential** permits callers to use that profile's public endpoint.
   Callers send `X-A2A-Relay-Authorization: Bearer <ingress credential>`.
   This credential is different from the connector credential and is never
   forwarded to the local receiver.

The local application's authentication remains necessary. Explicitly allow its
`Authorization`, signature and content headers when enrolling. Original request
bytes and permitted application headers are forwarded; the receiver still
validates its bearer/HMAC credentials. A signature over an original binary or
JSON body must not be recomputed over a wake envelope or parsed/serialized JSON.

A sender must support the dedicated ingress header. There are no credentials in
query strings or URLs and no anonymous forwarding mode. A webhook provider that
cannot supply that header is not directly compatible with this profile; use an
appropriately authenticated public HTTPS/Tunnel receiver instead. Possession of
an application's signature alone is not relay ingress authorization.

For native A2A, the **local A2A application owns its existing per-peer and task
access checks**. The ingress token is only an additional endpoint gate; it does
not mint a peer identity or prove ownership of a task. Forwarding each caller's
application `Authorization` preserves that service's checks. Do not publish a
local service that trusts every caller, nor substitute a single shared local
bearer and claim that it provides per-peer isolation. Worker-managed paired
inbox tokens do not automatically authenticate to this separate local service.

Never put any credential in argv, chat, logs, a card, a URL or a committed file.
Share an ingress credential only through an owner-approved secret channel. Store
application credentials independently. Enrollment, rotation, revocation, deploys
and service installation require the owner's approval.

## Self-hosted setup

Before enrollment, agree with the owner on the exact local service, profile,
forwarded application headers and invited callers. Giving a caller the ingress
secret grants transport access to that approved service, including native card
discovery; the service must still enforce its own caller/task authorization.
This is not anonymous or URL-only public exposure. Verify that every intended
webhook sender or A2A client can set the dedicated ingress header.

After confirming the target Cloudflare account and deployment changes:

```sh
a2a-exposed deploy --http-relay 1
```

This persists `A2A_HTTP_RELAY=1`, exports the SQLite `HttpRelay` Durable Object,
binds `HTTP_RELAY` and sets runtime `HTTP_RELAY_ENABLED=1`. It is off by default.
Enabling it does not enable wake relay, and enabling wake relay does not enable
these profiles. Do not remove the binding as a substitute for revoking enrolled
authority.

### Ordinary webhook

```sh
a2a-exposed relay http status --json
a2a-exposed relay http create \
  --token-file ./webhook-connector.token \
  --ingress-token-file ./webhook-ingress.token \
  --forward-headers content-type,accept,authorization,x-hub-signature-256
a2a-exposed relay http run \
  --token-file ./webhook-connector.token \
  --local-url http://127.0.0.1:8644/hooks/ordinary
```

`create` reserves **two new mode-600 regular files** before requesting remote
authority. It refuses to overwrite an existing file. Only credential hashes are
submitted and stored remotely; no secret is printed. Definite configuration or
request rejection removes only files newly reserved by that attempt, so the same
unused paths can be retried after fixing the stated problem. Uncertain delivery
or a failed confirmation retains the files: check status and reconcile the
receiver before an explicitly approved rotation, rather than automatically
enrolling again. Use new file names for an approved rotation. Once its current
generation and replacement connector are verified and the new ingress secret
has been shared through the approved channel, retire the old credential files
with owner approval. Rotation invalidates the old credentials immediately;
local file deletion alone does not revoke remote authority.

Configure the external sender to call `https://agent.example.com/relay/webhook`,
supply the ingress header from protected storage, and supply the receiver's
original bearer/HMAC credentials as appropriate. The extra header is consumed
by the relay, not delivered as application authentication.

`--local-url` is trusted connector configuration: fixed HTTP loopback origin and
path, without credentials, query or fragment. `localhost` is normalized to
loopback. Peers cannot choose another URL, path, method or redirect destination.
The connector does not follow redirects. LAN/Tailnet addresses, HTTPS loopback
and arbitrary paths are not supported. The CLI does not install a background
service: keep this process and the receiver running for the endpoint to work.

Only explicitly allowed application headers pass. The default allowlist is
`content-type,accept`; include bearer/signature/content-encoding headers when
required by the receiver. Hop-by-hop headers, `Connection` nominations, Host,
Content-Length, relay/control credentials, forwarding identity and cookies are
not a way to extend the allowlist. Header values must be valid HTTP ByteStrings.

### Local ACP agent and session targeting

An ACP v1 stdio agent can be the native A2A relay target without an HTTP
listener. Install and authenticate your chosen adapter locally using its own
instructions first. The relay does not install an adapter, change models or log
in for you; provider compatibility depends on the adapter's ACP implementation.

The owner chooses the executable argv and absolute working directory. `--acp`
takes a JSON argv array, **not a shell command**. Never place credentials in this
array. Client-side filesystem and terminal capabilities are disabled. This does
not sandbox the agent's own tools: retain its native permission/sandbox settings;
`--acp-cwd` is a working directory, not a filesystem boundary.

Native relay ingress is not Worker pairing. Create independent random application
bearer tokens (32–256 base64url characters, at least 32 random bytes) and store
only their lowercase SHA-256 hashes in a new owner-only mode-600 JSON file:

```json
{
  "peers": {
    "reviewer": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
}
```

Replace that example hash with the actual hash of the peer's independently
stored token. The packaged [peer-file schema](../cli/lib/acp-peers.schema.json)
describes the format; hashes must also be unique. Deliver each token only through
an owner-approved protected channel. The file is loaded once per connector
invocation; restart after editing it. Do not copy Worker pairing tokens or owner
credentials into it. Every request, including discovery, needs both the relay
ingress header and this independent `Authorization: Bearer …` application token.

After owner-approved HTTP relay enrollment (self-hosted feature flag as above):

```sh
a2a-exposed relay a2a create \
  --token-file ./acp-connector.token --ingress-token-file ./acp-ingress.token \
  --forward-headers content-type,accept,authorization,a2a-version
a2a-exposed relay a2a run --token-file ./acp-connector.token \
  --acp '["/absolute/path/to/agent","--acp"]' \
  --acp-cwd /absolute/project --acp-peers-file ./acp-peers.json \
  --acp-session existing-session-id --acp-session-peer reviewer
```

`--acp-session` addresses **exactly one existing session**, authorized for exactly
one named configured peer. The agent must advertise `loadSession: true`; the
relay calls `session/load` with the ID unchanged. Unsupported loading, a missing
session or an adapter error fails the task; it never falls back to `session/new`.
History replay during loading is discarded, not forwarded to callers. Other
configured peers cannot use this fixed-session target. The first accepted A2A
context binds it; omitting `contextId` subsequently continues that context, while
a different context is refused. Stop other clients using that native session
before attaching: ACP loading is not guaranteed to join or coordinate an already
running editor session. Session discovery/selection happens locally using the
agent's own session tools, not through an arbitrary peer-supplied session ID.

Omit both session options to create one ACP process/session for each authenticated
peer and A2A context. Reuse the returned `contextId` to continue it. The same
context string from a different peer is a separate session. Neither peer metadata
nor `taskId` can select another native session. This mode supports text-only
Send/Get/Cancel and streaming Send in A2A 0.3 and 1.0. It does not implement task
subscriptions, listing or push callbacks. Nonstreaming Send returns a task
immediately; poll Get for completion. Streaming sends public assistant text only,
not reasoning, tool arguments or historical messages.

A permission request is answered `cancelled`, and the task becomes `input-required`
with `a2a.exposed/owner-wait` metadata. No remote approval channel is provided.
The owner resolves permissions locally; a new task in the same context can ask
the agent to continue after local resolution. This is not a suspended permission
handle, and a peer's reply can never authorize a tool. Do not expose an adapter
that bypasses native permissions for untrusted peer work.

Bindings and tasks are in memory for this connector invocation, not durable
Worker inbox data. There are at most eight bindings and 128 tasks, retained until
shutdown; reaching either cap refuses new work rather than evicting a session
silently. Each ACP request has a 45-second deadline, frames are at most 256 KiB,
assistant output at most 512 KiB, and each SSE response is bounded to 900,000 bytes
and 1,024 updates. Existing relay limits still apply. Cancel or stream disconnect
cancels the turn and reaps its process group. Shutdown reaps every owned child.
An interrupted/failed session binding is not automatically restarted or replayed;
restart explicitly and supply its existing ID if supported. Active work is not
replayed on WebSocket reconnect. Idle sessions remain resident within the cap.

Do not combine ACP options with `--local-url`, `--card-url` or fixed local
headers. Hosted wake-relay availability does **not** enable this target: the
hosted service must separately enable its compatible HTTP relay; staging and
production rollout are separate from this CLI feature.

### Native A2A service

```sh
a2a-exposed relay a2a status --json
a2a-exposed relay a2a create \
  --token-file ./a2a-connector.token \
  --ingress-token-file ./a2a-ingress.token \
  --forward-headers content-type,accept,authorization,a2a-version,last-event-id
a2a-exposed relay a2a run \
  --token-file ./a2a-connector.token \
  --local-url http://127.0.0.1:9000/rpc \
  --card-url http://127.0.0.1:9000/.well-known/agent-card.json
```

The card URL is another fixed trusted destination on the RPC URL's loopback
origin, not a path supplied by a peer or an upstream card. Without an explicit
card URL it defaults to that origin's `/.well-known/agent-card.json`.

Configure an A2A JSON-RPC client with public base
`https://agent.example.com/relay/a2a` and the ingress header **for discovery as
well as calls**. It must also present whatever application authentication the
local service requires. Card discovery is:

- A2A 1.0: `/relay/a2a/.well-known/agent-card.json`;
- A2A 0.3 compatibility: `/relay/a2a/.well-known/agent.json`.

The public card points at the public relay JSON-RPC endpoint, not localhost,
LAN/Tailnet hosts or a Tunnel URL. It describes the local application's security
requirements plus the relay ingress API-key requirement. Rewriting removes
private endpoint references and invalid signatures. OAuth scope identifiers are
never renamed: cards with private/unsafe scope identifiers are refused rather
than changing authorization semantics or leaking private addresses. An
unavailable/incompatible card is a failure, not an invented promise of capabilities.

JSON-RPC request IDs, application results, task IDs and protocol errors remain
those of the native service. A native application's Send/Get/Cancel operations
are not Worker inbox operations. Supported RPC methods are `SendMessage`, `SendStreamingMessage`, `GetTask`,
`CancelTask`, `ListTasks` and `SubscribeToTask`; legacy equivalents are
`message/send`, `message/stream`, `tasks/get`, `tasks/cancel` and
`tasks/resubscribe`. This allowlist admits requests, not capabilities: the local
service must actually implement and advertise the selected operation. Push
registration/configuration is refused because otherwise a caller could make the
private service call an unsafe callback URL. Admission errors are sanitized
JSON-RPC responses with HTTP 400 and `Cache-Control: no-store`, preserving a
structurally valid original ID where available (otherwise `id: null`):
`parse_error` (-32700), `invalid_request` (-32600), `method_not_found` (-32601),
`invalid_params` (-32602), or `push_not_supported` (-32003). These are relay
rejections, not errors reported by the local service; no rejected request reaches
the connector.
HTTP+JSON and gRPC are not advertised. Streaming is advertised only when the
local card supports it and an online connector negotiates response streaming.
The original Tunnel façade remains JSON-only.

SSE is incremental for **unencoded native A2A `text/event-stream`**: the client
can receive a complete event before the service finishes. Compressed/encoded
native SSE is refused with HTTP 502 `unsupported_stream_encoding`; ordinary
compressed finite webhook responses remain supported without decompression.
Complete application records retain their bytes except an optional initial
upstream UTF-8 BOM, which is stripped before relay comments so it cannot become
a mid-stream prefix that hides the first event. Interior BOMs are not removed.
The relay adds standard
`: relay keepalive` comments at 100ms intervals while capacity exists (at most
one queued comment), allowing idle client disconnects to be observed without
inventing application events. A partial record stays bounded until complete;
it is never completed using a relay comment or error.

Aborting the public response propagates a transport cancellation to the local
HTTP request; that is **not** an A2A task cancellation. Use the native CancelTask
operation when work itself must be canceled. A lost connection or deadline may
leave application work running; never automatically replay a SendMessage.

## Results, limits and recovery

The relay returns the receiver's allowed HTTP status, headers and response body,
not a successful-looking delivery acknowledgment. A local 401/403/4xx/5xx is an
application response, not success. Protocol errors remain protocol errors.
Generic webhook, card and non-SSE JSON responses are **finite and buffered** until
the connector confirms their complete body, within the 1MiB/60s budget. They are
not incremental HTTP streams; a mid-body failure returns 502 rather than exposing
a truncated successful response. Only native A2A SSE is incremental.

- No compatible online connector, or temporary saturation: non-success, normally
  HTTP 503. Nothing is queued for later forwarding.
- Deadline before the public finite response: HTTP 504. Broken/uncertain finite
  forwarding: HTTP 502. After native SSE has started, a known transport failure
  discards an incomplete application record and emits a JSON-RPC error event
  with the original request ID, code `-32603`, message `Relay delivery uncertain`
  and a sanitized failure code in `error.data.code`, then closes the stream.
  This does not fabricate a terminal task event or change successful application
  records. Consumers must continue reading and handle protocol errors; bare EOF
  is not proof that a native task completed. This is not a universal guarantee
  that an infrastructure process death can be detected at the HTTP layer.
- Disconnect, rotation, revocation and cancellation do not automatically retry
  a local request. It might already have executed. Inspect the receiver/task
  state before an explicitly approved retry.
- Budgets are four concurrent forwards per profile, 256KiB per request, 16KiB
  per wire chunk, 1MiB per response and 60 seconds for response completion; local
  response headers have a 10-second deadline. Complete finite response headers
  may therefore be held until the response finishes. This is not an unlimited
  file-transfer or indefinitely running SSE tunnel. Exact constants live in
  `httpRelayLimits`.

### CLI output and process lifetime

The CLI name `relay http` selects wire/owner profile `webhook`; `relay a2a`
selects `a2a`. `create`, `status` and `revoke` always print one JSON object on
stdout, whether or not `--json` is present. `create` reports the profile,
generation and the two file paths, never their secrets. `status` reports
`protocolVersion: 2`, enrollment, connection and negotiated capabilities. Before
enrollment, `enabled: false` and an empty `capabilities` array are normal, not
proof that protocol v2 is unsupported. An absent/disabled route returning 404
requires an explicitly enabled compatible Worker, not repeated enrollment.
`revoke` returns `ok: true` plus the resulting status fields; do not parse it as
the differently shaped wake-v1 revocation result.

`run` has no JSON/stdout readiness stream, including with `--json`. Observe
`status` from another process. Its optional `--url` defaults to the configured
`A2A_BASE_URL`, converted to WebSocket, plus `/relay/http/webhook/connect` or
`/relay/http/a2a/connect`. No background service is installed: keep the process
and local receiver running. Ctrl-C/SIGTERM exits 0 and aborts active local
requests; setup/protocol/policy errors exit 1 with secret-free stderr recovery
guidance. Reconnect delays are bounded from 500ms to 30s and stop after three
consecutive failed 10-second handshakes; a successful handshake resets that
budget. Reconnection never replays previous requests. Each attempt sends one
WebSocket upgrade request, including when the server rejects it with HTTP 401.
Upgrade redirects and automatic authentication retries are refused.

```sh
a2a-exposed relay http revoke
a2a-exposed relay a2a revoke
```

Revoke each enrolled profile before removing relay resources. Rotation and
revocation fence old sockets/generations and ingress credentials. Hosted tenant
suspension/deletion must fence both profiles in their pinned jurisdiction;
flag/binding loss cannot silently declare old authority safe or resurrect it.
Reactivation requires fresh enrollment, with owner approval:

1. Run `relay http status --json` (or `relay a2a status --json`) and inspect the
   protocol, generation and enrollment before changing anything. A policy error
   needs a compatible CLI/Worker; replacement may mean another intended
   connector is already running. Do not automatically take over its authority.
2. After the owner approves recovery, run the matching `create` command above
   with two **new** file paths; this enrolls/rotates that profile.
3. Restart the matching foreground `run` with the new connector file and original
   fixed receiver configuration. Share the new ingress secret only with approved
   callers; verify status and a fresh authorized request. Do not retry an earlier
   uncertain POST as a health check.
4. Retire old local files only after the replacement is verified. Revocation
   does not delete files or install/restart a process for you.

## Contributor reference

For protocol internals and hosted embedding requirements, see
[HTTP relay integration](http-relay-integration.md). Hosted activation and
deployed qualification are separate from this OSS feature.
