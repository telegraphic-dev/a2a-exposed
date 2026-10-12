import { TENANT_NAME } from "../tenants/reserved.ts";

/**
 * A same-origin path back to one agent page.
 * Anything else, including another origin or a different path on this host, is not an agent return.
 */
export function agentReturnPath(value: string): string {
	if (value.length > 64 || !value.startsWith("/app/agents/")) return "";
	const name = value.slice("/app/agents/".length);
	if (!TENANT_NAME.test(name)) return "";
	return `/app/agents/${name}`;
}

/**
 * A same-origin path a sign-in may return to: one agent page, the account page, or Cloudflare setup.
 * A query string, another origin, or any other path is not a return.
 */
export function signInReturnPath(value: string): string {
	if (value === "/app" || value === "/app/cloudflare") return value;
	return agentReturnPath(value);
}
