// Wake URL checks for WAKE_TARGET_POLICY=public-https. Unset stays the previous fetch
// (any URL the operator configured, redirects followed by the platform).
//
// The TCP connection is to an address from the DNS check. TLS is not the runtime's
// startTls({ expectedServerHostname }): on the Workers edge that sends no SNI when the
// socket was opened to an IP (cloudflare/workerd#6903), so the peer aborts before HTTP.
// The handshake runs in-process, with the URL hostname as SNI, over that pinned socket.
// A socket still cannot open a Cloudflare address, so a *.workers.dev target does not connect.
import { CertificateError, Client, TlsError } from "tunnelfetch";
import { isPrivateHost } from "./a2a.ts";
import { isPublicIp } from "./mcp.ts";

/** DNS-over-HTTPS resolver. Same endpoint the client-metadata fetch uses. */
export const DOH_URL = "https://cloudflare-dns.com/dns-query";

/** Original request plus this many redirects. Each hop is checked before it is requested. */
const MAX_REDIRECTS = 3;

const REQUEST_TIMEOUT_MS = 15_000;

/** Host to addresses. `null` means the lookup failed and the caller must fail closed. */
export type AddressLookup = (host: string) => Promise<string[] | null>;

type WakeSocket = {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
	opened?: Promise<{ remoteAddress?: string | null }>;
	close?: () => Promise<void>;
};

/** Raw TCP. Production uses `cloudflare:sockets`. Tests replace it. */
export type WakeConnect = (address: { hostname: string; port: number }, options?: { secureTransport?: "off" | "on" | "starttls"; allowHalfOpen?: boolean }) => WakeSocket;

/** One checked hop. `ip` is the address the socket must use. `hostname` is the TLS name. */
export type CheckedDeliver = (url: string, init: RequestInit, target: { ip: string; hostname: string }) => Promise<Response>;

export const wakeNet: { connect: null | WakeConnect; deliver: null | CheckedDeliver } = { connect: null, deliver: null };

export type WakeDeps = {
	lookup?: AddressLookup;
	connect?: WakeConnect;
	deliver?: CheckedDeliver;
	/** Deliver a URL on this host in-process. Used for a wake aimed at this inbox. */
	localHost?: string;
	local?: (url: string, init: RequestInit) => Promise<Response>;
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
 * link-local (including metadata), CGNAT, multicast, benchmarking, Teredo, 6to4, and documentation ranges are refused.
 * A lookup that cannot be completed is refused.
 */
export async function publicWakeProblem(url: string, lookup: AddressLookup = lookupAddresses): Promise<string> {
	const checked = await checkedWakeAddress(url, lookup);
	return "refused" in checked ? checked.refused : "";
}

/** Every public address from one lookup. The socket uses the first. The TLS name is the URL host. */
async function checkedWakeAddresses(url: string, lookup: AddressLookup): Promise<{ hostname: string; ips: string[] } | { refused: string }> {
	let parsed: URL;
	try { parsed = new URL(url); } catch { return { refused: "not a URL" }; }
	if (parsed.protocol !== "https:") return { refused: "must be https" };
	if (parsed.username || parsed.password) return { refused: "must not contain credentials" };
	const host = parsed.hostname;
	if (!host || isPrivateHost(host)) return { refused: "private or internal host" };
	const bare = bareHost(host);
	if (isIpLiteral(host)) return isPublicIp(bare) ? { hostname: bare, ips: [bare] } : { refused: "private or reserved address" };
	let ips: string[] | null;
	try { ips = await lookup(host); } catch { return { refused: "its address could not be checked" }; }
	if (ips == null) return { refused: "its address could not be checked" };
	if (!ips.length) return { refused: "the host has no address" };
	if (!ips.every((ip) => isPublicIp(ip))) return { refused: "resolves to a private or reserved address" };
	return { hostname: host, ips };
}

/** The address the next request must use. A name is resolved once; the returned IP is from that answer. */
export async function checkedWakeAddress(url: string, lookup: AddressLookup = lookupAddresses): Promise<{ ip: string } | { refused: string }> {
	const checked = await checkedWakeAddresses(url, lookup);
	if ("refused" in checked) return checked;
	return { ip: checked.ips[0]! };
}

/**
 * Dial `ip`, ignoring the hostname the TLS stack passes in. The handshake names that hostname
 * itself; this function only chooses the TCP address.
 */
export function dialChecked(ip: string, connect: WakeConnect): WakeConnect {
	return (addr) => connect({ hostname: ip, port: addr.port }, { secureTransport: "off", allowHalfOpen: false });
}

async function runtimeConnect(): Promise<WakeConnect> {
	if (wakeNet.connect) return wakeNet.connect;
	const sockets = await import("cloudflare:sockets");
	return sockets.connect as unknown as WakeConnect;
}

/** Enough of an error body to recognise a Cloudflare status page. A success body is not kept. */
const HINT_BYTES = 4096;

/**
 * HTTPS to the checked IP, with SNI and certificate verification for the URL host.
 * `forceTunnel` keeps the platform from fetching the hostname again.
 * The body is copied before the client closes, because closing drops the socket.
 */
async function deliverPinned(url: string, init: RequestInit, target: { ip: string; hostname: string }, connect: WakeConnect): Promise<Response> {
	const client = new Client({
		connect: dialChecked(target.ip, connect),
		forceTunnel: true,
		maxRedirects: 0,
		maxBodyBytes: Infinity,
		http2: false,
		keepAlive: false,
		timeouts: { totalMs: REQUEST_TIMEOUT_MS },
	});
	try {
		const res = await client.fetch(url, {
			method: init.method,
			headers: init.headers,
			body: init.body,
			redirect: "manual",
		});
		return await responseForCaller(res);
	} catch (e) {
		if (e instanceof TlsError || e instanceof CertificateError) throw new Error("TLS Handshake Failed.");
		throw e;
	} finally {
		await client.close().catch(() => {});
	}
}

/** Status and headers, plus the start of an error body. The live socket is not returned. */
async function responseForCaller(res: Response): Promise<Response> {
	const headers = new Headers(res.headers);
	if (res.ok || !res.body) {
		await res.body?.cancel().catch(() => {});
		return new Response(null, { status: res.status, headers });
	}
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (total < HINT_BYTES) {
			const next = await reader.read();
			if (next.done || !next.value) break;
			chunks.push(next.value);
			total += next.value.byteLength;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const merged = new Uint8Array(Math.min(total, HINT_BYTES));
	let offset = 0;
	for (const chunk of chunks) {
		const take = Math.min(chunk.byteLength, merged.byteLength - offset);
		if (take <= 0) break;
		merged.set(chunk.subarray(0, take), offset);
		offset += take;
	}
	return new Response(merged, { status: res.status, headers });
}

/** Keep a bounded response body for an authenticated peer JSON-RPC call. The socket client enforces the
 *  limit before this helper runs; copying detaches the returned body from the socket before it is closed. */
async function peerResponseForCaller(res: Response): Promise<Response> {
	const body = res.body ? await res.arrayBuffer() : null;
	return new Response(body, { status: res.status, headers: new Headers(res.headers) });
}

async function deliverPinnedPeer(url: string, init: RequestInit, target: { ip: string; hostname: string }, connect: WakeConnect): Promise<Response> {
	const client = new Client({
		connect: dialChecked(target.ip, connect),
		forceTunnel: true,
		maxRedirects: 0,
		maxBodyBytes: 1 << 20,
		http2: false,
		keepAlive: false,
		timeouts: { totalMs: REQUEST_TIMEOUT_MS },
	});
	try {
		const res = await client.fetch(url, { method: init.method, headers: init.headers, body: init.body, redirect: "manual", signal: init.signal ?? undefined });
		return await peerResponseForCaller(res);
	} catch (e) {
		if (e instanceof TlsError || e instanceof CertificateError) throw new Error("TLS Handshake Failed.");
		throw e;
	} finally {
		await client.close().catch(() => {});
	}
}

/** One authenticated peer request with DNS resolution pinned to the connected socket. Redirects are refused:
 *  a bearer token and a reply must never be replayed at a card-selected second destination. */
export async function fetchCheckedPeer(
	url: string,
	init: RequestInit,
	deps: Pick<WakeDeps, "lookup" | "connect" | "deliver"> = {},
): Promise<{ response: Response } | { refused: string }> {
	init.signal?.throwIfAborted();
	const checked = await checkedWakeAddresses(url, deps.lookup ?? ((host) => lookupAddresses(host, init.signal ?? undefined)));
	init.signal?.throwIfAborted();
	if ("refused" in checked) return checked;
	const target = { ip: checked.ips[0]!, hostname: checked.hostname };
	const nextInit: RequestInit = { ...init, redirect: "manual" };
	const response = deps.deliver
		? await deps.deliver(url, nextInit, target)
		: wakeNet.deliver
			? await wakeNet.deliver(url, nextInit, target)
			: await deliverPinnedPeer(url, nextInit, target, deps.connect ?? wakeNet.connect ?? await runtimeConnect());
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel().catch(() => {});
		return { refused: "redirects are not allowed" };
	}
	return { response };
}

function bodyBytes(body: BodyInit | null | undefined): Uint8Array {
	if (body == null) return new Uint8Array();
	if (typeof body === "string") return new TextEncoder().encode(body);
	if (body instanceof Uint8Array) return body;
	throw new Error("unsupported wake body");
}

/**
 * POST (or whatever `init` says) to `url` after the public-https check.
 * The socket opens to an address from that check. TLS uses the hostname.
 * A redirect is followed only when it stays on the same origin, and that hop is checked again.
 * A cross-origin redirect is refused, so wake credentials are not sent to another host.
 * 301, 302, and 303 drop the body. 307 and 308 keep it.
 */
export async function fetchCheckedWake(
	url: string,
	init: RequestInit,
	deps: WakeDeps = {},
): Promise<{ response: Response } | { refused: string }> {
	const lookup = deps.lookup ?? lookupAddresses;
	let current = url;
	let method = (init.method || "GET").toUpperCase();
	let body = bodyBytes(method === "GET" || method === "HEAD" ? undefined : init.body);
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const checked = await checkedWakeAddresses(current, lookup);
		if ("refused" in checked) return checked;
		const nextInit: RequestInit = {
			method,
			headers: init.headers,
			body: method === "GET" || method === "HEAD" || body.byteLength === 0 ? undefined : body,
			redirect: "manual",
		};
		const target = { ip: checked.ips[0]!, hostname: checked.hostname };
		let res: Response;
		if (deps.local && deps.localHost && new URL(current).host === deps.localHost) res = await deps.local(current, nextInit);
		else if (deps.deliver) res = await deps.deliver(current, nextInit, target);
		else if (wakeNet.deliver) res = await wakeNet.deliver(current, nextInit, target);
		else res = await deliverPinned(current, nextInit, target, deps.connect ?? wakeNet.connect ?? await runtimeConnect());
		const location = res.headers.get("location");
		if (res.status < 300 || res.status >= 400 || !location) return { response: res };
		await res.body?.cancel().catch(() => {});
		if (hop === MAX_REDIRECTS) return { refused: "too many redirects" };
		let next: URL;
		try { next = new URL(location, current); } catch { return { refused: "not a URL" }; }
		const ahead = await checkedWakeAddresses(next.href, lookup);
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
