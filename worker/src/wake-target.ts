// Wake URL checks for WAKE_TARGET_POLICY=public-https. Unset stays the previous fetch
// (any URL the operator configured, redirects followed by the platform).
//
// The TCP connection is to an address from the DNS check. TLS is not the runtime's
// startTls({ expectedServerHostname }): on the Workers edge that sends no SNI when the
// socket was opened to an IP (cloudflare/workerd#6903), so the peer aborts before HTTP.
// The handshake runs in-process, with the URL hostname as SNI, over that pinned socket.
// A socket still cannot open a Cloudflare address, so a *.workers.dev target does not connect.
// With EGRESS_CLOUDFLARE_EDGE=1, a named host whose pinned socket the Workers socket policy refused
// for a checked Cloudflare address is retried once with the platform fetch (see `edgeRetryAllowed`).
// That fetch resolves the name again; see docs/security.md.
import { withDeadline } from "./deadline.ts";
import { CertificateError, Client, LimitError, TlsError } from "tunnelfetch";
import { isPrivateHost } from "./a2a.ts";
import { isCloudflareIp, isPublicIp } from "./mcp.ts";

/** DNS-over-HTTPS resolver. Same endpoint the client-metadata fetch uses. */
export const DOH_URL = "https://cloudflare-dns.com/dns-query";

/** Original request plus this many redirects. Each hop is checked before it is requested. */
const MAX_REDIRECTS = 3;

const REQUEST_TIMEOUT_MS = 15_000;

/** Host to addresses. `null` means the lookup failed and the caller must fail closed. */
export type AddressLookup = (host: string, signal?: AbortSignal) => Promise<string[] | null>;

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

/** Platform fetch for the socket-policy retry. Redirects stay manual. */
export type EdgeFetch = (url: string, init: RequestInit) => Promise<Response>;

export const wakeNet: { connect: null | WakeConnect; deliver: null | CheckedDeliver; edge: null | EdgeFetch } = { connect: null, deliver: null, edge: null };

/** The runtime fetch, used only after `edgeRetryAllowed`. Tests replace it with `wakeNet.edge`. */
export const edgeFetch: EdgeFetch = (url, init) => (wakeNet.edge ?? fetch)(url, { ...init, redirect: "manual" });

/** Marks a response that came from the socket-policy retry, so callers can log the transport. */
export type EgressTransport = "fetch_fallback";

/** The Workers socket error for a disallowed address (Cloudflare IPs, localhost, private networks). */
const SOCKET_POLICY_REFUSAL = /proxy request failed, cannot connect to the specified address/i;

export function isSocketPolicyRefusal(e: unknown): boolean {
	return e instanceof Error && SOCKET_POLICY_REFUSAL.test(e.message);
}

/** One pinned socket: the checked IP it dialled, and whether the socket policy refused it. */
export type SocketAttempt = { ip: string; refused: boolean; settled?: Promise<void> };

/** Record a socket (or the error `connect` threw) on `attempt`. */
export function noteSocket(attempt: SocketAttempt, socket: { opened?: Promise<unknown> } | undefined, thrown?: unknown): void {
	if (thrown !== undefined && isSocketPolicyRefusal(thrown)) attempt.refused = true;
	const opened = socket?.opened;
	if (opened) attempt.settled = opened.then(() => {}, (e) => { if (isSocketPolicyRefusal(e)) attempt.refused = true; });
}

/** `connect`, recording each attempt. */
function watchConnect(connect: WakeConnect, attempts: SocketAttempt[]): WakeConnect {
	return (address, options) => {
		const attempt: SocketAttempt = { ip: address.hostname, refused: false };
		attempts.push(attempt);
		try {
			const socket = connect(address, options);
			noteSocket(attempt, socket);
			return socket;
		} catch (e) {
			noteSocket(attempt, undefined, e);
			throw e;
		}
	};
}

/**
 * True only when the single pinned socket for a named host was refused by the Workers socket policy, its
 * checked address is in Cloudflare's published ranges, and a fresh lookup is again all public Cloudflare
 * addresses. Anything else (another socket error, an IP literal, a mixed or private answer) keeps the failure.
 */
export async function edgeRetryAllowed(hostname: string, attempts: SocketAttempt[], thrown: unknown, lookup: AddressLookup, signal?: AbortSignal): Promise<boolean> {
	if (isIpLiteral(hostname) || attempts.length !== 1) return false;
	const attempt = attempts[0]!;
	if (attempt.settled) await Promise.race([attempt.settled, new Promise((r) => setTimeout(r, 0))]);
	if (!(attempt.refused || isSocketPolicyRefusal(thrown)) || !isCloudflareIp(attempt.ip)) return false;
	let ips: string[] | null;
	try { ips = await lookup(hostname, signal); } catch { return false; }
	return !!ips?.length && ips.every((ip) => isPublicIp(ip) && isCloudflareIp(ip));
}

function remainingSignal(deadline: number, outer?: AbortSignal | null): AbortSignal {
	const t = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
	return outer ? AbortSignal.any([outer, t]) : t;
}

function deadlineError(): Error {
	return new DOMException("The operation timed out.", "TimeoutError");
}

/**
 * The socket-policy retry inside the request's one deadline. The fresh lookup and the fetch share a signal bound to
 * what is left of it; neither starts once the deadline has passed. Not eligible: the original socket error is rethrown.
 */
async function edgeRetry(url: string, init: RequestInit, hostname: string, attempts: SocketAttempt[], thrown: unknown, deadline: number,
	edge: EdgeFetch, lookup?: AddressLookup, outer?: AbortSignal | null): Promise<Response> {
	if (Date.now() >= deadline || outer?.aborted) throw outer?.aborted ? thrown : deadlineError();
	const signal = remainingSignal(deadline, outer);
	const fresh: AddressLookup = lookup ?? ((host, s) => lookupAddresses(host, s, true));
	const allowed = await edgeRetryAllowed(hostname, attempts, thrown, fresh, signal);
	if (signal.aborted || Date.now() >= deadline) throw outer?.aborted ? thrown : deadlineError();
	if (!allowed) throw thrown;
	return await edge(url, { ...init, signal });
}

/** Read at most `max` body bytes; a longer body throws. The returned response is detached from the network. */
async function cappedResponse(res: Response, max: number): Promise<Response> {
	const headers = new Headers(res.headers);
	if (!res.body) return new Response(null, { status: res.status, headers });
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > max) throw new Error("response limit");
			chunks.push(next.value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
	return new Response(res.status === 204 || res.status === 304 ? null : body, { status: res.status, headers });
}

export type WakeDeps = {
	lookup?: AddressLookup;
	connect?: WakeConnect;
	deliver?: CheckedDeliver;
	/** Test seam: the per-request deadline in milliseconds (default 15 s). */
	timeoutMs?: number;
	/** Set only when the edge egress gate is on. Used for a host served only from Cloudflare addresses. */
	edge?: EdgeFetch;
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
export async function lookupAddresses(host: string, signal?: AbortSignal, fresh = false): Promise<string[] | null> {
	const ips: string[] = [];
	for (const type of ["A", "AAAA"]) {
		let body: { Status?: number; Answer?: { type?: number; data?: string }[] };
		try {
			const res = await fetch(`${DOH_URL}?name=${encodeURIComponent(host)}&type=${type}`, {
				headers: { accept: "application/dns-json" },
				redirect: "manual",
				signal,
				...(fresh ? { cache: "no-store" as const } : {}),
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

/** Thrown when a client metadata body is over its limit. */
export class MetadataTooLarge extends Error {}

/**
 * Client metadata GET over a socket to the checked IP, with SNI and certificate verification for the URL host
 * (the same in-process TLS as wake delivery; the runtime's startTls drops SNI on an IP socket, workerd#6903).
 * No redirects, no credentials, body capped at `max`. Each dial is recorded on `attempts`.
 */
export async function getPinnedMetadata(url: string, target: { ip: string; hostname: string }, max: number, timeoutMs: number, signal: AbortSignal,
	attempts: SocketAttempt[], connect?: WakeConnect): Promise<Response> {
	const client = new Client({
		connect: dialChecked(target.ip, watchConnect(connect ?? wakeNet.connect ?? await runtimeConnect(), attempts)),
		forceTunnel: true,
		maxRedirects: 0,
		maxBodyBytes: max,
		http2: false,
		keepAlive: false,
		timeouts: { totalMs: timeoutMs },
	});
	try {
		const res = await client.fetch(url, {
			method: "GET",
			headers: { accept: "application/json", "accept-encoding": "identity", "user-agent": "a2a-exposed (client metadata)" },
			redirect: "manual",
			signal,
		});
		return await peerResponseForCaller(res);
	} catch (e) {
		if (e instanceof LimitError) throw new MetadataTooLarge();
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
	deps: Pick<WakeDeps, "lookup" | "connect" | "deliver" | "edge" | "timeoutMs"> = {},
): Promise<{ response: Response; transport?: EgressTransport } | { refused: string }> {
	init.signal?.throwIfAborted();
	const checked = await checkedWakeAddresses(url, deps.lookup ?? ((host) => lookupAddresses(host, init.signal ?? undefined)));
	init.signal?.throwIfAborted();
	if ("refused" in checked) return checked;
	const target = { ip: checked.ips[0]!, hostname: checked.hostname };
	const nextInit: RequestInit = { ...init, redirect: "manual" };
	let transport: EgressTransport | undefined;
	let response: Response;
	if (deps.deliver) response = await deps.deliver(url, nextInit, target);
	else if (wakeNet.deliver) response = await wakeNet.deliver(url, nextInit, target);
	else {
		const attempts: SocketAttempt[] = [];
		const deadline = Date.now() + (deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
		try {
			response = await deliverPinnedPeer(url, nextInit, target, watchConnect(deps.connect ?? wakeNet.connect ?? await runtimeConnect(), attempts));
		} catch (e) {
			if (!deps.edge) throw e;
			response = await cappedResponse(await edgeRetry(url, nextInit, checked.hostname, attempts, e, deadline, deps.edge, deps.lookup, init.signal), 1 << 20);
			transport = "fetch_fallback";
		}
	}
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel().catch(() => {});
		return { refused: "redirects are not allowed" };
	}
	return { response, ...(transport ? { transport } : {}) };
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
): Promise<{ response: Response; transport?: EgressTransport } | { refused: string }> {
	const lookup = deps.lookup ?? lookupAddresses;
	let transport: EgressTransport | undefined;
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
		else {
			const attempts: SocketAttempt[] = [];
			const deadline = Date.now() + (deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
			try {
				res = await deliverPinned(current, nextInit, target, watchConnect(deps.connect ?? wakeNet.connect ?? await runtimeConnect(), attempts));
			} catch (e) {
				if (!deps.edge) throw e;
				res = await responseForCaller(await edgeRetry(current, nextInit, checked.hostname, attempts, e, deadline, deps.edge, deps.lookup));
				transport = "fetch_fallback";
			}
		}
		const location = res.headers.get("location");
		if (res.status < 300 || res.status >= 400 || !location) return { response: res, ...(transport ? { transport } : {}) };
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

/** Scrubbed single-attempt callback result. No destination or response is logged. */
export type CallbackResult = { ok: true; status: number; body: Uint8Array } | { ok: false; reason: "target" | "redirect" | "timeout" | "transport" | "response_limit" };
export const CALLBACK_TIMEOUT_MS = 10_000;
export const CALLBACK_RESPONSE_BYTES = 16_384;

/** Strict Events callback transport; DNS, TLS and bounded body share ONE deadline.
 * Never uses a native-fetch fallback, even when Workers socket egress is refused.
 */
export async function fetchCheckedCallback(url: string, init: RequestInit, deps: Pick<WakeDeps, "lookup" | "connect" | "deliver"> = {}): Promise<CallbackResult> {
 const deadline = Date.now() + CALLBACK_TIMEOUT_MS;
 let reason: "target" | "redirect" | "timeout" | "transport" | "response_limit" = "transport";
 try {
  if (url.length > 2000) return { ok: false, reason: "target" };
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || parsed.port && parsed.port !== "443") return { ok: false, reason: "target" };
  const payload = bodyBytes(init.body);
  if (payload.byteLength > 65536 || init.method && init.method.toUpperCase() !== "POST") return { ok: false, reason: "target" };
  const headers = new Headers(init.headers);
  for (const name of headers.keys()) if (!/^(content-type|accept|user-agent|x-mcp-subscription-id|webhook-(id|timestamp|signature)|x-a2a-(timestamp|signature))$/.test(name)) return { ok: false, reason: "target" };
  return await withDeadline(CALLBACK_TIMEOUT_MS, async signal => {
   const checked = await checkedWakeAddresses(url, deps.lookup ?? (host => lookupAddresses(host, signal)));
   signal.throwIfAborted();
   if ("refused" in checked) return { ok: false, reason: "target" } as CallbackResult;
   const target = { ip: checked.ips[0]!, hostname: checked.hostname };
   const request = { ...init, method: "POST", body: init.body ?? payload, headers, redirect: "manual" as const, signal };
   let client: Client | undefined;
   try {
    let res: Response;
    if (deps.deliver) res = await deps.deliver(url, request, target);
    else if (wakeNet.deliver) res = await wakeNet.deliver(url, request, target);
    else {
     const connect = deps.connect ?? wakeNet.connect ?? await runtimeConnect();
     signal.throwIfAborted();
     client = new Client({ connect: dialChecked(target.ip, connect), forceTunnel: true, maxRedirects: 0, maxBodyBytes: CALLBACK_RESPONSE_BYTES, http2: false, keepAlive: false, timeouts: { totalMs: Math.max(1, deadline - Date.now()) } });
     res = await client.fetch(url, { ...request, signal });
    }
    signal.throwIfAborted();
    if (res.status >= 300 && res.status < 400) { await res.body?.cancel(); return { ok: false, reason: "redirect" } as CallbackResult; }
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = res.body?.getReader();
    const cancel = () => { void reader?.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
     if (reader) while (true) {
      const part = await reader.read(); signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > CALLBACK_RESPONSE_BYTES) { reason = "response_limit"; throw new Error("response limit"); }
      chunks.push(part.value);
     }
    } finally { signal.removeEventListener("abort", cancel); await reader?.cancel().catch(() => {}); }
    const body = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return { ok: true, status: res.status, body } as CallbackResult;
   } finally { await client?.close().catch(() => {}); }
  }, init.signal ?? undefined);
 } catch { return { ok: false, reason: Date.now() >= deadline || init.signal?.aborted ? "timeout" : reason }; }
}
