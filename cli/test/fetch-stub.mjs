// Test-only preload (node --import ./test/fetch-stub.mjs): replaces fetch so CLI tests never touch the network.
// A2A_TEST_FETCH_ROUTES: JSON file { "<url prefix>": { status, body (string or JSON), headers } } (longest prefix wins;
// "status": 0 simulates a network failure). A2A_TEST_FETCH_LOG: every request is appended as one JSON line
// ({ url, method, headers, body }). Unmatched URLs fail like an unreachable host.
import fs from "node:fs";

globalThis.fetch = async (input, init = {}) => {
	const url = String(input);
	const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
	if (process.env.A2A_TEST_FETCH_LOG)
		fs.appendFileSync(process.env.A2A_TEST_FETCH_LOG, JSON.stringify({ url, method: init.method || "GET", headers, body: init.body ?? null }) + "\n");
	let routes = {};
	try { routes = JSON.parse(fs.readFileSync(process.env.A2A_TEST_FETCH_ROUTES, "utf8")); } catch { /* none */ }
	const key = Object.keys(routes).filter((p) => url.startsWith(p)).sort((a, b) => b.length - a.length)[0];
	const r = key && routes[key];
	if (!r || !r.status) throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
	const body = typeof r.body === "string" ? r.body : r.body === undefined ? "" : JSON.stringify(r.body);
	return new Response(r.status === 204 || r.status === 304 ? null : body, { status: r.status, headers: r.headers || (typeof r.body === "string" ? {} : { "content-type": "application/json" }) });
};
