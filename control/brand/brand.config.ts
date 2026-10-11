// Neutral brand. The overlay replaces this file. No hosted name, URL, or legal page is the default.
export interface BrandLink {
	href: string;
	label: string;
}

export interface Brand {
	name: string;
	supportEmail: string;
	footerLinks: BrandLink[];
	legal: { privacy?: string; terms?: string };
	/** Shown when SIGNUP_ALLOWLIST refuses a sign-in. The overlay may replace this sentence. */
	signupClosed?: string;
}

export const SIGNUP_CLOSED = "Sign-in is invite-only for now.";

export function brandConfig(env: { BRAND_NAME?: string } = {}): Brand {
	const name = (env.BRAND_NAME ?? "").trim() || "Inbox";
	return { name, supportEmail: "", footerLinks: [], legal: {}, signupClosed: SIGNUP_CLOSED };
}
