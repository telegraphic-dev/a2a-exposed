// Worker-only entry. Importing does not bind or enable HTTP_RELAY.
export { HttpRelay, HTTP_RELAY_PROTOCOL, httpRelayLimits } from "../../../worker/src/http-relay.ts";
export type { HttpRelayProfile, HttpRelayTarget, HttpRelayHeaders } from "../../../worker/src/http-relay.ts";
export { HTTP_RELAY_PROTOCOL_VERSION, HTTP_RELAY_CAPABILITIES } from "./http-relay-metadata.ts";
