// Narrow wake carrier, not an HTTP tunnel. Only the resolved tenant can reach control/dispatch.
import { DurableObject } from "cloudflare:workers";
import { timingSafeEqualStr } from "./a2a.ts";

export const WAKE_RELAY_PROTOCOL_VERSION = 1;
const MAX_FRAME = 128 * 1024;
const MAX_BODY = 64 * 1024;
const MAX_INFLIGHT = 4;
const DEADLINE_MS = 10000;
type State = { hash: string | null; generation: number; enrollment: number; idem: string | null; active: number };
type Pending = { socket: WebSocket; generation: number; finish: (r: Response) => void };
const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const failure = (code: string, status = 503) => reply({ error: code }, status);
async function hash(token: string): Promise<string> {
	return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))), b => b.toString(16).padStart(2, "0")).join("");
}

export class WakeRelay extends DurableObject {
	pending = new Map<string, Pending>();
	constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
		super(ctx, env);
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS relay (id INTEGER PRIMARY KEY CHECK(id=1), hash TEXT, generation INTEGER NOT NULL, enrollment INTEGER NOT NULL, idem TEXT, active INTEGER NOT NULL)");
		ctx.storage.sql.exec("INSERT OR IGNORE INTO relay VALUES (1, NULL, 0, 0, NULL, 1)");
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}
	state(): State { return this.ctx.storage.sql.exec<State>("SELECT hash, generation, enrollment, idem, active FROM relay WHERE id=1").one(); }
	fence(): void {
		for (const ws of this.ctx.getWebSockets()) { try { ws.close(4001, "connector replaced or revoked"); } catch { /* closed */ } }
		for (const p of this.pending.values()) p.finish(failure("delivery_uncertain", 502));
	}
	async fetch(req: Request): Promise<Response> {
		const path = new URL(req.url).pathname;
		if (path === "/issue" && req.method === "POST") {
			const input = await req.json() as { credentialHash?: string; idempotencyKey?: string };
			if (!/^[a-f0-9]{64}$/.test(input.credentialHash || "") || !/^[a-zA-Z0-9_-]{16,128}$/.test(input.idempotencyKey || "")) return failure("invalid_enrollment", 400);
			const s = this.state();
			if (!s.active) return failure("relay_inactive", 409);
			const idem = await hash(input.idempotencyKey!);
			// Recheck after digest yields: revocation/suspension must win.
			const current = this.state();
			if (!current.active || current.generation !== s.generation) return failure("conflict", 409);
			if (current.idem === idem) return current.hash === input.credentialHash ? reply({ connectorId: "default", generation: current.enrollment, protocolVersion: 1 }) : failure("conflict", 409);
			this.ctx.storage.sql.exec("UPDATE relay SET hash=?, idem=?, enrollment=enrollment+1, generation=generation+1 WHERE id=1", input.credentialHash!, idem);
			this.fence();
			return reply({ connectorId: "default", generation: this.state().enrollment, protocolVersion: 1 });
		}
		if ((path === "/disable" || path === "/enable") && req.method === "POST") {
			this.ctx.storage.sql.exec("UPDATE relay SET hash=NULL, idem=NULL, active=?, enrollment=enrollment+1, generation=generation+1 WHERE id=1", path === "/enable" ? 1 : 0); this.fence(); return reply({ ok: true });
		}
		if (path === "/revoke" && req.method === "POST") {
			const input = await req.json() as { generation?: number };
			if (input.generation !== this.state().enrollment) return failure("conflict", 409);
			this.ctx.storage.sql.exec("UPDATE relay SET hash=NULL, idem=NULL, enrollment=enrollment+1, generation=generation+1 WHERE id=1"); this.fence(); return reply({ revoked: true, generation: this.state().enrollment });
		}
		if (path === "/status" && req.method === "GET") {
			const s = this.state();
			return reply({ enabled: true, protocolVersion: WAKE_RELAY_PROTOCOL_VERSION, transport: "relay", connectorId: "default", enrolled: !!s.hash, generation: s.enrollment, connectionGeneration: s.generation, connected: this.ctx.getWebSockets().some(ws => ws.readyState === 1 && ws.deserializeAttachment()?.generation === s.generation) });
		}
		if (path === "/connect" && req.method === "GET") {
			const protocols = (req.headers.get("sec-websocket-protocol") || "").split(",").map(s => s.trim());
			if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return failure("websocket_required", 426);
			if (protocols.length !== 2 || protocols[0] !== "a2a-wake-v1" || !/^a2ar_[A-Za-z0-9_-]{43}$/.test(protocols[1])) return failure("unauthorized", 401);
			const digest = await hash(protocols[1]);
			if (!this.state().active || !timingSafeEqualStr(this.state().hash || "0".repeat(64), digest)) return failure("unauthorized", 401);
			this.ctx.storage.sql.exec("UPDATE relay SET generation=generation+1 WHERE id=1"); this.fence();
			const generation = this.state().generation;
			const pair = new WebSocketPair();
			this.ctx.acceptWebSocket(pair[1]); pair[1].serializeAttachment({ generation });
			pair[1].send(JSON.stringify({ v: 1, type: "hello", generation }));
			return new Response(null, { status: 101, webSocket: pair[0], headers: { "sec-websocket-protocol": "a2a-wake-v1" } });
		}
		if (path === "/deliver" && req.method === "POST") {
			const raw = await req.text();
			if (new TextEncoder().encode(raw).length > MAX_FRAME) return failure("body_too_large", 413);
			const { body, headers, enrollment } = JSON.parse(raw);
			// Select authority only after body parsing yields; rotation/revocation must win.
			const s = this.state();
			if (enrollment !== undefined && enrollment !== s.enrollment) return failure("stale_enrollment", 409);
			const ws = this.ctx.getWebSockets().find(w => w.readyState === 1 && w.deserializeAttachment()?.generation === s.generation);
			if (!s.hash || !ws) return failure("connector_offline");
			if (this.pending.size >= MAX_INFLIGHT) return failure("connector_busy");
			if (typeof body !== "string" || new TextEncoder().encode(body).length > MAX_BODY) return failure("body_too_large", 413);
			// No await between selecting authority and sending after body parsing.
			if (this.state().generation !== s.generation) return failure("connector_offline");
			if (this.pending.size >= MAX_INFLIGHT) return failure("connector_busy");
			const id = crypto.randomUUID(), deadline = Date.now() + DEADLINE_MS;
			return new Promise(resolve => {
				const timer = setTimeout(() => {
					try { ws.send(JSON.stringify({ v: 1, type: "cancel", id, generation: s.generation })); } catch { /* disconnected */ }
					finish(failure("delivery_uncertain", 504));
				}, DEADLINE_MS);
				const finish = (response: Response) => { clearTimeout(timer); this.pending.delete(id); resolve(response); };
				this.pending.set(id, { socket: ws, generation: s.generation, finish });
				try { ws.send(JSON.stringify({ v: 1, type: "wake", id, generation: s.generation, deadline, body, headers })); }
				catch { finish(failure("delivery_uncertain", 502)); }
			});
		}
		return failure("not_found", 404);
	}
	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
		const generation = ws.deserializeAttachment()?.generation;
		if (generation !== this.state().generation) { ws.close(4001, "stale generation"); return; }
		try {
			if (typeof message !== "string" || new TextEncoder().encode(message).length > 1024) throw new Error();
			const m = JSON.parse(message);
			if (!m || Object.keys(m).sort().join(",") !== "generation,id,status,type,v" || m.v !== 1 || m.type !== "result" || m.generation !== generation || typeof m.id !== "string" || !/^[0-9a-f-]{36}$/.test(m.id) || !Number.isInteger(m.status) || (m.status !== 0 && (m.status < 200 || m.status > 599))) throw new Error();
			const p = this.pending.get(m.id);
			if (p?.socket === ws && p.generation === generation) p.finish(m.status ? reply({ status: m.status }) : failure("delivery_uncertain", 502));
		} catch { ws.close(1008, "invalid relay frame"); this.cleanup(ws); }
	}
	cleanup(ws: WebSocket): void { for (const p of this.pending.values()) if (p.socket === ws) p.finish(failure("delivery_uncertain", 502)); }
	webSocketClose(ws: WebSocket): void { this.cleanup(ws); }
	webSocketError(ws: WebSocket): void { this.cleanup(ws); }
}
