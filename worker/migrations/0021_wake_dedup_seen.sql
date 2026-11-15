-- When a status fingerprint was saved, in epoch milliseconds. An identical status counts as
-- unchanged only inside the debounce window after that time. Rows saved before this migration
-- are NULL and are treated as outside the window, so they still wake.
ALTER TABLE wake_dedup ADD COLUMN seen_ms INTEGER;
