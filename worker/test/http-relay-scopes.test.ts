import { test } from "node:test";
import assert from "node:assert/strict";
import { httpRelayCard } from "../src/http-relay-routing.ts";

const base = "https://agent.example.com/relay/a2a";
function upstream(scope: string, required = true) {
	return { name: "Scope fixture", protocolVersion: "0.3.0", url: "http://127.0.0.1:8123/rpc", preferredTransport: "JSONRPC", securitySchemes: { app: { type: "oauth2", flows: { clientCredentials: { tokenUrl: "https://auth.example.com/token", scopes: { [scope]: "Read tasks" } } } } }, security: [{ app: required ? [scope] : [] }], capabilities: {}, skills: [] };
}
for (const legacy of [false, true]) {
	test(`native ${legacy ? "0.3" : "1.0"} card refuses private OAuth scope identifiers rather than changing authorization semantics`, () => {
		for (const scope of ["http://127.0.0.1:8123/task.read", "http://[::1]:8123/task.read", "https://fixture.ts.net/task.read"]) {
			assert.throws(() => httpRelayCard(upstream(scope), base, true, legacy), /invalid_card/);
			assert.throws(() => httpRelayCard(upstream(scope, false), base, true, legacy), /invalid_card/, "even an optional advertised scope must not be renamed");
			const requirementOnly = upstream("task.read"); requirementOnly.security[0].app = [scope];
			assert.throws(() => httpRelayCard(requirementOnly, base, true, legacy), /invalid_card/);
		}
	});
	test(`native ${legacy ? "0.3" : "1.0"} card preserves public OAuth scope references exactly`, () => {
		for (const scope of ["task.read", "https://auth.example.com/scopes/task.read"]) {
			const card = httpRelayCard(upstream(scope), base, true, legacy);
			const flow = legacy ? card.securitySchemes.app.flows.clientCredentials : card.securitySchemes.app.oauth2SecurityScheme.flows.clientCredentials;
			assert.deepEqual(Object.keys(flow.scopes), [scope]);
			assert.deepEqual(legacy ? card.security[0].app : card.securityRequirements[0].schemes.app.list, [scope]);
		}
	});
}
