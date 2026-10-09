// Host → tenant name directory. The hosted router reads this before it touches a Durable Object.
// Control (later) writes `tenant:<name>` = { id, status, region, version }. No secrets live here.
// An entry with an empty region is pinned on first sight (`eu`, `fedramp`, or `default`) and then only read.
// The isolate caches each lookup, including "not in the directory", for 60 seconds, capped so a scan of
// random names cannot grow it without bound.

import type { KvNamespace } from "./tenancy.ts";

/** 4–32 characters: letter or digit, then letters, digits or hyphens, ending in a letter or digit. */
export const TENANT_NAME = /^[a-z0-9](?:[a-z0-9-]{2,30}[a-z0-9])$/;

export const DIRECTORY_TTL_MS = 60_000;
/** Isolate cap. A scan of random names must not keep a map entry for every miss. */
export const DIRECTORY_MAX = 1024;

export interface DirectoryEntry {
	id: string;
	status: string;
	/**
	 * Placement, pinned once. `eu` and `fedramp` select that jurisdiction. `default` is the namespace's
	 * default placement. `""` means not pinned yet.
	 */
	region: string;
	version: number;
}

const cache = new Map<string, { at: number; entry: DirectoryEntry | null }>();

export function clearDirectoryCache(): void {
	cache.clear();
}

/** Move `name` to the newest end and drop expired, then oldest, entries past the cap. */
function remember(name: string, at: number, entry: DirectoryEntry | null, now: number): void {
	cache.delete(name);
	cache.set(name, { at, entry });
	if (cache.size <= DIRECTORY_MAX) return;
	for (const [k, v] of cache) if (now - v.at >= DIRECTORY_TTL_MS) cache.delete(k);
	while (cache.size > DIRECTORY_MAX) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
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

/** `eu` or `fedramp` when the directory entry says so. `default` and anything else use the default namespace. */
export function tenantRegion(entry: DirectoryEntry): string {
	return entry.region === "eu" || entry.region === "fedramp" ? entry.region : "";
}

/**
 * Write a placement into an entry that does not have one yet, then return that entry.
 * `DATA_REGION` is read only here. A later change to it does not move a tenant whose row already
 * has `eu`, `fedramp`, or `default`. Returns null when the write fails; the caller must not address
 * an object until the placement is stored.
 */
export async function pinDirectoryRegion(
	kv: Pick<KvNamespace, "put">,
	name: string,
	entry: DirectoryEntry,
	dataRegion: string,
	now = Date.now(),
): Promise<DirectoryEntry | null> {
	if (entry.region !== "") return entry;
	const region = dataRegion === "eu" || dataRegion === "fedramp" ? dataRegion : "default";
	const pinned: DirectoryEntry = { ...entry, region };
	try {
		await kv.put(directoryKey(name), JSON.stringify(pinned));
	} catch {
		return null;
	}
	remember(name, now, pinned, now);
	return pinned;
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
	if (hit && now - hit.at < DIRECTORY_TTL_MS) {
		remember(name, hit.at, hit.entry, now);
		return hit.entry;
	}
	let entry: DirectoryEntry | null = null;
	try {
		entry = parseDirectoryEntry(await kv.get(directoryKey(name), "json"));
	} catch {
		entry = null;
	}
	remember(name, now, entry, now);
	return entry;
}
