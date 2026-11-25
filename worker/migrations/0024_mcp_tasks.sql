-- Durable MCP observation handles; separate from A2A delivery and task state.
CREATE TABLE mcp_tasks (
 id TEXT PRIMARY KEY,
 grant_label TEXT NOT NULL,
 source_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 expires_ms INTEGER NOT NULL,
 snapshot_json TEXT NOT NULL
);
CREATE INDEX mcp_tasks_grant ON mcp_tasks(grant_label, expires_ms);
