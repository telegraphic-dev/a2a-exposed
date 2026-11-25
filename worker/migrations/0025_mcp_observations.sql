CREATE TABLE mcp_observations (
 id TEXT PRIMARY KEY,
 scope TEXT NOT NULL,
 owner_key TEXT NOT NULL,
 source_key TEXT NOT NULL,
 context_id TEXT NOT NULL,
 source_json TEXT NOT NULL,
 expires_ms INTEGER NOT NULL,
 snapshot_json TEXT NOT NULL
);
CREATE INDEX mcp_observations_scope ON mcp_observations(scope, expires_ms);
CREATE INDEX mcp_observations_source ON mcp_observations(source_key);
CREATE INDEX mcp_observations_owner ON mcp_observations(owner_key, expires_ms);
ALTER TABLE outbound ADD COLUMN observation_id TEXT;
UPDATE outbound SET observation_id=lower(hex(randomblob(16)));
CREATE TRIGGER outbound_observation_insert AFTER INSERT ON outbound WHEN NEW.observation_id IS NULL BEGIN
 UPDATE outbound SET observation_id=lower(hex(randomblob(16))) WHERE task_id=NEW.task_id;
END;
CREATE TABLE mcp_observation_origin (singleton INTEGER PRIMARY KEY CHECK(singleton=1), incarnation TEXT NOT NULL);
INSERT INTO mcp_observation_origin VALUES (1,lower(hex(randomblob(16))));
