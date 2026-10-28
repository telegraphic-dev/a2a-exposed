-- One delivery outcome for one logical owner reply. The key includes the inbound turn and reply content,
-- so an HTTP/MCP retry is idempotent while a later peer message permits the same words to be sent again.
CREATE TABLE IF NOT EXISTS reply_deliveries (
	delivery_key TEXT PRIMARY KEY,
	task_id TEXT NOT NULL,
	message_id TEXT NOT NULL,
	result_json TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reply_deliveries_task ON reply_deliveries(task_id, created_at);
