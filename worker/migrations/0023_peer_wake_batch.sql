-- Identity survives credential rotation/sync and resets when a pairing is revoked/removed.
ALTER TABLE peers ADD COLUMN wake_policy_id TEXT NOT NULL DEFAULT '';
UPDATE peers SET wake_policy_id = lower(hex(randomblob(16)));
ALTER TABLE outbound_peers ADD COLUMN wake_policy_id TEXT NOT NULL DEFAULT '';
UPDATE outbound_peers SET wake_policy_id = lower(hex(randomblob(16)));
CREATE TABLE peer_wake_batch (
 peer_id TEXT NOT NULL, peer TEXT NOT NULL, context_id TEXT NOT NULL, task_id TEXT NOT NULL,
 kind TEXT NOT NULL, generation TEXT NOT NULL,
 PRIMARY KEY(peer_id, context_id, task_id)
);
ALTER TABLE outbound ADD COLUMN wake_policy_peer_id TEXT;
-- 0: canonical; 1: send response in flight; 2: failed response retains local history while references await canonical recovery.
ALTER TABLE outbound ADD COLUMN wake_context_pending INTEGER NOT NULL DEFAULT 0;
