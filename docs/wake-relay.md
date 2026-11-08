# Wake relay

The optional relay carries **wake webhooks only**, from the Worker to a foreground
connector on the agent's machine. The machine makes an outbound WebSocket
connection; it needs no public webhook hostname, Cloudflare Tunnel, inbound port,
service install, or Cloudflare API credential. This is not a façade transport or a
general HTTP/network tunnel. Existing HTTPS/Tunnel wakes remain unchanged.

## Self-hosted setup

Use Node 22.18 or newer. Enable the feature when deploying your own Worker:

```sh
a2a-exposed deploy --wake-relay 1 --wake-transport relay --preset hermes
```

The equivalent deployment environment is `A2A_WAKE_RELAY=1`,
`WAKE_TRANSPORT=relay`, and `WAKE_PRESET=hermes`. These are non-secret settings;
the CLI persists explicit deployment flags. `A2A_WAKE_RELAY` is off by default:
an ordinary deployment declares no relay binding or Durable Object export.
For HTTP delivery use `--wake-transport webhook`. Keep the relay binding enabled
until enrolled connectors have been revoked; removing the binding is not a
substitute for revoking authority.

Configure the receiver's application credentials exactly as for HTTP wakes:
`WAKE_WEBHOOK_KEY`, `WAKE_HMAC_SECRET`, and preset options still apply. Upload
secrets through the existing protected environment/file flows, never plaintext
arguments. A relay credential does not replace receiver bearer/HMAC validation.
`WAKE_WEBHOOK_URL` is unnecessary in relay mode; no fake URL or exception to
`WAKE_TARGET_POLICY=public-https` is used.

```sh
a2a-exposed relay status --json
a2a-exposed relay create --token-file ./wake-relay.token
a2a-exposed relay run --token-file ./wake-relay.token \
  --local-url http://127.0.0.1:8644/webhooks/a2a-wake
```

`create` creates a **new** mode-600 file and rotates any previous enrollment.
It refuses to overwrite files, prints no credential, and confirms the remote
state before reporting success. On an unconfirmed enrollment the local file is
retained: check status before rotating again. To rotate, use a new filename.
`run` also accepts `--token-env VARIABLE_NAME`, mutually exclusive with the file.
Never put the credential in argv, a URL, chat, or logs. `--url` selects an explicit
`wss://agent.example.com/relay/connect` endpoint; otherwise it uses this config's
`A2A_BASE_URL`. Hosted applications can supply that URL and a protected relay
credential without giving the connector an owner credential.

`--local-url` is trusted local configuration: HTTP(S), loopback host only
(`127.0.0.1`, `::1`, or `localhost`), with a fixed path and no credentials, query,
or fragment. All deliveries are POSTs to that exact URL. Frames cannot choose a
URL, path, method, redirect destination, or alternate application credential.
Redirects are not followed. Keep the loopback listener protected from other
local users and validate its application credentials.

In another terminal run the existing `a2a-exposed wake test`. A successful result
means the local HTTP server returned a 2xx status, **not** that the agent finished
work. A socket receipt alone is not a successful wake. Stop with Ctrl-C/SIGTERM.
The connector aborts active requests and exits without installing anything.

```sh
a2a-exposed relay revoke
a2a-exposed relay status --json
```

Revocation reads the enrollment generation, revokes that exact generation, and
reads back the result. Rotation, revocation, and a newer connection fence old
sockets and their acknowledgments. Only one connector is active per tenant.
A connector replaced/revoked with close code 4001 exits instead of fighting the
replacement. Other disconnections reconnect with bounded exponential backoff
and full jitter (at most 30 seconds). No service is installed automatically.

## Hosted integration contract

This is reusable OSS runtime/control-core support. Hosted services pin their
own releases and must explicitly enable and integrate it. Its presence in this
repository does not update a hosted service or establish a production deployment.

- Export `WakeRelay` as a **SQLite** Durable Object and bind it as `WAKE_RELAY`.
  Set runtime `WAKE_RELAY_ENABLED=1`; the supplied `cf` config does both when
  `A2A_WAKE_RELAY=1`. `WAKE_RELAY_PROTOCOL_VERSION` is exported from
  `worker/src/relay.ts` and from `@a2a-exposed/control-core`, with value **1**.
- Route the tenant hostname through the existing hosted router. The relay
  coordination key is `wake-relay-v1:host:<immutable tenant id>` (self-hosted:
  `wake-relay-v1:single:self`), in the inbox directory's pinned jurisdiction (retained in tenant storage for deletion fencing).
  Missing region discovery fails closed; it never silently enrolls a global relay. Never shard
  on a recyclable hostname or use a platform-wide room.
- The public owner API requires the existing owner bearer. Peer and MCP tokens
  cannot enroll or administer a connector. The trusted `TenantStore.owner()`
  allowlist supports the same routes, but **the calling service must verify
  account ownership and approval first**. A caller-supplied `accountId` is not
  proof of ownership; never expose that internal RPC as an unchecked proxy.
- Suspension/deleting config pushes and `deleteStorage()` revoke and close the
  separate relay before completing. Reactivation requires fresh enrollment.
  Tenant deletion retains its existing tombstone; a stale directory entry and
  a late config push cannot reconnect the deleted tenant.

### Owner API

All responses use `Cache-Control: no-store`. Feature disabled/unbound: 404.

| Method and path | Request | Response |
| --- | --- | --- |
| `GET /owner/wake/relay` | No body/query | `enabled`, `protocolVersion:1`, `transport:"relay"`, `connectorId:"default"`, `enrolled`, `generation` (credential epoch), `connectionGeneration`, `connected`, `configVersion` |
| `POST /owner/wake/relay` | `{credentialHash, idempotencyKey, configVersion}` | `{connectorId:"default", generation, protocolVersion:1}` |
| `DELETE /owner/wake/relay` | `{generation}` | `{revoked:true, generation}` (new epoch) |

The client generates `a2ar_` plus 43 base64url characters from 32 random bytes,
saves it locally, and submits its lowercase SHA-256 hex `credentialHash`.
Only the hash is stored by the Worker; no credential is returned. The
`idempotencyKey` is 16–128 ASCII letters, digits, `_` or `-` (CLI uses fresh random
bytes). Repeating the current key/hash returns the same credential epoch even
after reconnect; the same key with a different hash conflicts. Only the current
enrollment's key is retained; this is not an indefinite historical replay log.
A new key rotates the credential and closes current sockets. DELETE requires an
exact current epoch, otherwise 409. Revocation advances the epoch and clears
the enrollment/idempotency key.

Hosted POST requires the currently applied runtime `configVersion`; a mismatch
is 409. Self-hosted config version is 0 and the field is optional. Enrollment
and saving wake settings are separate operations, not a distributed transaction.
Do not claim success until the relevant runtime and control-plane reads agree.

`WakeSaveInput` accepts `transport:"webhook"|"relay"`, `connectorId:"default"`,
and numeric `generation`. Relay saves require a positive credential epoch and
an **empty** URL. Empty URL in relay mode does not disable the wake or erase its
application credentials. Public config uses `WAKE_TRANSPORT`,
`WAKE_CONNECTOR_ID`, `WAKE_CONNECTOR_GENERATION`; application secrets remain
sealed. The existing config-version CAS and immediately following outbox insert
remain in the same database batch (`UPDATE tenants SET config_json = ...`).
`wakeSettingsOf()` returns relay transport/identity/epoch for relay settings;
legacy webhook settings keep their existing shape. A blank secret retains an
existing secret only for the same transport, connector identity, preset and
authentication mode. Switching transport requires supplying credentials again.

`POST /owner/wake/test` without a body continues to test the **applied** settings
(the public owner HTTP API also retains the legacy empty-object `{}` form).
To test an initial or edited relay draft **before saving**, send this owner-only
body through the same HTTP route or trusted `TenantStore.owner()` call:

```json
{
  "transport": "relay",
  "connectorId": "default",
  "generation": 1,
  "credentialsMode": "resolved",
  "preset": "generic",
  "key": "dummy-receiver-key",
  "hmacSecret": "dummy-receiver-signing-secret"
}
```

`generation` is the current positive enrollment epoch, not the connection
counter or config version. Required fields are exactly those shown above except
`key` and `hmacSecret`, which are optional. Other optional string fields are
`agentId`, `keyHeader`, `keyPrefix`, `bodyTemplate`, `cliCommand`,
`accessClientId`, and `accessClientSecret`. An optional `url` must be empty;
nonempty URLs, unknown fields, raw headers, methods, and frame bodies are refused.
The preset must be in `WAKE_PRESETS`. The machine-readable
[request schema](../worker/src/wake-relay-test.schema.json) ships with the Worker.
Strings are bounded to 4096 characters (JSON body template: 65536); header
values cannot contain control characters. The existing 1 MiB request limit,
relay frame/body limits, and fixed connector destination still apply.

`credentialsMode:"resolved"` explicitly means **use only this body's values**.
Omitted or empty credentials are absent: the runtime never falls back to saved
secrets. The trusted hosted caller must resolve a retained secret only when its
existing saved-setting credential-retention rules permit it, or require fresh
input. Do not send secret values to the browser, logs, or public errors. The
runtime renders and signs one `kind:"test"` event from this draft, sends its
exact bytes, and does not save settings, arm busy state, or flush/consume the
pending wake queue. A no-body probe and the draft probe are distinct operations.

Successful dispatch returns HTTP 200 with `{preset, configured:true,
transport:"relay", connector, status, info}`. `connector` is the pre-dispatch
status snapshot; `status` is the actual local HTTP status, or null when offline
or unconfirmed. Treat only 2xx **local status** as test success. Invalid draft or
render failure is HTTP 400; stale/revoked enrollment is 409 (checked both before
render and at final dispatch); disabled feature is 404. No response returns the
supplied credentials or receiver body. This additive owner API does not change
WebSocket protocol v1 or its credential format.

After testing, save with the existing expected-version check and wait for the
outbox to apply. Enrollment, testing, and saving are separate operations. If
saving fails after enrollment, revoke that exact new enrollment epoch; do not
overwrite another writer's settings.

### WebSocket protocol v1

`GET /relay/connect`, no query string and no browser Origin header. Offer
`Sec-WebSocket-Protocol: a2a-wake-v1, <relay credential>`; the server selects only
`a2a-wake-v1`. Credentials are never query parameters or echoed response headers.
Redact the protocol request header in any infrastructure logging you add.
Native Node WebSocket supports this without custom headers or dependencies.
The server authenticates before accepting; owner/peer/MCP credentials are refused.

All application frames are single JSON text messages with exact keys:

```text
server → connector {v:1,type:"hello",generation:<connection generation>}
server → connector {v:1,type:"wake",id:<UUID>,generation,deadline:<Unix ms>,headers:<object>,body:<UTF-8 string>}
server → connector {v:1,type:"cancel",id,generation}
connector → server {v:1,type:"result",id,generation,status:<HTTP status or 0>}
```

`status:0` means unconfirmed local execution. HTTP status is 200–599. The
connector cancels the response body rather than forwarding receiver content.
No peer-selected network operation is supported. Frames are at most 128 KiB,
bodies 64 KiB, request headers 16 KiB; connector results at most 1 KiB. At most
four requests run concurrently, with a ten-second deadline; saturation rejects
instead of queuing. Invalid/binary/oversized result frames close with 1008.
Late unknown IDs are ignored; a stale connection generation cannot acknowledge
another connection's request. Credentials and application headers are not logged.

The connector sends text `ping` every 25 seconds. `setWebSocketAutoResponse`
answers `pong` without waking the Durable Object; there is no recurring DO idle
timer. Sockets use `acceptWebSocket` and a generation attachment, recovered with
`getWebSockets()` after hibernation. Active HTTP waits have bounded timers and
are not idle hibernation time. A runtime/deployment reset can still disconnect
sockets and fail in-flight waits.

## Delivery and recovery

The inbox is authoritative. A connect regenerates one fresh, coalesced, signed
`catchup` hint when submitted/working tasks, unseen outbound updates or pending
wake rows exist. The hint asks for an unfiltered `inbox`, contains no peer text,
and does not clear inbox/wake state. Reading the inbox and replying keep their
existing acknowledgment and isolation rules. Catch-up obeys the hourly wake cap.
This is a wake hint, not replay of a previous serialized webhook.

Timeout, cancellation, or disconnect after a request was dispatched can mean the
local receiver executed it but its acknowledgment was lost. The relay reports
unconfirmed delivery, cleans up the wait, and **never automatically retries that
POST**, including HTTP 429/503. Reconnect may generate another inbox hint for work
still pending, so receivers must tolerate duplicate hints. There is no exactly-once
execution guarantee. Poll the inbox as a fallback, especially after an unconfirmed
wake, a cap, or a disabled/offline connector. Pending pairing notices are still
available through `pair list`; the relay does not persist/replay pairing POSTs.

## Local verification and boundaries

`worker/test/relay.test.ts` runs the actual bundled Worker/SQLite relay in workerd,
the native Node connector and real loopback HTTP receiver, and the actual CLI
create/status/run/revoke journey. It covers owner/transport auth, tenant isolation,
connected rotation/revocation, stale responses, malformed/oversized results,
concurrency saturation, timeout, uncertain acknowledgment, offline inbox catch-up,
restart persistence, and hosted suspension/deletion. These are local integration
tests, not live Cloudflare deployment or agent-execution proof. Forced hibernation
with preserved sockets is not available through this repository's Miniflare test
harness; accept/attachment recovery is implemented but that specific lifecycle
transition is not claimed as exercised. The reset test instead restarts workerd
with persisted storage. No façade forwarding, streaming, multiple connectors,
automatic service supervision, or production hosted activation is included.
