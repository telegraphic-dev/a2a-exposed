/** A dashboard approve, deny, revoke, owner-token rotation, or agent delete needs a sign-in from about the last 10 minutes. */
export const RECENT_SIGN_IN_MS = 10 * 60 * 1000;

export const REAUTH_MESSAGE = "Sign in again to approve, deny, revoke, rotate the owner token, or delete the agent. This session is older than 10 minutes.";

const CLOCK_SKEW_MS = 60_000;

function signedInAt(value: unknown): number | null {
	if (value instanceof Date || (value !== null && typeof value === "object" && "getTime" in value && typeof (value as { getTime?: unknown }).getTime === "function")) {
		const ms = (value as { getTime: () => number }).getTime();
		return Number.isFinite(ms) ? ms : null;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		// Seconds since the epoch are below 1e12. Milliseconds are not.
		if (value > 0 && value < 1e12) return Math.round(value * 1000);
		return value;
	}
	if (typeof value === "string" && value.trim()) {
		const ms = Date.parse(value);
		return Number.isFinite(ms) ? ms : null;
	}
	return null;
}

/** True when this session was created within the last 10 minutes, allowing a minute of clock skew. */
export function recentSignIn(session: { session?: { createdAt?: unknown } } | null, now = Date.now()): boolean {
	const at = signedInAt(session?.session?.createdAt);
	if (at === null) return false;
	const age = now - at;
	return age >= -CLOCK_SKEW_MS && age <= RECENT_SIGN_IN_MS;
}
