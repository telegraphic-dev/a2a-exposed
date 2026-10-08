-- Device-flow pairing (OAuth 2.0 Device Authorization Grant, RFC 8628): a peer agent asks for a token, the inbox
-- owner approves it (human: /device page + approval password; agent: owner API), the peer redeems it once.
-- Numbered 0003 so it never collides with a 0002 migration from another branch; D1 applies unapplied files by name.
CREATE TABLE IF NOT EXISTS device_requests (
  device_hash TEXT PRIMARY KEY,         -- sha256(device_code); the device code itself is never stored
  user_code TEXT NOT NULL UNIQUE,       -- normalised (no dash), e.g. WDJB4827
  client_id TEXT,
  client_name TEXT,
  agent_card_url TEXT,
  ip TEXT,
  country TEXT,
  status TEXT NOT NULL,                 -- pending | approved | denied (| redeemed, just before the row is deleted)
  created_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  interval_s INTEGER NOT NULL,
  last_poll_ms INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  label TEXT,                           -- peer label chosen at approval
  decided_ms INTEGER,
  decided_by TEXT                       -- human | agent | owner | lockout
);
CREATE INDEX IF NOT EXISTS device_requests_status ON device_requests(status, expires_ms);
-- fixed-window counters: device requests per IP / globally, wrong approval passwords per IP / globally, token polls
CREATE TABLE IF NOT EXISTS pairing_rate (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
-- owner settings; approval_password = {"alg":"pbkdf2-sha256","iterations":..,"salt":..,"hash":..,"setAt":..}
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- where a peer token came from: NULL = `token issue`, 'pairing' = device flow (with the user code it was approved under)
ALTER TABLE peers ADD COLUMN source TEXT;
ALTER TABLE peers ADD COLUMN user_code TEXT;
ALTER TABLE peers ADD COLUMN client_name TEXT;
