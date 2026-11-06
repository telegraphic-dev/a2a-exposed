// Hosted owner RPC for send, reply, and mark_working. The caller has already checked that the account owns the tenant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "../src/a2a.ts";
import { dispatch, runOwnerRpc } from "../src/index.ts";
import { hostedTenantContext, resolveTenant, type WorkerBindings } from "../src/tenancy.ts";
import { d1 } from "./d1.ts";

const BASE = "https://carol.example.com";
const ectx = { waitUntil() {}, passThroughOnException() {} };

test("hosted control plane send, reply, and mark_working", async (t) => {
	const DB = d1(new URL("../migrations/", import.meta.url));
	const ownerToken = "hosted-owner-token";
	const hash = await sha256(ownerToken);
	const env = {
		DB, TENANCY: "host", TENANT_SECRETS_KEY: "platform-key", PUBLIC_URL: BASE, OWNER_TOKEN: "platform-owner",
	} as WorkerBindings;
	const ctx = hostedTenantContext(env, {
		id: "ten_carol", db: DB, publicUrl: BASE, ownerTokenHash: hash, status: "active",
		config: { AGENT_NAME: "Carol" },
	});
	const peerCalls: { host: string; auth: string | null; body: any }[] = [];
	let modern = true;
	let cancelRefused = false;
	const origFetch = globalThis.fetch;
	globalThis.fetch = (async (input: any, init: any = {}) => {
		const u = new URL(String(input));
		if (u.pathname === "/.well-known/agent-card.json")
			return modern ? Response.json({ name: u.host, supportedInterfaces: [{ url: `https://${u.host}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }] }) : Response.json({ url: `https://${u.host}/a2a`, protocolVersion: "0.3" });
		if (u.pathname === "/a2a") {
			const body = JSON.parse(init.body);
			const auth = new Headers(init.headers).get("authorization");
			peerCalls.push({ host: u.host, auth, body });
			if (auth !== `Bearer tok-${u.host.split(".")[0]}`) return new Response("no", { status: 401 });
			if (body.method === "GetTask" || body.method === "tasks/get" || body.method === "CancelTask" || body.method === "tasks/cancel") {
				assert.equal(new Headers(init.headers).get("a2a-version"), modern ? "1.0" : "0.3");
				const cancel = body.method === "CancelTask" || body.method === "tasks/cancel";
				if (cancel && cancelRefused) return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32002, message: "Task cannot be canceled" } });
				return Response.json({ jsonrpc: "2.0", id: body.id, result: { id: body.params.id, contextId: "ctx-out-1", status: { state: modern ? (cancel ? "TASK_STATE_CANCELED" : "TASK_STATE_WORKING") : (cancel ? "canceled" : "working") } } });
			}
			if (body.params?.message?.parts[0]?.text === "echo-token") return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "Rejected tok-alpha" } });
			if (body.params?.message?.parts[0]?.text === "terminal") return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32002, message: "Task is in a terminal state" } });
			if (body.method === "SendMessage" || body.method === "message/send") return Response.json({ jsonrpc: "2.0", id: body.id, result: { task: { id: `pt-${u.host.split(".")[0]}${modern ? "" : "-03"}`, contextId: "ctx-out-1", status: { state: "TASK_STATE_SUBMITTED" } } } });
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	t.after(() => { globalThis.fetch = origFetch; });

	const http = async (method: string, path: string, auth: string | null, json?: unknown, headers: Record<string, string> = {}) => {
		const h: Record<string, string> = { "content-type": "application/json", ...headers };
		if (auth) h.authorization = auth;
		const res = await dispatch(new Request(BASE + path, {
			method, headers: h, body: json === undefined ? undefined : JSON.stringify(json),
		}), ctx, ectx as any);
		const text = await res.text();
		let data: any = text;
		try { data = JSON.parse(text); } catch { /* plain text */ }
		return { status: res.status, data, text };
	};
	const rpc = (path: string, body?: unknown, extra: Record<string, unknown> = {}) =>
		runOwnerRpc(ctx, ectx as any, { accountId: "acct_carol", method: "POST", path, ...(body === undefined ? {} : { body }), ...extra } as any);

	const single = await runOwnerRpc(resolveTenant({ DB, PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret" } as WorkerBindings), ectx as any, {
		accountId: "acct_carol", method: "POST", path: "/owner/mcp/send", body: { to: "alpha", text: "hi" },
	});
	assert.equal(single.status, 404, "self-host keeps the bearer owner API");

	assert.equal((await http("POST", "/owner/mcp/send", null, { to: "alpha", text: "hi" })).status, 401);
	assert.equal((await http("POST", "/owner/mcp/send", "Bearer platform-owner", { to: "alpha", text: "hi" })).status, 401);
	assert.equal((await http("POST", "/owner/mcp/send", "Bearer a2aow_" + "c".repeat(43), { to: "alpha", text: "hi" })).status, 401);
	const synced = await http("PUT", "/owner/outbound-peers/alpha", `Bearer ${ownerToken}`, { url: "https://alpha.example.org", token: "tok-alpha" });
	assert.equal(synced.status, 200, synced.text);

	const missing = await rpc("/owner/mcp/send");
	assert.equal(missing.status, 400);
	assert.match(String((missing.body as { error?: string }).error), /body must be an object/);
	const sneaky = await rpc("/owner/mcp/send", { to: "alpha", text: "hi", token: "tok-alpha" });
	assert.equal(sneaky.status, 400);
	assert.equal(peerCalls.length, 0);
	const human = await rpc("/owner/mcp/send", { to: "alpha", text: "hi" }, { actor: "human" });
	assert.equal(human.status, 400);
	assert.equal(peerCalls.length, 0);
	const badAccount = await runOwnerRpc(ctx, ectx as any, {
		accountId: "../acct", method: "POST", path: "/owner/mcp/send", body: { to: "alpha", text: "hi" },
	});
	assert.equal(badAccount.status, 400);
	assert.equal(peerCalls.length, 0);

	const sent = await rpc("/owner/mcp/send", { to: "alpha", text: "status?", contextId: "ctx-hosted" });
	assert.equal(sent.status, 200, JSON.stringify(sent.body));
	const sentBody = sent.body as { text?: string; isError?: boolean };
	assert.equal(sentBody.isError, false);
	assert.match(sentBody.text || "", /task pt-alpha/);
	assert.equal(JSON.stringify(sent.body).includes("tok-alpha"), false);
	assert.equal(JSON.stringify(sent.body).includes(ownerToken), false);
	assert.equal(peerCalls.at(-1)!.host, "alpha.example.org");
	assert.equal(peerCalls.at(-1)!.auth, "Bearer tok-alpha");
	assert.equal(peerCalls.at(-1)!.body.params.message.parts[0].text, "status?");
	assert.equal(peerCalls.at(-1)!.body.params.message.contextId, "ctx-hosted");

	for (const version of [true, false]) {
		modern = version;
		const taskId = version ? "pt-alpha" : "pt-alpha-03";
		await rpc("/owner/mcp/send", { to: "alpha", text: "status?" });
		for (const tool of ["poll_outbound", "cancel_outbound"]) {
			const before = peerCalls.length;
			const missing = await rpc(`/owner/mcp/${tool}`, { taskId: "unknown" });
			assert.equal((missing.body as any).isError, true);
			assert.equal(peerCalls.length, before, "unknown task never calls a peer");
			const denied = await http("POST", `/owner/mcp/${tool}`, "Bearer platform-owner", { taskId });
			assert.equal(denied.status, 401);
			const result = await rpc(`/owner/mcp/${tool}`, { taskId });
			assert.equal(result.status, 200);
			assert.equal((result.body as any).isError, false, JSON.stringify(result.body));
			assert.match((result.body as any).text, tool === "poll_outbound" ? /working/ : /canceled/);
			assert.equal(peerCalls.at(-1)!.auth, "Bearer tok-alpha");
			assert.equal(peerCalls.at(-1)!.body.method, version ? (tool === "poll_outbound" ? "GetTask" : "CancelTask") : (tool === "poll_outbound" ? "tasks/get" : "tasks/cancel"));
			assert.deepEqual(peerCalls.at(-1)!.body.params, { id: taskId });
			assert.equal(JSON.stringify(result.body).includes("tok-alpha"), false);
			const stored = await http("GET", `/owner/outbound/${taskId}`, `Bearer ${ownerToken}`);
			assert.match(JSON.stringify(stored.data), tool === "poll_outbound" ? /WORKING|working/ : /CANCELED|canceled/);
		}
		cancelRefused = true;
		const beforeRefusal = await http("GET", `/owner/outbound/${taskId}`, `Bearer ${ownerToken}`);
		const refused = await rpc("/owner/mcp/cancel_outbound", { taskId });
		assert.equal((refused.body as any).isError, true);
		assert.match((refused.body as any).text, /JSON-RPC -32002: Task cannot be canceled/);
		assert.deepEqual((await http("GET", `/owner/outbound/${taskId}`, `Bearer ${ownerToken}`)).data, beforeRefusal.data, "refused cancellation preserves the saved task");
		cancelRefused = false;
		const error = await rpc("/owner/mcp/send", { to: "alpha", text: "terminal" });
		assert.equal((error.body as any).isError, true);
		assert.match((error.body as any).text, /JSON-RPC -32002: Task is in a terminal state/);
		assert.doesNotMatch((error.body as any).text, /HTTP 200/);
	}
	modern = true;
	const echoed = await rpc("/owner/mcp/send", { to: "alpha", text: "echo-token" });
	assert.equal((echoed.body as any).isError, true);
	assert.doesNotMatch(JSON.stringify(echoed.body), /tok-alpha/);
	const history = await http("GET", "/owner/history/ctx-out-1", `Bearer ${ownerToken}`);
	assert.match(JSON.stringify(history.data), /"event":"cancel"/);

	const viaHttp = await http("POST", "/owner/mcp/send", `Bearer ${ownerToken}`, { to: "alpha", text: "from the owner token" });
	assert.equal(viaHttp.status, 200, viaHttp.text);
	assert.equal(viaHttp.data.isError, false);
	assert.equal(viaHttp.text.includes("tok-alpha"), false);
	assert.equal(peerCalls.at(-1)!.body.params.message.parts[0].text, "from the owner token");

	// A hosted rotation keeps stored outbound tokens readable through the actual owner send path.
	const rotating = hostedTenantContext({ ...env, TENANT_SECRETS_KEY: JSON.stringify({
		v: 2, active: "next", keys: { old: "platform-key", next: "next-platform-key" },
	}) }, { id: "ten_carol", db: DB, publicUrl: BASE, ownerTokenHash: hash, status: "active" });
	const afterRotation = await runOwnerRpc(rotating, ectx as any, {
		accountId: "acct_carol", method: "POST", path: "/owner/mcp/send", body: { to: "alpha", text: "after rotation" },
	});
	assert.equal(afterRotation.status, 200);
	assert.equal((afterRotation.body as any).isError, false, JSON.stringify(afterRotation.body));
	assert.equal(peerCalls.at(-1)!.auth, "Bearer tok-alpha");

	const withBody = await runOwnerRpc(ctx, ectx as any, { accountId: "acct_carol", method: "GET", path: "/owner/peers", body: { label: "bob" } });
	assert.equal(withBody.status, 400);
	assert.equal((withBody.body as { error?: string }).error, "this call takes no body");
	const minted = await rpc("/owner/peers", { label: "bob" });
	assert.equal(minted.status, 404);

	const issued = await http("POST", "/owner/peers", `Bearer ${ownerToken}`, { label: "ada" });
	assert.match(issued.data.token || "", /^a2aow_/);
	const inbound = await http("POST", "/", `Bearer ${issued.data.token}`, {
		jsonrpc: "2.0", id: 1, method: "message/send",
		params: { message: { kind: "message", role: "user", messageId: "m-ada", parts: [{ kind: "text", text: "hello" }] } },
	}, { "a2a-version": "0.3" });
	assert.equal(inbound.status, 200, inbound.text);
	const taskId = inbound.data.result.id as string;
	assert.ok(taskId);
	const working = await rpc("/owner/mcp/mark_working", { taskId });
	assert.equal(working.status, 200, JSON.stringify(working.body));
	assert.match((working.body as { text?: string }).text || "", new RegExp(`Task ${taskId} is now working`));
	const replied = await rpc("/owner/mcp/reply", { taskId, text: "done", state: "completed" });
	assert.equal(replied.status, 200, JSON.stringify(replied.body));
	assert.equal((replied.body as { isError?: boolean }).isError, false);
	const task = await http("GET", `/owner/tasks/${taskId}`, `Bearer ${ownerToken}`);
	assert.equal(task.data.status.state, "completed");
	const unknown = await rpc("/owner/mcp/send", { to: "missing", text: "hi" });
	assert.equal(unknown.status, 200);
	assert.equal((unknown.body as { isError?: boolean }).isError, true);
	assert.match((unknown.body as { text?: string }).text || "", /no peer "missing"/);
});
