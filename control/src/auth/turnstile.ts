const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const SECRET_CODES = new Set(["invalid-input-secret", "missing-input-secret"]);
const TOKEN_CODES = new Set([
	"invalid-input-response",
	"missing-input-response",
	"timeout-or-duplicate",
	"bad-request",
]);

export interface TurnstileFailure {
	status: number;
	code: string;
	message: string;
}

/** Cloudflare's connecting IP, or null when the header is missing or not an address. */
export function connectingIp(request: Request): string | null {
	const value = request.headers.get("cf-connecting-ip")?.trim() ?? "";
	if (!value || value.length > 64 || !/^[0-9a-fA-F:.]+$/.test(value)) return null;
	return value;
}

/**
 * Check a Turnstile token. Cloudflare answers HTTP 400, with `success: false`,
 * when it does not accept the secret. The caller maps `code` onto the sign-in page.
 * Returns null when the token is accepted.
 */
export async function verifyTurnstile(secret: string, token: string, remoteIp: string | null): Promise<TurnstileFailure | null> {
	let response: Response;
	try {
		response = await fetch(SITEVERIFY, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ secret, response: token, ...(remoteIp ? { remoteip: remoteIp } : {}) }),
		});
	} catch {
		return { status: 503, code: "turnstile_unavailable", message: "Turnstile did not answer." };
	}
	let body: { success?: unknown; "error-codes"?: unknown } | null = null;
	try {
		const parsed = await response.json() as { success?: unknown; "error-codes"?: unknown };
		if (parsed && typeof parsed === "object") body = parsed;
	} catch {
		body = null;
	}
	if (response.ok && body?.success === true) return null;
	const listed = Array.isArray(body?.["error-codes"]) ? body["error-codes"] : [];
	const raw = listed.find((item) => typeof item === "string" && /^[a-z0-9-]{1,64}$/.test(item));
	const code = typeof raw === "string" ? raw : "";
	if (SECRET_CODES.has(code)) return { status: response.status || 400, code, message: "Turnstile rejected the secret." };
	if (TOKEN_CODES.has(code) || body?.success === false) {
		return { status: response.status || 400, code: code || "turnstile", message: "Turnstile rejected the token." };
	}
	return { status: response.status || 503, code: "turnstile_unavailable", message: "Turnstile did not answer." };
}
