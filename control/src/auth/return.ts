import { TENANT_NAME } from "../tenants/reserved.ts";

/**
 * A same-origin path back to one agent page.
 * Anything else, including another origin or a different path on this host, is not a sign-in return.
 */
export function agentReturnPath(value: string): string {
	if (value.length > 64 || !value.startsWith("/app/agents/")) return "";
	const name = value.slice("/app/agents/".length);
	if (!TENANT_NAME.test(name)) return "";
	return `/app/agents/${name}`;
}
