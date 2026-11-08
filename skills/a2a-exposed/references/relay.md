# Wake relay operations

Use `relay status --json` for authenticated runtime capability, enrollment epoch
and connection status. A 404 means unsupported or disabled. Do not assume a
hosted service runs the latest OSS version.

A `catchup` hint asks for unfiltered `inbox`. The inbox remains authoritative;
duplicate hints can follow uncertain delivery. Never resend a message merely
because a wake timed out. A 2xx acknowledgment means only local webhook acceptance,
not that an agent handled the inbox.

Enrollment, rotation and revocation require the human's approval. Use the setup
skill and [relay contract](https://github.com/telegraphic-dev/a2a-exposed/blob/main/docs/wake-relay.md). Credentials stay in a
mode-600 file or named environment variable, never argv, URLs, chat or logs.
The relay carries wakes only, not A2A façade traffic.

The foreground connector stops on replacement/revocation (4001) or a protocol
violation (1008/4008), rather than reconnecting. Invalid relay frames are rejected
before local delivery; check the relay endpoint/configuration before restarting.
`run` emits no stdout/JSON stream. Intentional SIGINT/SIGTERM exits 0; setup,
protocol/policy/revocation failures exit 1 with secret-free stderr guidance.
Reconnect waits 500ms–30s, never zero. Three consecutive failed upgrades or
10-second hello timeouts stop with exit 1; a healthy hello resets the budget.
Native WebSocket hides handshake HTTP status, so check endpoint, capability and
enrollment rather than assuming every failure is authentication. Expired/skewed
frames and temporary concurrency saturation fail that delivery, not the socket.
Owner draft tests expose canonical `error` codes: `offline`, `timeout`, `revoked`,
`stale_enrollment`, `invalid`, `local_http`, `busy`, `uncertain`, `unavailable`; success omits `error`.
`busy` means temporary backpressure; `uncertain` means a POST may have executed.
Check the connector, receiver and authoritative inbox before explicitly retesting;
never automatically replay an unconfirmed execution.
Keep the numeric local HTTP `status` (including 401/500); never parse `info`.

The owner API can test an unsaved relay draft before saving: `POST
/owner/wake/test` accepts explicit `transport:"relay"`, `connectorId:"default"`,
current enrollment `generation`, `credentialsMode:"resolved"`, preset and optional
application credentials/options. Only supplied credentials are used; omitted or
empty secrets never inherit saved values. Trusted hosted callers resolve any
permitted retained secrets before this call. No URLs or raw request frames are
accepted, and no settings or pending wakes are consumed. A no-body call still
tests applied settings. See the relay contract for the exact allowlist. Do not
send draft credentials through chat or print them in test evidence.
