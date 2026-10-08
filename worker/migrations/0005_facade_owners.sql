-- Proxy / expose mode (UPSTREAM_URL): which peer label created each upstream task and context, so peers that share
-- the façade's one upstream credential can't read, cancel or continue each other's tasks. Unused in inbox mode.
CREATE TABLE IF NOT EXISTS facade_owners (
	kind TEXT NOT NULL,        -- 'task' | 'context'
	id TEXT NOT NULL,          -- the upstream's task / context id
	peer TEXT NOT NULL,        -- peer label (peers.label) that created it through the façade
	created_at TEXT NOT NULL,
	PRIMARY KEY (kind, id)
);
