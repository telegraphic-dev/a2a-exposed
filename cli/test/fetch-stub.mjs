// Test-only preload (node --import ./test/fetch-stub.mjs): replaces fetch so CLI tests never touch the network.
// A2A_TEST_FETCH_ROUTES: JSON file { "<url prefix>": { status, body (string or JSON), headers } } (longest prefix wins;
// "status": 0 simulates a network failure). A route may also set byHeader: { "<header>": { status, body } } and
// default: { status, body } so one URL can answer differently when a header is present.
// A2A_TEST_FETCH_LOG: every request is appended as one JSON line ({ url, method, headers, body }).
// A2A_TEST_DNS: "ENOTFOUND" or "EAI_AGAIN" makes non-address lookups fail that way. Unset: they resolve to
// A2A_TEST_DNS_IP (default 203.0.113.10) without a network query. "real" uses the system resolver.
// Unmatched URLs fail like an unreachable host.
import dns from "node:dns";
import fs from "node:fs";
import { isIP } from "node:net";
import { promisify } from "node:util";

const origLookup = dns.lookup;
function lookup(hostname, options, callback) {
	if (typeof options === "function") { callback = options; options = {}; }
	else if (typeof options === "number") options = { family: options };
	else options = options || {};
	const mode = process.env.A2A_TEST_DNS || "";
	if (!isIP(hostname) && mode !== "real") {
		if (mode === "ENOTFOUND" || mode === "EAI_AGAIN") {
			const err = new Error(`getaddrinfo ${mode} ${hostname}`);
			err.code = mode;
			return callback(err);
		}
		const address = process.env.A2A_TEST_DNS_IP || "203.0.113.10";
		if (options.all) return callback(null, [{ address, family: 4 }]);
		return callback(null, address, 4);
	}
	return origLookup(hostname, options, callback);
}
dns.lookup = lookup;
dns.promises.lookup = promisify(lookup);

function routeBody(r, headers) {
	if (r && r.byHeader) {
		for (const [name, value] of Object.entries(r.byHeader)) {
			if (headers[name.toLowerCase()]) return value;
		}
		return r.default || null;
	}
	return r;
}

globalThis.fetch = async (input, init = {}) => {
	const url = String(input);
	const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
	if (process.env.A2A_TEST_FETCH_LOG)
		fs.appendFileSync(process.env.A2A_TEST_FETCH_LOG, JSON.stringify({ url, method: init.method || "GET", headers, body: init.body ?? null }) + "\n");
	let routes = {};
	try { routes = JSON.parse(fs.readFileSync(process.env.A2A_TEST_FETCH_ROUTES, "utf8")); } catch { /* none */ }
	const key = Object.keys(routes).filter((p) => url.startsWith(p)).sort((a, b) => b.length - a.length)[0];
	const r = routeBody(key && routes[key], headers);
	if (!r || !r.status) throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
	const body = typeof r.body === "string" ? r.body : r.body === undefined ? "" : JSON.stringify(r.body);
	return new Response(r.status === 204 || r.status === 304 ? null : body, { status: r.status, headers: r.headers || (typeof r.body === "string" ? {} : { "content-type": "application/json" }) });
};
