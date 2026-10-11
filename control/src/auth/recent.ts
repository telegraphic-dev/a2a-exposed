/** A dashboard approve, deny, revoke, or owner-token rotation needs a sign-in from about the last 10 minutes. */
export const RECENT_SIGN_IN_MS = 10 * 60 * 1000;

export const REAUTH_MESSAGE = "Sign in again to approve, deny, revoke, or rotate the owner token. This session is older than 10 minutes.";

const CLOCK_SKEW_MS = 60_000;

function signedInAt(value: unknown): number | null {
	if (value instanceof Date) {
		const ms = value.getTime();
		return Number.isFinite(ms) ? ms : null;
	}
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.length > 0 && value.length < 40) {
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
