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
submitted and stored remotely; no secret is printed. Check status after an
unconfirmed enrollment rather than automatically rotating again. Use new file
names for an explicitly approved rotation.

Configure the external sender to call `https://agent.example.com/relay/webhook`,
supply the ingress header from protected storage, and supply the receiver's
original bearer/HMAC credentials as appropriate. The extra header is consumed
by the relay, not delivered as application authentication.

`--local-url` is trusted connector configuration: fixed HTTP loopback origin and
path, without credentials, query or fragment. `localhost` is normalized to
loopback. Peers cannot choose another URL, path, method or redirect destination.
The connector does not follow redirects. This qualification does not include
LAN/Tailnet addresses, HTTPS loopback, arbitrary paths or background services.

Only explicitly allowed application headers pass. The default allowlist is
`content-type,accept`; include bearer/signature/content-encoding headers when
required by the receiver. Hop-by-hop headers, `Connection` nominations, Host,
Content-Length, relay/control credentials, forwarding identity and cookies are
not a way to extend the allowlist. Header values must be valid HTTP ByteStrings.

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
private endpoint references and invalid signatures. An unavailable/incompatible
card is a failure, not an invented promise of capabilities.

JSON-RPC request IDs, application results, task IDs and protocol errors remain
those of the native service. A native application's Send/Get/Cancel operations
are not Worker inbox operations. Push registration/configuration is refused:
otherwise a caller could make the private service call an unsafe callback URL.
HTTP+JSON and gRPC are not advertised. Streaming is advertised only when the
local card supports it and an online connector negotiates response streaming.
The original Tunnel façade remains JSON-only.

SSE is incremental: the client can receive an event before the service finishes.
Aborting the public response propagates a transport cancellation to the local
HTTP request; that is **not** an A2A task cancellation. Use the native CancelTask
operation when work itself must be canceled. A lost connection or deadline may
leave application work running; never automatically replay a SendMessage.

## Results, limits and recovery

The relay returns the receiver's allowed HTTP status, headers and response body,
not a successful-looking delivery acknowledgment. A local 401/403/4xx/5xx is an
application response, not success. Protocol errors remain protocol errors.

- No compatible online connector, or temporary saturation: non-success, normally
  HTTP 503. Nothing is queued for later forwarding.
- Deadline before response headers: HTTP 504. Broken/uncertain forwarding:
  HTTP 502. If a response has already started, a later failure terminates the
  stream rather than replacing its status with a misleading JSON success.
- Disconnect, rotation, revocation and cancellation do not automatically retry
  a local request. It might already have executed. Inspect the receiver/task
  state before an explicitly approved retry.
- Finite request, frame, response, concurrency and time budgets apply. This is
  not an unlimited file-transfer or indefinitely running SSE tunnel. Exact
  protocol limits live in `httpRelayLimits`; do not advertise an unlimited
  stream because a short fixture works.

Run the connector in the foreground. Ctrl-C/SIGTERM stops it and aborts active
local requests. Other failures use secret-free diagnostics and a nonzero exit;
reconnects are bounded and never replay previous requests. Native Node 24 may
internally duplicate a rejected HTTP 401 WebSocket upgrade: a bounded number of
constructor attempts is not a promise of one wire request per attempt.

```sh
a2a-exposed relay http revoke
a2a-exposed relay a2a revoke
```

Revoke each enrolled profile before removing relay resources. Rotation and
revocation fence old sockets/generations and ingress credentials. Hosted tenant
suspension/deletion must fence both profiles in their pinned jurisdiction;
flag/binding loss cannot silently declare old authority safe or resurrect it.
Reactivation requires fresh enrollment.

## Protocol and hosted integration

`HttpRelay` uses a separate version-2 protocol and namespace from `WakeRelay` v1.
It negotiates HTTP responses and response streaming, uses fixed target enums
rather than URLs in frames, and bounds flow through sequenced chunks and credit.
A wake-v1 connector cannot stand in for an HTTP-v2 connector. A stale or
unsupported version must fail closed before calling the local receiver.

The Worker owner routes are `GET|POST|DELETE /owner/relay/http/webhook` and
`GET|POST|DELETE /owner/relay/http/a2a`. The existing owner authentication and
trusted hosted RPC ownership checks apply. Only SHA-256 credential hashes and a
bounded header allowlist belong in enrollment requests; a caller-supplied tenant
name or account ID is not evidence of ownership. Status never discloses tokens
or their hashes.

Hosted adoption requires the new SQLite export/binding, explicit capability
flag, correct tenant/jurisdiction routing, lifecycle fencing and an integration
using a released compatible core and CLI. This OSS implementation does not
change hosted dashboard UI or activate these profiles on any hosted service.
