import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { httpRelayCard } from "../src/http-relay-routing.ts";
import { AgentCard as SDKAgentCard } from "@a2a-js/sdk";

const base = "https://agent.example.com/relay/a2a";
const modern = {
	name: "Native agent", description: "Native service", version: "1",
	supportedInterfaces: [{ url: "http://127.0.0.1:8123/rpc", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
	securitySchemes: { app: { httpAuthSecurityScheme: { scheme: "bearer" } } },
	securityRequirements: [{ schemes: { app: { list: ["tasks:own"] } } }],
	capabilities: { streaming: true }, skills: [],
};
// A2A 1.0 specification/a2a.proto: SecurityRequirement.schemes maps to StringList;
// APIKeySecurityScheme uses location. A2A 0.3 uses flat security maps and in.
// Keep these assertions independent of the existing flat-map card fixtures.
test("security: real 1.0 requirements include ingress INSIDE schemes with StringList scopes", () => {
	const card = httpRelayCard(modern, base, true);
	assert.deepEqual(SDKAgentCard.fromJSON(card).securityRequirements, [{ schemes: { app: { list: ["tasks:own"] }, relayIngress: { list: [] } } }]);
	assert.deepEqual(card.securityRequirements, [{ schemes: { app: { list: ["tasks:own"] }, relayIngress: { list: [] } } }]);
});

test("security: a 0.3 upstream becomes real 1.0 requirements on modern discovery", () => {
	const { supportedInterfaces: _interfaces, securityRequirements: _requirements, ...rest } = modern;
	const card = httpRelayCard({ ...rest, protocolVersion: "0.3.0", url: "http://127.0.0.1:8123/rpc", security: [{ app: ["tasks:own"] }] }, base, true);
	assert.deepEqual(SDKAgentCard.fromJSON(card).securityRequirements, [{ schemes: { app: { list: ["tasks:own"] }, relayIngress: { list: [] } } }]);
	assert.deepEqual(card.securityRequirements, [{ schemes: { app: { list: ["tasks:own"] }, relayIngress: { list: [] } } }]);
});

test("security: 0.3 discovery flattens 1.0 scopes for a dual-version upstream", () => {
	const card = httpRelayCard({ ...modern, supportedInterfaces: [...modern.supportedInterfaces, { ...modern.supportedInterfaces[0], protocolVersion: "0.3" }] }, base, true, true);
	assert.deepEqual(card.security, [{ app: ["tasks:own"], relayIngress: [] }]);
	assert.equal(card.securityRequirements, undefined);
});

test("security: ingress and upstream API keys use the selected card version's location field", () => {
	const card = httpRelayCard({ ...modern, securitySchemes: { localKey: { type: "apiKey", in: "header", name: "X-App-Key" } }, securityRequirements: [{ schemes: { localKey: { list: [] } } }] }, base, true);
	const decoded = SDKAgentCard.fromJSON(card).securitySchemes.localKey.scheme;
	assert.equal(decoded?.$case, "apiKeySecurityScheme");
	if (decoded?.$case === "apiKeySecurityScheme") assert.equal(decoded.value.location, "header");
	assert.deepEqual(card.securitySchemes.localKey, { apiKeySecurityScheme: { location: "header", name: "X-App-Key" } });
	assert.equal(card.securitySchemes.relayIngress.apiKeySecurityScheme.location, "header");
	assert.equal(card.securitySchemes.relayIngress.apiKeySecurityScheme.in, undefined);
});

test("security: official 1.0 decoder retains the mandatory ingress key header location", () => {
	const card = httpRelayCard(modern, base, true);
	const decoded = SDKAgentCard.fromJSON(card).securitySchemes.relayIngress.scheme;
	assert.equal(decoded?.$case, "apiKeySecurityScheme");
	if (decoded?.$case === "apiKeySecurityScheme") assert.equal(decoded.value.location, "header");
});

test("security: real 1.0 API key location becomes legacy in on dual-version discovery", () => {
	const card = httpRelayCard({ ...modern, supportedInterfaces: [...modern.supportedInterfaces, { ...modern.supportedInterfaces[0], protocolVersion: "0.3" }], securitySchemes: { app: { apiKeySecurityScheme: { location: "header", name: "X-App-Key" } } } }, base, true, true);
	assert.deepEqual(card.securitySchemes.app, { type: "apiKey", in: "header", name: "X-App-Key" });
	assert.equal(card.securitySchemes.relayIngress.in, "header");
});

test("security: discovery cannot invent 0.3 support for a raw 1.0-only endpoint", () => {
	assert.throws(() => httpRelayCard(modern, base, true, true), /unsupported|invalid_card/);
});

test("security: scrubbing colliding local scheme identifiers preserves both AND requirements", () => {
	const card = httpRelayCard({ ...modern,
		securitySchemes: { localhost: { httpAuthSecurityScheme: { scheme: "bearer" } }, "127.0.0.1": { apiKeySecurityScheme: { location: "header", name: "X-Second-Factor" } } },
		securityRequirements: [{ schemes: { localhost: { list: [] }, "127.0.0.1": { list: [] } } }],
	}, base, true);
	assert.equal(Object.keys(card.securitySchemes).length, 3, "both local schemes plus ingress must survive, not overwrite each other");
	assert.equal(Object.keys(card.securityRequirements[0].schemes).length, 3);
	assert.doesNotMatch(JSON.stringify(card), /localhost|127\.0\.0\.1/);
});

test("security: IPv6 endpoints are scrubbed and streaming/push capabilities remain truthful", () => {
	const card = httpRelayCard({ ...modern, description: "Use http://[::1]:8123/rpc or [::1]:8123", supportedInterfaces: [{ ...modern.supportedInterfaces[0], url: "http://[::1]:8123/rpc" }], capabilities: { streaming: true, pushNotifications: true, extendedAgentCard: true }, signatures: [{ signature: "must-not-survive" }] }, base, false);
	assert.deepEqual(card.supportedInterfaces, [{ url: base + "/", protocolBinding: "JSONRPC", protocolVersion: "1.0" }]);
	assert.doesNotMatch(JSON.stringify(card), /\[::1\]|127\.0\.0\.1|localhost|must-not-survive/);
	assert.equal(card.capabilities.streaming, false);
	assert.equal(card.capabilities.pushNotifications, false);
	assert.equal(card.capabilities.extendedAgentCard, false);
});

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const connector = "a2ah_" + "c".repeat(43), ingress = "a2ai_" + "i".repeat(43);
async function relayRuntime() {
	// Real HttpRelay DO in workerd; no production owner/tenant-routing substitution claimed.
	const built = await build({ stdin: { contents: "export { HttpRelay } from './src/http-relay.ts'; export default { fetch() { return new Response(null, {status:404}); } };", resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "neutral", external: ["cloudflare:*"] });
	return new Miniflare(convertV4MiniflareOptions({ name: "http-relay-security", modules: true, script: built.outputFiles[0].text, compatibilityDate: "2026-10-06", durableObjects: { HTTP_RELAY: { className: "HttpRelay", useSQLite: true } } }));
}

test("security: DO revocation CAS refuses stale generations without erasing rotated authority", { timeout: 30000 }, async () => {
	const mf = await relayRuntime();
	try {
		const ns = await mf.getDurableObjectNamespace("HTTP_RELAY"), stub = ns.get(ns.idFromName("cas"));
		const call = (path: string, body?: unknown) => stub.fetch("https://http-relay.internal" + path, { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		const enrollment = { credentialHash: hash(connector), ingressHash: hash(ingress), headers: ["authorization", "content-type"], profile: "a2a" };
		const first = await (await call("/enroll", enrollment)).json() as any;
		const rotated = await (await call("/enroll", { ...enrollment, ingressHash: hash("different ingress") })).json() as any;
		assert.ok(rotated.generation > first.generation);
		assert.equal((await call("/disable", { generation: first.generation })).status, 409);
		const alive = await (await call("/status")).json() as any;
		assert.equal(alive.enabled, true); assert.equal(alive.enrolled, true); assert.equal(alive.generation, rotated.generation);
		for (const body of [{ generation: -1 }, { generation: "1" }, { generation: rotated.generation, extra: true }, []]) assert.equal((await call("/disable", body)).status, 400);
		assert.equal((await call("/disable", { generation: rotated.generation })).status, 200);
		const disabled = await (await call("/status")).json() as any;
		assert.equal(disabled.enabled, false); assert.equal(disabled.enrolled, false); assert.ok(disabled.generation > rotated.generation);
		assert.equal((await call("/disable", { generation: rotated.generation })).status, 409);
		assert.doesNotMatch(JSON.stringify(disabled), new RegExp(hash(connector) + "|" + hash(ingress)));
	} finally { await mf.dispose(); }
});

test("security: authenticated DO admission blocks push before dispatch and preserves ordinary RPC bytes", { timeout: 30000 }, async () => {
	const mf = await relayRuntime(); let socket: any;
	try {
		const ns = await mf.getDurableObjectNamespace("HTTP_RELAY"), stub = ns.get(ns.idFromName("admission"));
		assert.equal((await stub.fetch("https://http-relay.internal/enroll", { method: "POST", body: JSON.stringify({ credentialHash: hash(connector), ingressHash: hash(ingress), headers: ["authorization", "content-type"], profile: "a2a" }) })).status, 200);
		const upgraded = await stub.fetch("https://http-relay.internal/connect", { headers: { upgrade: "websocket", "sec-websocket-protocol": `a2a-http-relay-v2, ${connector}` } });
		assert.equal(upgraded.status, 101); socket = upgraded.webSocket!;
		const frames: any[] = [];
		let readyResolve!: () => void;
		const ready = new Promise<void>(resolve => { readyResolve = resolve; });
		socket.addEventListener("message", (event: any) => {
			const m = JSON.parse(event.data); frames.push(m);
			if (m.type === "hello") { socket.send(JSON.stringify({ ...m, type: "ready" })); readyResolve(); }
			if (m.type === "request") {
				socket.send(JSON.stringify({ v: 2, generation: m.generation, type: "start", id: m.id, status: 204, headers: [] }));
				socket.send(JSON.stringify({ v: 2, generation: m.generation, type: "end", id: m.id, seq: 0 }));
			}
		}); socket.accept(); await ready;
		const end = Date.now() + 5000;
		while (!(await (await stub.fetch("https://http-relay.internal/status")).json() as any).connected) { assert.ok(Date.now() < end, "ready frame must establish connectivity"); await new Promise(r => setTimeout(r, 10)); }
		const forward = (body: string, token = ingress, target = "rpc") => stub.fetch("https://http-relay.internal/forward", { method: "POST", headers: { "x-a2a-relay-authorization": `Bearer ${token}`, "x-a2a-relay-target": target, "x-a2a-relay-method": "POST", authorization: "Bearer dummy-app", "content-type": "application/json" }, body });
		for (const method of ["message/send", "SendMessage", "message/stream", "SendStreamingMessage"]) {
			const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { configuration: { taskPushNotificationConfig: { url: "http://127.0.0.1/admin" } } } });
			assert.equal((await forward(body, "a2ai_" + "x".repeat(43))).status, 401, "authenticate before inspecting RPC");
			assert.equal((await forward(body)).status, 400);
		}
		assert.equal(frames.filter(f => f.type === "request").length, 0);
		assert.equal((await forward("{}", ingress, "webhook")).status, 400);
		const raw = '{ "jsonrpc":"2.0", "id":"unaltered", "method":"tasks/get", "params":{"id":"own-task"} }\n';
		assert.equal((await forward(raw)).status, 204);
		const requests = frames.filter(f => f.type === "request"); assert.equal(requests.length, 1);
		assert.equal(Buffer.from(requests[0].body, "base64").toString(), raw);
		assert.deepEqual(requests[0].headers, [["authorization", "Bearer dummy-app"], ["content-type", "application/json"]]);
	} finally { socket?.close(); await mf.dispose(); }
});

test("security: stalled uploads time out without forwarding collected bytes in either profile", { timeout: 30000 }, async () => {
	const mf = await relayRuntime(); const sockets: any[] = []; const uploads: ReadableStream[] = [];
	try {
		const ns = await mf.getDurableObjectNamespace("HTTP_RELAY");
		await Promise.all(["webhook", "a2a"].map(async profile => {
			const stub = ns.get(ns.idFromName(`upload-timeout-${profile}`));
			await stub.fetch("https://http-relay.internal/enroll", { method: "POST", body: JSON.stringify({ credentialHash: hash(connector), ingressHash: hash(ingress), headers: [], profile }) });
			const upgraded = await stub.fetch("https://http-relay.internal/connect", { headers: { upgrade: "websocket", "sec-websocket-protocol": `a2a-http-relay-v2, ${connector}` } });
			const socket = upgraded.webSocket!; sockets.push(socket); let requests = 0;
			socket.addEventListener("message", (event: any) => {
				const m = JSON.parse(event.data);
				if (m.type === "hello") socket.send(JSON.stringify({ ...m, type: "ready" }));
				if (m.type === "request") {
					requests++;
					socket.send(JSON.stringify({ v: 2, generation: m.generation, type: "start", id: m.id, status: 204, headers: [] }));
					socket.send(JSON.stringify({ v: 2, generation: m.generation, type: "end", id: m.id, seq: 0 }));
				}
			}); socket.accept();
			const deadline = Date.now() + 5000;
			while (!(await (await stub.fetch("https://http-relay.internal/status")).json() as any).connected) { assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 10)); }
			const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":7,"method":"GetTask","params":{"id":"x"}}')); } }); uploads.push(body);
			const response = await stub.fetch("https://http-relay.internal/forward", { method: "POST", headers: { "x-a2a-relay-authorization": `Bearer ${ingress}`, "x-a2a-relay-target": profile === "webhook" ? "webhook" : "rpc", "x-a2a-relay-method": "POST" }, body, duplex: "half" } as RequestInit);
			assert.equal(response.status, 504, profile);
			assert.deepEqual(await response.json(), { error: "request_timeout" });
			assert.equal(requests, 0, "timeout must not dispatch even a valid-looking prefix");
		}));
	} finally { for (const socket of sockets) socket.close(); for (const body of uploads) if (!body.locked) await body.cancel().catch(() => {}); await mf.dispose(); }
});
