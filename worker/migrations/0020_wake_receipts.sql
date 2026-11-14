-- One receiver report per wake attempt and original inbound message. No credentials or content.
CREATE TABLE IF NOT EXISTS wake_receipts (
  delivery_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  peer TEXT NOT NULL,
  context_id TEXT NOT NULL,
  issued_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  http_status INTEGER,
  signature_verified_at TEXT,
  handler_ran_at TEXT,
  owner_notified_at TEXT,
  PRIMARY KEY (delivery_id, task_id)
);
CREATE INDEX IF NOT EXISTS wake_receipts_task ON wake_receipts(task_id, message_id, issued_ms);
CREATE INDEX IF NOT EXISTS wake_receipts_expiry ON wake_receipts(expires_ms);
