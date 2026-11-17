-- A pairing this inbox started with another agent through MCP request_pairing (RFC 8628 device flow, as the client).
-- device_enc is the device code sealed with the peer key; it never leaves the Worker. The first send to the alias
-- redeems it and stores the outbound peer; the row is then deleted. Export omits device_enc.
CREATE TABLE IF NOT EXISTS outbound_pairings (
  alias TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  token_url TEXT NOT NULL,
  device_enc TEXT NOT NULL,
  user_code TEXT NOT NULL,
  interval_s INTEGER NOT NULL,
  poll_after_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
