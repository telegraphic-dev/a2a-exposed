// Deterministic pre-wake routing. No model call. Decisions are labels and counts;
// this module never sees a place to log message text.

export const WAKE_META = "a2a.exposed/wake";
export const INTENT_META = "a2a.exposed/intent";

export const WAKE_MODES = ["auto", "always", "never"] as const;
export const INTENTS = ["handoff", "blocker", "question", "status", "ack"] as const;
export const ROUTING_MODES = ["shadow", "enforce"] as const;

export type WakeMode = (typeof WAKE_MODES)[number];
export type Intent = (typeof INTENTS)[number];
export type RoutingMode = (typeof ROUTING_MODES)[number];
export type Proposed = "wake" | "suppress" | "batch";
export type RouteAction = "wake" | "suppress" | "batch" | "shadow";

const WAKE_SET = new Set<string>(WAKE_MODES);
const INTENT_SET = new Set<string>(INTENTS);
const ACTIONABLE = new Set<Intent>(["handoff", "blocker", "question"]);

/** `enforce` applies auto suppression and status batching. Anything else, including unset, is shadow. */
export function routingMode(raw: string | undefined | null): RoutingMode {
	return (raw ?? "").trim().toLowerCase() === "enforce" ? "enforce" : "shadow";
}

/** Collapse whitespace so an identical status compares equal. Empty means idle. */
export function statusText(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

export interface ParsedRoute {
	wake: WakeMode | null;
	intent: Intent | null;
}

export type RouteFields = { ok: true; fields: ParsedRoute } | { ok: false; error: string };

function metaValue(meta: unknown, key: string): unknown {
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
	if (!Object.prototype.hasOwnProperty.call(meta, key)) return undefined;
	return (meta as Record<string, unknown>)[key];
}

function pick(messageValue: unknown, paramsValue: unknown, name: string, allowed: Set<string>, expectation: string):
	{ ok: true; value: string | null } | { ok: false; error: string } {
	const messageSet = messageValue !== undefined;
	const paramsSet = paramsValue !== undefined;
	if (messageSet && paramsSet && messageValue !== paramsValue) {
		return { ok: false, error: `${name} is set on both the message and the request and they differ` };
	}
	const value = messageSet ? messageValue : paramsSet ? paramsValue : undefined;
	if (value === undefined) return { ok: true, value: null };
	if (typeof value !== "string" || !allowed.has(value)) return { ok: false, error: expectation };
	return { ok: true, value };
}

/**
 * Read `a2a.exposed/wake` and `a2a.exposed/intent` from message metadata and request metadata.
 * Absent fields stay null. A present value must be one of the listed tokens.
 */
export function readRouteFields(messageMeta: unknown, paramsMeta: unknown): RouteFields {
	const wake = pick(metaValue(messageMeta, WAKE_META), metaValue(paramsMeta, WAKE_META), "wake", WAKE_SET, "wake must be auto, always, or never");
	if (!wake.ok) return wake;
	const intent = pick(metaValue(messageMeta, INTENT_META), metaValue(paramsMeta, INTENT_META), "intent", INTENT_SET, "intent must be handoff, blocker, question, status, or ack");
	if (!intent.ok) return intent;
	return { ok: true, fields: { wake: wake.value as WakeMode | null, intent: intent.value as Intent | null } };
}

export interface RouteInput {
	mode: RoutingMode;
	wake: WakeMode | null;
	intent: Intent | null;
	duplicate: boolean;
	/** Status text is empty after normalization. */
	idle: boolean;
	/** Status text matches the last status stored for this peer and conversation. */
	unchanged: boolean;
}

export interface RouteDecision {
	/** Ask the existing wake path to run. Existing debounce, busy, and hourly-cap checks still apply. */
	deliver: boolean;
	/** Hold a changed status for the debounce window instead of sending immediately. */
	batch: boolean;
	decision: string;
	proposed: Proposed;
	action: RouteAction;
	intent: Intent | "absent";
	wake: WakeMode | "absent";
	mode: RoutingMode;
}

function shadowOr(mode: RoutingMode, proposed: "suppress" | "batch"): { deliver: boolean; batch: boolean; action: RouteAction } {
	if (mode === "enforce" && proposed === "suppress") return { deliver: false, batch: false, action: "suppress" };
	if (mode === "enforce") return { deliver: true, batch: true, action: "batch" };
	return { deliver: true, batch: false, action: "shadow" };
}

/**
 * Routing rules, in order:
 * a repeated message id does not wake;
 * `never` stores without a wake;
 * `always` wakes, subject to the caller's existing safeguards;
 * legacy (neither field) wakes, which is today's behavior;
 * `auto` wakes for handoff, blocker, and question;
 * `auto` ack, idle status, and unchanged status are proposed suppressions;
 * a changed `auto` status is proposed as one batched wake.
 * Shadow records a proposed suppression or batch and still wakes. Enforce applies them.
 */
export function decideRoute(input: RouteInput): RouteDecision {
	const wake: WakeMode | "absent" = input.wake ?? "absent";
	const intent: Intent | "absent" = input.intent ?? "absent";
	const base = { intent, wake, mode: input.mode };
	if (input.duplicate) {
		return { ...base, deliver: false, batch: false, decision: "duplicate", proposed: "suppress", action: "suppress" };
	}
	if (input.wake === "never") {
		return { ...base, deliver: false, batch: false, decision: "never", proposed: "suppress", action: "suppress" };
	}
	if (input.wake === "always") {
		return { ...base, deliver: true, batch: false, decision: "always", proposed: "wake", action: "wake" };
	}
	const auto = input.wake === "auto" || (input.wake === null && input.intent !== null);
	if (!auto) {
		return { ...base, deliver: true, batch: false, decision: "legacy", proposed: "wake", action: "wake" };
	}
	if (input.intent && ACTIONABLE.has(input.intent)) {
		return { ...base, deliver: true, batch: false, decision: input.intent, proposed: "wake", action: "wake" };
	}
	if (input.intent === "ack") {
		const applied = shadowOr(input.mode, "suppress");
		return { ...base, ...applied, decision: "ack", proposed: "suppress" };
	}
	if (input.intent === "status") {
		if (input.idle) {
			const applied = shadowOr(input.mode, "suppress");
			return { ...base, ...applied, decision: "status_idle", proposed: "suppress" };
		}
		if (input.unchanged) {
			const applied = shadowOr(input.mode, "suppress");
			return { ...base, ...applied, decision: "status_unchanged", proposed: "suppress" };
		}
		const applied = shadowOr(input.mode, "batch");
		return { ...base, ...applied, decision: "status", proposed: "batch" };
	}
	return { ...base, deliver: true, batch: false, decision: "auto_unspecified", proposed: "wake", action: "wake" };
}

/** Empty working status, including the v1 spelling, with no file or artifact parts. */
export function isIdleWorkingPush(state: string | null | undefined, text: string, hasFile: boolean): boolean {
	const plain = state === "TASK_STATE_WORKING" ? "working" : state;
	return plain === "working" && !statusText(text) && !hasFile;
}
