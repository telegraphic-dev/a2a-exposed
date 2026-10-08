// Public façade for a private A2A agent: agent card rewriting (pure helpers and the served cards) and proxy mode
// end to end against the real Worker fetch handler, with D1 on node:sqlite and the upstream stubbed. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import * as F from "../src/facade.ts";
import { d1 } from "./d1.ts";

const BASE = "https://agent.example.com";
const UPSTREAM = "https://agent-upstream.example.net/a2a";
const TAILNET = "https://jean.tail1234.ts.net:8443";

/** What an agent already running on a Tailnet typically serves: every URL is private. */
const tailnetCard = (over: any = {}) => ({
	name: "Jean", description: `Jean's assistant. Docs at ${TAILNET}/docs, admin on http://localhost:8080/admin.`, version: "2.1.0",
	supportedInterfaces: [
		{ url: `${TAILNET}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
		{ url: `${TAILNET}/grpc`, protocolBinding: "GRPC", protocolVersion: "1.0" },
	],
	securitySchemes: { upstreamKey: { apiKeySecurityScheme: { location: "header", name: "x-api-key" } } },
	securityRequirements: [{ schemes: { upstreamKey: { list: [] } } }],
	capabilities: { streaming: true, pushNotifications: true, extendedAgentCard: true, extensions: [{ uri: "https://a2a.example.org/ext/v1", description: "see http://100.101.102.103/ext", params: { [`${TAILNET}/admin`]: { scope: "all" } } }] },
	defaultInputModes: ["text/plain", "http://10.0.0.9/mode"], defaultOutputModes: ["text/plain", "application/json; charset=utf-8"],
	skills: [{ id: "chat", name: "Chat", description: "Talks. Runs on jean.tail1234.ts.net", tags: ["chat"], examples: [`Open ${TAILNET}/a2a please`] }],
	provider: { organization: "Jean Inc", url: "http://192.168.1.10/" },
	documentationUrl: `${TAILNET}/docs`, iconUrl: "https://cdn.example.org/jean.png",
	signatures: [{ protected: "x", signature: "y" }],
	...over,
});

test("scrubText: private and upstream URLs and Tailnet names are removed, public URLs kept", () => {
	const o = { publicBase: BASE, upstreamOrigins: ["https://agent-upstream.example.net"] };
	assert.equal(F.scrubText("see https://docs.example.org/x.", o), "see https://docs.example.org/x.");
	assert.equal(F.scrubText("see http://localhost:3000/a, ok", o), `see ${F.REMOVED_URL}, ok`);
	// bracketed IPv6 literals are part of the URL (loopback, ULA, link-local, IPv4-mapped private)
	for (const u of ["http://[::1]:8080/internal", "https://[::1]/x", "https://[fd12:3456::7]:8443/a2a", "https://[fe80::1%25eth0]/", "https://[::ffff:192.168.1.10]/admin", "https://user@[2606:4700::1]/"])
		assert.equal(F.scrubText(`at ${u} now`, o), `at ${F.REMOVED_URL} now`, u);
	assert.equal(F.scrubText("see https://[2606:4700::1]:443/docs.", o), "see https://[2606:4700::1]:443/docs.", "public IPv6 kept");
	assert.equal(F.scrubText("a list [https://docs.example.org/x] stays", o), "a list [https://docs.example.org/x] stays");
	assert.deepEqual(F.cardLeaks({ description: "admin at http://[::1]:8080/internal" }, BASE, []), ["description: http://[::1]:8080/internal"]);
	// property names are scrubbed too (extension params keyed by URL), and a __proto__ key stays a plain property
	const keyed = JSON.parse(`{"params":{"https://jean.tail1234.ts.net/admin":{"see":"http://10.0.0.5/x"},"https://docs.example.org/k":1,"__proto__":{"polluted":true}}}`);
	assert.ok(F.cardLeaks(keyed, BASE, []).some((l) => l.includes("jean.tail1234.ts.net/admin")), "cardLeaks sees keys");
	const clean = F.scrubDeep(keyed, o);
	assert.deepEqual(Object.keys(clean.params), [F.REMOVED_URL, "https://docs.example.org/k", "__proto__"]);
	assert.deepEqual(clean.params[F.REMOVED_URL], { see: F.REMOVED_URL });
	assert.equal(({} as any).polluted, undefined);
	assert.equal(Object.getPrototypeOf(clean.params), Object.prototype);
	assert.deepEqual(F.cardLeaks(clean, BASE, []), []);
	assert.equal(F.scrubText("on https://agent-upstream.example.net/a2a now", o), `on ${F.REMOVED_URL} now`);
	assert.equal(F.scrubText("host agent-upstream.example.net:443 here", o), `host ${F.REMOVED_HOST} here`);
	assert.equal(F.scrubText("on jean.tail1234.ts.net.", o), `on ${F.REMOVED_HOST}.`);
	assert.equal(F.scrubText("lan http://10.0.0.5/x and https://192.168.0.2", o), `lan ${F.REMOVED_URL} and ${F.REMOVED_URL}`);
	assert.equal(F.scrubText("urn:example:x mailto:a@example.com", o), "urn:example:x mailto:a@example.com");
	assert.equal(F.publicUrlOrNothing(`${TAILNET}/docs`, o), undefined);
	assert.equal(F.publicUrlOrNothing("https://docs.example.org/", o), "https://docs.example.org/");
});

test("upstream card parsing: interface origins and the JSON-RPC versions we can proxy", () => {
	assert.deepEqual(F.upstreamCardOrigins(tailnetCard()), [TAILNET]);
	assert.deepEqual(F.upstreamJsonRpcVersions(tailnetCard()), ["1.0"]);
	const c03 = { protocolVersion: "0.3.0", url: "http://100.70.0.1:9999/", preferredTransport: "JSONRPC", additionalInterfaces: [{ url: "http://100.70.0.1:9999/rest", transport: "HTTP+JSON" }] };
	assert.deepEqual(F.upstreamJsonRpcVersions(c03), ["0.3"]);
	assert.deepEqual(F.upstreamCardOrigins(c03), ["http://100.70.0.1:9999"]);
	assert.deepEqual(F.upstreamJsonRpcVersions({ protocolVersion: "0.3.0", preferredTransport: "GRPC" }), []);
	assert.deepEqual(F.upstreamEndpoint("http://agent.example.net/"), ["", "UPSTREAM_URL must be https"]);
	assert.match(F.upstreamEndpoint("https://jean.tail1234.ts.net/a2a")[1], /private-network/);
	assert.match(F.upstreamEndpoint("https://localhost/a2a")[1], /private-network/);
	assert.equal(F.upstreamEndpoint(UPSTREAM)[0], UPSTREAM);
	assert.deepEqual(F.upstreamCardUrl(UPSTREAM, ""), ["https://agent-upstream.example.net/.well-known/agent-card.json", ""]);
	assert.deepEqual(F.upstreamCardUrl(UPSTREAM, "https://agent-upstream.example.net/card.json"), ["https://agent-upstream.example.net/card.json", ""]);
	assert.equal(F.sameOrigin(UPSTREAM, "https://agent-upstream.example.net/other"), true);
	assert.equal(F.sameOrigin(UPSTREAM, "https://evil.example.com/card"), false);
	assert.match(F.upstreamCardUrl(UPSTREAM, "https://evil.example.com/card")[1], /must be on the UPSTREAM_URL origin/);
	assert.match(F.upstreamCardUrl(UPSTREAM, "http://insecure.example.net/card")[1], /must be https/);
	assert.match(F.upstreamCardUrl(UPSTREAM, "https://jean.tail1234.ts.net/card")[1], /private-network/);
	assert.deepEqual(F.idsFromResult({ task: { id: "t1", contextId: "c1" } }), { taskId: "t1", contextId: "c1" });
	assert.deepEqual(F.idsFromResult({ kind: "task", id: "t2", contextId: "c2" }), { taskId: "t2", contextId: "c2" });
	assert.deepEqual(F.idsFromResult({ message: { messageId: "m", contextId: "c3" } }), { taskId: undefined, contextId: "c3" });
	assert.equal(F.taskIdOf("get", { name: "tasks/t9" }), "t9");
	assert.equal(F.taskIdOf("pushget", { id: "t8", pushNotificationConfigId: "p" }), "t8");
	assert.equal(F.taskIdOf("pushset", { taskId: "t7", id: "cfg" }), "t7");
	assert.equal(F.taskIdOf("pushset", { id: "cfg", url: "https://x.example" }), undefined);
});

test("facadeCard: public URLs only, façade security, upstream name/skills/capabilities preserved, config wins", () => {
	const schemes = { bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } } };
	const card = F.facadeCard({ upstream: tailnetCard(), config: {}, publicBase: BASE, upstreamOrigins: [TAILNET, "https://agent-upstream.example.net"],
		securitySchemes: schemes, securityRequirements: [{ schemes: { bearer: { list: [] } } }], defaults: { description: "d", skills: [] } });
	assert.deepEqual(card.supportedInterfaces, [{ url: BASE + "/", protocolBinding: "JSONRPC", protocolVersion: "1.0" }]);
	assert.deepEqual(card.securitySchemes, schemes);
	assert.equal(card.name, "Jean");
	assert.equal(card.version, "2.1.0");
	assert.equal(card.skills[0].id, "chat");
	assert.equal(card.skills[0].description, `Talks. Runs on ${F.REMOVED_HOST}`);
	assert.equal(card.skills[0].examples[0], `Open ${F.REMOVED_URL} please`);
	assert.deepEqual(card.capabilities, { streaming: false, pushNotifications: false, extendedAgentCard: false,
		extensions: [{ uri: "https://a2a.example.org/ext/v1", description: `see ${F.REMOVED_URL}`, params: { [F.REMOVED_URL]: { scope: "all" } } }] });
	assert.equal(card.documentationUrl, undefined);
	assert.equal(card.provider, undefined);
	assert.equal(card.iconUrl, "https://cdn.example.org/jean.png");
	assert.deepEqual(card.defaultInputModes, ["text/plain"], "non-media-type modes dropped");
	assert.deepEqual(card.defaultOutputModes, ["text/plain", "application/json; charset=utf-8"]);
	for (const k of ["url", "signatures", "additionalInterfaces", "security", "preferredTransport"]) assert.ok(!(k in card), k);
	assert.deepEqual(F.cardLeaks(card, BASE, [TAILNET]), []);
	assert.ok(F.cardLeaks(tailnetCard(), BASE, [TAILNET]).length > 3, "the raw upstream card does leak");

	const over = F.facadeCard({ upstream: tailnetCard(), config: { name: "Jean (public)", documentationUrl: "https://docs.example.org/jean", providerOrganization: "Acme", providerUrl: "https://acme.example" },
		publicBase: BASE, upstreamOrigins: [TAILNET], securitySchemes: schemes, securityRequirements: [], defaults: { description: "d", skills: [] } });
	assert.equal(over.name, "Jean (public)");
	assert.equal(over.documentationUrl, "https://docs.example.org/jean");
	assert.deepEqual(over.provider, { organization: "Acme", url: "https://acme.example" });

	const none = F.facadeCard({ upstream: null, config: {}, publicBase: BASE, upstreamOrigins: [], securitySchemes: schemes, securityRequirements: [],
		defaults: { description: "fallback", skills: [{ id: "general" }] } });
	assert.deepEqual(none.supportedInterfaces.map((i: any) => i.protocolVersion), ["1.0", "0.3"]);
	assert.equal(none.description, "fallback");
});

// ------------------------------------------------------------------ the Worker

function setup(over: Record<string, string> = {}, upstream: (url: string, init: any) => Response | Promise<Response> = defaultUpstream()) {
	const DB = d1(new URL("../migrations/", import.meta.url));
	const env: any = { DB, PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", PAIRING_APPROVAL: "human", ...over };
	const calls: any[] = [];
	const origFetch = globalThis.fetch;
	globalThis.fetch = (async (url: any, init: any = {}) => {
		calls.push({ url: String(url), method: init.method || "GET", headers: { ...(init.headers || {}) }, body: init.body });
		return upstream(String(url), init);
	}) as any;
	const call = async (method: string, path: string, o: { json?: any; token?: string; headers?: Record<string, string> } = {}) => {
		const headers: Record<string, string> = { "cf-connecting-ip": "198.51.100.7", ...(o.headers || {}) };
		if (o.token) headers.authorization = `Bearer ${o.token}`;
		let body: string | undefined;
		if (o.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(o.json); }
		const pending: Promise<unknown>[] = [];
		const res = await worker.fetch(new Request(BASE + path, { method, headers, body }) as any, env, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as any);
		await Promise.allSettled(pending);
		const text = await res.text();
		let data: any = text;
		try { data = JSON.parse(text); } catch { /* text */ }
		return { status: res.status, data, text };
	};
	const issue = async (label: string) => (await call("POST", "/owner/peers", { json: { label }, token: "owner-secret" })).data.token as string;
	const rpc = (token: string, method: string, params: any, id: any = 1) => call("POST", "/", { token, json: { jsonrpc: "2.0", id, method, params }, headers: { "a2a-version": "1.0" } });
	return { env, DB, calls, call, issue, rpc, restore: () => { globalThis.fetch = origFetch; } };
}

let seq = 0;
/** A stub upstream: serves the Tailnet card, and answers SendMessage with a new task (GetTask echoes the id). */
function defaultUpstream(card: any = tailnetCard()) {
	return async (url: string, init: any): Promise<Response> => {
		if (url.endsWith(".json")) return Response.json(card);
		if (url.startsWith("https://hook.example.net/")) return new Response("ok"); // wake webhook
		const rq = JSON.parse(init.body);
		if (rq.method === "SendMessage") {
			const m = rq.params.message;
			return Response.json({ jsonrpc: "2.0", id: rq.id, result: { task: { id: m.taskId || `up-task-${++seq}`, contextId: m.contextId || `up-ctx-${seq}`, status: { state: "TASK_STATE_SUBMITTED" } } } });
		}
		return Response.json({ jsonrpc: "2.0", id: rq.id, result: { id: rq.params.id || rq.params.taskId, status: { state: "TASK_STATE_WORKING" } } });
	};
}

test("inbox mode: private URLs in AGENT_* settings never reach the card", async (t) => {
	const s = setup({ DOCUMENTATION_URL: "https://jean.tail1234.ts.net/docs", PROVIDER_ORGANIZATION: "Acme", PROVIDER_URL: "http://192.168.1.2/",
		AGENT_DESCRIPTION: "Ask me. Local UI: http://localhost:3000", AGENT_SKILLS: JSON.stringify([{ id: "x", name: "X", description: "via http://100.64.1.2/", tags: [] }]) });
	t.after(s.restore);
	for (const p of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
		const card = (await s.call("GET", p)).data;
		assert.deepEqual(F.cardLeaks(card, BASE), [], p);
		assert.equal(card.documentationUrl, undefined, p);
		assert.equal(card.provider, undefined, p);
		assert.equal(card.description, `Ask me. Local UI: ${F.REMOVED_URL}`, p);
	}
	const ok = setup({ DOCUMENTATION_URL: "https://docs.example.org/", PROVIDER_ORGANIZATION: "Acme", PROVIDER_URL: "https://acme.example/" });
	t.after(ok.restore);
	const card = (await ok.call("GET", "/.well-known/agent-card.json")).data;
	assert.equal(card.documentationUrl, "https://docs.example.org/");
	assert.deepEqual(card.provider, { organization: "Acme", url: "https://acme.example/" });
	assert.equal((await ok.call("GET", "/health")).data.mode, "inbox");
});

test("proxy mode: the served cards are the upstream's, rewritten to the public URL (1.0 and 0.3)", async (t) => {
	const s = setup({ UPSTREAM_URL: UPSTREAM, UPSTREAM_CARD_URL: "https://agent-upstream.example.net/card-a.json", UPSTREAM_TOKEN: "up-secret",
		UPSTREAM_ACCESS_CLIENT_ID: "cid.access", UPSTREAM_ACCESS_CLIENT_SECRET: "csecret" });
	t.after(s.restore);
	const card = (await s.call("GET", "/.well-known/agent-card.json")).data;
	assert.equal(card.name, "Jean");
	assert.deepEqual(card.supportedInterfaces, [{ url: BASE + "/", protocolBinding: "JSONRPC", protocolVersion: "1.0" }]);
	assert.ok(card.securitySchemes.bearer && card.securitySchemes.pairing, "façade bearer + device-flow pairing");
	assert.ok(!card.securitySchemes.upstreamKey, "never the upstream's scheme");
	assert.equal(card.securitySchemes.pairing.oauth2SecurityScheme.flows.deviceCode.deviceAuthorizationUrl, `${BASE}/oauth/device_authorization`);
	assert.deepEqual(F.cardLeaks(card, BASE, [TAILNET, "https://agent-upstream.example.net"]), []);
	assert.ok(!JSON.stringify(card).includes("agent-upstream"), "the tunnel hostname stays private too");
	const c03 = (await s.call("GET", "/.well-known/agent.json")).data;
	assert.equal(c03.url, BASE + "/");
	assert.equal(c03.name, "Jean");
	assert.deepEqual(F.cardLeaks(c03, BASE, [TAILNET]), []);
	// the card fetch carried the façade's upstream credentials (Access service token + bearer)
	const cf = s.calls.find((c) => c.url.endsWith("/card-a.json"));
	assert.equal(cf.headers.authorization, "Bearer up-secret");
	assert.equal(cf.headers["cf-access-client-id"], "cid.access");
	assert.equal((await s.call("GET", "/health")).data.mode, "proxy");
	const diag = (await s.call("GET", "/owner/facade", { token: "owner-secret" })).data;
	assert.equal(diag.mode, "proxy");
	assert.equal(diag.upstreamCard, "ok");
	assert.deepEqual(diag.upstreamVersions, ["1.0"]);
	assert.deepEqual(diag.publicCardLeaks, []);
	assert.equal(diag.hasUpstreamToken, true);
	assert.ok(!JSON.stringify(diag).includes("up-secret") && !JSON.stringify(diag).includes("csecret"), "no secret values");
});

test("proxy mode: a cross-origin UPSTREAM_CARD_URL is refused and never fetched with credentials", async (t) => {
	const evil = "https://evil.example.com/steal-card.json";
	const s = setup({ UPSTREAM_URL: UPSTREAM, UPSTREAM_CARD_URL: evil, UPSTREAM_TOKEN: "up-secret",
		UPSTREAM_ACCESS_CLIENT_ID: "cid.access", UPSTREAM_ACCESS_CLIENT_SECRET: "csecret", AGENT_NAME: "Jean" });
	t.after(s.restore);
	const card = (await s.call("GET", "/.well-known/agent-card.json")).data;
	assert.equal(card.name, "Jean", "config-based card when the upstream card URL is refused");
	assert.ok(!s.calls.some((c) => c.url === evil || c.url.includes("evil.example.com")), "the cross-origin URL is never fetched");
	assert.ok(!s.calls.some((c) => (c.headers?.authorization || "").includes("up-secret")
		|| c.headers?.["cf-access-client-id"] === "cid.access"
		|| c.headers?.["cf-access-client-secret"] === "csecret"), "credentials never leave for a third-party host");
	const diag = (await s.call("GET", "/owner/facade", { token: "owner-secret" })).data;
	assert.match(diag.upstreamCardProblem || "", /must be on the UPSTREAM_URL origin/);
	assert.match(diag.upstreamCard, /must be on the UPSTREAM_URL origin/);
	assert.equal(diag.upstreamCardUrl, null);
});

test("proxy mode: upstream card unavailable -> config-based card, still no private URL", async (t) => {
	const s = setup({ UPSTREAM_URL: UPSTREAM, UPSTREAM_CARD_URL: "https://agent-upstream.example.net/card-down.json", AGENT_NAME: "Jean" },
		async () => new Response("<html>Bad gateway</html>", { status: 502 }));
	t.after(s.restore);
	const card = (await s.call("GET", "/.well-known/agent-card.json")).data;
	assert.equal(card.name, "Jean");
	assert.deepEqual(card.supportedInterfaces.map((i: any) => i.url), [BASE + "/", BASE + "/"]);
	const diag = (await s.call("GET", "/owner/facade", { token: "owner-secret" })).data;
	assert.match(diag.upstreamCard, /HTTP 502/);
});

test("proxy mode: JSON-RPC is forwarded with the façade's credential, never the peer's token", async (t) => {
	const s = setup({ UPSTREAM_URL: UPSTREAM, UPSTREAM_CARD_URL: "https://agent-upstream.example.net/card-b.json", UPSTREAM_TOKEN: "up-secret",
		UPSTREAM_ACCESS_CLIENT_ID: "cid.access", UPSTREAM_ACCESS_CLIENT_SECRET: "csecret" });
	t.after(s.restore);
	// no token: the usual 401 with the device-flow hint; nothing reaches the upstream
	const un = await s.call("POST", "/", { json: { jsonrpc: "2.0", id: 7, method: "SendMessage", params: {} } });
	assert.equal(un.status, 401);
	assert.equal(un.data.id, 7);
	assert.ok(!s.calls.some((c) => c.url === UPSTREAM));

	const tok = await s.issue("barry");
	const r = await s.rpc(tok, "SendMessage", { message: { role: "ROLE_USER", messageId: "m1", parts: [{ text: "hi" }] } });
	assert.equal(r.status, 200, JSON.stringify(r.data));
	const taskId = r.data.result.task.id;
	const fwd = s.calls.filter((c) => c.url === UPSTREAM).at(-1);
	assert.equal(fwd.method, "POST");
	assert.equal(fwd.headers.authorization, "Bearer up-secret");
	assert.equal(fwd.headers["cf-access-client-id"], "cid.access");
	assert.equal(fwd.headers["cf-access-client-secret"], "csecret");
	assert.equal(fwd.headers["x-a2a-peer"], "barry");
	assert.equal(fwd.headers["a2a-version"], "1.0");
	assert.ok(!JSON.stringify(fwd.headers).includes(tok), "the peer's token is not forwarded");
	assert.equal(JSON.parse(fwd.body).params.message.parts[0].text, "hi");

	const g = await s.rpc(tok, "GetTask", { id: taskId });
	assert.equal(g.data.result.id, taskId);
	// no wake, no inbox row: the upstream handles the message
	assert.equal((s.DB.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as any).n, 0);
});

test("proxy mode: peers sharing the upstream identity can't touch each other's tasks or contexts", async (t) => {
	const s = setup({ UPSTREAM_URL: UPSTREAM, UPSTREAM_CARD_URL: "https://agent-upstream.example.net/card-c.json" });
	t.after(s.restore);
	const a = await s.issue("alice"), b = await s.issue("bob");
	const r = await s.rpc(a, "SendMessage", { message: { role: "ROLE_USER", parts: [{ text: "secret plan" }] } });
	const { id: taskId, contextId } = r.data.result.task;
	const before = s.calls.filter((c) => c.url === UPSTREAM).length;
	for (const [method, params] of [
		["GetTask", { id: taskId }], ["CancelTask", { id: taskId }], ["tasks/get", { id: taskId }],
		["GetTaskPushNotificationConfig", { taskId, id: "x" }], ["ListTaskPushNotificationConfig", { taskId }],
		["DeleteTaskPushNotificationConfig", { taskId, id: "x" }], ["GetTask", { id: "never-seen" }],
	] as const) {
		const x = await s.rpc(b, method, params);
		assert.equal(x.data.error?.code, -32001, `${method}: ${JSON.stringify(x.data)}`);
	}
	const cont = await s.rpc(b, "SendMessage", { message: { role: "ROLE_USER", taskId, parts: [{ text: "x" }] } });
	assert.equal(cont.data.error?.code, -32001);
	const ref = await s.rpc(b, "SendMessage", { message: { role: "ROLE_USER", referenceTaskIds: [taskId], parts: [{ text: "summarize that" }] } });
	assert.equal(ref.data.error?.code, -32001, "no reading another peer's task through referenceTaskIds");
	const ctx = await s.rpc(b, "SendMessage", { message: { role: "ROLE_USER", contextId, parts: [{ text: "x" }] } });
	assert.equal(ctx.data.error?.code, -32602);
	assert.equal(s.calls.filter((c) => c.url === UPSTREAM).length, before, "refused before reaching the upstream");
	// the owner of the task can continue it
	const own = await s.rpc(a, "SendMessage", { message: { role: "ROLE_USER", taskId, contextId, parts: [{ text: "more" }] } });
	assert.ok(own.data.result, JSON.stringify(own.data));
	assert.ok((await s.rpc(a, "SendMessage", { message: { role: "ROLE_USER", referenceTaskIds: [taskId], parts: [{ text: "follow-up" }] } })).data.result, "own tasks can be referenced");
	// fail closed: a contextId the façade has no record of (client-chosen, or an upstream context opened elsewhere) is
	// refused for everyone, before the upstream; the peer's own returned context works
	const n0 = s.calls.filter((c) => c.url === UPSTREAM).length;
	for (const [tok, ctxId] of [[b, "bob-ctx-1"], [a, "bob-ctx-1"], [a, "upstream-ctx-made-elsewhere"]] as const) {
		const x = await s.rpc(tok, "SendMessage", { message: { role: "ROLE_USER", contextId: ctxId, parts: [{ text: "x" }] } });
		assert.equal(x.data.error?.code, -32602, JSON.stringify(x.data));
		assert.match(x.data.error.message, /omit contextId/);
	}
	assert.equal(s.calls.filter((c) => c.url === UPSTREAM).length, n0, "unrecorded contexts never reach the upstream");
	const bobOwn = (await s.rpc(b, "SendMessage", { message: { role: "ROLE_USER", parts: [{ text: "hi" }] } })).data.result.task.contextId;
	assert.ok((await s.rpc(b, "SendMessage", { message: { role: "ROLE_USER", contextId: bobOwn, parts: [{ text: "again" }] } })).data.result);
	assert.equal((await s.rpc(a, "SendMessage", { message: { role: "ROLE_USER", contextId: bobOwn, parts: [{ text: "x" }] } })).data.error?.code, -32602);
	// ListTasks would list every peer's tasks; streaming is not proxied yet
	assert.equal((await s.rpc(a, "ListTasks", {})).data.error?.code, -32004);
	assert.equal((await s.rpc(a, "SendStreamingMessage", { message: { role: "ROLE_USER", parts: [{ text: "x" }] } })).data.error?.code, -32004);
	assert.equal((await s.rpc(a, "GetExtendedAgentCard", {})).data.error?.code, -32601);
});

test("proxy mode: push configs never reach the upstream (it would call them from inside the private network)", async (t) => {
	const s = setup({ UPSTREAM_URL: UPSTREAM, UPSTREAM_CARD_URL: "https://agent-upstream.example.net/card-d.json" });
	t.after(s.restore);
	const a = await s.issue("alice");
	const card = (await s.call("GET", "/.well-known/agent-card.json")).data;
	assert.equal(card.capabilities.pushNotifications, false, "even though the upstream card says true");
	const msg = { role: "ROLE_USER", parts: [{ text: "x" }] };
	const n0 = s.calls.filter((c) => c.url === UPSTREAM).length;
	// public-looking names can resolve to private space on the upstream's network (127.0.0.1.nip.io), so every push URL is refused
	for (const url of ["https://127.0.0.1.nip.io/x", "https://hooks.example.org/a2a", "http://hooks.example.org/x", "https://192.168.1.1/"]) {
		for (const configuration of [{ taskPushNotificationConfig: { url } }, { pushNotificationConfig: { url } }, { taskPushNotificationConfig: { pushNotificationConfig: { url } } }]) {
			const r = await s.rpc(a, "SendMessage", { message: msg, configuration });
			assert.equal(r.data.error?.code, -32003, `${url} ${JSON.stringify(configuration)}`);
		}
	}
	const ok = await s.rpc(a, "SendMessage", { message: msg, configuration: { acceptedOutputModes: ["text/plain"] } });
	const taskId = ok.data.result.task.id;
	const n1 = s.calls.filter((c) => c.url === UPSTREAM).length;
	assert.equal(n1, n0 + 1, "only the push-free message went upstream");
	for (const [method, params] of [
		["CreateTaskPushNotificationConfig", { taskId, url: "https://hooks.example.org/b" }],
		["tasks/pushNotificationConfig/set", { taskId, pushNotificationConfig: { url: "https://hooks.example.org/b" } }],
		["GetTaskPushNotificationConfig", { taskId, id: "x" }], ["ListTaskPushNotificationConfig", { taskId }],
		["DeleteTaskPushNotificationConfig", { taskId, id: "x" }], ["tasks/pushNotificationConfig/get", { id: taskId }],
	] as const) {
		const r = await s.rpc(a, method, params);
		assert.equal(r.data.error?.code, -32003, method);
	}
	assert.equal(s.calls.filter((c) => c.url === UPSTREAM).length, n1, "no push call reached the upstream");
	assert.equal(F.wantsPush("send", { configuration: { blocking: true } }), false);
	assert.equal(F.wantsPush("send", { configuration: { pushNotificationConfig: null } }), false);
	assert.equal(F.wantsPush("pushget", {}), true);
});

test("proxy mode: upstream failures are the façade's errors, never a 401 to the peer", async (t) => {
	let mode = "401";
	const s = setup({ UPSTREAM_URL: UPSTREAM, UPSTREAM_CARD_URL: "https://agent-upstream.example.net/card-e.json" }, async (url) => {
		if (url.endsWith(".json")) return Response.json(tailnetCard());
		if (mode === "401") return new Response("unauthorized", { status: 401 });
		if (mode === "html") return new Response("<html>error 1033</html>", { status: 530 });
		if (mode === "rpc-error") return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad" } }, { status: 400 });
		throw new Error("connect ECONNREFUSED");
	});
	t.after(s.restore);
	const a = await s.issue("alice");
	const send = () => s.rpc(a, "SendMessage", { message: { role: "ROLE_USER", parts: [{ text: "x" }] } });
	let r = await send();
	assert.equal(r.status, 502);
	assert.match(r.data.error.message, /refused by its upstream/);
	mode = "html";
	r = await send();
	assert.equal(r.status, 502);
	assert.equal(r.data.error.code, -32603);
	mode = "down";
	r = await send();
	assert.equal(r.status, 502);
	assert.match(r.data.error.message, /not reachable/);
	mode = "rpc-error";
	r = await send();
	assert.equal(r.status, 200, "a JSON-RPC error from the upstream passes through");
	assert.equal(r.data.error.code, -32602);
});

test("proxy mode: a private UPSTREAM_URL is a configuration error (the Worker can't reach a Tailnet)", async (t) => {
	const s = setup({ UPSTREAM_URL: "https://jean.tail1234.ts.net/a2a" });
	t.after(s.restore);
	const a = await s.issue("alice");
	const r = await s.rpc(a, "SendMessage", { message: { role: "ROLE_USER", parts: [{ text: "x" }] } });
	assert.equal(r.status, 503);
	assert.equal(s.calls.length, 0);
	const card = (await s.call("GET", "/.well-known/agent-card.json")).data;
	assert.deepEqual(F.cardLeaks(card, BASE), []);
	assert.match((await s.call("GET", "/owner/facade", { token: "owner-secret" })).data.upstreamProblem, /private-network/);
});

test("pairing out from a Tailnet agent: a *.ts.net card URL is accepted and flagged as not publicly reachable", async (t) => {
	const s = setup({ WAKE_PRESET: "grok-bot", WAKE_WEBHOOK_URL: "https://hook.example.net/wake", WAKE_WEBHOOK_KEY: "k" });
	t.after(s.restore);
	const st = await s.call("POST", "/oauth/device_authorization", { json: { client_name: "Jean", agent_card_url: `${TAILNET}/.well-known/agent-card.json` } });
	assert.equal(st.status, 200, JSON.stringify(st.data));
	const wake = s.calls.find((c) => c.url === "https://hook.example.net/wake");
	assert.equal(JSON.parse(wake.body).pairing.agentCardPrivate, true, "the wake flags the private card");
	const page = await s.call("GET", `/device?user_code=${st.data.user_code}`);
	assert.match(page.text, /not publicly reachable/);
});

test("wake text for a private claimed card says it is not publicly reachable", async () => {
	const { wakeSummary } = await import("../src/wake.ts");
	const txt = wakeSummary({ contextId: "pairing", taskId: "none", taskIds: [], from: "Jean", preview: "", kind: "pairing_request", publicUrl: BASE,
		pairing: { userCode: "WDJB-4827", verificationUriComplete: `${BASE}/device?user_code=WDJB-4827`, approval: "human", clientName: "Jean", clientId: "",
			agentCardUrl: `${TAILNET}/.well-known/agent-card.json`, agentCardPrivate: true, expiresIn: 600 } }, "npx a2a-exposed");
	assert.match(txt, /private network: not publicly reachable/);
});

test("proxy mode: the landing page shows the rewritten card (upstream name and skills, no private URL)", async (t) => {
	const s = setup({ UPSTREAM_URL: UPSTREAM, UPSTREAM_TOKEN: "up-secret" });
	t.after(s.restore);
	const h = await s.call("GET", "/", { headers: { accept: "text/html" } });
	assert.equal(h.status, 200);
	assert.match(h.text, /<title>Jean<\/title>/);
	assert.match(h.text, /<b>Chat<\/b>/);
	for (const leak of ["ts.net", "tail1234", "localhost", "agent-upstream", "192.168.", "100.101."]) assert.ok(!h.text.includes(leak), leak);
	assert.ok(!h.text.includes("inbox"), "a façade isn't an inbox");
	const j = await s.call("GET", "/");
	assert.equal(j.data.name, "Jean");
	assert.ok(!JSON.stringify(j.data).includes("ts.net"));
});
