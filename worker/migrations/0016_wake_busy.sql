-- Busy cool-down after a sent message wake. Later events for this peer and conversation
-- accumulate until busy_until_ms, which sends one catch-up. An inbox read does not clear it.
ALTER TABLE wakes ADD COLUMN busy_until_ms INTEGER;
