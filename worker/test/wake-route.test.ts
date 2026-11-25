// Wake routing: explicit wake and intent, legacy senders, dedup, batching, and shadow mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { sha256 } from "../src/a2a.ts";
import { d1 } from "./d1.ts";
import { decideRoute, isIdleWorkingPush, readRouteFields, routingMode, statusText } from "../src/wake-route.ts";
import { TOOLS } from "../src/mcp.ts";

const BASE = "https://agent.example.com";

test("routing rules are deterministic", () => {
	assert.equal(routingMode(undefined), "shadow");
	assert.equal(routingMode("nope"), "shadow");
	assert.equal(routingMode("enforce"), "enforce");
	assert.equal(statusText("  still   working \n"), "still working");
	assert.equal(isIdleWorkingPush("working", "", false), true);
	assert.equal(isIdleWorkingPush("TASK_STATE_WORKING", "  ", false), true);
	assert.equal(isIdleWorkingPush("working", "still going", false), false);
	assert.equal(isIdleWorkingPush("working", "", true), false);
	assert.equal(isIdleWorkingPush("completed", "", false), false);
	assert.deepEqual(readRouteFields(undefined, undefined), { ok: true, fields: { wake: null, intent: null } });
	assert.equal(readRouteFields({ "a2a.exposed/wake": "later" }, undefined).ok, false);
	assert.equal(readRouteFields({ "a2a.exposed/wake": "auto" }, { "a2a.exposed/wake": "never" }).ok, false);
	assert.deepEqual(readRouteFields(undefined, { "a2a.exposed/intent": "ack" }), { ok: true, fields: { wake: null, intent: "ack" } });

	const shadowAck = decideRoute({ mode: "shadow", wake: "auto", intent: "ack", duplicate: false, idle: false, unchanged: false });
	assert.equal(shadowAck.deliver, true);
	assert.equal(shadowAck.action, "shadow");
	assert.equal(shadowAck.proposed, "suppress");
	const enforceAck = decideRoute({ mode: "enforce", wake: null, intent: "ack", duplicate: false, idle: false, unchanged: false });
	assert.equal(enforceAck.deliver, false);
	assert.equal(enforceAck.action, "suppress");
	for (const intent of ["handoff", "blocker", "question"] as const) {
		const decision = decideRoute({ mode: "enforce", wake: "auto", intent, duplicate: false, idle: false, unchanged: false });
		assert.equal(decision.deliver, true, intent);
		assert.equal(decision.action, "wake", intent);
	}
	const changed = decideRoute({ mode: "enforce", wake: "auto", intent: "status", duplicate: false, idle: false, unchanged: false });
	assert.equal(changed.batch, true);
	assert.equal(changed.deliver, true);
	const idle = decideRoute({ mode: "enforce", wake: "auto", intent: "status", duplicate: false, idle: true, unchanged: false });
	assert.equal(idle.deliver, false);
	assert.equal(idle.decision, "status_idle");
	const same = decideRoute({ mode: "enforce", wake: "auto", intent: "status", duplicate: false, idle: false, unchanged: true });
	assert.equal(same.deliver, false);
	assert.equal(same.decision, "status_unchanged");
	const always = decideRoute({ mode: "enforce", wake: "always", intent: "ack", duplicate: false, idle: false, unchanged: false });
	assert.equal(always.deliver, true);
	assert.equal(always.decision, "always");
	const never = decideRoute({ mode: "shadow", wake: "never", intent: "handoff", duplicate: false, idle: false, unchanged: false });
	assert.equal(never.deliver, false);
	const legacy = decideRoute({ mode: "enforce", wake: null, intent: null, duplicate: false, idle: false, unchanged: false });
	assert.equal(legacy.decision, "legacy");
	assert.equal(legacy.deliver, true);
	const duplicate = decideRoute({ mode: "shadow", wake: "always", intent: "question", duplicate: true, idle: false, unchanged: false });
	assert.equal(duplicate.deliver, false);
	assert.equal(duplicate.decision, "duplicate");
	const unspecified = decideRoute({ mode: "enforce", wake: "auto", intent: null, duplicate: false, idle: false, unchanged: false });
	assert.equal(unspecified.decision, "auto_unspecified");
	assert.equal(unspecified.deliver, true);
});

test("the send tool advertises wake and intent and forbids ack loops", () => {
	const send = TOOLS.find((tool) => tool.name === "send");
	assert.ok(send);
	const props = send.inputSchema.properties as Record<string, { enum?: string[] }>;
	assert.deepEqual(props.wake.enum, ["auto", "always", "never"]);
	assert.deepEqual(props.intent.enum, ["handoff", "blocker", "question", "status", "ack"]);
	assert.match(send.description, /acknowledgement-only/);
	assert.match(send.description, /do not answer an ack/i);
});

function envFor(over: Record<string, string> = {}) {
	return {
		DB: d1(new URL("../migrations/", import.meta.url)), PUBLIC_URL: BASE, OWNER_TOKEN: "owner-secret",
		WAKE_PRESET: "generic", WAKE_WEBHOOK_URL: "https://hook.example.net/wake", WAKE_WEBHOOK_KEY: "k",
		WAKE_DEBOUNCE_SECONDS: "0", WAKE_BUSY_SECONDS: "0", ...over,
	};
}

function harness(env: ReturnType<typeof envFor>) {
	const sent: { contextId?: string; taskId?: string; taskIds?: string[]; kind?: string; preview?: string }[] = [];
	const logs: string[] = [];
	const origFetch = globalThis.fetch;
	const origLog = console.log;
	globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
		if (init?.body) sent.push(JSON.parse(String(init.body)));
		return new Response("ok", { status: 200 });
	}) as typeof fetch;
	console.log = (...args: unknown[]) => { logs.push(String(args[0])); };
	const call = async (method: string, path: string, json?: unknown, auth = "Bearer owner-secret") => {
		const pending: Promise<unknown>[] = [];
		const res = await worker.fetch(new Request(BASE + path, {
			method, headers: { "content-type": "application/json", authorization: auth },
			body: json === undefined ? undefined : JSON.stringify(json),
		}) as never, env, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as never);
		await Promise.allSettled(pending);
		const text = await res.text();
		let data: unknown = text;
		try { data = text ? JSON.parse(text) : null; } catch { /* plain */ }
		return { status: res.status, data };
	};
	const restore = () => { globalThis.fetch = origFetch; console.log = origLog; };
	return { sent, logs, call, restore };
}

function message(text: string, extra: Record<string, unknown> = {}, id = crypto.randomUUID()) {
	return {
		jsonrpc: "2.0", id: 1, method: "message/send",
		params: {
			message: {
				kind: "message", role: "user", messageId: id, parts: [{ kind: "text", text }],
				...(extra.message ? { metadata: extra.message } : {}),
				...(extra.contextId ? { contextId: extra.contextId } : {}),
				...(extra.taskId ? { taskId: extra.taskId } : {}),
			},
			...(extra.params ? { metadata: extra.params } : {}),
		},
	};
}

function taskIdOf(data: unknown): string {
	const body = data as { result?: { id?: string; task?: { id?: string } } };
	const id = body.result?.id || body.result?.task?.id;
	assert.equal(typeof id, "string", JSON.stringify(data));
	return id as string;
}

function routes(logs: string[]) {
	return logs.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((row) => row?.event === "wake_route");
}

test("always is still subject to the peer rate limit", async (t) => {
	const env = envFor({ RATE_PER_MIN: "1" });
	const h = harness(env);
	t.after(h.restore);
	const token = ((await h.call("POST", "/owner/peers", { label: "ada" })).data as { token: string }).token;
	const peer = `Bearer ${token}`;
	const first = await h.call("POST", "/", message("go", { contextId: "ctx-rate", message: { "a2a.exposed/wake": "always" } }), peer);
	assert.equal(typeof taskIdOf(first.data), "string");
	assert.equal(h.sent.length, 1);
	const limited = await h.call("POST", "/", message("again", { contextId: "ctx-rate", message: { "a2a.exposed/wake": "always" } }), peer);
	assert.equal(limited.status, 429);
	assert.equal(h.sent.length, 1);
});

test("a repeated push does not wake twice", async (t) => {
	const env = envFor();
	const h = harness(env);
	t.after(h.restore);
	const token = "push-token-dedup";
	await env.DB.prepare(
		`INSERT INTO outbound (task_id, context_id, peer, endpoint, protocol, push_token_hash, sent_at, updates_json, updates_seen)
		 VALUES ('task-push', 'ctx-push', 'ada', 'https://ada.example.net/', '0.3', ?, '2026-01-01T00:00:00.000Z', '[]', 0)`,
	).bind(await sha256(token)).run();
	const auth = `Bearer ${token}`;
	const body = { task: { id: "task-push", contextId: "ctx-push", status: { state: "working", message: { parts: [{ kind: "text", text: "same" }] } } } };
	assert.equal((await h.call("POST", "/push", body, auth)).status, 200);
	assert.equal(h.sent.length, 1);
	assert.equal((await h.call("POST", "/push", body, auth)).status, 200);
	assert.equal(h.sent.length, 1);
	assert.equal(routes(h.logs).at(-1).decision, "duplicate");
	const changed = { task: { id: "task-push", contextId: "ctx-push", status: { state: "completed", message: { parts: [{ kind: "text", text: "done" }] } } } };
	await h.call("POST", "/push", changed, auth);
	assert.equal(h.sent.length, 2);
	const stored = env.DB.db.prepare("SELECT updates_json FROM outbound WHERE task_id = 'task-push'").get() as { updates_json: string };
	assert.equal(JSON.parse(stored.updates_json).length, 3);
});

test("concurrent retries of one message id store one task and wake once", async (t) => {
	const env = envFor();
	const h = harness(env);
	t.after(h.restore);
	const token = ((await h.call("POST", "/owner/peers", { label: "ada" })).data as { token: string }).token;
	const peer = `Bearer ${token}`;
	const body = message("once", { contextId: "ctx-race", message: { "a2a.exposed/wake": "always" } }, "msg-race");
	const [a, b] = await Promise.all([h.call("POST", "/", body, peer), h.call("POST", "/", body, peer)]);
	assert.equal(a.status, 200, JSON.stringify(a.data));
	assert.equal(b.status, 200, JSON.stringify(b.data));
	assert.equal(taskIdOf(a.data), taskIdOf(b.data));
	assert.equal(h.sent.length, 1);
	const tasks = env.DB.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE context_id = 'ctx-race'").get() as { n: number };
	const msgs = env.DB.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE message_id = 'msg-race'").get() as { n: number };
	const claims = env.DB.db.prepare("SELECT COUNT(*) AS n FROM message_claims WHERE peer = 'ada' AND message_id = 'msg-race'").get() as { n: number };
	assert.equal(tasks.n, 1);
	assert.equal(msgs.n, 1);
	assert.equal(claims.n, 1);
});

test("a push with the same filename and different bytes still wakes", async (t) => {
	const env = envFor();
	const h = harness(env);
	t.after(h.restore);
	const token = "push-token-file";
	await env.DB.prepare(
		`INSERT INTO outbound (task_id, context_id, peer, endpoint, protocol, push_token_hash, sent_at, updates_json, updates_seen)
		 VALUES ('task-file', 'ctx-file', 'ada', 'https://ada.example.net/', '0.3', ?, '2026-01-01T00:00:00.000Z', '[]', 0)`,
	).bind(await sha256(token)).run();
	const auth = `Bearer ${token}`;
	const file = (bytes: string) => ({
		task: {
			id: "task-file", contextId: "ctx-file",
			status: { state: "working", message: { parts: [{ kind: "file", file: { name: "note.txt", bytes } }] } },
		},
	});
	assert.equal((await h.call("POST", "/push", file("aaa"), auth)).status, 200);
	assert.equal(h.sent.length, 1);
	assert.equal((await h.call("POST", "/push", file("bbb"), auth)).status, 200);
	assert.equal(h.sent.length, 2, "different file bytes are not a duplicate");
	assert.equal((await h.call("POST", "/push", file("bbb"), auth)).status, 200);
	assert.equal(h.sent.length, 2, "the same payload does not wake again");
});

test("purge drops message claims and status fingerprints", async (t) => {
	const env = envFor({ WAKE_ROUTING: "enforce" });
	const h = harness(env);
	t.after(h.restore);
	const token = ((await h.call("POST", "/owner/peers", { label: "ada" })).data as { token: string }).token;
	const peer = `Bearer ${token}`;
	const first = await h.call("POST", "/", message("building", {
		contextId: "ctx-purge", message: { "a2a.exposed/wake": "auto", "a2a.exposed/intent": "status" },
	}, "msg-purge"), peer);
	assert.equal(first.status, 200, JSON.stringify(first.data));
	const purged = await h.call("POST", "/owner/purge", { contexts: ["ctx-purge"] });
	assert.equal(purged.status, 200, JSON.stringify(purged.data));
	const claims = env.DB.db.prepare("SELECT COUNT(*) AS n FROM message_claims WHERE message_id = 'msg-purge'").get() as { n: number };
	const fps = env.DB.db.prepare("SELECT COUNT(*) AS n FROM wake_dedup WHERE ref = 'ctx-purge'").get() as { n: number };
	assert.equal(claims.n, 0);
	assert.equal(fps.n, 0);
	const before = h.sent.length;
	const retried = await h.call("POST", "/", message("building", {
		contextId: "ctx-purge", message: { "a2a.exposed/wake": "auto", "a2a.exposed/intent": "status" },
	}, "msg-purge"), peer);
	assert.equal(retried.status, 200, JSON.stringify(retried.data));
	assert.equal((retried.data as { error?: { code?: number } }).error, undefined);
	assert.notEqual(taskIdOf(retried.data), taskIdOf(first.data));
	assert.notEqual(routes(h.logs).at(-1).decision, "status_unchanged");
	assert.ok(h.sent.length > before, "the same status text wakes again after purge");
});

// Sanitized #408 replay; no live traffic or credentials.
test("an answer on an input-required inbound task wakes even when labelled ack or status", async (t) => {
 const env=envFor({WAKE_ROUTING:"staging-enforce",WAKE_ROUTING_ENV:"staging"});const h=harness(env);t.after(h.restore);
 const token=((await h.call("POST","/owner/peers",{label:"ada"})).data as {token:string}).token;
 const peer=`Bearer ${token}`;
 for (const intent of ["ack","status"]) {
  const first=await h.call("POST","/",message("request",{contextId:`await-${intent}`}),peer);
  const id=taskIdOf(first.data);
  const waiting=await h.call("POST",`/owner/tasks/${id}/reply`,{text:"Please answer",state:"input-required"});
  assert.equal(waiting.status,200);
  const before=h.sent.length;
  const answer=message(intent==="status"?"":"yes",{taskId:id,message:{"a2a.exposed/intent":intent}},`answer-${intent}`);
  assert.equal((await h.call("POST","/",answer,peer)).status,200);
  assert.equal(h.sent.length,before+1,`the ${intent}-labelled answer must wake`);
  assert.equal(routes(h.logs).at(-1).decision,"peer_attention");
  await h.call("POST","/",answer,peer);
  assert.equal(h.sent.length,before+1,"a retry must not wake twice");
  await h.call("POST",`/owner/tasks/${id}/reply`,{text:"Please answer again",state:"input-required"});
  const silent=message("silent",{taskId:id,message:{"a2a.exposed/wake":"never","a2a.exposed/intent":intent}});
  await h.call("POST","/",silent,peer);
  assert.equal(h.sent.length,before+1,"explicit never remains authoritative");
 }
});

async function peerId(h: ReturnType<typeof harness>, peer: string, direction = "inbound") {
 const listed = (await h.call("GET", "/owner/wake/peers")).data as any;
 return listed.peers.find((r:any) => r.peer === peer && r.direction === direction).peerId;
}
const defaults = { inbound: "wake", update: "wake", completed: "wake", attention: "wake", empty: "skip", ack: "skip" };

test("peer defaults apply in shadow/enforce and after global legacy opt-out", async (t) => {
 for (const mode of ["shadow", "enforce", "staging-enforce"]) {
  const env = envFor({ WAKE_ROUTING: mode }); const h = harness(env);
  try {
   const token = ((await h.call("POST", "/owner/peers", { label: "ada" })).data as {token:string}).token;
   const auth = `Bearer ${token}`;
   await h.call("PUT", "/owner/wake/policy", { policy: "legacy" });
   await h.call("POST", "/", message("ack", {message:{"a2a.exposed/intent":"ack","a2a.exposed/wake":"always"}}), auth);
   assert.equal(h.sent.length, 0, `${mode}: sender always does not override ack policy`);
   for (const text of ["", "status", "status"]) await h.call("POST", "/", message(text, {message:{"a2a.exposed/intent":"status"}}), auth);
   assert.equal(h.sent.length, 3, `${mode}: inbound messages wake by default`);
   await h.call("POST", "/", message("question", {message:{"a2a.exposed/wake":"never"}}), auth);
   assert.equal(h.sent.length, 3);
   const report = (await h.call("GET", "/owner/wake/routing")).data as any;
   assert.equal(report.suppressed, 2); assert.equal(report.shadow, 0); assert.equal(report.delivered, 3);
   assert.equal(JSON.stringify(routes(h.logs)).includes('question'), false);
  } finally { h.restore(); }
 }
});

test("owner lists choices and updates one existing pairing; peer credentials cannot administer", async () => {
 const h = harness(envFor());
 try {
  const token = ((await h.call("POST", "/owner/peers", {label:"ada"})).data as any).token;
  await h.call("POST", "/owner/peers", {label:"bob"});
  const listed = (await h.call("GET", "/owner/wake/peers")).data as any;
  assert.deepEqual(listed.actions, ["wake","skip","batch"]); assert.equal(listed.peers.length,2);
  const policy = {...defaults, inbound:"skip", ack:"wake"};
  assert.equal((await h.call("PUT", "/owner/wake/peers", {peerId:await peerId(h,"ada"),policy})).status,200);
  const again = (await h.call("GET", "/owner/wake/peers")).data as any;
  assert.deepEqual(again.peers.find((p:any)=>p.peer==='ada').policy,policy);
  assert.deepEqual(again.peers.find((p:any)=>p.peer==='bob').policy,defaults);
  for (const body of [{peerId:"inbound:"+"0".repeat(32),policy}, {peerId:await peerId(h,"ada"),policy:{}}, {peerId:await peerId(h,"ada"),policy:{...policy,extra:"wake"}}, {peerId:await peerId(h,"ada"),policy,extra:true}]) assert.ok([400,409].includes((await h.call("PUT","/owner/wake/peers",body)).status));
  assert.equal((await h.call("GET","/owner/wake/peers",undefined,`Bearer ${token}`)).status,401);
  assert.equal((await h.call("PUT","/owner/wake/peers",{peerId:await peerId(h,"ada"),policy},`Bearer ${token}`)).status,401);
  await h.call("POST","/",message("skip me"),`Bearer ${token}`); assert.equal(h.sent.length,0);
  await h.call("POST","/",message("ack",{message:{"a2a.exposed/intent":"ack"}}),`Bearer ${token}`); assert.equal(h.sent.length,1);
 } finally {h.restore();}
});

test("batch waits across cron requests, joins next wake, and survives failed delivery", async () => {
 const env = envFor({ ENABLE_CRON:"1" }); const h = harness(env);
 try {
  const token=((await h.call("POST","/owner/peers",{label:"ada"})).data as any).token;
  await h.call("PUT","/owner/wake/peers",{peerId:await peerId(h,"ada"),policy:{...defaults,inbound:"batch"}});
  const first=await h.call("POST","/",message("queued",{contextId:"ctx-held"}),`Bearer ${token}`);
  assert.equal(h.sent.length,0); await h.call("GET","/health"); assert.equal(h.sent.length,0);
  assert.equal(Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM peer_wake_batch").first() as any).n),1);
  await h.call("PUT","/owner/wake/peers",{peerId:await peerId(h,"ada"),policy:defaults});
  const realFetch=globalThis.fetch; globalThis.fetch=(async()=>new Response("failed",{status:500})) as typeof fetch;
  await h.call("POST","/",message("trigger",{contextId:"ctx-failed"}),`Bearer ${token}`);
  globalThis.fetch=realFetch;
  assert.equal(Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM peer_wake_batch").first() as any).n),1,"failed send retains marker");
  await h.call("POST","/",message("next",{contextId:"ctx-next"}),`Bearer ${token}`);
  const wake=h.sent.at(-1) as any;
  assert.equal(wake.hint.endsWith(' inbox'),true); assert.deepEqual(wake.batched,[{peer:"ada",contextId:"ctx-held",taskId:taskIdOf(first.data),kind:"inbound"}]);
  assert.equal(Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM peer_wake_batch").first() as any).n),0);
  const inbox=(await h.call("GET","/owner/inbox")).data as any[]; assert.ok(inbox.some(row=>row.taskId===taskIdOf(first.data)));
 } finally {h.restore();}
});

test("push defaults skip empty working/submitted and ack but wake terminal states and content", async () => {
 const env=envFor();const h=harness(env);
 try {
  const token='policy-push-token';await env.DB.prepare(`INSERT INTO outbound(task_id,context_id,peer,endpoint,protocol,push_token_hash,sent_at,updates_json,updates_seen) VALUES('task-policy','ctx-policy','ada','https://ada.example.net/','0.3',?,'2026-01-01','[]',0)`).bind(await sha256(token)).run();
  const push=(state:string,text?:string,intent?:string,wake?:string)=>h.call('POST','/push',{task:{id:'task-policy',status:{state,message:{parts:text?[{kind:'text',text}]:[],metadata:{...(intent?{'a2a.exposed/intent':intent}:{}),...(wake?{'a2a.exposed/wake':wake}:{})}}}}},`Bearer ${token}`);
  for(const state of ['working','submitted','TASK_STATE_WORKING','TASK_STATE_SUBMITTED']) await push(state);
  await push('working','ok','ack','always');assert.equal(h.sent.length,0);
  for(const state of ['completed','input-required','failed','TASK_STATE_COMPLETED','TASK_STATE_INPUT_REQUIRED','TASK_STATE_FAILED']) await push(state,undefined,'ack');
  assert.equal(h.sent.length,6);
  await push('working','progress');assert.equal(h.sent.length,7);
  await push('unknown');assert.equal(h.sent.length,8,'unknown updates wake');
  await push('completed','silent',undefined,'never');assert.equal(h.sent.length,8);
 } finally {h.restore();}
});

test("pairing IDs survive sync/rotation, distinguish directions, and reject stale revoked IDs", async () => {
 const env=envFor();const h=harness(env);
 try {
  await h.call('POST','/owner/peers',{label:'ada'});
  await h.call('PUT','/owner/outbound-peers/ada',{url:'https://ada.example.net/',token:'dummy-one'});
  const inbound=await peerId(h,'ada');const outbound=await peerId(h,'ada','outbound');assert.notEqual(inbound,outbound);
  assert.equal((await h.call('PUT','/owner/wake/peers',{peerId:outbound,policy:{...defaults,update:'batch'}})).status,200);
  await h.call('PUT','/owner/outbound-peers/ada',{url:'https://ada.example.net/',token:'dummy-two'});
  assert.equal(await peerId(h,'ada','outbound'),outbound);
  assert.equal(((await h.call('GET','/owner/wake/peers')).data as any).peers.find((r:any)=>r.peerId===outbound).policy.update,'batch');
  await env.DB.prepare("UPDATE peers SET token_hash=? WHERE label='ada'").bind(await sha256('rotated')).run();
  assert.equal(await peerId(h,'ada'),inbound);
  await h.call('DELETE','/owner/peers/ada');
  assert.equal((await h.call('PUT','/owner/wake/peers',{peerId:inbound,policy:defaults})).status,409);
  await h.call('POST','/owner/peers',{label:'ada'});assert.notEqual(await peerId(h,'ada'),inbound);
 } finally {h.restore();}
});

test("late accepted batch snapshot cannot delete a marker reinserted after earlier acceptance", async () => {
 const env=envFor();const h=harness(env);
 try {
  const token=((await h.call('POST','/owner/peers',{label:'ada'})).data as any).token;
  const id=await peerId(h,'ada');await h.call('PUT','/owner/wake/peers',{peerId:id,policy:{...defaults,inbound:'batch'}});
  await h.call('POST','/',message('held',{contextId:'ctx-race-batch'}),`Bearer ${token}`);
  const old=await env.DB.prepare('SELECT * FROM peer_wake_batch').first() as any;
  await env.DB.prepare('DELETE FROM peer_wake_batch').run();
  await env.DB.prepare('INSERT INTO peer_wake_batch(peer_id,peer,context_id,task_id,kind,generation) VALUES(?,?,?,?,?,?)').bind(old.peer_id,old.peer,old.context_id,old.task_id,old.kind,crypto.randomUUID()).run();
  const deleted=await env.DB.prepare('DELETE FROM peer_wake_batch WHERE peer_id=? AND context_id=? AND task_id=? AND generation=?').bind(old.peer_id,old.context_id,old.task_id,old.generation).run();
  assert.equal(deleted.meta.changes,0);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM peer_wake_batch').first() as any).n,1);
 } finally {h.restore();}
});

test("batch markers are retained without a configured hook or when a custom template omits them", async () => {
 for(const config of [{WAKE_WEBHOOK_URL:""},{WAKE_BODY_TEMPLATE:'{"notification":"custom"}'}]) {
  const env=envFor(config);const h=harness(env);
  try {
   const token=((await h.call('POST','/owner/peers',{label:'ada'})).data as any).token;
   const id=await peerId(h,'ada');await h.call('PUT','/owner/wake/peers',{peerId:id,policy:{...defaults,inbound:'batch'}});
   await h.call('POST','/',message('held'),`Bearer ${token}`);
   await h.call('PUT','/owner/wake/peers',{peerId:id,policy:defaults});
   await h.call('POST','/',message('trigger'),`Bearer ${token}`);
   assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM peer_wake_batch').first() as any).n,1);
  } finally {h.restore();}
 }
});

test("message and batch marker roll back together when marker persistence fails", async () => {
 const env=envFor();const h=harness(env);
 try {
  const token=((await h.call('POST','/owner/peers',{label:'ada'})).data as any).token;
  const id=await peerId(h,'ada');await h.call('PUT','/owner/wake/peers',{peerId:id,policy:{...defaults,inbound:'batch'}});
  const batch=env.DB.batch.bind(env.DB);let armed=true;
  env.DB.batch=async statements=>{
   const at=statements.findIndex((s:any)=>s.__sql?.includes('INSERT INTO peer_wake_batch'));
   if(armed&&at>=0){armed=false;const failed=[...statements];failed[at]=env.DB.prepare('SELECT * FROM intentional_missing_batch_table');return batch(failed);}
   return batch(statements);
  };
  const body=message('must recover',{contextId:'ctx-atomic'},'msg-atomic');
  await h.call('POST','/',body,`Bearer ${token}`);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM tasks').first() as any).n,0);
  const retry=await h.call('POST','/',body,`Bearer ${token}`);assert.ok(taskIdOf(retry.data));
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM peer_wake_batch').first() as any).n,1);assert.equal(h.sent.length,0);
 }finally{h.restore();}
});

test("callbacks retain the original pairing and batch atomically with updates", async () => {
 const env=envFor();const h=harness(env);
 try {
  await h.call('PUT','/owner/outbound-peers/ada',{url:'https://ada.example.net/',token:'dummy-peer'});
  const id=await peerId(h,'ada','outbound');await h.call('PUT','/owner/wake/peers',{peerId:id,policy:{...defaults,update:'batch'}});
  const pushToken='atomic-push';await env.DB.prepare(`INSERT INTO outbound(task_id,context_id,peer,endpoint,protocol,push_token_hash,sent_at,updates_json,updates_seen,wake_policy_peer_id) VALUES('task-atomic','ctx-atomic-push','ada','https://ada.example.net/','0.3',?,'2026-01-01','[]',0,?)`).bind(await sha256(pushToken),id).run();
  const batch=env.DB.batch.bind(env.DB);let armed=true;
  env.DB.batch=async statements=>{
   const at=statements.findIndex((s:any)=>s.__sql?.includes('INSERT INTO peer_wake_batch'));
   if(armed&&at>=0){armed=false;const failed=[...statements];failed[at]=env.DB.prepare('SELECT * FROM intentional_missing_batch_table');return batch(failed);}
   return batch(statements);
  };
  const body={task:{id:'task-atomic',status:{state:'working',message:{parts:[{kind:'text',text:'progress'}]}}}};
  await h.call('POST','/push',body,`Bearer ${pushToken}`);
  assert.equal((await env.DB.prepare("SELECT updates_json FROM outbound WHERE task_id='task-atomic'").first() as any).updates_json,'[]');
  assert.equal((await h.call('POST','/push',body,`Bearer ${pushToken}`)).status,200);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM peer_wake_batch').first() as any).n,1);assert.equal(h.sent.length,0);
  await h.call('DELETE','/owner/outbound-peers/ada');await h.call('PUT','/owner/outbound-peers/ada',{url:'https://other.example.net/',token:'other-dummy'});
  const changed={task:{id:'task-atomic',status:{state:'working',message:{parts:[{kind:'text',text:'different'}]}}}};
  assert.equal((await h.call('POST','/push',changed,`Bearer ${pushToken}`)).status,200);assert.equal(h.sent.length,0,'old callback cannot borrow replacement defaults');
 }finally{h.restore();}
});

test("a retried MausBot carrier removes revoked batch references and changes delivery identity", async () => {
 const realNow=Date.now;let offset=0;Date.now=()=>realNow()+offset;
 const env=envFor({WAKE_PRESET:'mausbot',WAKE_WEBHOOK_URL:'https://hook.example/hooks/wh_test',ENABLE_CRON:'1'});const h=harness(env);
 try {
  const ada=((await h.call('POST','/owner/peers',{label:'ada'})).data as any).token;
  const bob=((await h.call('POST','/owner/peers',{label:'bob'})).data as any).token;
  const id=await peerId(h,'ada');await h.call('PUT','/owner/wake/peers',{peerId:id,policy:{...defaults,inbound:'batch'}});
  await h.call('POST','/',message('held',{contextId:'ctx-revoked'}),`Bearer ${ada}`);
  const captured:any[]=[];let fail=true;
  globalThis.fetch=(async(_url:any,init:any)=>{captured.push({headers:new Headers(init.headers),body:JSON.parse(init.body)});return new Response('fixture',{status:fail?503:200});}) as typeof fetch;
  await h.call('POST','/',message('carrier',{contextId:'ctx-carrier'}),`Bearer ${bob}`);
  assert.equal(captured[0].body.batched[0].peer,'ada');
  await h.call('DELETE','/owner/peers/ada');fail=false;offset+=61000;await h.call('GET','/health');
  assert.ok(captured.length>=2);assert.equal(captured.at(-1).body.batched,undefined);
  assert.notEqual(captured[0].headers.get('idempotency-key'),captured.at(-1).headers.get('idempotency-key'));
 } finally {Date.now=realNow;h.restore();}
});

test("pairing policy selectors cannot cross inbox databases", async () => {
 const h1=harness(envFor());let h2:ReturnType<typeof harness>|undefined;
 try {
  await h1.call('POST','/owner/peers',{label:'ada'});const foreign=await peerId(h1,'ada');
  h2=harness(envFor());await h2.call('POST','/owner/peers',{label:'ada'});
  assert.equal((await h2.call('PUT','/owner/wake/peers',{peerId:foreign,policy:{...defaults,inbound:'skip'}})).status,409);
  const listed=(await h2.call('GET','/owner/wake/peers')).data as any;
  assert.equal(listed.peers.some((row:any)=>row.peerId===foreign),false);assert.deepEqual(listed.peers[0].policy,defaults);
 } finally {h2?.restore();h1.restore();}
});

test("pairing discovery pages with one bounded joined query and supports exact selectors", async () => {
 const env=envFor();const h=harness(env);
 try {
  const stamp='2026-01-01';
  for(let i=0;i<105;i++) await env.DB.prepare('INSERT INTO peers(label,token_hash,created_at,wake_policy_id) VALUES(?,?,?,?)').bind(`peer-${i}`,await sha256(String(i)),stamp,i.toString(16).padStart(32,'0')).run();
  const first=(await h.call('GET','/owner/wake/peers')).data as any;assert.equal(first.peers.length,100);assert.ok(first.nextCursor);
  const second=(await h.call('GET',`/owner/wake/peers?cursor=${first.nextCursor}`)).data as any;assert.equal(second.peers.length,5);assert.equal(second.nextCursor,null);
  assert.equal(new Set([...first.peers,...second.peers].map(r=>r.peerId)).size,105);
  const selected=(await h.call('GET',`/owner/wake/peers?peerId=${second.peers[0].peerId}`)).data as any;assert.equal(selected.peers.length,1);
  assert.equal((await h.call('GET','/owner/wake/peers?cursor=invalid')).status,400);
 } finally {h.restore();}
});

test("MausBot retry preserves an empty first snapshot instead of changing bytes under its delivery key", async () => {
 const realNow=Date.now;let offset=0;Date.now=()=>realNow()+offset;
 const env=envFor({WAKE_PRESET:'mausbot',WAKE_WEBHOOK_URL:'https://hook.example/hooks/wh_test',ENABLE_CRON:'1'});const h=harness(env);
 try {
  const ada=((await h.call('POST','/owner/peers',{label:'ada'})).data as any).token;
  const bob=((await h.call('POST','/owner/peers',{label:'bob'})).data as any).token;
  const captured:any[]=[];let fail=true;
  globalThis.fetch=(async(_url:any,init:any)=>{captured.push({key:new Headers(init.headers).get('idempotency-key'),body:init.body});return new Response('fixture',{status:fail?503:200});}) as typeof fetch;
  await h.call('POST','/',message('first carrier',{contextId:'ctx-empty-carrier'}),`Bearer ${bob}`);
  assert.equal(JSON.parse(captured[0].body).batched,undefined);
  const id=await peerId(h,'ada');await h.call('PUT','/owner/wake/peers',{peerId:id,policy:{...defaults,inbound:'batch'}});
  await h.call('POST','/',message('later queued',{contextId:'ctx-later-queued'}),`Bearer ${ada}`);
  fail=false;offset+=61000;await h.call('GET','/health');assert.ok(captured.length>=2);
  assert.deepEqual(captured[1],captured[0]);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM peer_wake_batch').first() as any).n,1);
  await h.call('POST','/',message('next carrier',{contextId:'ctx-next-carrier'}),`Bearer ${bob}`);
  assert.equal(JSON.parse(captured.at(-1).body).batched[0].peer,'ada');
 } finally {Date.now=realNow;h.restore();}
});
