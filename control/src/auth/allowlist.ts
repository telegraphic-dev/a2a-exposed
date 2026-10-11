import { brandConfig } from "@brand/brand.config.ts";

/** Neutral sentence when a brand overlay does not set `signupClosed`. */
export const SIGNUP_CLOSED = "Sign-in is invite-only for now.";

/** The brand sentence when `signupClosed` is set, otherwise the neutral sentence. */
export function signupClosedText(env: { BRAND_NAME?: string } = {}): string {
	const configured = brandConfig(env).signupClosed;
	const text = typeof configured === "string" ? configured.trim() : "";
	return text || SIGNUP_CLOSED;
}

export interface SignupAllowlist {
	emails: Set<string>;
	domains: Set<string>;
}

const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const LOCAL_MAX = 64;

function domainOk(value: string): boolean {
	return value.length <= 253 && DOMAIN.test(value);
}

/** One `@`, a non-empty local part, and a dotted domain. The local part is otherwise opaque, so `o'connor` and `user!tag` stay. */
function emailOk(value: string): boolean {
	const at = value.indexOf("@");
	if (at <= 0 || at !== value.lastIndexOf("@")) return false;
	const local = value.slice(0, at);
	if (local.length > LOCAL_MAX || /[\s\u0000-\u001f<>]/.test(local)) return false;
	return domainOk(value.slice(at + 1));
}

/**
 * Empty or unset is open (`null`). A non-empty value is a closed list: exact
 * emails and `*@domain` wildcards, matched case-insensitively. An entry that
 * is neither is ignored. A list with no valid entry admits nobody.
 * `*@example.com` matches `person@example.com` and not `person@sub.example.com`.
 */
export function signupAllowlist(raw: string | undefined): SignupAllowlist | null {
	const text = raw?.trim() ?? "";
	if (!text) return null;
	const emails = new Set<string>();
	const domains = new Set<string>();
	for (const part of text.split(",")) {
		const item = part.trim().toLowerCase();
		if (!item) continue;
		if (item.startsWith("*@")) {
			const domain = item.slice(2);
			if (domainOk(domain)) domains.add(domain);
			continue;
		}
		if (emailOk(item)) emails.add(item);
	}
	return { emails, domains };
}

export function emailIsVerified(value: unknown): boolean {
	return value === true || value === 1;
}

/** Open when `list` is null. Otherwise the address must be verified and on the list. */
export function emailAllowed(list: SignupAllowlist | null, email: string, verified: boolean): boolean {
	if (!list) return true;
	if (!verified) return false;
	const address = email.trim().toLowerCase();
	if (!emailOk(address)) return false;
	if (list.emails.has(address)) return true;
	return list.domains.has(address.slice(address.lastIndexOf("@") + 1));
}
