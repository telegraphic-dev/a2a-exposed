// Minimal A2A client helpers (0.3 + 1.0) and HTTP utilities.
import crypto from "node:crypto";

export const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export class CliError extends Error {}
export const die = (msg) => { throw new CliError(msg); };

export function checkId(v, what = "id") {
	if (typeof v !== "string" || !ID_RE.test(v)) die(`invalid ${what}`);
	return v;
}

export const newId = () => crypto.randomUUID();
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

export async function httpJson(url, { method, body, headers = {}, timeout = 30000 } = {}) {
	const init = { method: method || (body === undefined ? "GET" : "POST"), headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeout) };
	if (body !== undefined) {
		init.headers["content-type"] = "application/json";
		init.body = JSON.stringify(body);
	}
	let r;
	try { r = await fetch(url, init); }
	catch (e) { die(`request to ${new URL(url).origin} failed: ${e?.cause?.code || e?.cause?.message || e?.message || e}`); }
	const text = await r.text();
	let data = text;
	try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
	return { status: r.status, data };
}

/** Lowercase A2A task state ("completed", "input-required", ...) from a 0.3 or 1.0 task. */
export const plainState = (t) => {
	const s = t && t.status && t.status.state;
	return typeof s === "string" && s.startsWith("TASK_STATE_") ? s.slice(11).toLowerCase().replace(/_/g, "-") : s;
};

/** First 12 hex chars of sha256(value), or null when unset (same as the Worker's `wake preview` fingerprints). */
export const fingerprint = (v) => (v ? crypto.createHash("sha256").update(String(v), "utf8").digest("hex").slice(0, 12) : null);

export function textOf(msgOrParts) {
	const parts = Array.isArray(msgOrParts) ? msgOrParts : (msgOrParts && msgOrParts.parts) || [];
	const out = [];
	for (const x of parts) {
		if (!x || typeof x !== "object") continue;
		if ("text" in x) out.push(String(x.text));
		else if ("data" in x) out.push(JSON.stringify(x.data));
		else if (x.kind === "file" || "url" in x || "raw" in x) {
			const f = x.file || {};
			out.push(`[file ${f.name || x.filename || f.uri || x.url || ""}]`);
		}
	}
	return out.join("\n");
}

export async function fetchCard(base) {
	for (const p of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
		try {
			const { status, data } = await httpJson(base + p, { timeout: 15000 });
			if (status === 200 && data && typeof data === "object") return data;
		} catch { /* try next */ }
	}
	return null;
}

/** Choose the JSON-RPC endpoint + protocol version from an agent card (prefers 1.0). */
export function pickEndpoint(base, card, force) {
	const ifaces = ((card && card.supportedInterfaces) || []).filter((i) => String(i.protocolBinding || "").toUpperCase() === "JSONRPC");
	if (force) {
		const hit = ifaces.find((i) => String(i.protocolVersion || "").startsWith(force));
		if (hit) return [hit.url, force];
		return [(card && card.url) || base + "/", force];
	}
	const v1 = ifaces.find((i) => String(i.protocolVersion || "").startsWith("1"));
	if (v1) return [v1.url, "1.0"];
	if (card && card.url) return [card.url, "0.3"];
	if (ifaces.length) return [ifaces[0].url, String(ifaces[0].protocolVersion || "0.3")];
	return [base + "/", "0.3"];
}

export async function rpc(url, version, token, method03, method1, params) {
	const v1 = version.startsWith("1");
	const headers = { "A2A-Version": v1 ? "1.0" : "0.3" };
	if (token) headers.authorization = `Bearer ${token}`;
	const body = { jsonrpc: "2.0", id: newId(), method: v1 ? method1 : method03, params };
	const { status, data } = await httpJson(url, { body, headers });
	if (status !== 200 || !data || typeof data !== "object" || "error" in data)
		die(`peer returned HTTP ${status}: ${JSON.stringify(data).slice(0, 500)}`);
	return data.result;
}
