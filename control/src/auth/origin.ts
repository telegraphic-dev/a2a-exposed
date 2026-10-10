/** https origin, or "" when the value is empty, not https, or carries userinfo. */
export function httpsOrigin(value: string | undefined): string {
	const raw = (value || "").trim();
	if (!raw) return "";
	try {
		const url = new URL(raw);
		if (url.protocol !== "https:" || url.username || url.password) return "";
		return url.origin;
	} catch {
		return "";
	}
}

/**
 * Origin Better Auth uses for this request. A configured `ISSUER` is that origin, and only when
 * the request is already on it, so a different `SITE_URL` cannot publish one host and sign in on
 * another. With `ISSUER` unset, `SITE_URL` is the base URL as before. With neither set, the
 * request origin is used.
 */
export function authBaseURL(env: { ISSUER?: string; SITE_URL?: string }, request: Request): string {
	const requestOrigin = new URL(request.url).origin;
	const issuerRaw = (env.ISSUER ?? "").trim();
	if (issuerRaw) {
		const issuer = httpsOrigin(issuerRaw);
		return issuer === requestOrigin ? issuer : "";
	}
	const configured = (env.SITE_URL ?? "").trim();
	if (configured) {
		try {
			return new URL(configured).origin;
		} catch {
			return requestOrigin;
		}
	}
	return requestOrigin;
}

/**
 * True when this POST came from a page on this host.
 * `Referrer-Policy: no-referrer` makes a browser send `Origin: null` on a same-origin form.
 * `Sec-Fetch-Site` is set by the browser. `cross-site` is rejected even when Origin matches.
 * A client that sends neither header must send this origin.
 */
export function sameOrigin(request: Request): boolean {
	const site = (request.headers.get("sec-fetch-site") ?? "").trim().toLowerCase();
	if (site === "cross-site") return false;
	const origin = (request.headers.get("origin") ?? "").trim();
	if (origin === new URL(request.url).origin) return true;
	if (origin && origin !== "null") return false;
	return site === "same-origin";
}
