export const SESSION_COOKIE = "__Host-a2a_session";
export const INVITE_COOKIE = "__Host-a2a_invite";

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

/** Host-only cookie. No Domain attribute: the __Host- prefix forbids one. */
export function hostCookie(name: string, value: string, maxAge: number): string {
	return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}
