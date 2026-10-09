-- Short-lived OpenID Connect sign-in (authorization code + PKCE). The callback deletes the row;
-- expired rows are removed when a new one is stored and by the pairing cleanup.
CREATE TABLE IF NOT EXISTS oidc_txns (
	state TEXT PRIMARY KEY,
	nonce TEXT NOT NULL,
	verifier TEXT NOT NULL,
	kind TEXT NOT NULL,
	csrf TEXT NOT NULL,
	user_code TEXT,
	payload_json TEXT NOT NULL,
	expires_ms INTEGER NOT NULL
);
