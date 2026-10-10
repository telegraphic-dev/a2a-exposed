// Cloudflare's user-details.read payload has an email and no verification field.
// Better Auth would treat a trusted provider as verified enough to link accounts,
// so this mapping never reports the address as verified. Callers leave Cloudflare
// out of trustedProviders as well.
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
