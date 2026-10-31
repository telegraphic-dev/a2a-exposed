// Test-only preload for tunnel tests: status must not query public DNS or the wake hostname.
// Loopback fetches pass through. DNS-over-HTTPS answers from A2A_TEST_DOH (default: an A record;
// "empty": no answer). Other hosts are the wake probe: 401 without a service token, 200 with one,
// unless A2A_TEST_WAKE_PROBE is "1033" or "down".
import dns from "node:dns";
import { isIP } from "node:net";
import { promisify } from "node:util";

const origLookup = dns.lookup;
function lookup(hostname, options, callback) {
	if (typeof options === "function") { callback = options; options = {}; }
	else if (typeof options === "number") options = { family: options };
	else options = options || {};
	if (isIP(hostname)) return origLookup(hostname, options, callback);
	if (process.env.A2A_TEST_DNS === "ENOTFOUND" || process.env.A2A_TEST_DNS === "EAI_AGAIN") {
		const err = new Error(`getaddrinfo ${process.env.A2A_TEST_DNS} ${hostname}`);
		err.code = process.env.A2A_TEST_DNS;
		return callback(err);
	}
	const address = process.env.A2A_TEST_DNS_IP || "203.0.113.10";
	if (options.all) return callback(null, [{ address, family: 4 }]);
	return callback(null, address, 4);
}
dns.lookup = lookup;
dns.promises.lookup = promisify(lookup);

const origFetch = globalThis.fetch;
const loopback = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

globalThis.fetch = async (input, init = {}) => {
	const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
	if (url.hostname === "cloudflare-dns.com") {
		const name = url.searchParams.get("name") || "";
		const body = process.env.A2A_TEST_DOH === "empty"
			? { Status: 3, Answer: [] }
			: { Status: 0, Answer: [{ name, type: 1, TTL: 30, data: "203.0.113.10" }] };
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/dns-json" } });
	}
	if (loopback.has(url.hostname)) return origFetch(input, init);
	const headers = new Headers(init.headers || {});
	// `tunnel status` probes have no CLI user-agent and must stay a network error (DNS still propagating).
	if (headers.get("user-agent") !== "a2a-exposed-cli")
		throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
	const mode = process.env.A2A_TEST_WAKE_PROBE || "";
	if (mode === "1033") return new Response("error code: 1033", { status: 530, headers: { "content-type": "text/plain" } });
	if (mode === "down") return new Response("bad gateway", { status: 502, headers: { "content-type": "text/plain" } });
	const hasToken = headers.get("cf-access-client-id") && headers.get("cf-access-client-secret");
	if (!hasToken) return new Response("denied", { status: 401, headers: { "www-authenticate": "Bearer" } });
	return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
};
