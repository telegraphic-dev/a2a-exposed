// A2A-Version selects the response shape; the extended card is -32007. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { d1 } from "./d1.ts";

const BASE = "https://agent.example.com";

function setup() {
	const DB = d1(new URL("../migrations/", import.meta.url));
	const env: any = { DB, PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", AGENT_NAME: "Test Inbox", PAIRING_APPROVAL: "off" };
	const call = async (method: string, path: string, o: { json?: any; headers?: Record<string, string> } = {}) => {
		const headers: Record<string, string> = { "cf-connecting-ip": "198.51.100.7", ...(o.headers || {}) };
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
	return { call };
}

test("A2A-Version selects the response shape; an absent header keeps the method name", async () => {
	const s = setup();
	const issued = await s.call("POST", "/owner/peers", { json: { label: "ada" }, headers: { authorization: "Bearer owner-secret" } });
	assert.equal(issued.status, 200, issued.text);
	const token = issued.data.token as string;
	let n = 0;
	const msg = () => ({ message: { role: "user", messageId: `m${++n}`, parts: [{ kind: "text", text: "hi" }] } });
	const rpc = (method: string, params: any, headers: Record<string, string> = {}, path = "/") =>
		s.call("POST", path, { json: { jsonrpc: "2.0", id: 1, method, params }, headers: { authorization: `Bearer ${token}`, ...headers } });

	const v1 = await rpc("message/send", msg(), { "a2a-version": "1.0" });
	assert.equal(v1.status, 200, v1.text);
	assert.equal(v1.data.result.task.status.state, "TASK_STATE_SUBMITTED");
	assert.equal(v1.data.result.task.kind, undefined);
	assert.equal(v1.data.result.task.history[0].role, "ROLE_USER");
	assert.equal(v1.data.result.task.history[0].parts[0].kind, undefined);
	assert.equal(v1.data.result.task.history[0].parts[0].text, "hi");

	const v03 = await rpc("SendMessage", msg(), { "a2a-version": "0.3" });
	assert.equal(v03.data.result.kind, "task");
	assert.equal(v03.data.result.status.state, "submitted");
	assert.equal(v03.data.result.task, undefined);
	assert.equal(v03.data.result.history[0].role, "user");
	assert.equal(v03.data.result.history[0].kind, "message");
	assert.equal(v03.data.result.history[0].parts[0].kind, "text");

	const bare03 = await rpc("message/send", msg());
	assert.equal(bare03.data.result.kind, "task");
	assert.equal(bare03.data.result.status.state, "submitted");
	const bare1 = await rpc("SendMessage", msg());
	assert.equal(bare1.data.result.task.status.state, "TASK_STATE_SUBMITTED");

	const patch1 = await rpc("message/send", msg(), { "a2a-version": "1.0.1" });
	assert.equal(patch1.data.result.task.status.state, "TASK_STATE_SUBMITTED");
	const patch03 = await rpc("SendMessage", msg(), { "A2A-Version": "0.3.0" });
	assert.equal(patch03.data.result.kind, "task");
	const short1 = await rpc("message/send", msg(), { "a2a-version": "1" });
	assert.equal(short1.data.result.task.status.state, "TASK_STATE_SUBMITTED");

	const query = await rpc("SendMessage", msg(), {}, "/?A2A-Version=0.3");
	assert.equal(query.data.result.kind, "task");
	assert.equal(query.data.result.status.state, "submitted");
	const headerWins = await rpc("SendMessage", msg(), { "a2a-version": "1.0" }, "/?A2A-Version=0.3");
	assert.equal(headerWins.data.result.task.status.state, "TASK_STATE_SUBMITTED");

	const created = bare1.data.result.task.id as string;
	const reread = await rpc("GetTask", { id: created }, { "a2a-version": "0.3" });
	assert.equal(reread.data.result.kind, "task");
	assert.equal(reread.data.result.status.state, "submitted");
	assert.equal(reread.data.result.id, created);

	for (const method of ["SendMessage", "no-such-method"]) {
		const bad = await rpc(method, msg(), { "a2a-version": "2.0" });
		assert.equal(bad.data.error?.code, -32009, method);
		assert.match(bad.data.error.message, /2\.0/);
	}
	const minor = await rpc("SendMessage", msg(), { "a2a-version": "1.2" });
	assert.equal(minor.data.error?.code, -32009);
	const unknown = await rpc("no-such-method", {});
	assert.equal(unknown.data.error?.code, -32601);
	const unknownOk = await rpc("no-such-method", {}, { "a2a-version": "1.0" });
	assert.equal(unknownOk.data.error?.code, -32601);

	for (const method of ["GetExtendedAgentCard", "agent/getAuthenticatedExtendedCard"]) {
		const missing = await rpc(method, {});
		assert.equal(missing.status, 200);
		assert.equal(missing.data.error?.code, -32007, method);
		assert.equal(missing.data.error?.message, "Extended agent card is not configured");
		const withHeader = await rpc(method, {}, { "a2a-version": "0.3" });
		assert.equal(withHeader.data.error?.code, -32007, method);
	}
	const extFirst = await rpc("GetExtendedAgentCard", {}, { "a2a-version": "2.0" });
	assert.equal(extFirst.data.error?.code, -32009);
});
