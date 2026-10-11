/**
 * Plain-text value bound as FREE_AGENT_LIMIT at deploy time.
 * An explicit non-negative integer wins. `none` binds nothing.
 * A hosted deploy (tenant domain or data-plane worker set) that leaves the variable unset binds 2.
 * A neutral control plane, with neither of those set, binds nothing.
 */
export function deployedFreeAgentLimit(raw: string | undefined, hosted: boolean): string {
	const value = (raw ?? "").trim().toLowerCase();
	if (value === "none" || value === "unlimited") return "";
	if (/^\d+$/.test(value)) return value;
	return hosted ? "2" : "";
}
