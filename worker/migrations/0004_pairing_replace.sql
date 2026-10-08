-- Re-pairing: a requester that presents its current active token (Authorization: Bearer) replaces that token on
-- approval. The new token takes over the label, so no orphan token or "-2" label is left. replaces_hash binds the
-- request to the token that was presented: if the owner rotates or revokes that token before redemption, the swap
-- is refused and a fresh label is used instead (a holder of a compromised old token cannot overwrite a rotated one).
ALTER TABLE device_requests ADD COLUMN replaces_label TEXT;
ALTER TABLE device_requests ADD COLUMN replaces_hash TEXT;
