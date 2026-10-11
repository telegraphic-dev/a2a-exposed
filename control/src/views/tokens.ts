/** Peer tokens, MCP tokens, and the hosted owner token (`a2aot_`). Keep this list in step with the Worker's `TOKEN_PREFIXES`. */
export const TOKEN_PREFIXES = ["a2aow_", "s2a_", "a2amcp_", "a2amcpr_", "a2aot_"] as const;

function tokenPattern(flags = ""): RegExp {
	return new RegExp(`(?:${TOKEN_PREFIXES.join("|")})[A-Za-z0-9_-]{20,}`, flags);
}

/** True when the text contains a peer token or a hosted owner token. */
export function hasToken(value: string): boolean {
	return tokenPattern().test(value);
}

/** Replace those tokens and leave the rest of the line. */
export function scrubTokenText(value: string): string {
	return value.replace(tokenPattern("g"), "[redacted]");
}
