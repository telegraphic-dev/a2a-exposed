-- Remote MCP server (/mcp): OAuth 2.1 clients (dynamic registration), one-time authorization codes, and the grants
-- (owner-approved, inbox-scoped tokens) that `token list` shows and `token revoke` ends. Peer tokens stay in `peers`
-- and are never accepted on /mcp; MCP tokens are never accepted on the A2A endpoint or /owner/*.
CREATE TABLE IF NOT EXISTS oauth_clients (
	client_id TEXT PRIMARY KEY,
	client_name TEXT,
	redirect_uris_json TEXT NOT NULL,
	created_ms INTEGER NOT NULL,
	ip TEXT
);
CREATE TABLE IF NOT EXISTS oauth_codes (
	code_hash TEXT PRIMARY KEY,
	client_id TEXT NOT NULL,
	redirect_uri TEXT NOT NULL,
	code_challenge TEXT NOT NULL,
	scope TEXT NOT NULL,
	resource TEXT NOT NULL,
	created_ms INTEGER NOT NULL,
	expires_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_grants (
	label TEXT PRIMARY KEY,
	client_id TEXT NOT NULL,
	client_name TEXT,
	redirect_host TEXT,
	scope TEXT NOT NULL,
	access_hash TEXT UNIQUE,
	access_expires_ms INTEGER,
	refresh_hash TEXT UNIQUE,
	refresh_expires_ms INTEGER,
	created_at TEXT NOT NULL,
	last_used_at TEXT,
	revoked_at TEXT
);
-- Peers this inbox sends to from the Worker (MCP `send` / `poll_outbound`), uploaded by `peers sync`. The token is
-- AES-GCM ciphertext under a key derived from the Worker's OWNER_TOKEN secret, so a D1 export alone doesn't reveal it.
CREATE TABLE IF NOT EXISTS outbound_peers (
	alias TEXT PRIMARY KEY,
	url TEXT NOT NULL,
	token_enc TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
