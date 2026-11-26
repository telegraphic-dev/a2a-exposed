# Conditional owner peer revocation

Source contract for callers that must bind a browser approval to one credential incarnation. This does not implement hosted confirmation resumption or activate a hosted client feature.

Read authenticated `GET /owner/peers`. An active peer includes `revokeIncarnation: "prv1_<opaque digest>"`; revoked/unverifiable peers have null. This version is not a token or an authorization grant. It is a domain-separated SHA-256 commitment to internal randomized source and credential identities, which are never returned. Existing message-event triggers replace credential identity on token replacement/revocation/recreation. SQL restore rotates source identity, invalidating old commitments.

Call authenticated `POST /owner/peers/:label/revoke` with exactly `{ "expectedIncarnation": "<value from the read>" }`. The hosted owner-RPC allowlist accepts the same route/body. Success200 returns `{ revoked: true, label, incarnation }`, echoing the acted-on commitment. Malformed input400; unavailable, revoked, missing, stale or raced incarnation412 with no effects. A replacement must never be silently selected for retry.

The preflight checks the opaque commitment, then a single storage batch guards announce-alias cleanup, outbound push-hash clearing, and peer revocation against the same internal source/credential identity. Cleanup runs before the revocation triggers rotate identities, all within the transaction. Transaction failure rolls all effects back. Owner-synced aliases stay intact. No raw credential hashes/source/peer instance ids are exposed.

Legacy `DELETE /owner/peers/:label` retains its existing behavior. New resumption clients must require this explicit versioned POST contract and must never fall back to label-only DELETE. Old Workers without the listing commitment/new route cannot safely support that path. Receipt loss, timeout,404, missing peer or changed identity are not proof of success: retain unknown unless an authorized same-incarnation result establishes the outcome. An old receipt refers only to its original incarnation, never to a replacement under the same label.

No release, version bump, hosted pin, deployment, production flag or access change is included. Hosted integration remains gated on the separately authorized normal release/pin and exact runtime evidence.
