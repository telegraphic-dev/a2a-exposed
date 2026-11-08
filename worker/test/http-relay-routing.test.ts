import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { httpRelayCard, httpRelayEnrollment, httpRelayHeaders, httpRelayRpcAllowed, routeHttpRelay } from "../src/http-relay-routing.ts";
import { resolveTenant } from "../src/tenancy.ts";
import { matchOwnerRpc, ownerRpcBody } from "../src/owner-rpc.ts";
import { cardLeaks } from "../src/facade.ts";
import type { WorkerBindings } from "../src/tenancy.ts";

const enrollment = { credentialHash: "a".repeat(64), ingressHash: "b".repeat(64), headers: ["content-type", "accept", "authorization", "x-signature"] };
const bytes = (b: unknown) => new TextEncoder().encode(JSON.stringify(b));

test("HTTP owner enrollment and RPC allowlist reject unsafe values before dispatch", () => {
	const schema = JSON.parse(readFileSync(new URL("../src/http-relay-enrollment.schema.json", import.meta.url), "utf8"));
	assert.deepEqual(schema.required.sort(), Object.keys(enrollment).sort());
	assert.equal(schema.additionalProperties, false);
	assert.equal(httpRelayEnrollment(enrollment), true);
	for (const profile of ["webhook", "a2a"]) for (const method of ["GET", "POST", "DELETE"]) {
		const route = matchOwnerRpc(method, `/owner/relay/http/${profile}`);
		assert.equal(route.ok, true);
		if (route.ok) assert.equal(route.route.path, `/owner/relay/http/${profile}`);
	}
	for (const profile of ["other", "wake", "webhook/extra", "%61%32%61"]) assert.equal(matchOwnerRpc("POST", `/owner/relay/http/${profile}`).ok, false);
	assert.equal(matchOwnerRpc("GET", "/owner/relay/http/a2a", { token: "no" }).ok, false);
	for (const bad of [null, {}, { ...enrollment, credentialHash: "A".repeat(64) }, { ...enrollment, ingressHash: enrollment.credentialHash }, { ...enrollment, profile: "a2a" }, { ...enrollment, target: "http://localhost/admin" }]) assert.equal(httpRelayEnrollment(bad), false);
	for (const name of ["X-Upper", "x-a2a-relay-authorization", "x-a2a-peer", "x-owner-token", "host", "content-length", "connection", "cookie", "cf-ray", "x-forwarded-for", "proxy-authorization", "authorization\n", "x-\u0100", "a".repeat(65)]) {
		assert.equal(httpRelayHeaders([name]), false, name);
		assert.equal(ownerRpcBody("POST /owner/relay/http/:profile", { ...enrollment, headers: [name] }).ok, false, name);
		assert.equal(new RegExp(schema.properties.headers.items.pattern).test(name) && !new RegExp(schema.properties.headers.items.not.pattern).test(name), false, name);
	}
	assert.equal(httpRelayHeaders(["accept", "accept"]), false);
	assert.equal(ownerRpcBody("POST /owner/relay/http/:profile", enrollment).ok, true);
	assert.equal(ownerRpcBody("DELETE /owner/relay/http/:profile", { generation: 2 }).ok, true);
});

test("native RPC allows fixed operations and blocks push callbacks without modifying raw payload", () => {
	for (const method of ["SendMessage", "message/send", "GetTask", "tasks/get", "CancelTask", "tasks/cancel", "SendStreamingMessage", "message/stream", "SubscribeToTask", "tasks/resubscribe", "ListTasks"]) assert.equal(httpRelayRpcAllowed(bytes({ jsonrpc: "2.0", id: "original", method, params: {} })), true, method);
	for (const method of ["tasks/pushNotificationConfig/set", "CreateTaskPushNotificationConfig", "GetExtendedAgentCard", "PeerAddressUpdate", "anything"]) assert.equal(httpRelayRpcAllowed(bytes({ jsonrpc: "2.0", id: 0, method })), false, method);
	for (const method of ["SendMessage", "message/send", "SendStreamingMessage", "message/stream"]) assert.equal(httpRelayRpcAllowed(bytes({ jsonrpc: "2.0", id: 1, method, params: { configuration: { pushNotificationConfig: { url: "http://localhost/admin" } } } })), false);
	assert.equal(httpRelayRpcAllowed(new Uint8Array([255])), false);
});

test("native cards retain local application security plus mandatory ingress, genuine stream bit, and actual 0.3 shape", () => {
	const local = { name: "Native http://127.0.0.1:8123/rpc", description: "Agent at 127.0.0.1:8123", version: "1", supportedInterfaces: [{ url: "http://127.0.0.1:8123/rpc", protocolBinding: "JSONRPC", protocolVersion: "1.0" }, { url: "http://127.0.0.1:8123/grpc", protocolBinding: "GRPC", protocolVersion: "1.0" }], securitySchemes: { app: { httpAuthSecurityScheme: { scheme: "bearer" } } }, securityRequirements: [{ schemes: { app: { list: ["tasks:own"] } } }], capabilities: { streaming: true, pushNotifications: true }, skills: [{ id: "native", name: "native", description: "native", tags: [] }], signatures: [{ signature: "invalid-after-rewrite" }] };
	const base = "https://agent.example.com/relay/a2a";
	const card = httpRelayCard(local, base, true);
	assert.equal(card.capabilities.streaming, true);
	assert.equal(card.capabilities.pushNotifications, false);
	assert.equal(card.signatures, undefined);
	assert.deepEqual(card.supportedInterfaces, [{ url: base + "/", protocolBinding: "JSONRPC", protocolVersion: "1.0" }]);
	assert.deepEqual(card.securityRequirements, [{ schemes: { app: { list: ["tasks:own"] }, relayIngress: { list: [] } } }]);
	assert.equal(card.securitySchemes.relayIngress.apiKeySecurityScheme.location, "header");
	assert.equal(card.securitySchemes.relayIngress.apiKeySecurityScheme.in, undefined);
	assert.deepEqual(card.securitySchemes.app, local.securitySchemes.app);
	assert.equal(card.securitySchemes.relayIngress.apiKeySecurityScheme.name, "X-A2A-Relay-Authorization");
	assert.deepEqual(cardLeaks(card, base, ["http://127.0.0.1:8123"]), []);
	assert.ok(!JSON.stringify(card).includes("127.0.0.1"));
	assert.equal(httpRelayCard(local, base, false).capabilities.streaming, false);
	assert.equal(httpRelayCard({ ...local, capabilities: { streaming: false } }, base, true).capabilities.streaming, false);
	const legacy = httpRelayCard({ ...local, supportedInterfaces: [...local.supportedInterfaces, { url: "http://127.0.0.1:8123/rpc", protocolBinding: "JSONRPC", protocolVersion: "0.3" }] }, base, true, true);
	assert.equal(legacy.protocolVersion, "0.3.0"); assert.equal(legacy.url, base + "/");
	assert.equal(legacy.supportedInterfaces, undefined); assert.equal(legacy.securityRequirements, undefined);
	assert.deepEqual(legacy.security, [{ app: ["tasks:own"], relayIngress: [] }]);
	assert.equal(legacy.securitySchemes.relayIngress.in, "header");
	assert.equal(legacy.securitySchemes.relayIngress.location, undefined);
	assert.deepEqual(legacy.securitySchemes.app, { type: "http", scheme: "bearer" });
	assert.equal(legacy.securitySchemes.relayIngress.type, "apiKey");
	assert.throws(() => httpRelayCard({ name: "gRPC only", supportedInterfaces: [{ protocolBinding: "GRPC", protocolVersion: "1.0" }] }, base, true), /invalid_card/);
});

test("card schema conversion preserves all authorization alternatives and scope lists", () => {
	const base = "https://agent.example.com/relay/a2a";
	const schemes = { bearer: { type: "http", scheme: "bearer" }, key: { type: "apiKey", in: "header", name: "X-App-Key" }, relayIngress: { type: "apiKey", in: "header", name: "X-Original-Key" } };
	const security = [{ bearer: ["task:own"], key: [] }, { relayIngress: ["alternate"] }];
	const legacy = { name: "native", protocolVersion: "0.3.0", url: "http://localhost/rpc", securitySchemes: schemes, security, capabilities: {}, skills: [] };
	const modern = httpRelayCard(legacy, base, true);
	assert.deepEqual(modern.securityRequirements, [{ schemes: { bearer: { list: ["task:own"] }, key: { list: [] }, relayIngress_: { list: [] } } }, { schemes: { relayIngress: { list: ["alternate"] }, relayIngress_: { list: [] } } }]);
	assert.deepEqual(modern.securitySchemes.key, { apiKeySecurityScheme: { location: "header", name: "X-App-Key" } });
	const roundtrip = httpRelayCard(modern, base, true, true);
	// A new relay ingress scheme is required independently of the original ones.
	assert.deepEqual(roundtrip.security, [{ bearer: ["task:own"], key: [], relayIngress_: [], relayIngress__: [] }, { relayIngress: ["alternate"], relayIngress_: [], relayIngress__: [] }]);
	assert.deepEqual(roundtrip.securitySchemes.key, schemes.key);
	for (const bad of [[{ absent: [] }], [{ bearer: "task:own" }], [{ schemes: { bearer: [] } }], [{ schemes: { bearer: { list: [42] } } }], [{ schemes: { bearer: { list: [], extra: true } } }]]) assert.throws(() => httpRelayCard({ ...legacy, security: bad }, base, true), /invalid_card/);
});

test("public HTTP routing fails closed without body reads and strips caller target metadata", async () => {
	let reads = 0; let dispatches = 0;
	const env = { DB: {}, PUBLIC_URL: "https://agent.example.com", HTTP_RELAY_ENABLED: "1", HTTP_RELAY: { idFromName(name: string) { assert.match(name, /^http-relay-v2:single:self:a2a$/); return name; }, get() { return { async fetch(req: Request) { dispatches++; assert.equal(req.headers.get("x-a2a-relay-target"), "rpc"); assert.equal(req.headers.get("x-a2a-relay-method"), "POST"); assert.equal(req.headers.get("x-a2a-peer"), null); return Response.json({ error: "unauthorized" }, { status: 401 }); } }; } } } as unknown as WorkerBindings;
	const make = (headers: Record<string, string> = {}) => new Request("https://agent.example.com/relay/a2a", { method: "POST", headers, body: new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 }), duplex: "half" } as RequestInit);
	assert.equal((await routeHttpRelay(make(), resolveTenant(env)))?.status, 401); assert.equal(reads, 0); assert.equal(dispatches, 0);
	assert.equal((await routeHttpRelay(make({ "x-a2a-relay-authorization": "Bearer a2ai_" + "x".repeat(43), "x-a2a-relay-target": "webhook", "x-a2a-relay-method": "DELETE", "x-a2a-peer": "forged" }), resolveTenant(env)))?.status, 401);
	assert.equal(reads, 0); assert.equal(dispatches, 1);
	assert.equal((await routeHttpRelay(make(), resolveTenant({ ...env, HTTP_RELAY_ENABLED: "" })))?.status, 404);
});
