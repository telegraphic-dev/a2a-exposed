# Changelog

## Unreleased

- Prevent duplicate rejected HTTP 401 WebSocket upgrades on Node 24 in wake and
  HTTP/A2A relay connectors. Each reconnect attempt sends one upgrade request;
  native framing, handshake validation and bounded reconnect delays remain.
- Add separately opted-in HTTP relay profiles for fixed local webhooks and native
  A2A JSON-RPC services, with original request bytes/application authentication,
  real receiver responses, rewritten discovery and bounded incremental SSE.
  Separate connector/ingress authority, header allowlists, generation fencing,
  flow control, cancellation and tenant lifecycle checks preserve wake-v1 and
  existing inbox/pairing behavior. Finite responses are bounded-buffered before
  public headers; native unencoded SSE preserves complete application records,
  adds bounded transport keepalives and reports known uncertainty as an
  original-ID protocol error. Hosted adoption remains a separate integration.
- Distinguish definite HTTP enrollment/configuration rejection from uncertain
  delivery, clean only newly reserved files on definite failure, and give safe
  recovery guidance without overwriting credentials or automatically rotating.
- Protect native SSE first-event delivery when an initial upstream UTF-8 BOM
  arrives after keepalives, and return distinct original-ID RPC admission errors.
- Clarify invited-caller/custom-header prerequisites, JSON output, foreground
  process lifetime, credential retirement and explicit recovery; move hosted
  embedding details into the contributor reference.

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
