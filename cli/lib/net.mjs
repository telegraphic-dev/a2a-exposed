// Proxy environment support and readable network errors for the CLI's fetch calls.
// Node's built-in fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 is set when the process starts.
// Proxy URLs can carry credentials, so messages name the variable, never its value.
import http from "node:http";

export const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
const LOOPBACK = ["localhost", "127.0.0.1", "::1"];
let applied = false;

/** Name of the first proxy variable that is set, or "". */
export function proxyVar(env = process.env) {
	return PROXY_VARS.find((key) => typeof env[key] === "string" && env[key].trim()) || "";
}

/** How this Node can use the proxy variables: "global" in-process, "env" with NODE_USE_ENV_PROXY=1 at startup, or "none". */
export function proxySupport(version = process.versions.node, setGlobal = http.setGlobalProxyFromEnv) {
	if (typeof setGlobal === "function") return "global";
	const [major, minor] = String(version).split(".").map(Number);
	return major >= 24 || (major === 22 && minor >= 21) ? "env" : "none";
}

/** NO_PROXY with loopback hosts added: local relays and receivers never go through the proxy. */
export function loopbackNoProxy(value = "") {
	if (String(value).trim() === "*") return "*";
	const list = String(value).split(/[\s,]+/).filter(Boolean);
	for (const host of LOOPBACK) if (!list.includes(host)) list.push(host);
	return list.join(",");
}

/**
 * Called once at startup. Returns "reexec" when the caller must restart Node with `env` (NODE_USE_ENV_PROXY=1).
 * An explicit NODE_USE_ENV_PROXY (any value) is the user's choice and is left alone.
 */
export function prepareProxy(env = process.env, { support = proxySupport(), setGlobal = http.setGlobalProxyFromEnv } = {}) {
	const live = env === process.env; // only the real environment changes what error messages say about the proxy
	if (env.NODE_USE_ENV_PROXY === "1") { if (live) applied = !!proxyVar(env); return "ready"; }
	if (!proxyVar(env) || env.NODE_USE_ENV_PROXY !== undefined || support === "none") return "ready";
	const key = env.NO_PROXY === undefined && env.no_proxy !== undefined ? "no_proxy" : "NO_PROXY";
	env[key] = loopbackNoProxy(env[key]);
	if (support === "global") {
		try { setGlobal(); if (live) applied = true; } catch { /* left to NODE_USE_ENV_PROXY; errors then say so */ }
		return "ready";
	}
	env.NODE_USE_ENV_PROXY = "1";
	return "reexec";
}

export const proxyApplied = () => applied;

const TLS = new Set([
	"SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "CERT_UNTRUSTED", "CERT_REVOKED",
	"CERT_SIGNATURE_FAILURE", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER", "EPROTO",
]);
const DNS = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME"]);
const REFUSED = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"]);
const CLOSED = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CLOSED"]);
const TIMEOUT = new Set(["TIMEOUT", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

/** The most specific network error code in an error's cause chain, or "". Only [A-Z0-9_] codes are returned. */
export function networkCode(error) {
	let e = error;
	for (let depth = 0; e && depth < 6; depth++, e = e.cause) {
		if (typeof e.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(e.code)) return e.code;
		if (e.name === "TimeoutError" || e.name === "AbortError") return "TIMEOUT";
	}
	return "";
}

/** One sentence that names the host and the real cause, plus a proxy or certificate hint when it applies. */
export function networkProblem(error, url, env = process.env) {
	let host = "the service";
	try { host = new URL(url).host; } catch { /* keep the generic name */ }
	const code = networkCode(error), tag = code ? ` (${code})` : "";
	const via = proxyVar(env);
	let text = DNS.has(code) ? `Could not resolve ${host}${tag}.`
		: REFUSED.has(code) ? `The connection to ${host} was refused${tag}.`
		: CLOSED.has(code) ? `The connection to ${host} closed before an answer${tag}.`
		: TIMEOUT.has(code) ? `${host} did not answer in time${tag}.`
		: TLS.has(code) ? `The TLS certificate check for ${host} failed${tag}.`
		: `Could not reach ${host}${tag}.`;
	if (via && !applied && env.NODE_USE_ENV_PROXY !== "1")
		text += ` ${via} is set, but this Node ${process.version} does not use it for fetch. Use Node 22.21+ or 24+, or the hosted MCP connector.`;
	else if (TLS.has(code))
		text += via ? ` If the proxy in ${via} inspects TLS, set NODE_EXTRA_CA_CERTS to its CA certificate file.` : " Check the system clock and the trusted certificates.";
	else if (via) text += ` Requests go through the proxy in ${via}; check that proxy, or list the host in NO_PROXY to bypass it.`;
	return { code: code || "network", message: text };
}
