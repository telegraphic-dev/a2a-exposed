/** A DNS label: worker names and workers.dev account names. */
export const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A hostname on a zone, such as agent.example.com. */
export const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeHostname(value: string): string {
	return value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
}

/** The account zone a hostname belongs to (longest matching suffix), or null. */
export function zoneForHostname(hostname: string, zones: { id: string; name: string; status: string }[]): { id: string; name: string } | null {
	const host = hostname.toLowerCase();
	const matches = zones.filter((zone) => zone.status === "active" && (host === zone.name || host.endsWith(`.${zone.name}`)));
	matches.sort((a, b) => b.name.length - a.name.length);
	return matches[0] ? { id: matches[0].id, name: matches[0].name } : null;
}

export function workerNameFromHostname(hostname: string): string | null {
	const label = hostname.split(".")[0] ?? "";
	return LABEL_RE.test(label) ? label : null;
}
