-- A wake is one peer's conversation. Two peers can use the same context id without sharing a row.
CREATE TABLE wakes_peer (
  context_id TEXT NOT NULL,
  peer TEXT NOT NULL DEFAULT '',
  last_sent_ms INTEGER NOT NULL DEFAULT 0,
  pending_json TEXT,
  pending_since_ms INTEGER,
  PRIMARY KEY (context_id, peer)
);
INSERT INTO wakes_peer (context_id, peer, last_sent_ms, pending_json, pending_since_ms)
SELECT
  w.context_id,
  COALESCE(
    NULLIF(json_extract(w.pending_json, '$.from'), ''),
    (SELECT t.peer FROM tasks t WHERE t.context_id = w.context_id AND t.peer IS NOT NULL AND t.peer != '' ORDER BY t.created_at, t.id LIMIT 1),
    (SELECT h.peer FROM history h WHERE h.context_id = w.context_id AND h.peer IS NOT NULL AND h.peer != '' ORDER BY h.seq LIMIT 1),
    ''
  ),
  w.last_sent_ms,
  w.pending_json,
  w.pending_since_ms
FROM wakes w;
DROP TABLE wakes;
ALTER TABLE wakes_peer RENAME TO wakes;
CREATE INDEX IF NOT EXISTS history_peer_ctx ON history(peer, context_id, seq);
