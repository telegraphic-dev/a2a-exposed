// Host → tenant name directory. The hosted router reads this before it touches a Durable Object.
// Control (later) writes `tenant:<name>` = { id, status, region, version }. No secrets live here.
// The isolate caches each lookup, including "not in the directory", for 60 seconds.

import type { KvNamespace } from "./tenancy.ts";

/** 4–32 characters: letter or digit, then letters, digits or hyphens, ending in a letter or digit. */
export const TENANT_NAME = /^[a-z0-9](?:[a-z0-9-]{2,30}[a-z0-9])$/;

export const DIRECTORY_TTL_MS = 60_000;

export interface DirectoryEntry {
	id: string;
	status: string;
	/** "" until control records one. `eu` and `fedramp` select a Durable Object jurisdiction. */
	region: string;
	version: number;
}

const cache = new Map<string, { at: number; entry: DirectoryEntry | null }>();

export function clearDirectoryCache(): void {
	cache.clear();
}

export function directoryKey(name: string): string {
	return `tenant:${name}`;
}

/**
 * First label under `domain`, or null. The apex, a nested name (`a.b.domain`) and a different parent do not match.
 * `domain` is compared already normalised (lowercase, no surrounding dots).
 */
export function tenantNameFromHost(host: string, domain: string): string | null {
	const h = host.toLowerCase();
	const d = domain.toLowerCase();
	if (!d || h === d || !h.endsWith("." + d)) return null;
	const name = h.slice(0, -(d.length + 1));
	return TENANT_NAME.test(name) ? name : null;
}

/** Directory region when set, otherwise the Worker's `DATA_REGION`. The region is fixed when the tenant is created. */
export function tenantRegion(entry: DirectoryEntry, dataRegion: string): string {
	return entry.region || dataRegion || "";
}

export function parseDirectoryEntry(raw: unknown): DirectoryEntry | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(o.id)) return null;
	if (typeof o.status !== "string" || !/^[a-z]{1,32}$/.test(o.status)) return null;
	const region = typeof o.region === "string" ? o.region : "";
	const version = typeof o.version === "number" && Number.isSafeInteger(o.version) ? o.version : 0;
	return { id: o.id, status: o.status, region, version };
}

/**
 * Cached directory lookup. A missing or unreadable value is cached as "unknown" so a scan of random names
 * does not hit KV on every request. Pass `now` from tests.
 */
export async function lookupDirectory(kv: Pick<KvNamespace, "get">, name: string, now = Date.now()): Promise<DirectoryEntry | null> {
	const hit = cache.get(name);
	if (hit && now - hit.at < DIRECTORY_TTL_MS) return hit.entry;
	let entry: DirectoryEntry | null = null;
	try {
		entry = parseDirectoryEntry(await kv.get(directoryKey(name), "json"));
	} catch {
		entry = null;
	}
	cache.set(name, { at: now, entry });
	return entry;
}
