-- a2a-over-webhook schema
CREATE TABLE IF NOT EXISTS peers (
  label TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL,
  peer TEXT NOT NULL,
  state TEXT NOT NULL,
  protocol TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status_json TEXT NOT NULL,          -- TaskStatus (internal 0.3 shape)
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT,
  push_configs_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state, updated_at);
CREATE INDEX IF NOT EXISTS tasks_ctx ON tasks(context_id);
CREATE INDEX IF NOT EXISTS tasks_peer ON tasks(peer, updated_at);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  role TEXT NOT NULL,
  ts TEXT NOT NULL,
  message_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id, seq);
CREATE TABLE IF NOT EXISTS history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  context_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  dir TEXT NOT NULL,                  -- in | out | local
  peer TEXT,
  task_id TEXT,
  role TEXT,
  state TEXT,
  event TEXT,
  text TEXT,
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS history_ctx ON history(context_id, seq);
CREATE TABLE IF NOT EXISTS outbound (
  task_id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL,
  peer TEXT NOT NULL,
  endpoint TEXT,
  protocol TEXT,
  push_token_hash TEXT,
  sent_at TEXT NOT NULL,
  task_json TEXT,
  updates_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS wakes (
  context_id TEXT PRIMARY KEY,
  last_sent_ms INTEGER NOT NULL DEFAULT 0,
  pending_json TEXT,
  pending_since_ms INTEGER
);
CREATE TABLE IF NOT EXISTS rate (
  peer TEXT NOT NULL,
  minute INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (peer, minute)
);
CREATE TABLE IF NOT EXISTS wake_budget (
  hour INTEGER PRIMARY KEY,           -- unix hour
  count INTEGER NOT NULL
);
