/** Host labels that are not tenant names. Personal names stay out of this tree. */
export const RESERVED_NAMES = new Set([
	"www", "app", "api", "docs", "content", "status", "admin", "mail", "blog",
	"help", "support", "auth", "login", "agent", "demo", "cdn", "static",
]);

/** 4–32 characters, the same shape the data-plane directory accepts. */
export const TENANT_NAME = /^[a-z0-9](?:[a-z0-9-]{2,30}[a-z0-9])$/;

export function tenantNameProblem(name: string): string {
	const normalized = name.trim().toLowerCase();
	if (!TENANT_NAME.test(normalized)) return "invalid_name";
	if (RESERVED_NAMES.has(normalized)) return "reserved_name";
	return "";
}
