/** Owner policy is independent of rollout mode and sender hints cannot escalate it. */
export const PEER_WAKE_EVENTS = ["inbound", "update", "completed", "attention", "empty", "ack"] as const;
export const PEER_WAKE_ACTIONS = ["wake", "skip", "batch"] as const;
export type PeerWakeEvent = typeof PEER_WAKE_EVENTS[number];
export type PeerWakeAction = typeof PEER_WAKE_ACTIONS[number];
export type PeerWakePolicy = Record<PeerWakeEvent, PeerWakeAction>;
export const DEFAULT_PEER_WAKE_POLICY: PeerWakePolicy = { inbound: "wake", update: "wake", completed: "wake", attention: "wake", empty: "skip", ack: "skip" };
export function validPeerWakePolicy(value: unknown): value is PeerWakePolicy {
 if (!value || typeof value !== "object" || Array.isArray(value)) return false;
 const policy = value as Record<string, unknown>;
 return Object.keys(policy).length === PEER_WAKE_EVENTS.length && PEER_WAKE_EVENTS.every(key => PEER_WAKE_ACTIONS.includes(policy[key] as PeerWakeAction));
}
export function peerWakeEvent(inbound: boolean, state: string | null, text: string, hasContent: boolean, intent: string | null): PeerWakeEvent {
 const plain = (state || "").replace(/^TASK_STATE_/, "").toLowerCase().replace(/_/g, "-");
 if (["input-required", "failed"].includes(plain)) return "attention";
 if (plain === "completed") return "completed";
 if (intent === "ack" && !hasContent) return "ack";
 if (inbound) return "inbound";
 if (["working", "submitted"].includes(plain) && !text.trim() && !hasContent) return "empty";
 return "update";
}
export function peerWakeAction(policy: PeerWakePolicy, event: PeerWakeEvent, wake: string | null, duplicate: boolean): PeerWakeAction {
 return duplicate || wake === "never" ? "skip" : policy[event];
}

export const PEER_WAKE_POLICY_SCHEMA = { type: "object", properties: Object.fromEntries(PEER_WAKE_EVENTS.map(event => [event, { type: "string", enum: [...PEER_WAKE_ACTIONS] }])), required: [...PEER_WAKE_EVENTS], additionalProperties: false };
export const PEER_WAKE_SAVED_SCHEMA = { type: "object", properties: { peerId: { type: "string" }, policy: PEER_WAKE_POLICY_SCHEMA, configured: { type: "boolean" } }, required: ["peerId", "policy", "configured"], additionalProperties: false };
export const PEER_WAKE_LIST_SCHEMA = { type: "object", properties: {
 events: { type: "array", items: { type: "string", enum: [...PEER_WAKE_EVENTS] } },
 actions: { type: "array", items: { type: "string", enum: [...PEER_WAKE_ACTIONS] } },
 nextCursor: { type: ["string", "null"] },
 defaults: PEER_WAKE_POLICY_SCHEMA,
 peers: { type: "array", items: { type: "object", properties: { peerId: { type: "string" }, peer: { type: "string" }, direction: { type: "string", enum: ["inbound", "outbound"] }, policy: PEER_WAKE_POLICY_SCHEMA, configured: { type: "boolean" } }, required: ["peerId", "peer", "direction", "policy", "configured"], additionalProperties: false } }
 }, required: ["events", "actions", "defaults", "peers"], additionalProperties: false };
