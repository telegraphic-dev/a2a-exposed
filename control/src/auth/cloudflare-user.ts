// Trust is per provider. GET /client/v4/user (scope user-details.read) returns
// an email and no verification field. Cloudflare lets an account sign in before
// that email is verified, so this mapping never reports the address as verified.
// Callers do not match it against SIGNUP_ALLOWLIST and do not put Cloudflare in
// trustedProviders. A payload field named email_verified is not read. Connect
// stores the Cloudflare account id, not this email, and does not open a session.
export interface CloudflareUserResult {
	id?: string;
	email?: string;
	first_name?: string | null;
	last_name?: string | null;
}

export function mapCloudflareUser(result: CloudflareUserResult | null | undefined): {
	id: string;
	email: string;
	name: string;
	emailVerified: false;
} | null {
	const id = result?.id?.trim() ?? "";
	const email = result?.email?.trim() ?? "";
	if (!id || !email) return null;
	const name = [result?.first_name, result?.last_name].map((part) => part?.trim() ?? "").filter(Boolean).join(" ");
	return { id, email, name: name || email, emailVerified: false };
}
