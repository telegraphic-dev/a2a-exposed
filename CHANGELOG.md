# Changelog

## Unreleased

- Fix native Node relay connector shutdown on invalid frames, without retrying
  protocol violations or forwarding rejected frames to the local receiver.
- Add an optional tenant-scoped SQLite Durable Object wake relay and a
  zero-dependency foreground CLI connector, preserving local webhook bearer/HMAC
  authentication and actual HTTP acknowledgments.
- Add owner enrollment/status/revocation, connection-generation fencing,
  bounded requests and offline inbox catch-up, with hosted control-core settings
  and lifecycle fencing. The feature defaults off; hosted services must enable
  and integrate their pinned runtime separately.
