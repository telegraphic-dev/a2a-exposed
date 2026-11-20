-- Source and peer identities are not exported. Reset requires fresh source registration.
CREATE TABLE message_event_source (singleton INTEGER PRIMARY KEY CHECK(singleton=1), instance_id TEXT NOT NULL, activated INTEGER NOT NULL DEFAULT 0);
INSERT INTO message_event_source VALUES (1, lower(hex(randomblob(16))), 0);
CREATE TABLE message_event_peers (instance_id TEXT PRIMARY KEY, label TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN(0,1)));
CREATE UNIQUE INDEX message_event_peer_active ON message_event_peers(label) WHERE active=1;
INSERT INTO message_event_peers SELECT lower(hex(randomblob(16))), label, 1 FROM peers WHERE revoked_at IS NULL;
CREATE TRIGGER message_event_peer_insert AFTER INSERT ON peers WHEN NEW.revoked_at IS NULL BEGIN
 UPDATE message_event_peers SET active=0 WHERE label=NEW.label;
 INSERT INTO message_event_peers VALUES(lower(hex(randomblob(16))),NEW.label,1);
END;
CREATE TRIGGER message_event_peer_update AFTER UPDATE OF token_hash,revoked_at ON peers WHEN NEW.token_hash != OLD.token_hash OR NEW.revoked_at IS NOT OLD.revoked_at BEGIN
 UPDATE message_event_peers SET active=0 WHERE label=OLD.label OR label=NEW.label;
 INSERT INTO message_event_peers SELECT lower(hex(randomblob(16))),NEW.label,1 WHERE NEW.revoked_at IS NULL;
END;
CREATE TRIGGER message_event_peer_delete AFTER DELETE ON peers BEGIN
 UPDATE message_event_peers SET active=0 WHERE label=OLD.label;
END;
CREATE TRIGGER message_event_peer_label AFTER UPDATE OF label ON peers WHEN NEW.label != OLD.label BEGIN
 UPDATE message_event_peers SET label=NEW.label WHERE label=OLD.label AND active=1;
END;
CREATE TABLE message_event_outbox (event_id TEXT PRIMARY KEY, source_instance TEXT NOT NULL, peer_instance TEXT NOT NULL, body TEXT NOT NULL, target_fingerprint TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_ms INTEGER NOT NULL);
CREATE INDEX message_event_outbox_due ON message_event_outbox(next_ms);
