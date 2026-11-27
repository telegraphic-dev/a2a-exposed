# Committed inbound message events

This opt-in producer is an upstream prerequisite for a hosted consumer. It does
not implement MCP Events subscriptions or claim ChatGPT callback compatibility.
The owner wake and pairing event settings are independent and unchanged.

Set `MESSAGE_EVENT_URL` to a public HTTPS receiver and supply a separate
`MESSAGE_EVENT_SECRET` through a protected Worker secret (32–512 characters).
Hosted control planes seal that key in the existing tenant secrets blob. Never
put it in URLs, command arguments, logs or model content. Single-inbox installs
also require `ENABLE_CRON=1` with the minute cron; hosted inboxes use alarms.
Missing/invalid settings disable this producer and its identity reads.
Configuration and subscriptions still require their applicable owner approval.
For the hosted platform's Cloudflare-fronted ingress, the operator may explicitly
set deploy-only `MESSAGE_EVENT_INGRESS_ORIGIN` and the existing `CONTROL_SERVICE`
service binding. Only that exact origin and `/api/message-events` (no query) select
the capability-bound internal POST. Missing binding, wrong path and redirects fail
closed; no external fetch is tried. This path uses the same signed body and a
10s acknowledgement deadline and discards response bodies. Tenant configuration
cannot supply or override the platform binding/origin. It is selected before
transport, never as a fallback after a failed pinned request. Other receiver
origins use the strict public pinned transport described below. No deployment or
binding is created by installing this software.

## Event and acknowledgement

Each winning committed inbound message transaction stores a server-generated
occurrence ID and canonical JSON body in a durable outbox. Duplicate claims do
not create another event. An explicit direct reply is classified `direct_reply`;
ordinary accepted inbound messages are `inbound`. Both are `message_received`,
not `task.updated`. A façade forwarding call without an inbox commit emits none.
Plaintext and sealed messages use the same metadata-only schema:

```json
{"version":1,"type":"message_received","eventId":"server-occurrence-id","sourceInstanceId":"opaque-source-id","tenantId":"opaque-tenant-id","peerInstanceId":"opaque-peer-incarnation","peerLabel":"canonical-inbound-label","role":"user","messageId":"peer-message-id","taskId":"task-id","contextId":"context-id","receivedAt":"2026-01-01T00:00:00.000Z","classification":"inbound"}
```

There are no message parts, plaintext/ciphertext previews, token hashes, secrets
or instructions. Message/context IDs and peer-provided labels remain untrusted
filter data. Hostnames never grant authority. Read content only through existing
authorized tools. Encrypted content remains encrypted and encryption stays opt-in.

Posts carry `x-a2a-timestamp` (Unix seconds) and `x-a2a-signature`:
`sha256=<hex HMAC-SHA256(secret, timestamp + "." + exactBody)>`. The body and eventId
remain unchanged across retries; each attempt computes a current timestamp and
signature. The consumer authenticates the raw bytes against the registered source,
checks a bounded timestamp window and bounded schema, then atomically deduplicates
and durably accepts by `(sourceInstanceId,eventId)` before returning 2xx.
Acknowledgement means durable ingress, not downstream client delivery.

Delivery is at least once: acknowledgement loss or overlapping flushes may repeat
an event. Each attempt is durably claimed before HTTP, with a 15s recovery lease
so concurrent flushes cannot spend the same attempt. A crash before HTTP can
consume an attempt without delivery. There are at most eight scheduled attempts with exponential backoff
starting at one second, capped at one hour; a flush processes at most 16 due rows.
After the final attempt the row is dropped; there is no historical replay API.
Changing URL/key, disabling the feed, invalidating the source or revoking/rotating
the peer discards old pending rows rather than delivering them under new authority.
Storage errors retain the outbox. A committed row survives a lost waitUntil;
cron/alarm processing retries it. Hosted inboxes retain a one-minute local
outbox recovery alarm even when empty and ensure it is durable before a message
can commit; this does not poll A2A or replace owner wakes. A receiver must tolerate delayed/out-of-order
occurrences; do not use a timestamp high-water mark as a deduplication key.

## Authoritative owner reads

These GET routes are owner-only, including the allowlisted hosted owner RPC.
They are not public discovery or MCP tools and do not mutate state. A disabled
source is 404; absent owner authority is 401. The source and peer binding come
from one storage snapshot.

- `/owner/message-events/source`: `{version:1, sourceInstanceId, tenantId}`.
- `/owner/message-events/peers?label=<canonical inbound label>` resolves only the
  current active inbound credential: `{version:1, sourceInstanceId, tenantId,
  label, peerInstanceId, active:true}`. Missing/revoked is 404. Outbound aliases
  are never inferred. Use this only when creating a subscription.
- `/owner/message-events/peers/<peerInstanceId>` echoes that exact immutable
  binding and `active` boolean. Tombstones are `active:false`; unknown is 404.
  It never follows the label to a replacement credential.

Restart preserves source and peer identities. Every peer insertion, token
rotation/reissue, revocation and deletion updates incarnation tracking in the
same database operation. Rotation ends the old incarnation; metadata-only edits
do not. Site consumers pin account, MCP grant, tenant, source and peer instance.
Refresh/retry must retain the original binding and check current active ownership,
grant and exact-instance authority before enqueue and every callback attempt.
Tombstoned, unknown or mismatched identities terminate the subscription; unreadable
authority fails closed. Signed events do not substitute for these live checks.

Source identities and outboxes are excluded from SQL exports. Generated restore
SQL clears pending events/incarnations and creates a fresh source identity; apply
current migrations first and register that new source. In-place hosted bookmark
restore is refused once a message source has been configured/activated, because
restoring old identities would resurrect revoked incarnations. Restore into a new
tenant instead. This limitation is intentional and does not affect ordinary
bookmark restores on inboxes that never registered a feed. Raw database/PITR
operations outside supported restore paths must not be used to preserve an old
source registration.

## Strict callback transport

`@a2a-exposed/control-core/callbacks` exports `fetchCheckedCallback(url, init)`.
It reuses the inbox's pinned `tunnelfetch` TLS transport. The optional subpath
keeps the root library entry independent of transport initialization.

One 10,000 ms deadline covers public A/AAAA resolution, socket connect, TLS/SNI,
request, response headers and consumption of at most 16,384 response bytes.
Every connection resolves/checks all addresses, connects only to a checked public
IP and verifies TLS for the original hostname. Credentials, fragments, non-443
ports, private/mixed/reserved DNS answers and unexpected headers are refused.
Only POST with a string/byte body of at most 65,536 bytes is accepted.
Only content-type, accept, user-agent, Standard Webhooks signing headers and
x-a2a signing headers and `X-MCP-Subscription-Id` are accepted. Every redirect, even same-origin, is refused.
There is no native-fetch fallback or internal HTTP retry after an egress failure. `EGRESS_CLOUDFLARE_EDGE` does not change this helper.

Results are `{ok:true,status,body:Uint8Array}` or `{ok:false,reason}` with a fixed
category (`target`, `redirect`, `timeout`, `transport`, `response_limit`). Do not
log request/response bodies, URLs containing secrets or signatures. Challenge and
Standard Webhooks signing belong to the consumer, not this helper. Calling this
helper is a real network operation, not implicit authorization to contact a URL.
Workers socket restrictions, including Cloudflare-address egress restrictions,
remain fail-closed. Local tests cover SNI/pinning, TLS failure, workerd loading,
redirect/size refusal and deadlines; successful live ChatGPT callback delivery is
not established by those fixtures and remains a later qualification gate.

The subscription header is required on both verification and delivery by the
[OpenAI MCP Events contract](https://developers.openai.com/plugins/build/mcp-events).
The helper preserves its value along with signing headers and exact body bytes.
