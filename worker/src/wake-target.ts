// Wake URL checks for WAKE_TARGET_POLICY=public-https. Unset stays the previous fetch
// (any URL the operator configured, redirects followed by the platform).
import { isPrivateHost } from "./a2a.ts";
import { isPublicIp } from "./mcp.ts";

/** DNS-over-HTTPS resolver. Same endpoint the client-metadata fetch uses. */
export const DOH_URL = "https://cloudflare-dns.com/dns-query";

/** Original request plus this many redirects. Each hop is checked before it is requested. */
const MAX_REDIRECTS = 3;

/** Host to addresses. `null` means the lookup failed and the caller must fail closed. */
export type AddressLookup = (host: string) => Promise<string[] | null>;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function bareHost(host: string): string {
	return host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/** An address literal (IPv4, or IPv6 with or without brackets). Names go through DNS. */
export function isIpLiteral(host: string): boolean {
	const h = bareHost(host);
	if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) return true;
	return h.includes(":") && /^[0-9a-f:.]+$/.test(h);
}

/**
 * A and AAAA for `host`, CNAMEs followed by the resolver. `null` on any DNS or transport failure.
 * An empty list is a real answer with no address (NXDOMAIN or no A/AAAA).
 */
export async function lookupAddresses(host: string, signal?: AbortSignal): Promise<string[] | null> {
	const ips: string[] = [];
	for (const type of ["A", "AAAA"]) {
		let body: { Status?: number; Answer?: { type?: number; data?: string }[] };
		try {
			const res = await fetch(`${DOH_URL}?name=${encodeURIComponent(host)}&type=${type}`, {
				headers: { accept: "application/dns-json" },
				redirect: "manual",
				signal,
			});
			if (!res.ok) return null;
			body = await res.json();
		} catch {
			return null;
		}
		// Status 3 is NXDOMAIN. AAAA is often NXDOMAIN when A exists; that is not a failure.
		if (body?.Status !== 0 && !(body?.Status === 3 && type === "AAAA")) return null;
		for (const answer of Array.isArray(body.Answer) ? body.Answer : []) {
			if (answer?.type === 1 || answer?.type === 28) ips.push(String(answer.data));
		}
	}
	return ips;
}

/**
 * Why this URL must not be requested under public-https. Empty means it may be requested.
 * Names are resolved. Every returned address must be a public unicast address: private, loopback,
 * link-local (including metadata), CGNAT, multicast, and documentation ranges are refused.
 * A lookup that cannot be completed is refused.
 */
export async function publicWakeProblem(url: string, lookup: AddressLookup = lookupAddresses): Promise<string> {
	let parsed: URL;
	try { parsed = new URL(url); } catch { return "not a URL"; }
	if (parsed.protocol !== "https:") return "must be https";
	if (parsed.username || parsed.password) return "must not contain credentials";
	const host = parsed.hostname;
	if (!host || isPrivateHost(host)) return "private or internal host";
	const bare = bareHost(host);
	if (isIpLiteral(host)) return isPublicIp(bare) ? "" : "private or reserved address";
	let ips: string[] | null;
	try { ips = await lookup(host); } catch { return "its address could not be checked"; }
	if (ips == null) return "its address could not be checked";
	if (!ips.length) return "the host has no address";
	if (!ips.every((ip) => isPublicIp(ip))) return "resolves to a private or reserved address";
	return "";
}

/**
 * POST (or whatever `init` says) to `url`. Redirects are manual: the next Location is checked
 * with the same rules before it is requested, so a public URL cannot redirect the Worker at a
 * private, link-local, or metadata address. 301, 302, and 303 drop the body. 307 and 308 keep it.
 */
export async function fetchCheckedWake(
	url: string,
	init: RequestInit,
	fetchImpl: FetchLike,
	lookup: AddressLookup = lookupAddresses,
): Promise<{ response: Response } | { refused: string }> {
	let current = url;
	let method = (init.method || "GET").toUpperCase();
	let body = init.body;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const problem = await publicWakeProblem(current, lookup);
		if (problem) return { refused: problem };
		const res = await fetchImpl(current, {
			method,
			headers: init.headers,
			body: method === "GET" || method === "HEAD" ? undefined : body,
			redirect: "manual",
		});
		const location = res.headers.get("location");
		if (res.status < 300 || res.status >= 400 || !location) return { response: res };
		if (hop === MAX_REDIRECTS) {
			await res.body?.cancel().catch(() => {});
			return { refused: "too many redirects" };
		}
		let next: URL;
		try { next = new URL(location, current); } catch {
			await res.body?.cancel().catch(() => {});
			return { refused: "not a URL" };
		}
		if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")) {
			method = "GET";
			body = undefined;
		}
		await res.body?.cancel().catch(() => {});
		current = next.href;
	}
	return { refused: "too many redirects" };
}
