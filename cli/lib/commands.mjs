// Day-to-day commands: inbox / reply / history (owner API) and outbound send / poll.
import fs from "node:fs";
import * as C from "./config.mjs";
import { checkId, die, fetchCard, httpJson, newId, pickEndpoint, randomToken, rpc, taskFromAny, textOf } from "./a2a.mjs";

const q = encodeURIComponent;
const out = (obj) => console.log(JSON.stringify(obj, null, 2));
export const baseUrl = () => C.get("A2A_BASE_URL").replace(/\/$/, "");

export async function owner(method, path, body) {
	const base = baseUrl(), tok = C.get("A2A_OWNER_TOKEN");
	if (!base || !tok) die(`A2A_BASE_URL / A2A_OWNER_TOKEN missing (run \`a2a-over-webhook init\` or edit ${C.CONFIG_FILE})`);
	const { status, data } = await httpJson(base + path, { method, body, headers: { authorization: `Bearer ${tok}` } });
	if (status < 200 || status >= 300) die(`worker ${method} ${path} -> HTTP ${status}: ${JSON.stringify(data).slice(0, 400)}`);
	return data;
}

function printPush(res) {
	for (const r of (res && res.push) || []) console.error(`push -> ${r.url}: ${r.ok ? "ok" : "FAILED"} (${r.info})`);
}

const readStdin = () => fs.readFileSync(0, "utf8");

// ---------------------------------------------------------------- inbound side
export async function inbox(o) {
	const qs = [];
	if (o.context) qs.push("context=" + q(o.context));
	if (o.all) qs.push("all=1");
	const rows = await owner("GET", "/owner/inbox" + (qs.length ? "?" + qs.join("&") : ""));
	if (o.json) return out(rows);
	if (!rows.length) return console.log("(no unhandled tasks)");
	for (const r of rows) {
		console.log(`--- task ${r.taskId}  [${r.state}]  from=${r.from}  context=${r.contextId}  at=${r.updated}`);
		console.log("UNTRUSTED PEER MESSAGE >>>");
		console.log(r.text);
		console.log("<<< END PEER MESSAGE");
	}
}

export const show = async (id) => out(await owner("GET", `/owner/tasks/${q(id)}`));

export async function working(id) {
	printPush(await owner("POST", `/owner/tasks/${q(id)}/working`, {}));
	console.log(`${id} -> working`);
}

export async function reply(id, o) {
	const text = o.text ?? (o.stdin || !process.stdin.isTTY ? readStdin() : undefined);
	if (!text) die("--text or --stdin required");
	const res = await owner("POST", `/owner/tasks/${q(id)}/reply`, {
		text, state: o.state, artifact: !!o.artifact, artifactName: o["artifact-name"], force: !!o.force,
	});
	printPush(res);
	console.log(`${id} -> ${o.state}`);
}

export async function history(ctx, o) {
	const rows = await owner("GET", `/owner/history/${q(ctx)}?n=${Number(o.n || 50)}`);
	if (o.json) return out(rows);
	for (const e of rows) {
		const tag = [e.event, e.state || e.role].filter(Boolean).join("/");
		console.log(`${e.ts} ${(e.dir || "").padEnd(5)} ${(e.peer || "-").padEnd(10)} ${e.task_id || "-"} ${tag}: ${(e.text || "").slice(0, 400)}`);
	}
}

export async function contexts() {
	for (const r of await owner("GET", "/owner/contexts")) console.log(`${r.last}  ${r.context_id}  (${r.entries} entries)`);
}

// ---------------------------------------------------------------- inbound peer tokens (one per peer label)
export async function token(action, label, o) {
	if (action === "list") {
		for (const r of await owner("GET", "/owner/peers"))
			console.log(`${r.label}\tcreated=${r.created_at}\t${r.revoked_at ? "REVOKED " + r.revoked_at : "active"}`);
		return;
	}
	if (!label) die("label required");
	if (action === "issue" || action === "rotate") {
		const res = await owner("POST", "/owner/peers", { label, rotate: action === "rotate" || !!o.rotate });
		console.log(res.token);
		console.error(`# label=${res.label}  agent card: ${res.card}  (token shown once; hand it to the peer over a private channel)`);
		return;
	}
	if (action === "revoke") return out(await owner("DELETE", `/owner/peers/${q(label)}`));
	die(`unknown token action ${action} (issue|list|revoke|rotate)`);
}

// ---------------------------------------------------------------- outbound peers (agents we call)
function resolvePeer(to) {
	const peers = C.loadPeers();
	if (peers[to]) {
		const pe = peers[to];
		return [to, pe.url.replace(/\/$/, ""), pe.token_env ? C.get(pe.token_env) : ""];
	}
	if (/^https?:\/\//.test(to)) {
		for (const [alias, pe] of Object.entries(peers)) if (pe.url.replace(/\/$/, "") === to.replace(/\/$/, "")) return resolvePeer(alias);
		return [to, to.replace(/\/$/, ""), C.get("A2A_PEER_TOKEN")];
	}
	die(`unknown peer alias ${JSON.stringify(to)} (see: a2a-over-webhook peers list)`);
}

export function peers(sub, args, o) {
	const all = C.loadPeers();
	if (sub === "add") {
		const [alias, url] = args;
		if (!alias || !url) die("usage: peers add <alias> <url> [--token-env VAR | --token-stdin]");
		if (!/^https?:\/\//.test(url)) die("URL must be http(s)");
		const tokenEnv = o["token-env"] || C.peerTokenVar(alias);
		all[alias] = { url: url.replace(/\/$/, ""), token_env: tokenEnv };
		if (o["token-stdin"]) {
			const t = readStdin().trim();
			if (!t) die("no token on stdin");
			C.saveConfig({ [tokenEnv]: t });
		} else if (!C.get(tokenEnv)) console.error(`note: no token stored; set ${tokenEnv} in the environment or ${C.CONFIG_FILE} (or re-run with --token-stdin)`);
		C.savePeers(all);
		return console.log(`peer ${alias} -> ${all[alias].url}`);
	}
	if (sub === "rm") {
		const [alias] = args;
		delete all[alias];
		C.savePeers(all);
		return console.log(`removed ${alias}`);
	}
	for (const [k, v] of Object.entries(all)) {
		const te = v.token_env || "";
		console.log(`${k}\t${v.url}\ttoken_env=${te || "-"}\t${te && C.get(te) ? "(set)" : "(missing)"}`);
	}
}

async function logHistory(ctx, entry) {
	try { await owner("POST", "/owner/history", { contextId: ctx, ...entry }); }
	catch { console.error("warning: could not log history to the worker"); }
}

export async function send(o) {
	if (!o.to) die("--to required");
	const [alias, base, tok] = resolvePeer(o.to);
	const card = await fetchCard(base);
	const [url, version] = pickEndpoint(base, card, o.proto);
	const text = o.text ?? readStdin();
	const v1 = version.startsWith("1");
	const msg = { messageId: newId(), role: v1 ? "ROLE_USER" : "user", parts: v1 ? [{ text }] : [{ kind: "text", text }] };
	if (!v1) msg.kind = "message";
	if (o.context) msg.contextId = checkId(o.context, "contextId");
	if (o.task) msg.taskId = checkId(o.task, "taskId");
	const conf = v1 ? { returnImmediately: true } : { blocking: false };
	let pushToken = null;
	if (o.push) {
		if (!baseUrl()) die("--push needs A2A_BASE_URL (your Worker)");
		pushToken = randomToken(24);
		conf[v1 ? "taskPushNotificationConfig" : "pushNotificationConfig"] = { url: baseUrl() + "/push", token: pushToken };
	}
	const res = await rpc(url, version, tok, "message/send", "SendMessage", { message: msg, configuration: conf });
	let obj = res && typeof res === "object" && ("task" in res || "message" in res) ? res.task || res.message : res;
	obj = taskFromAny(obj);
	const isTask = obj && typeof obj === "object" && "status" in obj;
	const ctx = (obj && obj.contextId) || o.context || newId();
	const tid = isTask ? obj.id : null;
	await logHistory(ctx, { dir: "out", peer: alias, taskId: tid, role: "user", text, data: { messageId: msg.messageId, endpoint: url, protocol: version } });
	if (tid) await owner("POST", "/owner/outbound", { taskId: tid, contextId: ctx, peer: alias, endpoint: url, protocol: version, pushToken, task: obj });
	else if (obj && obj.parts) await logHistory(ctx, { dir: "in", peer: alias, role: "agent", event: "direct_message", text: textOf(obj) });
	out(obj);
}

export async function poll(taskId, o) {
	if (!o.to) die("--to required");
	const [alias, base, tok] = resolvePeer(o.to);
	const tid = checkId(taskId, "taskId");
	let rec = {};
	try { rec = await owner("GET", `/owner/outbound/${q(tid)}`); } catch { rec = {}; }
	const [url, version] = rec.endpoint ? [rec.endpoint, rec.protocol || "0.3"] : pickEndpoint(base, await fetchCard(base), o.proto);
	const res = taskFromAny(await rpc(url, version, tok, "tasks/get", "GetTask", { id: tid }));
	if (rec.endpoint) {
		await owner("PUT", `/owner/outbound/${q(tid)}`, { task: res });
		const s = res.status || {};
		let txt = textOf(s.message || {});
		const arts = (res.artifacts || []).map((x) => textOf(x)).join("\n");
		if (arts && arts !== txt) txt = (txt ? txt + "\n" : "") + arts;
		await logHistory(rec.contextId, { dir: "in", peer: alias, taskId: tid, event: "poll", state: s.state, text: txt });
	}
	out(res);
}

export const outbound = async (id) => out(await owner("GET", `/owner/outbound/${q(id)}`));
