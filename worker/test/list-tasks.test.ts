// ListTasks returns a cursor. The page is this peer's tasks, newest update first. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { d1 } from "./d1.ts";

const BASE = "https://agent.example.com";

function setup() {
	const DB = d1(new URL("../migrations/", import.meta.url));
	const env: any = {
		DB, PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", AGENT_NAME: "Test Inbox", WAKE_PRESET: "generic",
	};
	const call = async (token: string, method: string, params: unknown) => {
		const res = await worker.fetch(new Request(BASE + "/", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		}) as any, env, { waitUntil() {}, passThroughOnException() {} } as any);
		const text = await res.text();
		let data: any = text;
		try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
		return { status: res.status, data, text };
	};
	const owner = async (method: string, path: string, json?: unknown) => {
		const res = await worker.fetch(new Request(BASE + path, {
			method, headers: { authorization: "Bearer owner-secret", "content-type": "application/json" },
			body: json === undefined ? undefined : JSON.stringify(json),
		}) as any, env, { waitUntil() {}, passThroughOnException() {} } as any);
		return res.json() as Promise<any>;
	};
	return { DB, call, owner };
}

function stamp(n: number): string {
	return `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`;
}

function decodeCursor(token: string): { updatedAt: string; id: string } {
	const pad = token.length % 4 === 0 ? "" : "=".repeat(4 - (token.length % 4));
	const text = Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString();
	const nl = text.indexOf("\n");
	return { updatedAt: text.slice(0, nl), id: text.slice(nl + 1) };
}

test("ListTasks pages with nextPageToken and stays on the caller", async () => {
	const s = setup();
	const ada = (await s.owner("POST", "/owner/peers", { label: "ada" })).token as string;
	const bob = (await s.owner("POST", "/owner/peers", { label: "bob" })).token as string;
	const insert = s.DB.db.prepare(`INSERT INTO tasks (id, context_id, peer, state, protocol, created_at, updated_at, status_json, artifacts_json, push_configs_json)
		VALUES (?, 'ctx-page', ?, 'submitted', '1.0', ?, ?, ?, '[]', '[]')`);
	const ids: string[] = [];
	for (let n = 1; n <= 16; n++) {
		const id = `t-${String(n).padStart(2, "0")}`;
		ids.push(id);
		// t-16 and t-15 share a timestamp so the tie breaks on id descending.
		const at = stamp(n === 15 ? 16 : n);
		insert.run(id, "ada", at, at, JSON.stringify({ state: "submitted", timestamp: at }));
	}
	insert.run("t-bob", "bob", stamp(30), stamp(30), JSON.stringify({ state: "submitted", timestamp: stamp(30) }));
	const expected = [...ids].reverse();
	assert.deepEqual(expected.slice(0, 2), ["t-16", "t-15"]);

	const seen: string[] = [];
	let token = "";
	let pages = 0;
	let total = -1;
	do {
		const page = await s.call(ada, "ListTasks", { pageSize: 5, ...(token ? { pageToken: token } : {}) });
		assert.equal(page.status, 200);
		assert.equal(page.data.error, undefined);
		const result = page.data.result;
		assert.equal(result.pageSize, 5);
		assert.equal(result.totalSize, 16);
		total = result.totalSize;
		const pageIds = (result.tasks as { id: string; contextId: string }[]).map((task) => task.id);
		assert.equal(pageIds.includes("t-bob"), false);
		assert.equal((result.tasks as { contextId: string }[]).every((task) => task.contextId === "ctx-page"), true);
		if (result.nextPageToken) {
			const cursor = decodeCursor(result.nextPageToken);
			assert.equal(cursor.id, pageIds[pageIds.length - 1]);
			assert.equal(result.tasks.length, 5);
		} else {
			assert.equal(result.nextPageToken, "");
		}
		seen.push(...pageIds);
		token = result.nextPageToken;
		pages++;
	} while (token);
	assert.equal(pages, 4);
	assert.equal(total, 16);
	assert.deepEqual(seen, expected);
	assert.equal(new Set(seen).size, 16);

	const bobPage = await s.call(bob, "ListTasks", { pageSize: 5 });
	assert.deepEqual((bobPage.data.result.tasks as { id: string }[]).map((task) => task.id), ["t-bob"]);
	assert.equal(bobPage.data.result.totalSize, 1);
	assert.equal(bobPage.data.result.nextPageToken, "");

	const filtered = await s.call(ada, "ListTasks", { contextId: "ctx-page", pageSize: 100 });
	assert.equal(filtered.data.result.totalSize, 16);
	assert.equal(filtered.data.result.pageSize, 100);
	assert.equal(filtered.data.result.nextPageToken, "");
	const empty = await s.call(ada, "ListTasks", { contextId: "ctx-none" });
	assert.deepEqual(empty.data.result, { tasks: [], nextPageToken: "", pageSize: 50, totalSize: 0 });
	const badContext = await s.call(ada, "ListTasks", { contextId: "bad id" });
	assert.equal(badContext.data.error?.code, -32602);

	const bad = "page-token-secret-value";
	const rejected = await s.call(ada, "ListTasks", { pageToken: bad });
	assert.deepEqual(rejected.data.error, { code: -32602, message: "Invalid params: pageToken" });
	assert.equal(rejected.text.includes(bad), false);
	const garbage = Buffer.from("not-a-cursor", "utf8").toString("base64url");
	const rejectedGarbage = await s.call(ada, "ListTasks", { pageToken: garbage });
	assert.equal(rejectedGarbage.data.error?.message, "Invalid params: pageToken");
	assert.equal(rejectedGarbage.text.includes(garbage), false);

	const absent = await s.call(ada, "tasks/list", {});
	assert.equal(absent.data.error?.code, -32601);
});
