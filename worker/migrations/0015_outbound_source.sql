-- Who created an outbound peer. NULL is an owner upload (`peers sync`). `announce` is a row this
-- inbox created from a verified PeerAddressUpdate. An announcement must not repoint any other row.
ALTER TABLE outbound_peers ADD COLUMN source TEXT;
