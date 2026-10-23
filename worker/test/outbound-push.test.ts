// Push registration and inbox acknowledgement.
// A connector send attaches a push config only when the peer card advertises it, and stores the token
// hash before SendMessage returns. Inbox marks a reply seen only when the stored update is still the
// snapshot that response returned, on every storage backend this file runs against.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "../src/a2a.ts";
import { dispatch, runOwnerRpc } from "../src/index.ts";
import { hostedTenantContext, resolveTenant, type WorkerBindings } from "../src/tenancy.ts";
import { d1 } from "./d1.ts";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const ectx = { waitUntil(_p: Promise<unknown>) {}, passThroughOnException() {} };
const OWNER = "owner-secret";

type Row = { taskId?: string; contextId?: string; text?: string; kind?: string; state?: string | null };
type Hist = { event?: string; text?: string; state?: string | null };
type SendBody = { text?: string; isError?: boolean };

function reqUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

function single(url: string) {
	const db = d1(MIGRATIONS);
	const ctx = resolveTenant({ DB: db, PUBLIC_URL: url, OWNER_TOKEN: OWNER, AGENT_NAME: "Owner" } as WorkerBindings);
	return { db, ctx };
}

async function owner(ctx: ReturnType<typeof resolveTenant>, method: string, path: string, body?: unknown) {
	const res = await dispatch(new Request(ctx.PUBLIC_URL + path, {
		method, headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	}), ctx, ectx as never);
	const text = await res.text();
	let data: unknown = text;
	try { data = JSON.parse(text); } catch { /* plain */ }
	return { status: res.status, data, text };
}

function card(url: string, version: string, push: boolean | undefined) {
	const body: Record<string, unknown> = {
		name: "Peer",
		url: `${url}/`,
		supportedInterfaces: [{ url: `${url}/`, protocolBinding: "JSONRPC", protocolVersion: version }],
	};
	if (push !== undefined) body.capabilities = { pushNotifications: push };
	return body;
}

function taskResult(id: string, contextId: string, version: string) {
	const task = { id, contextId, status: { state: version.startsWith("1") ? "TASK_STATE_COMPLETED" : "completed" } };
	return version.startsWith("1") ? { task } : task;
}

/** Run `inject` after the inbox's outbound read returns and before that read's caller continues. */
function duringOutboundRead(db: { prepare: (sql: string) => any }, inject: () => Promise<void>) {
	const orig = db.prepare.bind(db);
	let fired = false;
	db.prepare = (sql: string) => {
		const built = orig(sql);
		if (fired || !sql.includes("FROM outbound WHERE updates_json")) return built;
		const wrap = (s: any): any => {
			const origAll = s.all.bind(s);
			const origBind = s.bind.bind(s);
			s.bind = (...a: unknown[]) => wrap(origBind(...a));
			s.all = async () => {
				const rows = await origAll();
				if (fired) return rows;
				fired = true;
				db.prepare = orig;
				await inject();
				return rows;
			};
			return s;
		};
		return wrap(built);
	};
}

async function seedReply(db: { prepare: (sql: string) => any }, taskId: string, contextId: string, token: string, text: string) {
	const updates = JSON.stringify([{
		receivedAt: "2026-01-01T00:00:00.000Z",
		payload: { task: { id: taskId, contextId, status: { state: "completed", message: { parts: [{ text }] } } } },
	}]);
	await db.prepare(
		`INSERT INTO outbound (task_id, context_id, peer, endpoint, protocol, push_token_hash, sent_at, updates_json, updates_seen)
		 VALUES (?, ?, 'ada', 'https://ada.example.net/', '1.0', ?, '2026-01-01T00:00:00.000Z', ?, 0)`,
	).bind(taskId, contextId, await sha256(token), updates).run();
	await db.prepare("INSERT INTO wakes (context_id, last_sent_ms) VALUES (?, ?)").bind(contextId, Date.now()).run();
}

test("a push between the inbox read and the seen mark stays unseen", async () => {
	const { db, ctx } = single("https://owner.example.net");
	const token = "push-token-seen";
	await seedReply(db, "task-seen", "ctx-seen", token, "first reply");
	duringOutboundRead(db, async () => {
		const push = await dispatch(new Request("https://owner.example.net/push", {
			method: "POST",
			headers: { "content-type": "application/json", "x-a2a-notification-token": token },
			body: JSON.stringify({ task: { id: "task-seen", contextId: "ctx-seen", status: { state: "completed", message: { parts: [{ text: "newer reply" }] } } } }),
		}), ctx, ectx as never);
		assert.equal(push.status, 200);
	});
	const first = await owner(ctx, "GET", "/owner/inbox");
	assert.equal(first.status, 200, first.text);
	const shown = (first.data as Row[]).find((r) => r.kind === "outbound" && r.taskId === "task-seen");
	assert.equal(shown?.text, "first reply");
	const mid = await db.prepare("SELECT updates_seen, updates_json FROM outbound WHERE task_id = ?").bind("task-seen").first() as { updates_seen?: number; updates_json?: string };
	assert.equal(Number(mid.updates_seen), 0);
	assert.match(String(mid.updates_json), /newer reply/);
	const wake = await db.prepare("SELECT pending_json FROM wakes WHERE context_id = ?").bind("ctx-seen").first() as { pending_json?: string } | null;
	assert.match(String(wake?.pending_json), /outbound_update/);
	const second = await owner(ctx, "GET", "/owner/inbox");
	const again = (second.data as Row[]).find((r) => r.kind === "outbound" && r.taskId === "task-seen");
	assert.equal(again?.text, "newer reply");
	const done = await db.prepare("SELECT updates_seen FROM outbound WHERE task_id = ?").bind("task-seen").first() as { updates_seen?: number };
	assert.equal(Number(done.updates_seen), 1);
	const cleared = await db.prepare("SELECT pending_json FROM wakes WHERE context_id = ?").bind("ctx-seen").first() as { pending_json?: string | null };
	assert.equal(cleared.pending_json, null);
});

test("hosted inbox acknowledgement also waits for the returned snapshot", async () => {
	const db = d1(MIGRATIONS);
	const hash = await sha256("hosted-owner");
	const ctx = hostedTenantContext({
		DB: db, TENANCY: "host", TENANT_SECRETS_KEY: "platform-key", PUBLIC_URL: "https://owner.example.net", OWNER_TOKEN: "platform-owner",
	} as WorkerBindings, {
		id: "ten_seen", db, publicUrl: "https://owner.example.net", ownerTokenHash: hash, status: "active", config: { AGENT_NAME: "Owner" },
	});
	const token = "push-token-rpc";
	await seedReply(db, "task-rpc", "ctx-rpc", token, "first reply");
	duringOutboundRead(db, async () => {
		const push = await dispatch(new Request("https://owner.example.net/push", {
			method: "POST",
			headers: { "content-type": "application/json", "x-a2a-notification-token": token },
			body: JSON.stringify({ task: { id: "task-rpc", contextId: "ctx-rpc", status: { state: "completed", message: { parts: [{ text: "newer reply" }] } } } }),
		}), ctx, ectx as never);
		assert.equal(push.status, 200);
	});
	const read = () => runOwnerRpc(ctx, ectx as never, { accountId: "acct_seen", method: "GET", path: "/owner/inbox" });
	const first = await read();
	assert.equal(first.status, 200, JSON.stringify(first.body));
	const shown = (first.body as Row[]).find((r) => r.kind === "outbound" && r.taskId === "task-rpc");
	assert.equal(shown?.text, "first reply");
	const mid = await db.prepare("SELECT updates_seen FROM outbound WHERE task_id = ?").bind("task-rpc").first() as { updates_seen?: number };
	assert.equal(Number(mid.updates_seen), 0);
	const wake = await db.prepare("SELECT pending_json FROM wakes WHERE context_id = ?").bind("ctx-rpc").first() as { pending_json?: string } | null;
	assert.match(String(wake?.pending_json), /outbound_update/);
	const second = await read();
	const again = (second.body as Row[]).find((r) => r.kind === "outbound" && r.taskId === "task-rpc");
	assert.equal(again?.text, "newer reply");
	const done = await db.prepare("SELECT updates_seen FROM outbound WHERE task_id = ?").bind("task-rpc").first() as { updates_seen?: number };
	assert.equal(Number(done.updates_seen), 1);
});

test("send omits push unless the peer card advertises it", async (t) => {
	const { db, ctx } = single("https://owner.example.net");
	const seen: { host: string; configuration?: Record<string, unknown> }[] = [];
	const orig = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(reqUrl(input));
		if (init?.method !== "POST") {
			const push = url.host === "bea.example.net" ? false : undefined;
			return new Response(JSON.stringify(card(`https://${url.host}`, "1.0", push)), { status: 200, headers: { "content-type": "application/json" } });
		}
		const body = JSON.parse(String(init.body)) as { params?: { configuration?: Record<string, unknown> } };
		seen.push({ host: url.host, configuration: body.params?.configuration });
		const pend = await db.prepare("SELECT task_id FROM outbound WHERE task_id LIKE 'pend.%'").all() as { results: unknown[] };
		assert.equal(pend.results.length, 0);
		const id = url.host === "bea.example.net" ? "task-false" : "task-missing";
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: taskResult(id, "ctx-nopush", "1.0") }), { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	t.after(() => { globalThis.fetch = orig; });

	for (const [alias, url] of [["ada", "https://ada.example.net"], ["bea", "https://bea.example.net"]] as const) {
		const synced = await owner(ctx, "PUT", `/owner/outbound-peers/${alias}`, { url });
		assert.equal(synced.status, 200, synced.text);
	}
	for (const [alias, taskId] of [["ada", "task-missing"], ["bea", "task-false"]] as const) {
		const sent = await owner(ctx, "POST", "/owner/mcp/send", { to: alias, text: "hello", contextId: "ctx-nopush" });
		assert.equal(sent.status, 200, sent.text);
		assert.equal((sent.data as SendBody).isError, false, sent.text);
		assert.match((sent.data as SendBody).text || "", new RegExp(`task ${taskId}`));
		const row = await db.prepare("SELECT push_token_hash FROM outbound WHERE task_id = ?").bind(taskId).first() as { push_token_hash?: string | null };
		assert.equal(row.push_token_hash, null);
	}
	assert.equal(seen.length, 2);
	for (const call of seen) {
		assert.equal(call.configuration?.returnImmediately, true);
		assert.equal("taskPushNotificationConfig" in (call.configuration || {}), false);
		assert.equal("pushNotificationConfig" in (call.configuration || {}), false);
	}
});

test("the push hash is stored before SendMessage returns, and a fast callback authenticates", async (t) => {
	const { db, ctx } = single("https://owner.example.net");
	const outputs: string[] = [];
	let token = "";
	const orig = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(reqUrl(input));
		if (init?.method !== "POST") {
			const version = url.host === "cara.example.net" ? "0.3" : "1.0";
			return new Response(JSON.stringify(card(`https://${url.host}`, version, true)), { status: 200, headers: { "content-type": "application/json" } });
		}
		const body = JSON.parse(String(init.body)) as { params?: { configuration?: { taskPushNotificationConfig?: { token?: string }; pushNotificationConfig?: { token?: string } } } };
		const cfg = body.params?.configuration || {};
		const push = cfg.taskPushNotificationConfig || cfg.pushNotificationConfig;
		assert.equal(typeof push?.token, "string");
		token = push!.token!;
		if (url.host === "cara.example.net") {
			assert.equal("taskPushNotificationConfig" in cfg, false);
			assert.equal(typeof cfg.pushNotificationConfig?.token, "string");
		} else {
			assert.equal(typeof cfg.taskPushNotificationConfig?.token, "string");
		}
		const pend = await db.prepare("SELECT push_token_hash FROM outbound WHERE task_id LIKE 'pend.%'").all() as { results: { push_token_hash?: string }[] };
		assert.equal(pend.results.length, 1);
		assert.equal(pend.results[0]?.push_token_hash, await sha256(token));
		const taskId = url.host === "cara.example.net" ? "task-03" : "task-race";
		const contextId = url.host === "cara.example.net" ? "ctx-03" : "ctx-race";
		if (url.host !== "cara.example.net") {
			const pushRes = await dispatch(new Request("https://owner.example.net/push", {
				method: "POST",
				headers: { "content-type": "application/json", "x-a2a-notification-token": token },
				body: JSON.stringify({ task: { id: taskId, contextId, status: { state: "completed", message: { parts: [{ text: "raced reply" }] } } } }),
			}), ctx, ectx as never);
			const pushText = await pushRes.text();
			outputs.push(pushText);
			assert.equal(pushRes.status, 200, pushText);
		}
		const version = url.host === "cara.example.net" ? "0.3" : "1.0";
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: taskResult(taskId, contextId, version) }), { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	t.after(() => { globalThis.fetch = orig; });

	for (const [alias, url] of [["ada", "https://ada.example.net"], ["cara", "https://cara.example.net"]] as const) {
		const synced = await owner(ctx, "PUT", `/owner/outbound-peers/${alias}`, { url });
		assert.equal(synced.status, 200, synced.text);
	}
	const raced = await owner(ctx, "POST", "/owner/mcp/send", { to: "ada", text: "hello", contextId: "ctx-race" });
	outputs.push(raced.text);
	assert.equal((raced.data as SendBody).isError, false, raced.text);
	const racedToken = token;
	const racedRow = await db.prepare("SELECT task_id, push_token_hash, updates_json FROM outbound WHERE task_id = ?").bind("task-race").first() as { push_token_hash?: string; updates_json?: string };
	assert.equal(racedRow.push_token_hash, await sha256(racedToken));
	assert.match(String(racedRow.updates_json), /raced reply/);
	const pend = await db.prepare("SELECT task_id FROM outbound WHERE task_id LIKE 'pend.%'").all() as { results: unknown[] };
	assert.equal(pend.results.length, 0);
	const history = await owner(ctx, "GET", "/owner/history/ctx-race");
	assert.equal((history.data as Hist[]).some((r) => r.event === "push" && r.text === "raced reply"), true, history.text);
	const inbox = await owner(ctx, "GET", "/owner/inbox");
	outputs.push(inbox.text);
	const reply = (inbox.data as Row[]).find((r) => r.kind === "outbound" && r.taskId === "task-race");
	assert.equal(reply?.text, "raced reply");
	assert.equal(outputs.join("\n").includes(racedToken), false);

	const older = await owner(ctx, "POST", "/owner/mcp/send", { to: "cara", text: "hello", contextId: "ctx-03" });
	outputs.push(older.text);
	assert.equal((older.data as SendBody).isError, false, older.text);
	const oldRow = await db.prepare("SELECT push_token_hash FROM outbound WHERE task_id = ?").bind("task-03").first() as { push_token_hash?: string };
	assert.equal(oldRow.push_token_hash, await sha256(token));
	assert.equal(outputs.join("\n").includes(token), false);
});

test("a failed send drops an empty pending push row and keeps a callback that already arrived", async (t) => {
	const { db, ctx } = single("https://owner.example.net");
	let mode: "throw" | "push-then-throw" = "throw";
	const orig = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(reqUrl(input));
		if (init?.method !== "POST") return new Response(JSON.stringify(card(`https://${url.host}`, "1.0", true)), { status: 200, headers: { "content-type": "application/json" } });
		const body = JSON.parse(String(init.body)) as { params?: { configuration?: { taskPushNotificationConfig?: { token?: string } } } };
		const token = body.params?.configuration?.taskPushNotificationConfig?.token || "";
		const pend = await db.prepare("SELECT push_token_hash FROM outbound WHERE task_id LIKE 'pend.%'").all() as { results: { push_token_hash?: string }[] };
		assert.equal(pend.results.length, 1);
		assert.equal(pend.results[0]?.push_token_hash, await sha256(token));
		if (mode === "push-then-throw") {
			const push = await dispatch(new Request("https://owner.example.net/push", {
				method: "POST",
				headers: { "content-type": "application/json", "x-a2a-notification-token": token },
				body: JSON.stringify({ message: { taskId: "task-kept", contextId: "ctx-kept", role: "ROLE_AGENT", parts: [{ text: "kept reply" }] } }),
			}), ctx, ectx as never);
			assert.equal(push.status, 200);
		}
		throw new Error("peer down");
	}) as typeof fetch;
	t.after(() => { globalThis.fetch = orig; });
	const synced = await owner(ctx, "PUT", "/owner/outbound-peers/ada", { url: "https://ada.example.net" });
	assert.equal(synced.status, 200, synced.text);

	const failed = await owner(ctx, "POST", "/owner/mcp/send", { to: "ada", text: "hello", contextId: "ctx-fail" });
	assert.equal((failed.data as SendBody).isError, true, failed.text);
	const gone = await db.prepare("SELECT task_id FROM outbound").all() as { results: unknown[] };
	assert.equal(gone.results.length, 0);

	mode = "push-then-throw";
	const raced = await owner(ctx, "POST", "/owner/mcp/send", { to: "ada", text: "hello", contextId: "ctx-kept" });
	assert.equal((raced.data as SendBody).isError, true, raced.text);
	const kept = await db.prepare("SELECT task_id, updates_json FROM outbound").all() as { results: { task_id?: string; updates_json?: string }[] };
	assert.equal(kept.results.length, 1);
	assert.equal(kept.results[0]?.task_id, "task-kept");
	assert.match(String(kept.results[0]?.updates_json), /kept reply/);
	const history = await owner(ctx, "GET", "/owner/history/ctx-kept");
	assert.equal((history.data as Hist[]).some((r) => r.event === "push" && r.text === "kept reply"), true, history.text);
});

test("message and artifactUpdate pushes supply inbox text", async () => {
	const { db, ctx } = single("https://owner.example.net");
	const cases = [
		{ id: "t-msg", context: "ctx-msg", token: "tok-msg", text: "from message", state: null as string | null, body: { message: { taskId: "t-msg", contextId: "ctx-msg", role: "ROLE_AGENT", parts: [{ text: "from message" }] } } },
		{ id: "t-art", context: "ctx-art", token: "tok-art", text: "from artifact", state: null, body: { artifactUpdate: { taskId: "t-art", contextId: "ctx-art", artifact: { artifactId: "a1", parts: [{ text: "from artifact" }] } } } },
		{ id: "t-raw", context: "ctx-raw", token: "tok-raw", text: "raw artifact", state: null, body: { kind: "artifact-update", taskId: "t-raw", contextId: "ctx-raw", artifact: { artifactId: "a2", parts: [{ kind: "text", text: "raw artifact" }] } } },
		{ id: "t-st", context: "ctx-st", token: "tok-st", text: "from status", state: "completed", body: { statusUpdate: { taskId: "t-st", contextId: "ctx-st", status: { state: "TASK_STATE_COMPLETED", message: { parts: [{ text: "from status" }] } } } } },
	];
	for (const c of cases) {
		await db.prepare(
			`INSERT INTO outbound (task_id, context_id, peer, endpoint, protocol, push_token_hash, sent_at, updates_json, updates_seen)
			 VALUES (?, ?, 'ada', 'https://ada.example.net/', '1.0', ?, ?, '[]', 0)`,
		).bind(c.id, c.context, await sha256(c.token), `2026-01-01T00:00:0${cases.indexOf(c)}.000Z`).run();
		const push = await dispatch(new Request("https://owner.example.net/push", {
			method: "POST",
			headers: { "content-type": "application/json", "x-a2a-notification-token": c.token },
			body: JSON.stringify(c.body),
		}), ctx, ectx as never);
		assert.equal(push.status, 200, await push.clone().text());
	}
	const inbox = await owner(ctx, "GET", "/owner/inbox");
	assert.equal(inbox.status, 200, inbox.text);
	for (const c of cases) {
		const row = (inbox.data as Row[]).find((r) => r.taskId === c.id);
		assert.ok(row, inbox.text);
		assert.equal(row.kind, "outbound");
		assert.equal(row.text, c.text);
		assert.equal(row.state, c.state);
		const history = await owner(ctx, "GET", `/owner/history/${c.context}`);
		assert.equal((history.data as Hist[]).some((r) => r.event === "push" && r.text === c.text && r.state === c.state), true, history.text);
	}
});
