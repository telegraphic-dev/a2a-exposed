import type { Auth } from "./create-auth.ts";
import { hostCookie, readCookie } from "./cookies.ts";
import type { AuthOptions } from "./options.ts";
import { renderApp } from "../views/document.tsx";
import { renderDevice } from "../views/device.tsx";
import { renderSignIn } from "../views/sign-in.tsx";

/** Public client id the CLI sends. Any other id is rejected. */
export const CLI_CLIENT_ID = "a2a-cli";

/** Remembers the user code across the sign-in redirect. Host-only, no Domain. */
export const DEVICE_COOKIE = "__Host-a2a_device";

const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

export function userCode(value: string): string {
	const code = value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
	return CODE.test(code) ? code : "";
}

export function deviceCodeFromCookie(header: string | null): string {
	return userCode(readCookie(header, DEVICE_COOKIE));
}

export interface DeviceResult {
	kind: "html" | "redirect" | "closed";
	html?: string;
	location?: string;
	cookie?: string;
	turnstile?: boolean;
}

function sameOrigin(request: Request): boolean {
	const origin = request.headers.get("origin");
	return Boolean(origin) && origin === new URL(request.url).origin;
}

function page(request: Request, query: Record<string, string>): string {
	const url = new URL("/app/device", request.url);
	for (const [key, value] of Object.entries(query)) if (value) url.searchParams.set(key, value);
	return url.href;
}

/**
 * The plugin approves only a code this session has already loaded.
 * GET /api/auth/device allows 5 calls for the life of the code, so the page
 * does not call it. Approve and deny claim once, on submit.
 */
async function claimDevice(auth: Auth, request: Request, code: string): Promise<boolean> {
	const origin = new URL(request.url).origin;
	const headers = new Headers({ accept: "application/json", origin });
	const cookieHeader = request.headers.get("cookie");
	if (cookieHeader) headers.set("cookie", cookieHeader);
	const target = new URL("/api/auth/device", origin);
	target.searchParams.set("user_code", code);
	const response = await auth.handler(new Request(target, { headers }));
	await response.arrayBuffer().catch(() => undefined);
	return response.ok;
}

export async function handleDevice(request: Request, auth: Auth, options: AuthOptions, env: { BRAND_NAME?: string }): Promise<DeviceResult> {
	const url = new URL(request.url);
	const session = await auth.api.getSession({ headers: request.headers });
	const signedIn = Boolean(session?.user?.id);
	const turnstile = Boolean(options.turnstile);
	if (request.method === "GET") {
		const code = userCode(url.searchParams.get("user_code") ?? "") || deviceCodeFromCookie(request.headers.get("cookie"));
		const done = url.searchParams.get("done") ?? "";
		const error = url.searchParams.get("error") ?? "";
		const cookie = code ? hostCookie(DEVICE_COOKIE, code, 60 * 10) : undefined;
		const signIn = signedIn ? "" : renderSignIn({
			providers: [
				options.github ? "github" : "",
				options.google ? "google" : "",
				options.cloudflare ? "cloudflare" : "",
			].filter(Boolean),
			magicLink: Boolean(options.mailer || options.emailBinding),
			invitesRequired: options.invitesRequired,
			turnstileSiteKey: options.turnstile?.siteKey,
			error: error || undefined,
		});
		const html = renderApp(env, renderDevice({
			userCode: code,
			signedIn,
			email: session?.user?.email,
			signInHtml: signIn,
			done,
			error,
		}));
		return { kind: "html", html, cookie, turnstile };
	}
	if (request.method !== "POST") return { kind: "closed" };
	if (!sameOrigin(request)) return { kind: "redirect", location: page(request, { error: "auth" }) };
	const form = await request.formData();
	const code = userCode(String(form.get("user_code") ?? ""));
	const action = String(form.get("action") ?? "");
	if (!code || (action !== "approve" && action !== "deny")) {
		return { kind: "redirect", location: page(request, { error: "code" }), cookie: code ? hostCookie(DEVICE_COOKIE, code, 60 * 10) : undefined };
	}
	if (!signedIn) {
		return { kind: "redirect", location: page(request, { user_code: code, error: "auth" }), cookie: hostCookie(DEVICE_COOKIE, code, 60 * 10) };
	}
	const typed = userCode(String(form.get("confirm") ?? ""));
	if (action === "approve" && typed !== code) {
		return { kind: "redirect", location: page(request, { user_code: code, error: "match" }), cookie: hostCookie(DEVICE_COOKIE, code, 60 * 10) };
	}
	const origin = new URL(request.url).origin;
	if (!(await claimDevice(auth, request, code))) {
		return { kind: "redirect", location: page(request, { user_code: code, error: "auth" }) };
	}
	const headers = new Headers({ "content-type": "application/json", origin });
	const cookieHeader = request.headers.get("cookie");
	if (cookieHeader) headers.set("cookie", cookieHeader);
	const path = action === "approve" ? "/api/auth/device/approve" : "/api/auth/device/deny";
	const response = await auth.handler(new Request(new URL(path, origin), {
		method: "POST",
		headers,
		body: JSON.stringify({ userCode: code }),
	}));
	await response.arrayBuffer().catch(() => undefined);
	if (!response.ok) {
		return { kind: "redirect", location: page(request, { user_code: code, error: "auth" }) };
	}
	return {
		kind: "redirect",
		location: page(request, { done: action === "approve" ? "approved" : "denied" }),
		cookie: hostCookie(DEVICE_COOKIE, "", 0),
	};
}
