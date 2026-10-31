// `status`: where a setup stands and what to do next. Safe to run any time (read-only: GET requests and cf list/get
// calls only), so an agent that was interrupted can resume from the printed next step. The CLI fetches the agent card
// itself, so agents need no curl (some agent sandboxes flag *.dev URLs in shell commands).
import dns from "node:dns";
import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import * as C from "./config.mjs";
import { CLI, cardUrlProblem, cfErrorCode, describeHttp, die, fingerprint, httpJson, isPrivateHost } from "./a2a.mjs";
import { baseUrl, owner, ownerTry } from "./commands.mjs";
import * as D from "./deploy.mjs";
import { buildLayers, layerValue, usablePin } from "./layers.mjs";
import * as T from "./tunnel.mjs";
import { cacheFile, readCache, newer } from "./update.mjs";

const DOH_URL = "https://cloudflare-dns.com/dns-query";
const LOOKUP_MS = 5000;

/** ENOTFOUND / EAI_AGAIN, including the text httpJson puts on a failed request. */
export function isResolverError(e) {
	const code = e?.code || e?.cause?.code || "";
	if (code === "ENOTFOUND" || code === "EAI_AGAIN") return true;
	return /\b(ENOTFOUND|EAI_AGAIN)\b/.test(String(e?.message || ""));
}

/** First address from the system resolver, or EAI_AGAIN when it does not answer in time. */
export async function defaultLookup(host) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => {
			const err = new Error(`DNS lookup timed out for ${host}`);
			err.code = "EAI_AGAIN";
			reject(err);
		}, LOOKUP_MS);
	});
	try {
		const rows = await Promise.race([dns.promises.lookup(host, { all: true }), timeout]);
		const first = Array.isArray(rows) ? rows[0] : null;
		const address = typeof first === "string" ? first : first?.address;
		if (!address) {
			const err = new Error(`ENOTFOUND ${host}`);
			err.code = "ENOTFOUND";
			throw err;
		}
		return address;
	} finally { clearTimeout(timer); }
}

/** Connect `host` to `ip` for the duration of `fn` (TLS still checks the hostname). Other names use the previous resolver. */
export async function withHostPin(host, ip, fn) {
	const prev = dns.lookup;
	const prevPromises = dns.promises.lookup;
	dns.lookup = (hostname, options, callback) => {
		if (typeof options === "function") { callback = options; options = {}; }
		else if (typeof options === "number") options = { family: options };
		else options = options || {};
		if (hostname === host) {
			if (options.all) return callback(null, [{ address: ip, family: 4 }]);
			return callback(null, ip, 4);
		}
		return prev(hostname, options, callback);
	};
	dns.promises.lookup = promisify(dns.lookup);
	try { return await fn(); }
	finally {
		dns.lookup = prev;
		dns.promises.lookup = prevPromises;
	}
}

/** DNS-over-HTTPS A (or the requested type) lookup. `application/dns-json`. No redirects.
 *  When the system resolver cannot resolve the DoH host, retry once pinned to 1.1.1.1. */
export async function queryDoh(name, type = "A") {
	const url = `${DOH_URL}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
	const init = {
		method: "GET", redirect: "manual",
		headers: { accept: "application/dns-json", "user-agent": "a2a-exposed-cli" },
		signal: AbortSignal.timeout(5000),
	};
	let res;
	try { res = await fetch(url, init); }
	catch (e) {
		if (!isResolverError(e)) throw e;
		res = await withHostPin("cloudflare-dns.com", "1.1.1.1", () => fetch(url, init));
	}
	if (!res || res.status !== 200) {
		const err = new Error(`HTTP ${res ? res.status : 0}`);
		err.code = `HTTP_${res ? res.status : 0}`;
		throw err;
	}
	const data = await res.json();
	const want = type === "AAAA" ? 28 : 1;
	const answer = Array.isArray(data?.Answer) ? data.Answer : [];
	return answer.filter((a) => a && Number(a.type) === want && typeof a.data === "string").map((a) => a.data);
}

function firstAddress(raw) {
	if (typeof raw === "string") return raw;
	if (Array.isArray(raw)) {
		const first = raw[0];
		return typeof first === "string" ? first : first?.address || "";
	}
	return raw?.address || "";
}

/** System lookup, then DNS-over-HTTPS on ENOTFOUND or EAI_AGAIN. `lookup` and `doh` are injectable. */
export async function resolveWorkerDns(host, { lookup = defaultLookup, doh = queryDoh } = {}) {
	if (!host) return { kind: "skip" };
	if (isIP(host)) return { kind: "ip", ip: host };
	try {
		const ip = firstAddress(await lookup(host));
		return { kind: "system", ip };
	} catch (e) {
		if (!isResolverError(e)) return { kind: "fail", error: e?.code || e?.message || "lookup failed" };
		let answers;
		try { answers = await doh(host, "A"); }
		catch (err) { return { kind: "fail", error: err?.code || err?.message || "DNS-over-HTTPS failed" }; }
		const ips = (Array.isArray(answers) ? answers : []).map(String).filter((a) => isIP(a) === 4);
		if (!ips.length) return { kind: "no-record" };
		return { kind: "public-only", ip: ips[0] };
	}
}

/** Public DNS for the wake hostname (DNS-over-HTTPS only). */
export async function resolveWakeDns(host, { doh = queryDoh } = {}) {
	if (!host || isIP(host) || isPrivateHost(host)) return { kind: "skip" };
	try {
		const ips = (await doh(host, "A") || []).map(String).filter((a) => isIP(a) === 4);
		if (!ips.length) return { kind: "no-record" };
		return { kind: "pass", ip: ips[0] };
	} catch (e) {
		return { kind: "fail", error: e?.code || e?.message || "DNS-over-HTTPS failed" };
	}
}

/** GET probe. Request headers are sent and never returned. The result keeps the status, redirect
 *  location, Cloudflare error code, Access response-header names (never their values), the
 *  WWW-Authenticate challenge, and a body slice, so a 401/403 can be attributed. */
async function probeGet(url, headers) {
	try {
		const r = await fetch(url, {
			method: "GET", redirect: "manual",
			headers: { "user-agent": "a2a-exposed-cli", ...(headers || {}) },
			signal: AbortSignal.timeout(15000),
		});
		const body = (await r.text()).slice(0, 8192);
		const cf = T.cloudflareErrorCode(body);
		const accessHeaders = [];
		r.headers.forEach((_value, name) => {
			if (name.toLowerCase().startsWith("cf-access-")) accessHeaders.push(name.toLowerCase());
		});
		const wwwAuthenticate = r.headers.get("www-authenticate") || "";
		return {
			status: r.status, location: r.headers.get("location") || "", ...(cf ? { cf } : {}),
			...(accessHeaders.length ? { accessHeaders } : {}),
			...(wwwAuthenticate ? { wwwAuthenticate: wwwAuthenticate.slice(0, 500) } : {}),
			...(body ? { body } : {}),
		};
	} catch (e) {
		return { error: e?.cause?.code || e?.cause?.message || e?.message || "request failed" };
	}
}

/** Public health probe. Only a valid health answer establishes missing version reporting. */
export async function checkHealth(base) {
	try {
		const { status, data } = await httpJson(`${base}/health`, { timeout: 15000 });
		if (status === 200 && data?.ok === true)
			return { ok: true, version: typeof data.version === "string" && data.version ? data.version : null, httpStatus: status };
		return { ok: false, version: null, httpStatus: status };
	} catch (e) { /* unreachable: version stays unknown */ return { ok: false, version: null, httpStatus: null, error: e.message }; }
}

/** Presets whose webhook usually listens only locally: wakes need the tunnel (or another reverse proxy). */
export const LOCAL_PRESETS = ["openclaw-wake", "openclaw-agent", "hermes"];

/** Agent card check: { ok, name, versions, urls, urlProblem } or { ok: false, error }. urlProblem is "" when every
 *  endpoint URL in the card is the base URL (peers send requests there). */
export async function checkCard(base) {
	try {
		const { status, data } = await httpJson(`${base}/.well-known/agent-card.json`, { timeout: 15000 });
		if (status !== 200 || !data || typeof data !== "object" || !data.name) {
			const cf = cfErrorCode(typeof data === "string" ? data : "");
			return { ok: false, httpStatus: status, error: status === 200 ? "HTTP 200 (no agent card)" : describeHttp(status, data), ...(cf ? { cfError: cf } : {}) };
		}
		return { ok: true, httpStatus: status, name: data.name, versions: (data.supportedInterfaces || []).map((i) => i.protocolVersion).filter(Boolean),
			urls: [...new Set((data.supportedInterfaces || []).map((i) => i && i.url).filter(Boolean))], urlProblem: cardUrlProblem(data, base) };
	} catch (e) { return { ok: false, httpStatus: null, error: e.message }; }
}

/** One line describing how wakes reach the agent. */
export function wakeLine(s) {
	if (!s.wake) return "unknown (owner API not reachable)";
	const w = s.wake;
	if (!w.configured) return "none: no WAKE_WEBHOOK_URL on the Worker, so the agent is expected to poll the A2A endpoint";
	const auth = [w.hasKey && "bearer/API key", w.hasHmacSecret && "HMAC signature", w.hasAccessServiceToken && "Access service token"].filter(Boolean);
	return `webhook (preset ${w.preset}${s.tunnel ? ", through the tunnel" : ""}); auth: ${auth.join(" + ") || "none"}; URL fingerprint ${w.urlFingerprint || "-"}`;
}

// ---------------------------------------------------------------- proxy mode: upstream diagnosis
/** What to do for each reason code of the Worker's upstream check (`POST /owner/facade/verify`, Worker log
 *  `upstream_error`). `d` is the check's detail line (HTTP status, Cloudflare error; never a secret). */
export const UPSTREAM_FIX = {
	access_credentials_missing: (d) => `Cloudflare Access refused the Worker (${d}). Export UPSTREAM_ACCESS_CLIENT_ID / UPSTREAM_ACCESS_CLIENT_SECRET (the service token the upstream's Access app admits) and run \`${CLI} deploy\``,
	access_rejected: (d) => `Cloudflare Access refused the Worker's service token (${d}): the Access app on the upstream hostname needs a Service Auth policy for that token, and UPSTREAM_ACCESS_CLIENT_ID / _SECRET must be its current pair (export them and run \`${CLI} deploy\`)`,
	upstream_auth_missing: (d) => `Access let the Worker through, but the agent refused the call (${d}). Export UPSTREAM_TOKEN (the bearer the agent expects; its card advertises it) and run \`${CLI} deploy\` (or pipe it: \`<print token> | ${CLI} deploy --upstream-token-stdin\`)`,
	upstream_auth_rejected: (d) => `Access let the Worker through, but the agent refused its UPSTREAM_TOKEN (${d}): wrong or rotated. Export the current one and run \`${CLI} deploy\``,
	tunnel_down: (d) => `Cloudflare can't reach the upstream tunnel (${d}): start the connector on the agent's machine (\`cloudflared tunnel run ...\`)`,
	upstream_unavailable: (d) => `the tunnel answers but the agent's A2A server behind it does not (${d}): start the agent, and check the tunnel ingress \`service:\` URL`,
	network: (d) => `the Worker could not connect to the upstream (${d}): check the tunnel hostname (DNS record, certificate)`,
	unexpected_response: (d) => `the upstream answered without JSON-RPC (${d}): --upstream must be the agent's JSON-RPC endpoint (not its web UI or card URL); fix it with \`${CLI} deploy --upstream <URL>\``,
	misconfigured: (d) => `the upstream URL is unusable (${d}): fix it with \`${CLI} deploy --upstream <tunnel URL>\``,
};

/** The upstream check as layer-by-layer rows: façade peer auth (public), Cloudflare Access, the agent's bearer check, the
 *  A2A app. `v`: the Worker's verify answer; `fa`: the public peer-auth probe ({ status }) or null. Pure; unit-tested. */
export function verifyLayers(v, fa = null) {
	const rows = [];
	if (fa) rows.push(["façade peer auth", fa.status === 401 ? "enforced (an unauthenticated call gets 401 from the façade)"
		: fa.error ? `not checked (${fa.error})` : `UNEXPECTED: an unauthenticated call got HTTP ${fa.status} (expected 401)`]);
	if (!v) return rows;
	const r = v.reason, sent = v.sent || {};
	const notReached = "not reached";
	const access = r === "access_credentials_missing" ? "FAILED: refused by Cloudflare Access; the Worker has no Access service token"
		: r === "access_rejected" ? "FAILED: Cloudflare Access refused the Worker's service token (policy or wrong token)"
		: ["upstream_auth_missing", "upstream_auth_rejected", "reachable", "upstream_unavailable"].includes(r) ? (sent.accessServiceToken ? "passed" : "no service token sent (the upstream hostname is not behind Access?)")
		: r === "tunnel_down" || r === "network" ? notReached : "?";
	const bearer = r === "upstream_auth_missing" ? "FAILED: the agent wants a credential; the Worker has no UPSTREAM_TOKEN"
		: r === "upstream_auth_rejected" ? "FAILED: the agent refused the Worker's UPSTREAM_TOKEN"
		: r === "reachable" ? (sent.bearer ? "accepted" : "none sent (the agent accepted the call without one)")
		: notReached;
	const app = r === "reachable" ? `reachable (${v.detail}${v.rpcErrorCode === -32601 ? ": method not found, as expected" : ""}; no task created)`
		: ["tunnel_down", "upstream_unavailable", "network", "unexpected_response", "misconfigured"].includes(r) ? `FAILED: ${v.detail}` : notReached;
	rows.push(["Access", access], ["upstream bearer", bearer], ["A2A app", app]);
	return rows;
}

/** Peer token variables set in the environment that shadow a different token saved in config.env (names only). */
export function shadowedPeerTokens() {
	return [...new Set(Object.values(C.loadPeers()).map((p) => p && p.token_env).filter(Boolean))].filter((k) => C.envOverridesFile(k));
}

/** How long after `tunnel create` uploads secrets `status` treats a missing Worker preview as propagation. */
export const SECRET_PROPAGATION_MS = 60_000;

/** How long after `tunnel create` a connector with 0 connections is still "connecting", not broken. */
export const CONNECTOR_WAIT_MS = 60_000;

/** Cloudflare tunnel status `inactive` means the connector has never connected. */
export function tunnelStateLabel(state) {
	if (state === "inactive") return "never connected";
	return state || "?";
}

/** True for about a minute after `tunnel create` while the connector reports 0 connections. */
export function connectorConnecting(tunnel, now = Date.now()) {
	if (!tunnel || tunnel.connections !== 0) return false;
	const at = Number(tunnel.secretsAt);
	if (!Number.isFinite(at) || at <= 0) return false;
	const age = now - at;
	return age >= 0 && age < CONNECTOR_WAIT_MS;
}

/** True while the tunnel's Worker secrets were uploaded recently and may still be invisible to `wake preview`. */
export function secretsPropagating(tunnel, now = Date.now()) {
	const at = Number(tunnel && tunnel.secretsAt);
	if (!Number.isFinite(at) || at <= 0) return false;
	const age = now - at;
	return age >= 0 && age < SECRET_PROPAGATION_MS;
}

/** The single most useful next step for a status snapshot (pure; unit-tested). `also`: optional extra hints, printed
 *  as separate lines (so the next step stays one short instruction). */
export function nextStep(s) {
	const n = nextStepCore(s);
	const version = s.cliVersion || D.VERSION;
	if (s.workerVersion && s.latestVersion && newer(s.latestVersion, s.workerVersion) && !newer(s.workerVersion, version))
		n.also.push(`a2a-exposed ${s.latestVersion} is available: run npx -y a2a-exposed@latest deploy`);
	const sh = (s.peerTokenShadowed || []).map((k) => `${k} is set in the environment and overrides the different peer token saved in ${s.configFile} (e.g. a stale value from before \`connect\` stored a new one): send/poll use the environment value. Unset ${k} where it is set to use the saved token`);
	const addr = s.addresses;
	if (addr && Array.isArray(addr.announcePending) && addr.announcePending.length)
		n.also.push(`an address announcement is still pending: run \`${CLI} peer announce --all\``);
	if (addr && Array.isArray(addr.inboundNoAddress) && addr.inboundNoAddress.length)
		n.also.push("paired peers with no callback keep replies on the task until they announce an address");
	return sh.length ? { ...n, also: [...n.also, ...sh] } : n;
}

function nextStepCore(s) {
	const fail = (text) => ({ ok: false, text, also: [] });
	const done = (text, also = []) => ({ ok: true, text, also });
	if (!s.deployed) return fail(`nothing is deployed from ${path.dirname(s.configFile)}. Run \`${CLI} init\` (see the quick start). Another deployment? Set A2A_CONFIG_DIR.`);
	if (s.baseUrlEnv)
		return fail(`A2A_BASE_URL is exported as ${s.baseUrlEnv}, but ${s.configFile} has ${s.baseUrlSaved || "(none)"}: CLI commands (and push URLs sent to peers) use the exported value. Unset A2A_BASE_URL (the A2A endpoint URL is always the deployment's own)`);
	if (!s.baseUrl || !s.hasOwnerToken)
		return fail(`the deployment is incomplete (no ${!s.baseUrl ? "base URL" : "owner token"} saved): re-run \`${CLI} init\` with the same flags (safe: it reuses the D1 database and the owner token)`);
	if (!s.card.ok && s.card.cfError === 1042)
		return fail(`the Worker is still propagating (Cloudflare error 1042, normal for up to 30 seconds after a first deploy): run \`${CLI} status\` again in 30 seconds. Still 1042 after a few minutes? Run \`${CLI} deploy\``);
	if (!s.card.ok)
		return fail(`the agent card is not reachable (${s.card.error}). A new workers.dev subdomain or custom domain can take a few minutes: run \`${CLI} status\` again. Still failing? Run \`${CLI} deploy\``);
	if (s.card.urlProblem)
		return fail(`the agent card does not point peers at this deployment: ${s.card.urlProblem}, so peers would send requests there. Run \`${CLI} deploy\`: the card URL comes from the deployment (custom hostname or workers.dev), never from a local webhook, Tailnet or tunnel URL; don't edit the card by hand`);
	if (!s.ownerApi.ok)
		return fail(/HTTP 401/.test(s.ownerApi.error)
			? `the owner token in ${s.configFile} does not match the Worker: run \`${CLI} init --rotate-owner-token\` from the machine that owns this deployment`
			: `the owner API failed (${s.ownerApi.error}): run \`${CLI} deploy\``);
	const version = s.cliVersion || D.VERSION;
	if (s.workerVersion && newer(version, s.workerVersion))
		return fail(`the deployed Worker is ${s.workerVersion}, older than this CLI (${version}): run \`${CLI} deploy\``);
	if (s.health?.ok && s.health.version === null)
		return fail(`the deployed Worker predates version reporting (older than ${version}): run \`${CLI} deploy\``);
	// proxy / expose mode: the upstream answers peers, so wakes are optional (pairing notifications only)
	const fc = s.facade;
	if (fc) {
		if (fc.mode !== "proxy")
			return fail(`${s.configFile} has A2A_UPSTREAM_URL, but the Worker is not in proxy mode (an older template or an interrupted deploy): run \`${CLI} deploy\``);
		if (fc.upstreamProblem) return fail(`the upstream URL is unusable: ${fc.upstreamProblem}. Fix it with \`${CLI} deploy --upstream <tunnel URL>\``);
		if (fc.upstreamCardProblem) return fail(`the upstream card URL is refused: ${fc.upstreamCardProblem}. Fix it with \`${CLI} deploy --upstream-card-url <URL on the upstream's origin>\` (or \`--upstream-card-url none\` for the default)`);
		// the live check (owner-authenticated, run by the Worker with its stored secrets) is the precise diagnosis
		const v = s.upstreamVerify;
		if (v && v.reason && v.reason !== "reachable" && UPSTREAM_FIX[v.reason]) return fail(UPSTREAM_FIX[v.reason](v.detail || v.reason));
		// an Access-only configuration must not look complete when the agent's card asks for a bearer
		const wantsBearer = fc.upstreamAuth && fc.upstreamAuth.bearer === true;
		if (wantsBearer && !fc.hasUpstreamToken && !(v && v.ok) && !s.upstreamNoToken)
			return fail(`the upstream's card asks for a bearer token (${(fc.upstreamAuth.schemes || []).join(", ")}) and the Worker has no UPSTREAM_TOKEN: Cloudflare Access only lets the Worker through the tunnel, so peers' calls would fail with HTTP 502. Export UPSTREAM_TOKEN and run \`${CLI} deploy\``);
		if (fc.upstreamCard !== "ok")
			return fail(`the Worker can't fetch the upstream's agent card (${fc.upstreamCard}): is the tunnel connector running on the agent's machine, and does the Access app admit the service token you exported as UPSTREAM_ACCESS_CLIENT_ID / UPSTREAM_ACCESS_CLIENT_SECRET (re-run \`${CLI} deploy\` with them exported)?`);
		if (fc.publicCardLeaks && fc.publicCardLeaks.length)
			return fail(`the public card still names a private URL (${fc.publicCardLeaks[0]}): report this as a bug; meanwhile override the field with --agent-description / --agent-skills and run \`${CLI} deploy\``);
		const also = [];
		if (!fc.hasUpstreamAccessServiceToken) also.push("no Access service token for the upstream: unless the upstream hostname is protected another way, put it behind Cloudflare Access and export UPSTREAM_ACCESS_CLIENT_ID / UPSTREAM_ACCESS_CLIENT_SECRET, then deploy");
		if (wantsBearer && !fc.hasUpstreamToken)
			also.push(`the upstream's card asks for a bearer token but the Worker has none${s.upstreamNoToken ? " (--no-upstream-token)" : ""}${v && v.ok ? "; the agent accepts calls without it today" : ""}: if peers get HTTP 502, export UPSTREAM_TOKEN and run \`${CLI} deploy\``);
		if (fc.upstreamAuth && fc.upstreamAuth.unsupported && fc.upstreamAuth.unsupported.length)
			also.push(`the upstream's card requires ${fc.upstreamAuth.unsupported.join(", ")}; the façade only presents a bearer token (UPSTREAM_TOKEN) and the Access service token`);
		if (s.localUpstreamToken && fc.fingerprints && fc.fingerprints.upstreamToken !== s.localUpstreamToken)
			also.push(`the UPSTREAM_TOKEN exported here (fingerprint ${s.localUpstreamToken}) differs from the Worker's (${fc.fingerprints.upstreamToken || "none"}): run \`${CLI} deploy\` to upload it`);
		if (!v && s.upstreamVerifyError) also.push(`the live upstream check was not run (${s.upstreamVerifyError || "unavailable"})${/HTTP 404/.test(s.upstreamVerifyError || "") ? `: run \`${CLI} deploy\` for a Worker with \`upstream verify\`` : ""}`);
		if (fc.lastFailure && fc.lastFailure.reason && v && v.ok)
			also.push(`last failed peer call: ${fc.lastFailure.reason}${fc.lastFailure.status ? ` (HTTP ${fc.lastFailure.status})` : ""} at ${fc.lastFailure.at}; the live check passes now`);
		if (s.pairing && s.pairing.mode === "human" && !s.pairing.passwordSet)
			also.push(`peers can't connect yet: run \`${CLI} pair set-password --web\` and send your human the one-time link (or they run \`${CLI} pair set-password\` in a terminal); never set it yourself`);
		if (s.pairing && s.pairing.pending) also.push(`${s.pairing.pending} pending pairing request(s): \`${CLI} pair list\`, then tell your human (never approve on your own)`);
		return done(`none: the façade is up and forwards paired peers' A2A calls to the upstream. Peers connect with \`${CLI} connect ${s.baseUrl}\``, also);
	}
	const t = s.tunnel;
	if (t && !t.complete) return fail(`a previous \`tunnel create\` did not finish: run \`${CLI} tunnel rm\`, then \`${CLI} tunnel create\``);
	if (t && !t.tokenFileOk)
		return fail(`the tunnel's connector token file (${t.tokenFile}) is missing or empty: run \`${CLI} tunnel create\` again (it downloads the token again; nothing new is created)`);
	const agentSecret = ["hermes", "openbot"].includes(s.wake.preset) ? "WAKE_HMAC_SECRET" : "WAKE_WEBHOOK_KEY";
	const needsAgentSecret = s.wake.preset === "openbot" ? !s.wake.hasHmacSecret : LOCAL_PRESETS.includes(s.wake.preset) && !s.wake.hasKey && !s.wake.hasHmacSecret;
	const now = typeof s.now === "number" ? s.now : Date.now();
	if (t && !(s.wake.hasAccessServiceToken && t.workerUrlMatches)) {
		if (secretsPropagating(t, now) && (t.connections === 0 || t.connections == null))
			return done(`Worker wake secrets are still propagating (about 15 to 40 seconds after tunnel create). Wait about 30 seconds. Start \`cloudflared tunnel run --token-file ${t.tokenFile}\` on the agent's machine now, then run \`${CLI} status\` again.`);
		return fail(`the Worker does not have the tunnel's wake secrets: ${needsAgentSecret ? `export ${agentSecret} and ` : ""}run \`${CLI} tunnel create\` again (it re-uploads them; nothing new is created)`);
	}
	if (t && connectorConnecting(t, now))
		return done(`waiting for the connector to connect. Start \`cloudflared tunnel run --token-file ${t.tokenFile}\` on the agent's machine now, then run \`${CLI} status\` again.`);
	if (t && t.connections === 0)
		return fail(`the tunnel has ${t.state === "inactive" ? "never connected" : "no running connector"}: on the agent's machine run \`cloudflared tunnel run --token-file ${t.tokenFile}\` (outbound port 7844 must be open), then \`${CLI} wake test\``);
	if (s.wake.configured && needsAgentSecret)
		return fail(`the Worker sends no webhook auth, so the ${s.wake.preset} webhook will reject wakes: export ${agentSecret} (${["hermes", "openbot"].includes(s.wake.preset) ? "the route secret" : "the hooks token"}), then run \`${CLI} ${t ? "tunnel create" : "wake set"}\``);
	// not broken, but peers can't pair until the human sets the approval password
	const also = [];
	if (s.pairing && s.pairing.mode === "human" && !s.pairing.passwordSet)
		also.push(`peers can't connect yet: run \`${CLI} pair set-password --web\` and send your human the one-time link (or they run \`${CLI} pair set-password\` in a terminal); never set it yourself`);
	if (s.pairing && s.pairing.pending)
		also.push(`${s.pairing.pending} pending pairing request(s): \`${CLI} pair list\`, then tell your human (never approve on your own)`);
	const done2 = (text, extra = []) => done(text, [...extra, ...also]);
	if (!s.wake.configured) {
		const poll = "the agent must check the A2A endpoint on a schedule (Hermes and OpenClaw have copy-paste commands in the setup references)";
		if (s.wake.preset && !LOCAL_PRESETS.includes(s.wake.preset) && s.wake.preset !== "generic")
			return done2(`no wake webhook: export WAKE_WEBHOOK_URL and ${agentSecret}, then run \`${CLI} wake set --preset ${s.wake.preset}\`; or ${poll}`);
		const z = s.zones;
		const tunnel = !z ? `a local-only webhook can use \`${CLI} tunnel create\` (needs a zone on the account)`
			: !z.length ? "the account has no domain (zone), so the secure tunnel is not available"
			: z.length === 1 ? `for immediate wakes to a local-only webhook, run \`${CLI} tunnel create\` (it uses the account's zone ${z[0]}; no redeploy needed)`
			: `for immediate wakes to a local-only webhook, run \`${CLI} tunnel create --tunnel-zone <zone>\` with one of: ${z.join(", ")} (no redeploy needed)`;
		const pub = s.wake.preset === "generic" ? `a public webhook: export WAKE_WEBHOOK_URL (and a key), then \`${CLI} wake set\`` : "";
		return done2(`no wake webhook, so ${poll}.`, [`optional: ${tunnel}`, ...(pub ? [`optional: ${pub}`] : [])]);
	}
	return done2(`none: setup is complete. Check a real wake with \`${CLI} wake test\`.`,
		[`peers connect with \`${CLI} connect ${s.baseUrl}\` (your human approves each one); \`${CLI} token issue <peer>\` is the manual fallback`]);
}

function hostOf(url) {
	try { return new URL(url).hostname; } catch { return ""; }
}

/** Facts for the eight layers. Tokens and client secrets stay out of this object. */
function layerFacts(s, extra) {
	const t = s.tunnel;
	return {
		deployed: s.deployed, baseUrl: s.baseUrl || "", host: extra.host || "", platform: process.platform,
		workerDns: extra.workerDns, card: s.card, health: s.health, hasOwnerToken: s.hasOwnerToken, ownerApi: s.ownerApi,
		wakeHost: extra.wakeHost || "", wakeDns: extra.wakeDns, bare: extra.bare, authed: extra.authed,
		serviceToken: extra.serviceToken, localServiceToken: extra.localServiceToken, pairing: s.pairing,
		tunnel: t ? {
			complete: t.complete, tokenFileOk: t.tokenFileOk, tokenFile: t.tokenFile, connections: t.connections,
			grace: connectorConnecting(t), origin: t.origin, down1033: !!extra.down1033,
		} : null,
	};
}

/** Wake DNS, the bare Access probe, and the service-token probe. GET only. The Access token is sent
 *  and not stored. The webhook's bearer and HMAC are not sent. */
async function wakeProbes(s, net) {
	const wakeHost = s.tunnel?.hostname || "";
	const empty = { wakeHost, wakeDns: { kind: "skip" }, bare: null, authed: null, down1033: false };
	if (!wakeHost) return empty;
	const wakeDns = await resolveWakeDns(wakeHost, net);
	if (wakeDns.kind !== "pass" || !s.tunnel?.wakeUrl) return { ...empty, wakeDns };
	const localServiceToken = !!(C.get("A2A_TUNNEL_ACCESS_CLIENT_ID") && C.get("A2A_TUNNEL_ACCESS_CLIENT_SECRET"));
	const run = async () => {
		const bare = await probeGet(s.tunnel.wakeUrl);
		let authed = null;
		if (localServiceToken) {
			authed = await probeGet(s.tunnel.wakeUrl, {
				"CF-Access-Client-Id": C.get("A2A_TUNNEL_ACCESS_CLIENT_ID"),
				"CF-Access-Client-Secret": C.get("A2A_TUNNEL_ACCESS_CLIENT_SECRET"),
			});
		}
		return { bare, authed };
	};
	let probed;
	try {
		probed = wakeDns.ip && usablePin(wakeDns.ip) ? await withHostPin(wakeHost, wakeDns.ip, run) : await run();
	} catch (e) {
		probed = { bare: { error: e?.message || "request failed" }, authed: null };
	}
	const down1033 = [probed.bare, probed.authed].some((p) => p && p.cf === "1033");
	return { wakeHost, wakeDns, bare: probed.bare, authed: probed.authed, down1033 };
}

function finishLayers(s, extra) {
	const localServiceToken = !!(C.get("A2A_TUNNEL_ACCESS_CLIENT_ID") && C.get("A2A_TUNNEL_ACCESS_CLIENT_SECRET"));
	const serviceToken = localServiceToken || s.wake?.hasAccessServiceToken ? "configured" : "not-configured";
	s.layers = buildLayers(layerFacts(s, { ...extra, localServiceToken, serviceToken }));
	return s;
}

/** Collect the snapshot. Each probe tolerates failure; nothing is created or changed.
 *  `net.lookup` and `net.doh` replace the system resolver and DNS-over-HTTPS in tests. */
export async function collect(net = {}) {
	const s = {
		configFile: C.CONFIG_FILE,
		deployed: !!(C.get("A2A_D1_ID") && C.get("A2A_WORKER_NAME")),
		worker: C.get("A2A_WORKER_NAME"), d1: C.get("A2A_D1_NAME"), account: C.get("CLOUDFLARE_ACCOUNT_ID"), cfProfile: C.get("CF_PROFILE"),
		baseUrl: baseUrl(), urlKind: C.get("A2A_HOSTNAME") ? "custom domain" : "workers.dev", cron: C.get("A2A_ENABLE_CRON") === "1",
		hasOwnerToken: !!C.get("A2A_OWNER_TOKEN"), baseUrlSaved: (C.fileConfig().A2A_BASE_URL || "").replace(/\/$/, ""), baseUrlEnv: "",
		card: { ok: false, error: "not checked" }, ownerApi: { ok: false, error: "not checked" }, wake: null, tunnel: null, zones: null, pairing: null,
		upstream: C.get("A2A_UPSTREAM_URL") || null, facade: null, upstreamVerify: null, upstreamVerifyError: "", facadePeerAuth: null,
		upstreamNoToken: C.get("A2A_UPSTREAM_NO_TOKEN") === "1", localUpstreamToken: fingerprint(process.env.UPSTREAM_TOKEN),
		peerTokenShadowed: shadowedPeerTokens(), addresses: null,
		mcp: "unknown", health: null, workerVersion: null, cliVersion: D.VERSION, latestVersion: readCache(cacheFile())?.latest || null,
	};
	const envBase = (process.env.A2A_BASE_URL || "").replace(/\/$/, "");
	if (envBase && envBase !== s.baseUrlSaved) s.baseUrlEnv = envBase;
	if (!s.deployed || !s.baseUrl) return finishLayers(s, { host: "", workerDns: { kind: "skip" }, wakeHost: "", wakeDns: { kind: "skip" }, bare: null, authed: null });
	const host = hostOf(s.baseUrl);
	const workerDns = await resolveWorkerDns(host, net);
	const remote = async () => {
		s.card = await checkCard(s.baseUrl);
		s.health = await checkHealth(s.baseUrl);
		s.workerVersion = s.health.version;
		if (s.hasOwnerToken) {
			try {
				const p = await owner("GET", "/owner/wake/preview");
				s.ownerApi = { ok: true };
				s.wake = { preset: p.preset, configured: !!p.configured, hasKey: !!p.hasKey, hasHmacSecret: !!p.hasHmacSecret,
					hasAccessServiceToken: !!p.hasAccessServiceToken, urlFingerprint: p.fingerprints?.url || null };
			} catch (e) { s.ownerApi = { ok: false, error: e.message }; }
			if (s.ownerApi.ok) {
				try {
					const pr = await owner("GET", "/owner/pairing");
					if (pr && typeof pr === "object" && ["human", "agent", "off"].includes(pr.mode))
						s.pairing = { mode: pr.mode, passwordSet: !!pr.passwordSet, passwordSetAt: pr.passwordSetAt || null, passwordSetVia: pr.passwordSetVia || null,
							setupLinkExpiresAt: pr.setupLinkExpiresAt || null, pending: (pr.pending || []).length,
							...(typeof pr.oidcIssuer === "string" && pr.oidcIssuer ? { oidcIssuer: pr.oidcIssuer } : {}),
							...(typeof pr.manageUrl === "string" && pr.manageUrl ? { manageUrl: pr.manageUrl } : {}) };
				} catch { /* older Worker (no pairing yet): leave unknown */ }
				try {
					const ad = await ownerTry("GET", "/owner/address");
					if (ad.status === 200 && ad.data && typeof ad.data === "object") s.addresses = ad.data;
				} catch { /* older Worker: no address lifecycle */ }
				if (s.upstream) {
					try { s.facade = await owner("GET", "/owner/facade"); }
					catch (e) { s.facade = { mode: "unknown", error: e.message }; }
					if (s.facade && s.facade.mode === "proxy") Object.assign(s, await upstreamCheck(s.baseUrl));
				}
				try {
					const m = await ownerTry("GET", "/owner/mcp");
					if (m.status === 200 && m.data && typeof m.data === "object" && typeof m.data.enabled === "boolean")
						s.mcp = m.data.enabled ? "on" : "off";
				} catch { /* probe failed: leave mcp unknown so status omits the add line */ }
			}
		}
		const dir = D.workerDir({});
		const haveCf = fs.existsSync(dir);
		const tunnelHost = C.get("A2A_TUNNEL_HOSTNAME");
		if (tunnelHost || C.get("A2A_TUNNEL_ID")) {
			const url = T.wakeUrl(tunnelHost || "?", C.get("A2A_TUNNEL_PATH") || "/");
			s.tunnel = { hostname: tunnelHost, wakeUrl: url, origin: C.get("A2A_TUNNEL_ORIGIN"), complete: T.tunnelComplete(), tokenFileOk: T.tokenFileOk(),
				tokenFile: C.get("A2A_TUNNEL_TOKEN_FILE") || "<config dir>/tunnel-token", workerUrlMatches: s.wake?.urlFingerprint === fingerprint(url),
				secretsAt: Number(C.get("A2A_TUNNEL_SECRETS_AT")) || 0, connections: null };
			if (haveCf && C.get("A2A_TUNNEL_ID")) {
				try {
					const t = T.cfCall(dir, ["tunnels", "get", C.get("A2A_TUNNEL_ID")], { allowNotFound: true });
					if (!t) s.tunnel.complete = false;
					else { s.tunnel.state = t.status; s.tunnel.connections = (t.connections || []).length; }
				} catch (e) { s.tunnel.error = e.message; }
			}
		} else if (s.wake && !s.wake.configured && haveCf) {
			try { s.zones = T.listZones(dir).filter((z) => !z.status || z.status === "active").map((z) => z.name); } catch { /* not logged in, offline: leave unknown */ }
		}
	};
	if (workerDns.kind === "public-only" && usablePin(workerDns.ip)) await withHostPin(host, workerDns.ip, remote);
	else await remote();
	const wake = await wakeProbes(s, net);
	return finishLayers(s, { host, workerDns, ...wake });
}

const VERIFY_METHOD = "a2a-exposed/verify-unknown-method";

/** The two upstream probes, neither creating anything: (1) public: an unauthenticated JSON-RPC call to the façade, which
 *  must answer 401 before looking at the method; (2) owner-authenticated: the Worker sends a JSON-RPC call with an
 *  unknown method to the upstream with its stored secrets and classifies the answer (POST /owner/facade/verify). */
export async function upstreamCheck(base) {
	const out = { facadePeerAuth: null, upstreamVerify: null, upstreamVerifyError: "" };
	try {
		const r = await httpJson(base + "/", { method: "POST", body: { jsonrpc: "2.0", id: "a2a-exposed-verify", method: VERIFY_METHOD, params: {} }, headers: { "a2a-version": "1.0" }, timeout: 15000 });
		out.facadePeerAuth = { status: r.status };
	} catch (e) { out.facadePeerAuth = { status: null, error: e.message }; }
	try {
		const r = await ownerTry("POST", "/owner/facade/verify", {});
		if (r.status === 200 && r.data && typeof r.data === "object" && r.data.reason) out.upstreamVerify = r.data;
		else out.upstreamVerifyError = describeHttp(r.status, r.data);
	} catch (e) { out.upstreamVerifyError = e.message; }
	return out;
}

/** Exact `claude mcp add` line when GET /owner/mcp reports `enabled` and the agent card is reachable. */
export function mcpAddCommand(s) {
	if (!s || !s.baseUrl || s.mcp !== "on" || !s.card?.ok || !s.ownerApi?.ok) return "";
	return `claude mcp add --transport http a2a-exposed ${String(s.baseUrl).replace(/\/$/, "")}/mcp`;
}

/** `upstream verify`: the façade's whole path, layer by layer; exit 1 unless the upstream app answered. */
export async function upstreamVerify(o) {
	if (!C.get("A2A_UPSTREAM_URL")) die(`not a façade: ${C.CONFIG_FILE} has no A2A_UPSTREAM_URL (proxy mode: \`${CLI} deploy --upstream <tunnel URL>\`). For an A2A endpoint, check wakes with \`${CLI} wake test\``);
	const base = baseUrl();
	if (!base || !C.get("A2A_OWNER_TOKEN")) die(`A2A_BASE_URL / A2A_OWNER_TOKEN missing (run \`${CLI} init\` or edit ${C.CONFIG_FILE})`);
	const r = await upstreamCheck(base);
	const v = r.upstreamVerify;
	if (o.json) console.log(JSON.stringify({ ...r, ok: !!(v && v.ok) }, null, 2));
	else {
		const rows = [["upstream", C.get("A2A_UPSTREAM_URL")], ...verifyLayers(v, r.facadePeerAuth)];
		if (!v) rows.push(["check", `FAILED: ${r.upstreamVerifyError}${/HTTP 404/.test(r.upstreamVerifyError) ? ` (this Worker predates \`upstream verify\`: run \`${CLI} deploy\`)` : ""}`]);
		else rows.push(["result", v.ok ? "OK: the façade reaches the agent with its stored credentials" : `${v.reason}: ${UPSTREAM_FIX[v.reason] ? UPSTREAM_FIX[v.reason](v.detail || v.reason) : v.detail}`]);
		for (const [k, val] of rows) console.log(`${(k + ":").padEnd(18)} ${val}`);
	}
	if (!(v && v.ok) || (r.facadePeerAuth && r.facadePeerAuth.status !== null && r.facadePeerAuth.status !== 401)) process.exitCode = 1;
}

export async function status(o) {
	const s = await collect();
	const next = nextStep(s);
	const mcpAdd = mcpAddCommand(s);
	const layers = Array.isArray(s.layers) ? s.layers : [];
	const ok = next.ok && !layers.some((l) => l.result === "FAIL");
	if (o.json) {
		const out = { ...s, mcpAdd, nextStep: next.text, also: next.also, ok, layers };
		if (out.tunnel && out.tunnel.state != null) out.tunnel = { ...out.tunnel, state: tunnelStateLabel(out.tunnel.state) };
		console.log(JSON.stringify(out, null, 2));
	}
	else {
		const rows = [
			["config", s.configFile],
			["deployment", s.deployed ? `Worker ${s.worker}, D1 ${s.d1 || s.worker}${s.account ? `, account ${s.account}` : ""}${s.cfProfile ? `, cf profile ${s.cfProfile}` : ""}${s.cron ? ", cron flush on" : ""}` : "none"],
			["base URL", s.baseUrl ? `${s.baseUrl} (${s.baseUrlEnv ? `from the exported A2A_BASE_URL; ${s.configFile} has ${s.baseUrlSaved || "none"}` : s.urlKind})` : "(not saved)"],
		];
		if (s.deployed && s.baseUrl) {
			rows.push(["agent card", !s.card.ok ? `FAILED: ${s.card.error}` : s.card.urlProblem ? `WRONG URL: "${s.card.name}", but ${s.card.urlProblem}`
				: `OK: "${s.card.name}" (A2A ${s.card.versions.join(", ") || "?"})`]);
			rows.push(["worker version", `${s.workerVersion || "unknown"} (CLI ${s.cliVersion})`]);
			rows.push(["owner API", s.ownerApi.ok ? "OK" : `FAILED: ${s.ownerApi.error}`]);
			if (s.upstream) {
				const f = s.facade || {};
				rows.push(["upstream", `${s.upstream} (proxy mode)${f.mode === "proxy" ? `; card ${f.upstreamCard}${f.upstreamVersions && f.upstreamVersions.length ? ` (A2A ${f.upstreamVersions.join(", ")})` : ""}; public card ${f.publicCardLeaks && f.publicCardLeaks.length ? "LEAKS a private URL" : "clean"}` : f.error ? `; ${f.error}` : "; the Worker is not in proxy mode"}`]);
				if (f.mode === "proxy") {
					const ua = f.upstreamAuth || {};
					rows.push(["upstream Access", f.hasUpstreamAccessServiceToken ? `credential configured (UPSTREAM_ACCESS_CLIENT_ID fingerprint ${f.fingerprints?.upstreamAccessClientId || "?"})` : "NONE (UPSTREAM_ACCESS_CLIENT_ID / _SECRET not on the Worker)"]);
					rows.push(["upstream bearer", f.hasUpstreamToken ? `bearer configured (UPSTREAM_TOKEN fingerprint ${f.fingerprints?.upstreamToken || "?"})`
						: ua.bearer === true ? `NONE, but the upstream card asks for one (${(ua.schemes || []).join(", ")})${s.upstreamNoToken ? "; --no-upstream-token" : ""}`
						: ua.bearer === false ? "none (the upstream card declares no bearer auth)" : `none${s.upstreamNoToken ? " (--no-upstream-token)" : ""}`]);
					const v = s.upstreamVerify;
					rows.push(["upstream check", !v ? `not run (${s.upstreamVerifyError || "?"})` : v.ok ? `OK: ${verifyLayers(v).map(([k, x]) => `${k} ${x.replace(/ \(.*$/, "")}`).join("; ")}` : `FAILED (${v.reason}): ${v.detail}`]);
					if (s.facadePeerAuth) rows.push(["peer auth", verifyLayers(null, s.facadePeerAuth)[0][1]]);
					if (f.lastFailure && f.lastFailure.reason) rows.push(["last failure", `${f.lastFailure.reason}${f.lastFailure.status ? ` (HTTP ${f.lastFailure.status})` : ""} on ${f.lastFailure.method || "?"} from peer ${f.lastFailure.peer || "?"} at ${f.lastFailure.at}`]);
				}
			}
			rows.push(["wake", wakeLine(s)]);
			const t = s.tunnel;
			rows.push(["tunnel", !t ? "none" : `${t.wakeUrl} -> ${t.origin || "?"}; ${!t.complete ? "INCOMPLETE" : t.tokenFileOk ? "set up" : "set up, but the connector token file is MISSING"}` +
				(t.connections != null ? `; ${tunnelStateLabel(t.state)}, ${t.connections} connector connection(s)` : t.error ? `; state unknown (${t.error})` : "")]);
			if (s.zones) rows.push(["zones", s.zones.length ? s.zones.join(", ") : "none on this account"]);
			const addr = s.addresses;
			if (addr) {
				const bits = [];
				if (Array.isArray(addr.inboundNoAddress) && addr.inboundNoAddress.length)
					bits.push(`${addr.inboundNoAddress.length} paired peer(s) with no callback (${addr.inboundNoAddress.map((x) => x.label).join(", ")})`);
				if (Array.isArray(addr.announcePending) && addr.announcePending.length)
					bits.push(`announce still pending for ${addr.announcePending.map((x) => x.alias).join(", ")}`);
				if (addr.forward && addr.forward.active) bits.push(`grace forward until ${addr.forward.until}`);
				if (bits.length) rows.push(["addresses", bits.join("; ")]);
			}
			const pg = s.pairing;
			if (pg) rows.push(["pairing", pg.mode === "off" ? "off (token issue only)"
				: `${pg.mode} approval; approval password ${pg.passwordSet ? `set${pg.passwordSetAt ? ` ${pg.passwordSetAt}` : ""}${pg.passwordSetVia ? ` (via ${pg.passwordSetVia})` : ""}` : `NOT SET${pg.setupLinkExpiresAt ? ` (a setup link is open until ${pg.setupLinkExpiresAt})` : ""}`}${pg.oidcIssuer ? `; OpenID Connect (${pg.oidcIssuer})` : ""}${pg.manageUrl ? `; dashboard ${pg.manageUrl}` : ""}${pg.pending ? `; ${pg.pending} pending request(s): ${CLI} pair list` : ""}`]);
		}
		if (mcpAdd) rows.push(["mcp", mcpAdd]);
		for (const l of layers) rows.push([l.name, layerValue(l)]);
		rows.push(["next step", next.text]);
		for (const a of next.also || []) rows.push(["also", a]);
		const w = Math.max(12, ...rows.map(([k]) => k.length + 2));
		for (const [k, v] of rows) console.log(`${(k + ":").padEnd(w)} ${v}`);
	}
	if (!ok) process.exitCode = 1;
}
