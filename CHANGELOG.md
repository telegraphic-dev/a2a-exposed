# Changelog

## Unreleased

- Distinguish busy and uncertain relay delivery from service incompatibility;
  preserve unconfirmed execution and advise checking the receiver and inbox before retesting.

- Make relay setup, protocol/policy failures and replacement/revocation actionable
  nonzero exits with sanitized diagnostics; bound failed handshakes and enforce
  a 500ms reconnect floor. Clock skew and temporary saturation fail only delivery.
- Preserve structured owner relay-test failure codes and actual local HTTP status
  through HTTP/RPC, and reject unsafe saved forwarding headers before dispatch.
- Fail hosted lifecycle changes closed when prior relay authority cannot be
  fenced after binding/flag loss, including initial unsaved draft enrollment.

- Fix native Node relay connector shutdown on invalid frames, without retrying
  protocol violations or forwarding rejected frames to the local receiver.
- Add an optional tenant-scoped SQLite Durable Object wake relay and a
  zero-dependency foreground CLI connector, preserving local webhook bearer/HMAC
  authentication and actual HTTP acknowledgments.
- Add owner enrollment/status/revocation, connection-generation fencing,
  bounded requests and offline inbox catch-up, with hosted control-core settings
  and lifecycle fencing. The feature defaults off; hosted services must enable
  and integrate their pinned runtime separately.
