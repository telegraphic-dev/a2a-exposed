export const SESSION_COOKIE = "__Host-a2a_session";
export const INVITE_COOKIE = "__Host-a2a_invite";
/** One-time owner token for the page that follows a form create. Not the session. */
export const OWNER_COOKIE = "__Host-a2a_owner";
/** One-time Cloudflare connect or disconnect to finish after a fresh sign-in. Not the session. */
export const CLOUDFLARE_RESUME_COOKIE = "__Host-a2a_cf_resume";
/** One-time owner token for an inbox created in the user's Cloudflare account. Not the session. */
export const CF_OWNER_COOKIE = "__Host-a2a_cf_owner";

export function readCookie(header: string | null, name: string): string {
	if (!header) return "";
	for (const part of header.split(";")) {
		const trimmed = part.trim();
		const eq = trimmed.indexOf("=");
		if (eq < 0) continue;
		if (trimmed.slice(0, eq) !== name) continue;
		try {
			return decodeURIComponent(trimmed.slice(eq + 1));
		} catch {
			return "";
		}
	}
	return "";
}

/** Host-only cookie. No Domain attribute: the __Host- prefix forbids one, and it requires Path=/. */
export function hostCookie(name: string, value: string, maxAge: number): string {
	return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

const BARE_OWNER_TOKEN = /^a2aot_[A-Za-z0-9_-]{43}$/;

/** Create stores the bare token. Anything else is not shown on the account page. */
export function bareOwnerToken(value: string): string {
	return BARE_OWNER_TOKEN.test(value) ? value : "";
}

/**
 * Rotation stores `agentName.token`. The __Host- prefix requires Path=/, so the cookie is sent to
 * every page; only the named agent's page may show it.
 */
export function ownerTokenForAgent(value: string, name: string): string {
	const prefix = `${name}.`;
	if (!name || !value.startsWith(prefix)) return "";
	const token = value.slice(prefix.length);
	return BARE_OWNER_TOKEN.test(token) ? token : "";
}
