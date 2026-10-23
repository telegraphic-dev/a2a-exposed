// A peer must not post into another peer's conversation by reusing its contextId.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { d1 } from "./d1.ts";

const BASE = "https://agent.example.com";
const UNKNOWN = "Invalid params: unknown contextId (omit contextId to start a new conversation, then use the one returned)";

function setup() {
	const DB = d1(new URL("../migrations/", import.meta.url));
	const env: any = {
		DB, PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret", AGENT_NAME: "Test Inbox", WAKE_PRESET: "generic",
		WAKE_DEBOUNCE_SECONDS: "3600", WAKE_WEBHOOK_URL: "https://hook.example.net/wake", WAKE_WEBHOOK_KEY: "hook-key",
	};
	const origFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response("ok")) as typeof fetch;
	const call = async (method: string, path: string, json?: unknown, auth = "Bearer owner-secret") => {
		const headers: Record<string, string> = { authorization: auth, "content-type": "application/json", "cf-connecting-ip": "198.51.100.7" };
		const pending: Promise<unknown>[] = [];
		const res = await worker.fetch(new Request(BASE + path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) }) as any,
			env, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as any);
		await Promise.allSettled(pending);
		const text = await res.text();
		let data: any = text;
		try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
		return { status: res.status, data, text };
	};
	const owner = (method: string, path: string, json?: unknown) => call(method, path, json);
	const send = (token: string, text: string, contextId?: string, method = "message/send") => call("POST", "/", {
		jsonrpc: "2.0", id: 1, method,
		params: { message: { kind: "message", role: "user", messageId: crypto.randomUUID(), ...(contextId ? { contextId } : {}), parts: [{ kind: "text", text }] } },
	}, `Bearer ${token}`);
	return { DB, owner, send, restore: () => { globalThis.fetch = origFetch; } };
}

test("another peer's contextId is refused without joining that conversation", async (t) => {
	const s = setup();
	t.after(s.restore);
	const ada = (await s.owner("POST", "/owner/peers", { label: "ada" })).data.token as string;
	const bob = (await s.owner("POST", "/owner/peers", { label: "bob" })).data.token as string;
	assert.match(ada, /^a2aow_/);
	assert.match(bob, /^a2aow_/);

	const first = await s.send(ada, "y-one", "ctx-y");
	assert.equal(first.status, 200, first.text);
	assert.equal(first.data.result.contextId, "ctx-y");
	const second = await s.send(ada, "y-two", "ctx-y");
	assert.equal(second.status, 200, second.text);
	assert.equal(second.data.result.contextId, "ctx-y");

	const history = () => s.owner("GET", "/owner/history/ctx-y");
	const beforeHist = await history();
	assert.equal(beforeHist.status, 200, beforeHist.text);
	const beforeTexts = (beforeHist.data as { text: string }[]).map((r) => r.text);
	assert.deepEqual(beforeTexts, ["y-one", "y-two"]);
	const wake = () => s.DB.db.prepare("SELECT context_id, peer, last_sent_ms, pending_json, pending_since_ms FROM wakes WHERE context_id = 'ctx-y' AND peer = 'ada'").get() as {
		pending_json: string; peer: string; last_sent_ms: number; pending_since_ms: number;
	};
	const beforeWake = wake();
	assert.equal(beforeWake.peer, "ada");
	const pending = JSON.parse(beforeWake.pending_json);
	assert.equal(pending.from, "ada");
	assert.equal(pending.preview, "y-two");
	assert.equal(pending.taskIds.includes(second.data.result.id), true);

	const foreign = await s.send(bob, "x-inject", "ctx-y");
	const foreignV1 = await s.send(bob, "x-inject-v1", "ctx-y", "SendMessage");
	assert.deepEqual(foreign.data.error, { code: -32602, message: UNKNOWN });
	assert.deepEqual(foreignV1.data.error, foreign.data.error);
	const body = JSON.stringify(foreign.data);
	assert.equal(body.includes("ada"), false);
	assert.equal(body.includes("ctx-y"), false);
	assert.equal(body.includes("y-one"), false);
	assert.equal(body.includes("y-two"), false);
	assert.equal(body.includes("exists"), false);
	assert.equal(body.includes(ada), false);
	assert.equal(body.includes(bob), false);

	const afterHist = await history();
	assert.deepEqual(afterHist.data, beforeHist.data);
	assert.deepEqual(wake(), beforeWake);
	const db = s.DB.db;
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE context_id = 'ctx-y' AND peer = 'bob'").get() as { n: number }).n, 0);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM history WHERE context_id = 'ctx-y' AND peer = 'bob'").get() as { n: number }).n, 0);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM wakes WHERE context_id = 'ctx-y' AND peer = 'bob'").get() as { n: number }).n, 0);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE context_id = 'ctx-y' AND message_json LIKE '%x-inject%'").get() as { n: number }).n, 0);

	assert.equal((db.prepare("SELECT peer FROM conversation_owners WHERE context_id = 'ctx-y'").get() as { peer: string }).peer, "ada");

	const follow = await s.send(ada, "y-three", "ctx-y");
	assert.equal(follow.status, 200, follow.text);
	assert.equal(follow.data.result.contextId, "ctx-y");
	const texts = ((await history()).data as { text: string; peer: string }[]).map((r) => r.text);
	assert.deepEqual(texts, ["y-one", "y-two", "y-three"]);
	const after = JSON.parse(wake().pending_json);
	assert.equal(after.from, "ada");
	assert.equal(after.preview, "y-three");
	assert.equal(String(after.preview).includes("x-inject"), false);
	assert.equal(after.taskIds.includes(follow.data.result.id), true);
	assert.equal(after.taskIds.includes(second.data.result.id), true);

	const own = await s.send(bob, "x-own", "ctx-x");
	assert.equal(own.status, 200, own.text);
	assert.equal(own.data.result.contextId, "ctx-x");
	const again = await s.send(bob, "x-again", "ctx-x");
	assert.equal(again.status, 200, again.text);
	assert.equal(again.data.result.contextId, "ctx-x");
	const bobHist = await s.owner("GET", "/owner/history/ctx-x");
	assert.deepEqual((bobHist.data as { text: string }[]).map((r) => r.text), ["x-own", "x-again"]);
	assert.deepEqual(((await history()).data as { text: string }[]).map((r) => r.text), ["y-one", "y-two", "y-three"]);
	assert.equal(JSON.parse(wake().pending_json).from, "ada");
	assert.equal(JSON.parse(wake().pending_json).preview, "y-three");
	assert.equal((db.prepare("SELECT peer FROM conversation_owners WHERE context_id = 'ctx-x'").get() as { peer: string }).peer, "bob");
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM conversation_owners WHERE context_id = 'ctx-y'").get() as { n: number }).n, 1);
});

test("two peers cannot both claim one unused contextId", async (t) => {
	const s = setup();
	t.after(s.restore);
	const ada = (await s.owner("POST", "/owner/peers", { label: "ada" })).data.token as string;
	const bob = (await s.owner("POST", "/owner/peers", { label: "bob" })).data.token as string;
	let arrived = 0;
	let openGate = () => {};
	const gate = new Promise<void>((resolve) => { openGate = resolve; });
	const orig = s.DB.batch.bind(s.DB);
	s.DB.batch = async (stmts: { __sql?: string }[]) => {
		const claim = stmts.some((st) => typeof st.__sql === "string" && st.__sql.includes("INSERT INTO conversation_owners"));
		if (!claim || arrived >= 2) return orig(stmts);
		arrived++;
		if (arrived === 2) openGate();
		await gate;
		return orig(stmts);
	};
	const [left, right] = await Promise.all([
		s.send(ada, "from-ada", "ctx-race"),
		s.send(bob, "from-bob", "ctx-race"),
	]);
	assert.equal(arrived, 2);
	const ok = [left, right].filter((r) => r.status === 200 && !r.data.error);
	const denied = [left, right].filter((r) => r.data?.error);
	assert.equal(ok.length, 1, JSON.stringify([left.data, right.data]));
	assert.equal(denied.length, 1);
	assert.deepEqual(denied[0].data.error, { code: -32602, message: UNKNOWN });
	assert.equal(ok[0].data.result.contextId, "ctx-race");
	const body = JSON.stringify(denied[0].data);
	for (const secret of ["ada", "bob", "ctx-race", "from-ada", "from-bob", "exists", ada, bob]) assert.equal(body.includes(secret), false, secret);

	const db = s.DB.db;
	const owners = db.prepare("SELECT peer FROM conversation_owners WHERE context_id = 'ctx-race'").all() as { peer: string }[];
	assert.equal(owners.length, 1);
	const winner = owners[0].peer;
	const loser = winner === "ada" ? "bob" : "ada";
	assert.equal(winner === "ada" || winner === "bob", true);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE context_id = 'ctx-race'").get() as { n: number }).n, 1);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE context_id = 'ctx-race' AND peer = ?").get(loser) as { n: number }).n, 0);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM history WHERE context_id = 'ctx-race' AND peer = ?").get(loser) as { n: number }).n, 0);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE context_id = 'ctx-race' AND message_json LIKE ?").get(`%from-${loser}%`) as { n: number }).n, 0);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM wakes WHERE context_id = 'ctx-race' AND peer = ?").get(loser) as { n: number }).n, 0);

	const follow = await s.send(winner === "ada" ? ada : bob, "follow", "ctx-race");
	assert.equal(follow.status, 200, follow.text);
	assert.equal(follow.data.result.contextId, "ctx-race");
	const hist = await s.owner("GET", "/owner/history/ctx-race");
	assert.deepEqual((hist.data as { text: string; peer: string }[]).map((r) => r.text), [winner === "ada" ? "from-ada" : "from-bob", "follow"]);
	assert.equal((hist.data as { peer: string }[]).every((r) => r.peer === winner), true);
	const again = await s.send(loser === "ada" ? ada : bob, "still-no", "ctx-race");
	assert.deepEqual(again.data.error, { code: -32602, message: UNKNOWN });
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE context_id = 'ctx-race' AND peer = ?").get(loser) as { n: number }).n, 0);
});
