-- One owner per context id. The first peer to insert the row keeps it (ON CONFLICT DO NOTHING).
CREATE TABLE conversation_owners (
  context_id TEXT NOT NULL PRIMARY KEY,
  peer TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO conversation_owners (context_id, peer, created_at)
SELECT t.context_id, t.peer, t.created_at
FROM tasks t
WHERE t.peer IS NOT NULL AND t.peer != ''
  AND NOT EXISTS (
    SELECT 1 FROM tasks t2
    WHERE t2.context_id = t.context_id AND t2.peer IS NOT NULL AND t2.peer != ''
      AND (t2.created_at < t.created_at OR (t2.created_at = t.created_at AND t2.id < t.id))
  );
INSERT INTO conversation_owners (context_id, peer, created_at)
SELECT h.context_id, h.peer, h.ts
FROM history h
WHERE h.peer IS NOT NULL AND h.peer != ''
  AND NOT EXISTS (SELECT 1 FROM conversation_owners o WHERE o.context_id = h.context_id)
  AND NOT EXISTS (
    SELECT 1 FROM history h2
    WHERE h2.context_id = h.context_id AND h2.peer IS NOT NULL AND h2.peer != '' AND h2.seq < h.seq
  );
INSERT INTO conversation_owners (context_id, peer, created_at)
SELECT o.context_id, o.peer, o.sent_at
FROM outbound o
WHERE o.peer IS NOT NULL AND o.peer != ''
  AND NOT EXISTS (SELECT 1 FROM conversation_owners c WHERE c.context_id = o.context_id)
  AND NOT EXISTS (
    SELECT 1 FROM outbound o2
    WHERE o2.context_id = o.context_id AND o2.peer IS NOT NULL AND o2.peer != ''
      AND (o2.sent_at < o.sent_at OR (o2.sent_at = o.sent_at AND o2.task_id < o.task_id))
  );
