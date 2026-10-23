-- A reply pushed onto an outbound task stays in the inbox until that list is read.
ALTER TABLE outbound ADD COLUMN updates_seen INTEGER NOT NULL DEFAULT 0;
