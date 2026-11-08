# Contributor reference: HTTP relay integration

For audience, setup and recovery, start with [HTTP/native relay](http-relay.md).
This page describes the embedding contract, not a claim that hosted activation
or deployed end-to-end qualification has happened.

## Protocol and embedding contract

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
using a released compatible core and CLI. Enable incoming `Request.signal`
(`enable_request_signal` for the supplied 2026-10-06 compatibility date) so caller
disconnects propagate. The supplied self-host config opts in with HTTP relay;
a hosted embedding must configure its own Worker likewise. See [Cloudflare's
compatibility contract](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-requestsignal-for-incoming-requests).
Import the class from the Worker-only
`@a2a-exposed/control-core/http-relay` subpath; the main core entry keeps its
plain-Node compatibility and exposes protocol/capability metadata without
loading `cloudflare:workers`. This OSS implementation does not change hosted
dashboard UI or activate these profiles on any hosted service.
