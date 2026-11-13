-- Public bundles only. Local signing/encryption private keys never enter the Worker.
ALTER TABLE device_requests ADD COLUMN sealed_requester TEXT;
ALTER TABLE device_requests ADD COLUMN sealed_responder TEXT;
ALTER TABLE peers ADD COLUMN sealed_requester TEXT;
ALTER TABLE peers ADD COLUMN sealed_responder TEXT;
