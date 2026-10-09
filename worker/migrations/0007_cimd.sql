-- MCP authorization (2026-07-28): OAuth Client ID Metadata Documents. A client_id that is an https URL names a JSON
-- document the Worker fetches (SSRF-guarded, 5 KB, 5 s) and validates; valid documents are cached here for their
-- Cache-Control max-age (60 s - 24 h, default 1 h). Errors and invalid documents are never cached.
CREATE TABLE IF NOT EXISTS oauth_client_metadata (
	client_id TEXT PRIMARY KEY,
	client_name TEXT,
	redirect_uris_json TEXT NOT NULL,
	fetched_ms INTEGER NOT NULL,
	expires_ms INTEGER NOT NULL
);
