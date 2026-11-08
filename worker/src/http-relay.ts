/**
 * Isolated HTTP relay v2. Private API: POST /enroll {credentialHash,ingressHash,
 * headers,profile}; GET /status; POST /disable; GET /connect; POST /forward
 * (X-A2A-Relay-Target webhook|rpc|card, X-A2A-Relay-Method POST|GET).
 *
 * Exact JSON wire frames (no extra keys), all include v:2 and generation:
 * S>C hello {type,profile,capabilities}; C>S ready {type,profile,capabilities}.
 * S>C request {type,id,target,method,headers:[name,value][],body:base64,timeoutMs,deadline}.
 * deadline is an absolute epoch-ms fence; timeoutMs also bounds local execution.
 * C>S start {type,id,status,headers}; C>S chunk {type,id,seq,body:base64};
 * C>S end {type,id,seq}; C>S error {type,id,code:'local_failure'|'timeout'}.
 * S>C credit {type,id,seq} grants EXACTLY one <=16KiB chunk (seq starts 0).
 * S>C cancel {type,id}. end uses next seq, requires no credit. Credit is issued
 * only by response ReadableStream.pull, with zero prefetch. At most one chunk
 * is in flight per response. ping/pong are transport keepalive strings.
 * Requests are never persisted/replayed. Hibernated sockets retain generation,
 * profile and negotiated capabilities; any orphaned response fences the socket.
 */
import { DurableObject } from "cloudflare:workers";
import { timingSafeEqualStr } from "./a2a.ts";

export type HttpRelayProfile = "webhook" | "a2a";
export type HttpRelayTarget = "webhook" | "rpc" | "card";
export type HttpRelayHeaders = [string, string][];
export const httpRelayLimits = Object.freeze({ maxInflight: 4, requestBytes: 256 * 1024, chunkBytes: 16 * 1024, responseBytes: 1024 * 1024, frameBytes: 384 * 1024, headerBytes: 16 * 1024, headerMs: 10000, streamMs: 60000 });
export const HTTP_RELAY_PROTOCOL = "a2a-http-relay-v2";
export const HTTP_RELAY_CAPABILITIES = ["http-response-v1", "response-stream-v1"];
type State = { credentialHash: string | null; ingressHash: string | null; generation: number; profile: HttpRelayProfile | null; headers: string[]; enabled: boolean };
type Attachment = { generation: number; profile: HttpRelayProfile; capabilities: string[]; ready: boolean };
type Pending = { ws: WebSocket; generation: number; seq: number; credit: boolean; bytes: number; started: boolean; noBody: boolean; controller?: ReadableStreamDefaultController<Uint8Array>; resolve: (response: Response) => void; headerTimer: ReturnType<typeof setTimeout>; timer: ReturnType<typeof setTimeout>; detach: () => void };
const enc = new TextEncoder();
const fail = (error: string, status = 503) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
const validProfile = (p: unknown): p is HttpRelayProfile => p === "webhook" || p === "a2a";
const keys = (m: Record<string, unknown>, wanted: string) => Object.keys(m).sort().join(",") === wanted.split(",").sort().join(",");
export function httpRelayHeaderAllowed(name: string): boolean {
	return /^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name) && !/^(?:host|connection|upgrade|keep-alive|te|trailer|transfer-encoding|content-length|expect|origin|cookie|set-cookie|location|forwarded|via|proxy-.*|sec-.*|cf-.*|x-forwarded-.*|x-a2a-.*|x-owner-.*)$/i.test(name);
}
export function httpRelayHeaderValueValid(value: unknown): value is string {
	return typeof value === "string" && value.length <= 8192 && !/[^\t\x20-\x7e\x80-\xff]/.test(value);
}
function headerPairs(value: unknown): value is HttpRelayHeaders {
	return Array.isArray(value) && value.length <= 64 && value.every(p => Array.isArray(p) && p.length === 2 && typeof p[0] === "string" && httpRelayHeaderAllowed(p[0]) && httpRelayHeaderValueValid(p[1])) && value.reduce((n, p) => n + p[0].length + p[1].length, 0) <= httpRelayLimits.headerBytes;
}
function filteredHeaders(headers: Headers, allow?: string[]): HttpRelayHeaders {
	const nominated = new Set((headers.get("connection") || "").toLowerCase().split(",").map(s => s.trim()));
	return [...headers].filter(([k]) => httpRelayHeaderAllowed(k) && !nominated.has(k) && (!allow || allow.includes(k)));
}
async function digest(token: string): Promise<string> {
	return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(token))), b => b.toString(16).padStart(2, "0")).join("");
}
function encode(bytes: Uint8Array): string {
	let value = "";
	for (let n = 0; n < bytes.length; n += 8192) value += String.fromCharCode(...bytes.subarray(n, n + 8192));
	return btoa(value);
}
function decode(value: unknown, limit: number): Uint8Array {
	if (typeof value !== "string" || value.length > Math.ceil(limit / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("invalid body");
	const raw = atob(value); const out = Uint8Array.from(raw, c => c.charCodeAt(0));
	if (out.length > limit || encode(out) !== value) throw new Error("invalid body");
	return out;
}
async function readBody(req: Request): Promise<Uint8Array> {
	const reader = req.body?.getReader(); if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = []; let size = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new Error("timeout")); }, httpRelayLimits.headerMs); });
	try {
		while (true) {
			const { value, done } = await Promise.race([reader.read(), timeout]); if (done) break;
			size += value.length; if (size > httpRelayLimits.requestBytes) { void reader.cancel().catch(() => {}); throw new Error("size"); } chunks.push(value);
		}
		const result = new Uint8Array(size); let offset = 0;
		for (const c of chunks) { result.set(c, offset); offset += c.length; } return result;
	} finally { if (timer !== undefined) clearTimeout(timer); reader.releaseLock(); }
}
export class HttpRelay extends DurableObject {
	pending = new Map<string, Pending>();
	// Only tolerate bounded late frames for requests explicitly cancelled on this socket.
	cancelled = new Map<string, WebSocket>();
	reading = 0;
	constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
		super(ctx, env);
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS http_relay (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL)");
		ctx.storage.sql.exec("INSERT OR IGNORE INTO http_relay VALUES (1, ?)", JSON.stringify({ credentialHash: null, ingressHash: null, generation: 0, profile: null, headers: [], enabled: false }));
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}
	state(): State { return JSON.parse(this.ctx.storage.sql.exec<{ state: string }>("SELECT state FROM http_relay WHERE id=1").one().state); }
	save(s: State): void { this.ctx.storage.sql.exec("UPDATE http_relay SET state=? WHERE id=1", JSON.stringify(s)); }
	socket(s = this.state()): WebSocket | undefined { return this.ctx.getWebSockets().find(ws => { const a = ws.deserializeAttachment() as Attachment | null; return ws.readyState === 1 && a?.generation === s.generation && a.profile === s.profile && a.ready; }); }
	status(): Record<string, unknown> { const s = this.state(); return { enabled: s.enabled, enrolled: !!s.credentialHash, connected: !!this.socket(s), generation: s.generation, profile: s.profile, capabilities: this.socket(s) ? HTTP_RELAY_CAPABILITIES : [], headers: s.headers, protocolVersion: 2 }; }
	send(ws: WebSocket, generation: number, frame: Record<string, unknown>): void { ws.send(JSON.stringify({ v: 2, generation, ...frame })); }
	settle(id: string, error?: string, status = 502, cancel = false): void {
		const p = this.pending.get(id); if (!p) return;
		this.pending.delete(id); clearTimeout(p.timer); clearTimeout(p.headerTimer); p.detach();
		if (cancel) {
			this.cancelled.set(id, p.ws); if (this.cancelled.size > 64) this.cancelled.delete(this.cancelled.keys().next().value!);
			try { this.send(p.ws, p.generation, { type: "cancel", id }); } catch { /* uncertain */ }
		}
		if (error) { if (p.started) p.controller?.error(new Error(error)); else p.resolve(fail(error, status)); }
		else p.controller?.close();
	}
	fence(): void {
		for (const id of this.pending.keys()) this.settle(id, "delivery_uncertain", 502, true);
		for (const ws of this.ctx.getWebSockets()) { try { ws.close(4001, "connector replaced or revoked"); } catch { /* closed */ } }
		this.cancelled.clear();
	}
	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url), path = url.pathname;
		if (url.search) return fail("invalid_request", 400);
		if (path === "/enroll" && req.method === "POST") {
			let input; try { input = JSON.parse(new TextDecoder().decode(await readBody(req))); } catch { return fail("invalid_enrollment", 400); }
			if (!input || !keys(input, "credentialHash,ingressHash,headers,profile") || !validProfile(input.profile) || typeof input.credentialHash !== "string" || typeof input.ingressHash !== "string" || !/^[a-f0-9]{64}$/.test(input.credentialHash) || !/^[a-f0-9]{64}$/.test(input.ingressHash) || input.credentialHash === input.ingressHash || !Array.isArray(input.headers) || input.headers.length > 16 || new Set(input.headers).size !== input.headers.length || !input.headers.every((h: unknown) => typeof h === "string" && httpRelayHeaderAllowed(h))) return fail("invalid_enrollment", 400);
			const old = this.state(); if (old.profile && old.profile !== input.profile) return fail("profile_conflict", 409);
			this.save({ ...input, generation: old.generation + 1, enabled: true }); this.fence(); return Response.json({ ok: true, ...this.status() });
		}
		if (path === "/disable" && req.method === "POST") {
			const s = this.state(); this.save({ ...s, enabled: false, credentialHash: null, ingressHash: null, generation: s.generation + 1 }); this.fence(); return Response.json({ ok: true, ...this.status() });
		}
		if (path === "/status" && req.method === "GET") return Response.json(this.status());
		if (path === "/connect" && req.method === "GET") {
			const protocols = (req.headers.get("sec-websocket-protocol") || "").split(",").map(s => s.trim());
			if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return fail("websocket_required", 426);
			if (req.headers.has("origin")) return fail("invalid_upgrade", 400);
			if (req.headers.has("authorization") || protocols.length !== 2 || protocols[0] !== HTTP_RELAY_PROTOCOL || !/^a2ah_[A-Za-z0-9_-]{43}$/.test(protocols[1])) return fail("unauthorized", 401);
			const hash = await digest(protocols[1]); const s = this.state();
			if (!s.enabled || !s.profile || !timingSafeEqualStr(s.credentialHash || "0".repeat(64), hash)) return fail("unauthorized", 401);
			this.save({ ...s, generation: s.generation + 1 }); this.fence();
			const pair = new WebSocketPair(), generation = s.generation + 1;
			this.ctx.acceptWebSocket(pair[1]); pair[1].serializeAttachment({ generation, profile: s.profile, capabilities: HTTP_RELAY_CAPABILITIES, ready: false });
			this.send(pair[1], generation, { type: "hello", profile: s.profile, capabilities: HTTP_RELAY_CAPABILITIES });
			return new Response(null, { status: 101, webSocket: pair[0], headers: { "sec-websocket-protocol": HTTP_RELAY_PROTOCOL } });
		}
		if (path === "/forward" && req.method === "POST") {
			const auth = req.headers.get("x-a2a-relay-authorization") || "";
			if (!/^Bearer a2ai_[A-Za-z0-9_-]{43}$/.test(auth)) return fail("unauthorized", 401);
			const hash = await digest(auth.slice(7)), s = this.state();
			if (!s.enabled || !timingSafeEqualStr(s.ingressHash || "0".repeat(64), hash)) return fail("unauthorized", 401);
			const target = req.headers.get("x-a2a-relay-target"), method = req.headers.get("x-a2a-relay-method");
			if (!(s.profile === "webhook" ? target === "webhook" && method === "POST" : (target === "rpc" && method === "POST") || (target === "card" && method === "GET"))) return fail("invalid_target", 400);
			const ws = this.socket(s); if (!ws) return fail("connector_offline");
			if (this.pending.size + this.reading >= httpRelayLimits.maxInflight) return fail("connector_busy");
			const headers = filteredHeaders(req.headers, s.headers); if (!headerPairs(headers)) return fail("invalid_headers", 400);
			this.reading++; let body;
			try { body = await readBody(req); } catch (e) { return fail((e as Error).message === "size" ? "body_too_large" : "request_timeout", (e as Error).message === "size" ? 413 : 504); } finally { this.reading--; }
			if (req.signal.aborted || this.state().generation !== s.generation || this.socket() !== ws) return fail("delivery_uncertain", 502);
			if (target === "card" && body.length) return fail("invalid_body", 400);
			const id = crypto.randomUUID();
			return new Promise<Response>(resolve => {
				const abort = () => this.settle(id, "request_cancelled", 502, true);
				const p: Pending = { ws, generation: s.generation, seq: 0, credit: false, bytes: 0, started: false, noBody: false, resolve, detach: () => req.signal.removeEventListener("abort", abort), headerTimer: setTimeout(() => this.settle(id, "delivery_timeout", 504, true), httpRelayLimits.headerMs), timer: setTimeout(() => this.settle(id, "delivery_timeout", 504, true), httpRelayLimits.streamMs) };
				this.pending.set(id, p); req.signal.addEventListener("abort", abort, { once: true });
				try { this.send(ws, s.generation, { type: "request", id, target, method, headers, body: encode(body), timeoutMs: httpRelayLimits.streamMs, deadline: Date.now() + httpRelayLimits.streamMs }); } catch { this.settle(id, "delivery_uncertain"); }
			});
		}
		return fail("not_found", 404);
	}
	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
		try {
			const a = ws.deserializeAttachment() as Attachment;
			if (!a || a.generation !== this.state().generation) { ws.close(4001, "stale generation"); this.cleanup(ws); return; }
			if (typeof message !== "string" || enc.encode(message).length > httpRelayLimits.frameBytes) throw new Error();
			const m = JSON.parse(message);
			if (!m || m.v !== 2 || m.generation !== a.generation) throw new Error();
			if (!a.ready && m.type === "ready" && keys(m, "v,type,generation,profile,capabilities") && m.profile === a.profile && JSON.stringify(m.capabilities) === JSON.stringify(HTTP_RELAY_CAPABILITIES)) { ws.serializeAttachment({ ...a, ready: true }); return; }
			if (!a.ready || typeof m.id !== "string" || !/^[0-9a-f-]{36}$/.test(m.id)) throw new Error();
			const p = this.pending.get(m.id);
			if (!p) { if (this.cancelled.get(m.id) === ws && ["start", "chunk", "end", "error"].includes(m.type)) return; throw new Error(); }
			if (p.ws !== ws || p.generation !== a.generation) throw new Error();
			if (m.type === "start" && keys(m, "v,type,generation,id,status,headers") && !p.started && Number.isInteger(m.status) && m.status >= 200 && m.status <= 599 && !(m.status >= 300 && m.status < 400) && headerPairs(m.headers)) {
				clearTimeout(p.headerTimer); p.started = true; p.noBody = m.status === 204 || m.status === 205;
				const stream = new ReadableStream<Uint8Array>({
					start: c => { p.controller = c; },
					pull: () => { if (!this.pending.has(m.id) || p.credit) return; p.credit = true; try { this.send(ws, p.generation, { type: "credit", id: m.id, seq: p.seq }); } catch { this.settle(m.id, "delivery_uncertain"); } },
					cancel: () => this.settle(m.id, "request_cancelled", 502, true),
				}, { highWaterMark: 0 });
				p.resolve(new Response(p.noBody ? null : stream, { status: m.status, headers: m.headers, encodeBody: "manual" })); return;
			}
			if (m.type === "chunk" && keys(m, "v,type,generation,id,seq,body") && p.started && !p.noBody && p.credit && m.seq === p.seq) {
				const body = decode(m.body, httpRelayLimits.chunkBytes); if (!body.length || p.bytes + body.length > httpRelayLimits.responseBytes) throw new Error();
				p.bytes += body.length; p.seq++; p.credit = false; p.controller!.enqueue(body); return;
			}
			if (m.type === "end" && keys(m, "v,type,generation,id,seq") && p.started && m.seq === p.seq) { this.settle(m.id); return; }
			if (m.type === "error" && keys(m, "v,type,generation,id,code") && ["local_failure", "timeout"].includes(m.code)) { this.settle(m.id, m.code === "timeout" ? "delivery_timeout" : "delivery_uncertain", m.code === "timeout" ? 504 : 502); return; }
			throw new Error();
		} catch { try { ws.close(4008, "invalid relay frame"); } catch { /* closed */ } this.cleanup(ws); }
	}
	cleanup(ws: WebSocket): void { for (const [id, p] of this.pending) if (p.ws === ws) this.settle(id, "delivery_uncertain"); for (const [id, socket] of this.cancelled) if (socket === ws) this.cancelled.delete(id); }
	webSocketClose(ws: WebSocket): void { this.cleanup(ws); }
	webSocketError(ws: WebSocket): void { this.cleanup(ws); }
}
