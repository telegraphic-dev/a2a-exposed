-- Keep the requester-supplied address distinct from its verified callback.
-- It is only a suggestion for human-approved pair-back, never a delivery target.
ALTER TABLE peers ADD COLUMN claimed_card_url TEXT;
