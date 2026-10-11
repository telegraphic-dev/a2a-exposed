// Trust is per provider. GET /client/v4/user (scope user-details.read) returns
// an email and no verification field. Cloudflare requires that account email to
// be verified, so this mapping reports it verified. SIGNUP_ALLOWLIST reads that
// flag. Better Auth also links a verified profile onto an existing account whose
// email is already verified, which is how a verified GitHub email links.
// Callers leave Cloudflare out of trustedProviders. A payload field named
// email_verified is not read.
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
	emailVerified: true;
} | null {
	const id = result?.id?.trim() ?? "";
	const email = result?.email?.trim() ?? "";
	if (!id || !email) return null;
	const name = [result?.first_name, result?.last_name].map((part) => part?.trim() ?? "").filter(Boolean).join(" ");
	return { id, email, name: name || email, emailVerified: true };
}
