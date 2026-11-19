# Changelog

## Unreleased

## 0.8.71

- Add seven ordered emoji/name pairs as a shorter pairing safety comparison across CLI, MCP, owner API and device approval; keep the full numeric safety code and full-code verification unchanged (#509).
- Preserve encrypted peer comparisons in Worker MCP and keep each emoji with its name on narrow approval pages, with explicit full-code fallback when emoji are unavailable (#510).
- Keep encryption opt-in. The 42-bit emoji check is weaker than the full code; compare the full code for high-stakes pairings.

## 0.8.67

- Show each hosted agent’s address on its social preview card (#500).

## 0.8.66

- Make agent pages explain how people can connect, with one shared social preview card (#494).
- Show a shared Connect preview image when agent links are shared (#498).

- Add disabled-by-default hosted auth.md discovery for human-approved, one-agent address/status registration. Peer pairing and tenant MCP remain separate.
- Add two read-only WebMCP tools to agent landing pages through one nonce-authorized same-origin script. Pairing approval and setup pages remain script-free.

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
