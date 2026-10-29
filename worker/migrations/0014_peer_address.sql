-- Pairing identity and the last verified callback address. Existing rows stay valid: every new column is nullable,
-- so a peer paired before this migration keeps its token and has no callback until it announces one.
ALTER TABLE peers ADD COLUMN identity_key TEXT;
ALTER TABLE peers ADD COLUMN card_url TEXT;
ALTER TABLE peers ADD COLUMN previous_card_url TEXT;
ALTER TABLE peers ADD COLUMN previous_until_ms INTEGER;
-- Sealed copy of a return token this inbox minted (source = 'reverse'). Null for every other peer.
-- The owner API never selects this column. Export omits it.
ALTER TABLE peers ADD COLUMN token_enc TEXT;
ALTER TABLE device_requests ADD COLUMN identity_key TEXT;
