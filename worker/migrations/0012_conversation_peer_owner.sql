-- One row per peer. The same context id can be a separate conversation for each peer.
-- 0011's single-column primary key made a second peer's insert fail, which is how a caller
-- could tell a fresh id from one another peer already held.
CREATE TABLE conversation_owners_peer (
  context_id TEXT NOT NULL,
  peer TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (context_id, peer)
);
INSERT INTO conversation_owners_peer (context_id, peer, created_at)
SELECT context_id, peer, created_at FROM conversation_owners;
DROP TABLE conversation_owners;
ALTER TABLE conversation_owners_peer RENAME TO conversation_owners;
