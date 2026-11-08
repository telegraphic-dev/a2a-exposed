import { namespaceForRegion, type TenantContext, type DoNamespace, type DataRegion } from "./tenancy.ts";
import * as F from "./facade.ts";

export type HttpRelayProfile = "webhook" | "a2a";
export const httpRelayProfiles: readonly HttpRelayProfile[] = ["webhook", "a2a"];
export const isHttpRelayProfile = (value: unknown): value is HttpRelayProfile => value === "webhook" || value === "a2a";
const fail = (error: string, status: number) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
const forbiddenHeader = /^(?:host|content-length|cookie|set-cookie|location|via|connection|keep-alive|proxy-.*|transfer-encoding|te|trailer|upgrade|expect|origin|sec-.*|cf-.*|x-forwarded-.*|forwarded|x-a2a-.*|x-owner-.*)$/;
export function httpRelayHeaders(value: unknown): value is string[] {
	return Array.isArray(value) && value.length <= 16 && new Set(value).size === value.length && value.every(name => typeof name === "string" && /^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name) && !forbiddenHeader.test(name));
}
export function httpRelayEnrollment(value: unknown): value is { credentialHash: string; ingressHash: string; headers: string[] } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const b = value as Record<string, unknown>;
	return Object.keys(b).sort().join(",") === "credentialHash,headers,ingressHash" && typeof b.credentialHash === "string" && /^[a-f0-9]{64}$/.test(b.credentialHash) && typeof b.ingressHash === "string" && /^[a-f0-9]{64}$/.test(b.ingressHash) && b.credentialHash !== b.ingressHash && httpRelayHeaders(b.headers);
}
export function httpRelayObject(namespace: DoNamespace, mode: "host" | "single", tenantId: string, region: DataRegion, profile: HttpRelayProfile) {
	const ns = namespaceForRegion(namespace, region);
	return ns.get(ns.idFromName(`http-relay-v2:${mode}:${tenantId || "self"}:${profile}`));
}
export function httpRelayFetch(ctx: TenantContext, profile: HttpRelayProfile, path: "/enroll" | "/status" | "/disable" | "/connect" | "/forward", init?: RequestInit): Promise<Response> {
	if (!ctx.httpRelayNamespace) return Promise.resolve(fail("http_relay_disabled", 404));
	if (ctx.mode === "host" && ctx.httpRelayRegion === undefined) return Promise.resolve(fail("http_relay_region_unavailable", 503));
	const stub = httpRelayObject(ctx.httpRelayNamespace, ctx.mode, ctx.id, ctx.mode === "host" ? ctx.httpRelayRegion! : ctx.gates.dataRegion, profile);
	return stub.fetch(new Request(`https://http-relay.internal${path}`, { ...init, ...(init?.body instanceof ReadableStream ? { duplex: "half" } : {}) }), { signal: init?.signal });
}

async function capped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array> {
	if (!body) return new Uint8Array();
	const reader = body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
	try {
		for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > max) throw new Error("body_limit"); chunks.push(value); }
	} catch (e) { await reader.cancel().catch(() => {}); throw e; } finally { reader.releaseLock(); }
	const result = new Uint8Array(size); let at = 0; for (const chunk of chunks) { result.set(chunk, at); at += chunk.byteLength; } return result;
}
const rpcMethods = new Map([
	["SendMessage", "send"], ["message/send", "send"], ["GetTask", "get"], ["tasks/get", "get"], ["CancelTask", "cancel"], ["tasks/cancel", "cancel"], ["ListTasks", "list"],
	["SendStreamingMessage", "send"], ["message/stream", "send"], ["SubscribeToTask", "stream"], ["tasks/resubscribe", "stream"],
]);
export function httpRelayRpcAllowed(bytes: Uint8Array): boolean {
	try {
		const b = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
		if (!b || typeof b !== "object" || Array.isArray(b) || b.jsonrpc !== "2.0" || typeof b.method !== "string" || !rpcMethods.has(b.method)) return false;
		return !F.wantsPush(rpcMethods.get(b.method)!, b.params);
	} catch { return false; }
}

function modernScheme(s: F.Json): F.Json {
	if (!s || typeof s !== "object") return s;
	if (s.type === "http") { const { type: _type, ...rest } = s; return { httpAuthSecurityScheme: rest }; }
	if (s.type === "apiKey") { const { type: _type, ...rest } = s; return { apiKeySecurityScheme: rest }; }
	if (s.type === "oauth2") { const { type: _type, ...rest } = s; return { oauth2SecurityScheme: rest }; }
	if (s.type === "openIdConnect") { const { type: _type, ...rest } = s; return { openIdConnectSecurityScheme: rest }; }
	return s;
}
function legacyScheme(s: F.Json): F.Json {
	for (const [key, type] of [["httpAuthSecurityScheme", "http"], ["apiKeySecurityScheme", "apiKey"], ["oauth2SecurityScheme", "oauth2"], ["openIdConnectSecurityScheme", "openIdConnect"], ["mtlsSecurityScheme", "mutualTLS"]]) if (s?.[key]) return { type, ...s[key] };
	return s;
}
export function httpRelayCard(up: F.Json, publicBase: string, streaming: boolean, legacy = false): F.Json {
	if (!up || typeof up !== "object" || Array.isArray(up) || !F.upstreamJsonRpcVersions(up).length) throw new Error("invalid_card");
	const origins = [...new Set([...F.upstreamCardOrigins(up), "http://localhost", "http://127.0.0.1", "http://[::1]"])];
	const o = { publicBase, upstreamOrigins: origins };
	const schemes = Object.fromEntries(Object.entries(up.securitySchemes || {}).map(([name, scheme]) => [name, modernScheme(F.scrubDeep(scheme, o))]));
	let ingress = "relayIngress"; while (Object.hasOwn(schemes, ingress)) ingress += "_";
	schemes[ingress] = { apiKeySecurityScheme: { in: "header", name: "X-A2A-Relay-Authorization", description: "Bearer relay ingress token. Independent local application credentials and per-peer/task authorization are also required." } };
	const source = up.securityRequirements ?? up.security ?? [];
	if (!Array.isArray(source) || source.some((v: unknown) => !v || typeof v !== "object" || Array.isArray(v))) throw new Error("invalid_card");
	const requirements = (source.length ? source : [{}]).map((v: F.Json) => ({ ...F.scrubDeep(v, o), [ingress]: [] }));
	const card = F.facadeCard({ upstream: up, config: {}, publicBase, upstreamOrigins: origins, securitySchemes: schemes, securityRequirements: requirements, defaults: { description: "Native A2A application", skills: [] } });
	card.supportedInterfaces = F.upstreamJsonRpcVersions(up).map(version => ({ url: publicBase.replace(/\/$/, "") + "/", protocolBinding: "JSONRPC", protocolVersion: version }));
	card.capabilities.streaming = up.capabilities?.streaming === true && streaming;
	if (!legacy) return card;
	const { supportedInterfaces: _interfaces, securityRequirements: _requirements, ...rest } = card;
	return { ...rest, protocolVersion: "0.3.0", url: publicBase.replace(/\/$/, "") + "/", preferredTransport: "JSONRPC", additionalInterfaces: [{ url: publicBase.replace(/\/$/, "") + "/", transport: "JSONRPC" }], securitySchemes: Object.fromEntries(Object.entries(schemes).map(([name, scheme]) => [name, legacyScheme(scheme)])), security: requirements, supportsAuthenticatedExtendedCard: false, skills: card.skills.map((skill: F.Json) => ({ ...skill, tags: Array.isArray(skill.tags) ? skill.tags : [] })) };
}

export async function routeHttpRelay(req: Request, ctx: TenantContext): Promise<Response | null> {
	const url = new URL(req.url); const path = url.pathname;
	const connect = /^\/relay\/http\/(webhook|a2a)\/connect$/.exec(path);
	const card = path === "/relay/a2a/.well-known/agent-card.json" || path === "/relay/a2a/.well-known/agent.json";
	const webhook = path === "/relay/webhook";
	const rpc = path === "/relay/a2a" || path === "/relay/a2a/";
	if (!connect && !card && !webhook && !rpc) return null;
	if (!ctx.httpRelayNamespace) return fail("http_relay_disabled", 404);
	if (url.search) return fail("invalid_relay_request", 400);
	if (connect) {
		if (req.method !== "GET" || req.headers.has("origin")) return fail("invalid_relay_upgrade", 400);
		return httpRelayFetch(ctx, connect[1] as HttpRelayProfile, "/connect", { method: "GET", headers: req.headers });
	}
	if (req.method !== (card ? "GET" : "POST")) return fail("method_not_allowed", 405);
	if (!/^Bearer a2ai_[A-Za-z0-9_-]{43}$/.test(req.headers.get("x-a2a-relay-authorization") || "")) return fail("unauthorized", 401);
	const headers = new Headers(req.headers);
	for (const name of Array.from(headers.keys())) if (/^x-a2a-/i.test(name) && name !== "x-a2a-relay-authorization") headers.delete(name);
	headers.set("x-a2a-relay-target", card ? "card" : rpc ? "rpc" : "webhook");
	headers.set("x-a2a-relay-method", card ? "GET" : "POST");
	try {
		const response = await httpRelayFetch(ctx, webhook ? "webhook" : "a2a", "/forward", { method: "POST", headers, body: card ? null : req.body, signal: req.signal });
		if (!card || !response.ok) return response;
		const bytes = await capped(response.body, 256 * 1024);
		const status = await httpRelayFetch(ctx, "a2a", "/status");
		const ready = await status.json() as { connected?: boolean; capabilities?: string[] };
		const rewritten = httpRelayCard(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)), ctx.PUBLIC_URL.replace(/\/$/, "") + "/relay/a2a", ready.connected === true && ready.capabilities?.includes("response-stream-v1") === true, path.endsWith("/agent.json"));
		return Response.json(rewritten, { headers: { "cache-control": "no-store" } });
	} catch { return fail("http_relay_unavailable", 502); }
}
