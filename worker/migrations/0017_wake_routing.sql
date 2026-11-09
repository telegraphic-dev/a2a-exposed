-- Routing counts for wake decisions. The row is an hour, a decision label, and an action.
-- It does not store message text, previews, or secrets.
CREATE TABLE IF NOT EXISTS wake_routing (
  hour INTEGER NOT NULL,
  decision TEXT NOT NULL,
  action TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (hour, decision, action)
);
-- Last status fingerprint for one peer and conversation, and the last push fingerprint
-- for one outbound task. The value is a SHA-256 hex digest, not the message text.
CREATE TABLE IF NOT EXISTS wake_dedup (
  kind TEXT NOT NULL,
  peer TEXT NOT NULL,
  ref TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY (kind, peer, ref)
);
CREATE INDEX IF NOT EXISTS messages_message_id ON messages(message_id);
