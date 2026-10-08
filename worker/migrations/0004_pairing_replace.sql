-- Re-pairing: a device request sent with the requester's current, still active token for this inbox (Authorization:
-- Bearer) replaces that token on approval. The new token takes over the label, so no orphan token or "-2" label is left.
ALTER TABLE device_requests ADD COLUMN replaces_label TEXT;
