// Push registration and inbox acknowledgement.
// A connector send attaches a push config only when the peer card advertises it, and stores the token
// hash before SendMessage returns. Inbox marks a reply seen only when the stored update is still the
// snapshot that response returned, on every storage backend this file runs against.
// Revoking the peer label clears that peer's push hashes. A later push with the old token is 401.
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

type OutSnap = {
	task_id?: string;
	context_id?: string;
	peer?: string;
	task_json?: string | null;
	updates_json?: string;
	updates_seen?: number;
	hash_cleared?: number;
};

test("revoking a peer rejects its old push token on the self-hosted and hosted paths", async (t) => {
	const logs: string[] = [];
	const origLog = console.log;
	console.log = (...args: unknown[]) => {
		logs.push(args.map((a) => String(a)).join(" "));
		origLog(...args);
	};
	const pushByHost = new Map<string, string>();
	const origFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(reqUrl(input));
		if (init?.method !== "POST") {
			return new Response(JSON.stringify(card(`https://${url.host}`, "1.0", true)), { status: 200, headers: { "content-type": "application/json" } });
		}
		const body = JSON.parse(String(init.body)) as { params?: { configuration?: { taskPushNotificationConfig?: { token?: string } } } };
		const token = body.params?.configuration?.taskPushNotificationConfig?.token || "";
		pushByHost.set(url.host, token);
		const taskId = url.host.startsWith("bea.") ? "task-bea" : "task-ada";
		const contextId = url.host.startsWith("bea.") ? "ctx-bea" : "ctx-ada";
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: taskResult(taskId, contextId, "1.0") }), { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	t.after(() => {
		globalThis.fetch = origFetch;
		console.log = origLog;
	});

	const secrets: string[] = [];
	const outputs: string[] = [];
	const hides = (blob: string, where: string) => {
		for (const secret of secrets) assert.equal(secret.length > 0 && blob.includes(secret), false, `${where} contains a token`);
	};

	for (const mode of ["single", "host"] as const) {
		pushByHost.clear();
		const db = d1(MIGRATIONS);
		const publicUrl = "https://owner.example.net";
		const ctx = mode === "single"
			? resolveTenant({ DB: db, PUBLIC_URL: publicUrl, OWNER_TOKEN: OWNER, AGENT_NAME: "Owner" } as WorkerBindings)
			: hostedTenantContext({
				DB: db, TENANCY: "host", TENANT_SECRETS_KEY: "platform-key", PUBLIC_URL: publicUrl, OWNER_TOKEN: "platform-owner",
			} as WorkerBindings, {
				id: "ten_revoke_push", db, publicUrl, ownerTokenHash: await sha256(OWNER), status: "active", config: { AGENT_NAME: "Owner" },
			});
		const http = (method: string, path: string, body?: unknown) => owner(ctx, method, path, body);
		const call = async (method: string, path: string, body?: unknown) => {
			if (mode === "single") return http(method, path, body);
			const res = await runOwnerRpc(ctx, ectx as never, {
				accountId: "acct_owner", method, path, ...(body === undefined ? {} : { body }),
			});
			const text = JSON.stringify(res.body);
			return { status: res.status, data: res.body, text };
		};
		const note = (res: { text: string }) => { outputs.push(res.text); return res; };

		const issue = async (label: string) => {
			const issued = await http("POST", "/owner/peers", { label });
			assert.equal(issued.status, 200, issued.text);
			const token = (issued.data as { token?: string }).token || "";
			assert.match(token, /^a2aow_/);
			secrets.push(token);
			return token;
		};
		const beaBearer = await issue("bea");
		const adaBearer = await issue("ada");
		for (const [alias, bearer] of [["bea", beaBearer], ["ada", adaBearer]] as const) {
			const synced = note(await call("PUT", `/owner/outbound-peers/${alias}`, { url: `https://${alias}.example.net`, token: bearer }));
			assert.equal(synced.status, 200, synced.text);
			assert.equal(JSON.stringify(synced.data).includes(bearer), false);
		}
		for (const alias of ["bea", "ada"] as const) {
			const sent = note(await call("POST", "/owner/mcp/send", { to: alias, text: `hello ${alias}`, contextId: `ctx-${alias}` }));
			assert.equal(sent.status, 200, sent.text);
			assert.equal((sent.data as SendBody).isError, false, sent.text);
			assert.match((sent.data as SendBody).text || "", new RegExp(`task task-${alias}`));
		}
		const beaPush = pushByHost.get("bea.example.net") || "";
		const adaPush = pushByHost.get("ada.example.net") || "";
		assert.equal(beaPush.length > 0 && adaPush.length > 0 && beaPush !== adaPush, true);
		secrets.push(beaPush, adaPush);
		const pendingToken = "pending-push-token";
		secrets.push(pendingToken);
		await db.prepare(
			`INSERT INTO outbound (task_id, context_id, peer, endpoint, protocol, push_token_hash, sent_at, updates_json, updates_seen)
			 VALUES ('pend.revoked', 'ctx-bea', 'bea', 'https://bea.example.net/', '1.0', ?, '2026-01-01T00:00:00.000Z', '[]', 0)`,
		).bind(await sha256(pendingToken)).run();

		const missed = note(await call("DELETE", "/owner/peers/nobody"));
		assert.equal(missed.status, 404, missed.text);
		const beforeRevoke = await db.prepare("SELECT push_token_hash IS NULL AS cleared FROM outbound WHERE task_id = ?").bind("task-bea").first() as { cleared?: number };
		assert.equal(Number(beforeRevoke.cleared), 0);

		const revoked = note(await call("DELETE", "/owner/peers/bea"));
		assert.equal(revoked.status, 200, revoked.text);
		assert.deepEqual(revoked.data, { revoked: true, label: "bea" });
		const again = note(await call("DELETE", "/owner/peers/bea"));
		assert.equal(again.status, 404, again.text);

		const cleared = async (taskId: string) => Number((await db.prepare("SELECT push_token_hash IS NULL AS cleared FROM outbound WHERE task_id = ?").bind(taskId).first() as { cleared?: number }).cleared);
		assert.equal(await cleared("task-bea"), 1);
		assert.equal(await cleared("pend.revoked"), 1);
		assert.equal(await cleared("task-ada"), 0);

		const snap = async (taskId: string) => await db.prepare(
			`SELECT task_id, context_id, peer, task_json, updates_json, updates_seen, push_token_hash IS NULL AS hash_cleared
			 FROM outbound WHERE task_id = ?`,
		).bind(taskId).first() as OutSnap;
		const histCount = async (contextId: string) => Number((await db.prepare("SELECT COUNT(*) AS n FROM history WHERE context_id = ?").bind(contextId).first() as { n: number }).n);
		const taskCount = async () => Number((await db.prepare("SELECT COUNT(*) AS n FROM tasks").first() as { n: number }).n);
		const beaBefore = await snap("task-bea");
		const beaHist = await histCount("ctx-bea");
		const tasksBefore = await taskCount();
		const push = async (token: string, taskId: string, text: string) => {
			const res = await dispatch(new Request("https://owner.example.net/push", {
				method: "POST",
				headers: { "content-type": "application/json", "x-a2a-notification-token": token },
				body: JSON.stringify({ task: { id: taskId, contextId: "ctx-bea", status: { state: "completed", message: { parts: [{ text }] } } } }),
			}), ctx, ectx as never);
			const body = await res.text();
			outputs.push(body);
			return { status: res.status, body };
		};
		const rejected = await push(beaPush, "task-bea", "revoked reply");
		assert.equal(rejected.status, 401);
		assert.equal(rejected.body, '{"error":"unauthorized"}');
		assert.deepEqual(await snap("task-bea"), beaBefore);
		assert.equal(await histCount("ctx-bea"), beaHist);
		assert.equal(await taskCount(), tasksBefore);
		const wake = await db.prepare("SELECT pending_json FROM wakes WHERE context_id = ?").bind("ctx-bea").first() as { pending_json?: string | null } | null;
		assert.equal(wake?.pending_json ?? null, null);

		const pending = await push(pendingToken, "task-claimed", "pending reply");
		assert.equal(pending.status, 401);
		assert.equal(pending.body, '{"error":"unauthorized"}');
		assert.equal(await cleared("pend.revoked"), 1);
		const claimed = await db.prepare("SELECT task_id FROM outbound WHERE task_id = ?").bind("task-claimed").first();
		assert.equal(claimed, null);
		assert.equal(await histCount("ctx-bea"), beaHist);
		assert.deepEqual(await snap("task-bea"), beaBefore);

		const standin = "restored-push-token";
		secrets.push(standin);
		await db.prepare("UPDATE outbound SET push_token_hash = ? WHERE task_id = ?").bind(await sha256(standin), "task-bea").run();
		const restored = await push(standin, "task-bea", "restored reply");
		assert.equal(restored.status, 401);
		assert.equal(restored.body, '{"error":"unauthorized"}');
		const afterRestore = await snap("task-bea");
		assert.equal(Number(afterRestore.hash_cleared), 0);
		assert.equal(afterRestore.task_json, beaBefore.task_json);
		assert.equal(afterRestore.updates_json, beaBefore.updates_json);
		assert.equal(afterRestore.updates_seen, beaBefore.updates_seen);
		assert.equal(await histCount("ctx-bea"), beaHist);

		const accepted = await dispatch(new Request("https://owner.example.net/push", {
			method: "POST",
			headers: { "content-type": "application/json", "x-a2a-notification-token": adaPush },
			body: JSON.stringify({ task: { id: "task-ada", contextId: "ctx-ada", status: { state: "completed", message: { parts: [{ text: "ada reply" }] } } } }),
		}), ctx, ectx as never);
		const acceptedText = await accepted.text();
		outputs.push(acceptedText);
		assert.equal(accepted.status, 200, acceptedText);
		const adaRow = await snap("task-ada");
		assert.match(String(adaRow.updates_json), /ada reply/);
		assert.equal(Number(adaRow.hash_cleared), 0);
		const adaHist = note(await call("GET", "/owner/history/ctx-ada"));
		assert.equal((adaHist.data as Hist[]).some((r) => r.event === "push" && r.text === "ada reply"), true, adaHist.text);
		const beaHistory = note(await call("GET", "/owner/history/ctx-bea"));
		assert.equal((beaHistory.data as Hist[]).some((r) => r.text === "revoked reply" || r.text === "pending reply" || r.text === "restored reply"), false, beaHistory.text);
		assert.deepEqual(await snap("task-bea"), afterRestore);
	}

	hides(outputs.join("\n"), "response");
	hides(logs.join("\n"), "log");
	for (const secret of secrets) {
		const hash = await sha256(secret);
		assert.equal(outputs.join("\n").includes(hash), false, "response contains a token hash");
		assert.equal(logs.join("\n").includes(hash), false, "log contains a token hash");
	}
});
