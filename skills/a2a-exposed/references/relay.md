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

The owner API can test an unsaved relay draft before saving: `POST
/owner/wake/test` accepts explicit `transport:"relay"`, `connectorId:"default"`,
current enrollment `generation`, `credentialsMode:"resolved"`, preset and optional
application credentials/options. Only supplied credentials are used; omitted or
empty secrets never inherit saved values. Trusted hosted callers resolve any
permitted retained secrets before this call. No URLs or raw request frames are
accepted, and no settings or pending wakes are consumed. A no-body call still
tests applied settings. See the relay contract for the exact allowlist. Do not
send draft credentials through chat or print them in test evidence.
