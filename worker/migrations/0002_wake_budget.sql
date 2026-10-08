-- wake_budget (hourly wake cap) for databases whose 0001_init.sql predates the table.
-- D1 records migrations by file name, so a database created by an earlier build with its own
-- 0001_init.sql (e.g. the s2a2a prototype) never gets wake_budget from the current 0001.
-- Idempotent: a no-op on databases created from the current 0001_init.sql.
CREATE TABLE IF NOT EXISTS wake_budget (
  hour INTEGER PRIMARY KEY,           -- unix hour
  count INTEGER NOT NULL
);
