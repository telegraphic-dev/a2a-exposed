// Wake URL checks for WAKE_TARGET_POLICY=public-https. Unset stays the previous fetch
// (any URL the operator configured, redirects followed by the platform).
import { isPrivateHost } from "./a2a.ts";
import { isPublicIp, net, parseHttpResponse, type PinnedSocket } from "./mcp.ts";

/** DNS-over-HTTPS resolver. Same endpoint the client-metadata fetch uses. */
export const DOH_URL = "https://cloudflare-dns.com/dns-query";

/** Original request plus this many redirects. Each hop is checked before it is requested. */
const MAX_REDIRECTS = 3;

/** Host to addresses. `null` means the lookup failed and the caller must fail closed. */
export type AddressLookup = (host: string) => Promise<string[] | null>;

type Connect = NonNullable<typeof net.connect>;

export type WakeDeps = {
	lookup?: AddressLookup;
	connect?: Connect;
};

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
	const checked = await checkedWakeAddress(url, lookup);
	return "refused" in checked ? checked.refused : "";
}

/** The address the next request must use. A name is resolved once; the returned IP is from that answer. */
export async function checkedWakeAddress(url: string, lookup: AddressLookup = lookupAddresses): Promise<{ ip: string } | { refused: string }> {
	let parsed: URL;
	try { parsed = new URL(url); } catch { return { refused: "not a URL" }; }
	if (parsed.protocol !== "https:") return { refused: "must be https" };
	if (parsed.username || parsed.password) return { refused: "must not contain credentials" };
	const host = parsed.hostname;
	if (!host || isPrivateHost(host)) return { refused: "private or internal host" };
	const bare = bareHost(host);
	if (isIpLiteral(host)) return isPublicIp(bare) ? { ip: bare } : { refused: "private or reserved address" };
	let ips: string[] | null;
	try { ips = await lookup(host); } catch { return { refused: "its address could not be checked" }; }
	if (ips == null) return { refused: "its address could not be checked" };
	if (!ips.length) return { refused: "the host has no address" };
	if (!ips.every((ip) => isPublicIp(ip))) return { refused: "resolves to a private or reserved address" };
	return { ip: ips[0] };
}

function headerEntries(headers: HeadersInit | undefined): [string, string][] {
	const out: [string, string][] = [];
	const list = new Headers(headers);
	list.forEach((value, key) => out.push([key, value]));
	return out;
}

function requestBytes(method: string, url: URL, headers: HeadersInit | undefined, body: Uint8Array): Uint8Array {
	const lines = [`${method} ${url.pathname}${url.search} HTTP/1.1`, `host: ${url.host}`];
	for (const [key, value] of headerEntries(headers)) {
		if (key === "host" || key === "content-length" || key === "connection" || key === "transfer-encoding") continue;
		if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) throw new Error("invalid header");
		lines.push(`${key}: ${value}`);
	}
	if (body.byteLength) lines.push(`content-length: ${body.byteLength}`);
	lines.push("connection: close");
	const head = new TextEncoder().encode(lines.join("\r\n") + "\r\n\r\n");
	const raw = new Uint8Array(head.byteLength + body.byteLength);
	raw.set(head);
	raw.set(body, head.byteLength);
	return raw;
}

async function readSocket(sock: PinnedSocket, cap: number): Promise<Uint8Array> {
	const reader = sock.readable.getReader();
	const chunks: Uint8Array[] = [];
	let n = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		n += value.byteLength;
		if (n > cap) break;
		chunks.push(value);
	}
	const raw = new Uint8Array(Math.min(n, cap));
	let o = 0;
	for (const chunk of chunks) {
		const take = Math.min(chunk.byteLength, raw.byteLength - o);
		raw.set(chunk.subarray(0, take), o);
		o += take;
	}
	return raw;
}

/**
 * HTTPS to `ip`, with TLS checked for the URL's hostname. The platform does not resolve the name again.
 */
async function pinnedRequest(ip: string, url: string, method: string, headers: HeadersInit | undefined, body: Uint8Array, connect: Connect): Promise<Response> {
	const parsed = new URL(url);
	const sock = connect({ hostname: ip, port: Number(parsed.port || 443) }, { secureTransport: "starttls" }).startTls({ expectedServerHostname: parsed.hostname });
	try {
		const writer = sock.writable.getWriter();
		await writer.write(requestBytes(method, parsed, headers, body));
		writer.releaseLock();
		const raw = await readSocket(sock, 65536);
		const message = parseHttpResponse(raw);
		if (typeof message === "string") throw new Error(message);
		const responseHeaders = new Headers();
		for (const [key, value] of Object.entries(message.headers)) responseHeaders.set(key, value);
		const payload = message.status === 204 || message.status === 304 ? null : message.body;
		return new Response(payload, { status: message.status, headers: responseHeaders });
	} finally {
		await sock.close().catch(() => {});
	}
}

function bodyBytes(body: BodyInit | null | undefined): Uint8Array {
	if (body == null) return new Uint8Array();
	if (typeof body === "string") return new TextEncoder().encode(body);
	if (body instanceof Uint8Array) return body;
	throw new Error("unsupported wake body");
}

/**
 * POST (or whatever `init` says) to `url` on the address that passed the public-https check.
 * A redirect is followed only when it stays on the same origin, and that hop is checked and pinned again.
 * A cross-origin redirect is refused, so wake credentials are not sent to another host.
 * 301, 302, and 303 drop the body. 307 and 308 keep it.
 */
export async function fetchCheckedWake(
	url: string,
	init: RequestInit,
	deps: WakeDeps = {},
): Promise<{ response: Response } | { refused: string }> {
	const lookup = deps.lookup ?? lookupAddresses;
	const connect = async (): Promise<Connect> => {
		if (deps.connect) return deps.connect;
		if (net.connect) return net.connect;
		return (await import("cloudflare:sockets")).connect as unknown as Connect;
	};
	let current = url;
	let method = (init.method || "GET").toUpperCase();
	let body = bodyBytes(method === "GET" || method === "HEAD" ? undefined : init.body);
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const checked = await checkedWakeAddress(current, lookup);
		if ("refused" in checked) return checked;
		const res = await pinnedRequest(checked.ip, current, method, init.headers, method === "GET" || method === "HEAD" ? new Uint8Array() : body, await connect());
		const location = res.headers.get("location");
		if (res.status < 300 || res.status >= 400 || !location) return { response: res };
		if (hop === MAX_REDIRECTS) return { refused: "too many redirects" };
		let next: URL;
		try { next = new URL(location, current); } catch { return { refused: "not a URL" }; }
		const ahead = await checkedWakeAddress(next.href, lookup);
		if ("refused" in ahead) return ahead;
		if (next.origin !== new URL(current).origin) return { refused: "cross-origin redirect" };
		if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")) {
			method = "GET";
			body = new Uint8Array();
		}
		current = next.href;
	}
	return { refused: "too many redirects" };
}
