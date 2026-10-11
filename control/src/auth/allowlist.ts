/** Shown when a sign-in is refused because SIGNUP_ALLOWLIST is set. */
export const SIGNUP_CLOSED = "Hosted a2a.exposed is invite-only for now.";

export interface SignupAllowlist {
	emails: Set<string>;
	domains: Set<string>;
}

const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const LOCAL = /^[a-z0-9._%+-]+$/;

function domainOk(value: string): boolean {
	return value.length <= 253 && DOMAIN.test(value);
}

function emailOk(value: string): boolean {
	const at = value.lastIndexOf("@");
	if (at <= 0) return false;
	return LOCAL.test(value.slice(0, at)) && domainOk(value.slice(at + 1));
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
