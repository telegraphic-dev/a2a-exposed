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
