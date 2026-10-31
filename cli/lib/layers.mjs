// Eight read-only checks for `status`. Pure: the caller supplies DNS and HTTP results.
// Each layer is PASS, FAIL, or SKIP. A failure names the missing or mismatched object and a fix.
// Nothing here prints a token, a client secret, or a webhook key.
import { CLI, isPrivateHost } from "./a2a.mjs";
import { isIP } from "node:net";

export const LAYER_NAMES = [
	"Worker DNS",
	"Worker",
	"Owner API",
	"Wake DNS",
	"Access",
	"Connector",
	"Local webhook",
	"Pairing",
];

const TLS_RE = /CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_GET_ISSUER_CERT|CERT_UNTRUSTED/;

/** Shown when public DNS has the Worker hostname and this machine's resolver does not. */
export function publicDnsMismatch(host) {
	return `public DNS resolves ${host}; this machine's resolver does not (local cache or resolver). The Worker is reachable through Cloudflare.`;
}

/** Shown when public DNS has no A record for the Worker hostname. */
export function noPublicDns(host) {
	return `no public DNS record for ${host} yet: check the Worker custom domain in Cloudflare (Workers → Settings → Domains)`;
}

export const MACOS_RESOLVER_FIX = "sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder";

/** An address from DNS-over-HTTPS that is safe to connect to (not loopback, LAN, or link-local). */
export function usablePin(ip) {
	return typeof ip === "string" && isIP(ip) !== 0 && !isPrivateHost(ip);
}

function layer(name, result, detail, fix = "") {
	return { name, result, detail, fix: result === "FAIL" ? fix : "" };
}

/** One status row: `PASS|FAIL|SKIP  detail` and, on failure, `Fix: …`. */
export function layerValue(l) {
	if (!l || l.result !== "FAIL" || !l.fix) return `${l.result}  ${l.detail}`;
	const gap = /[.]$/.test(l.detail) ? " " : ". ";
	return `${l.result}  ${l.detail}${gap}Fix: ${l.fix}`;
}

function workerDnsLayer(f) {
	if (!f.host) return layer("Worker DNS", "SKIP", "no base URL saved");
	const d = f.workerDns || { kind: "skip" };
	if (d.kind === "ip") return layer("Worker DNS", "PASS", `${f.host} is an address (no DNS name to resolve)`);
	if (d.kind === "system") return layer("Worker DNS", "PASS", `system resolver resolved ${f.host}${d.ip ? ` to ${d.ip}` : ""}`);
	if (d.kind === "public-only") {
		const mac = f.platform === "darwin" ? ` ${MACOS_RESOLVER_FIX}` : "";
		const fix = f.platform === "darwin" ? MACOS_RESOLVER_FIX : "flush this machine's DNS cache";
		return layer("Worker DNS", "FAIL", `${publicDnsMismatch(f.host)}${mac}`, fix);
	}
	if (d.kind === "no-record") return layer("Worker DNS", "FAIL", noPublicDns(f.host));
	if (d.kind === "fail") return layer("Worker DNS", "FAIL", `DNS lookup failed (${d.error || "unknown"}). Likely mismatched: resolver for ${f.host}`, "flush this machine's DNS cache, or check the hostname");
	return layer("Worker DNS", "SKIP", "not checked");
}

function workerLayer(f) {
	if (!f.baseUrl) return layer("Worker", "SKIP", "not checked (no base URL)");
	const https = /^https:/i.test(f.baseUrl);
	const card = f.card || { ok: false, error: "not checked" };
	if (https && card.error && TLS_RE.test(card.error))
		return layer("Worker", "FAIL", `Likely mismatched: TLS certificate for ${f.host}. ${card.error}`, `check the certificate for ${f.host} in Cloudflare (SSL/TLS)`);
	if (!card.ok)
		return layer("Worker", "FAIL", `Likely missing: deployed Worker. Agent card: ${card.error || "unreachable"}`, `${CLI} deploy`);
	if (card.urlProblem)
		return layer("Worker", "FAIL", `Likely mismatched: agent card URL. ${card.urlProblem}`, `${CLI} deploy`);
	const tls = https ? "TLS ok" : "TLS skipped (not https)";
	const named = card.name ? ` ("${card.name}")` : "";
	const cardBit = `${tls}; agent card HTTP ${card.httpStatus || 200}${named}`;
	const h = f.health;
	if (!h || h.ok !== true) {
		const problem = !h || h.httpStatus == null
			? `/health unreachable${h && h.error ? ` (${h.error})` : ""}`
			: h.httpStatus < 200 || h.httpStatus >= 300
				? `/health HTTP ${h.httpStatus}`
				: `/health HTTP ${h.httpStatus} did not report ok`;
		return layer("Worker", "FAIL", `Likely missing: Worker /health. ${cardBit}; ${problem}`, `${CLI} deploy`);
	}
	return layer("Worker", "PASS", `${cardBit}; /health HTTP ${h.httpStatus || 200}`);
}

function ownerLayer(f) {
	if (!f.deployed || !f.baseUrl) return layer("Owner API", "SKIP", "not checked (nothing deployed)");
	if (!f.hasOwnerToken) return layer("Owner API", "FAIL", "Likely missing: owner token", `${CLI} init`);
	if (f.ownerApi && f.ownerApi.ok) return layer("Owner API", "PASS", "owner token accepted");
	const err = (f.ownerApi && f.ownerApi.error) || "not checked";
	if (err === "not checked") return layer("Owner API", "SKIP", "not checked");
	if (/HTTP 401/.test(err)) return layer("Owner API", "FAIL", "Likely mismatched: owner token", `${CLI} init --rotate-owner-token`);
	return layer("Owner API", "FAIL", `Likely missing: deployed Worker. ${err}`, `${CLI} deploy`);
}

function wakeDnsLayer(f) {
	if (!f.wakeHost) return layer("Wake DNS", "SKIP", "no wake hostname");
	const d = f.wakeDns || { kind: "skip" };
	if (d.kind === "pass") return layer("Wake DNS", "PASS", `public DNS resolves ${f.wakeHost}${d.ip ? ` to ${d.ip}` : ""}`);
	if (d.kind === "no-record") return layer("Wake DNS", "FAIL", `no public DNS record for ${f.wakeHost} yet. Likely missing: tunnel DNS record for ${f.wakeHost}`, `${CLI} tunnel status`);
	if (d.kind === "fail") return layer("Wake DNS", "FAIL", `wake DNS check failed (${d.error || "unknown"}). Likely missing: tunnel DNS record for ${f.wakeHost}`, `${CLI} tunnel status`);
	return layer("Wake DNS", "SKIP", "not checked");
}

function accessProtected(bare) {
	if (!bare || bare.error || bare.status == null) return false;
	if (bare.status === 401 || bare.status === 403) return true;
	return bare.status >= 300 && bare.status < 400 && /cloudflareaccess\.com/i.test(bare.location || "");
}

function accessLayer(f) {
	if (!f.wakeHost) return layer("Access", "SKIP", "no wake hostname");
	const dns = f.wakeDns || {};
	if (dns.kind === "no-record" || dns.kind === "fail") return layer("Access", "SKIP", "not checked (wake DNS failed)");
	const bare = f.bare;
	if (!bare) return layer("Access", "SKIP", "not checked");
	if (bare.error) return layer("Access", "FAIL", `wake endpoint not reachable (${bare.error}). Likely missing: DNS record or Access application for ${f.wakeHost}`, `${CLI} tunnel status`);
	if (!accessProtected(bare))
		return layer("Access", "FAIL", `bare request was not blocked (HTTP ${bare.status}). Likely missing: Access application for ${f.wakeHost}`, `${CLI} tunnel status`);
	if (f.serviceToken !== "configured")
		return layer("Access", "FAIL", `protected (HTTP ${bare.status}); Access service token not configured. Likely missing: Access service token`, `${CLI} tunnel create`);
	return layer("Access", "PASS", `protected (HTTP ${bare.status}); Access service token configured`);
}

function connectorLayer(f) {
	const t = f.tunnel;
	if (!t) return layer("Connector", "SKIP", "no tunnel configured");
	const file = t.tokenFile || "tunnel-token";
	if (!t.complete) return layer("Connector", "FAIL", "Likely mismatched: unfinished tunnel", `${CLI} tunnel rm, then ${CLI} tunnel create`);
	if (!t.tokenFileOk) return layer("Connector", "FAIL", `Likely missing: connector token file (${file})`, `${CLI} tunnel create`);
	if (t.grace) return layer("Connector", "SKIP", `waiting for the connector to connect. Start \`cloudflared tunnel run --token-file ${file}\``);
	if (t.down1033 || t.connections === 0)
		return layer("Connector", "FAIL", `Likely missing: cloudflared connector${t.down1033 ? " (Cloudflare error 1033)" : ""}`, `cloudflared tunnel run --token-file ${file}`);
	if (typeof t.connections === "number" && t.connections > 0) return layer("Connector", "PASS", `connected (${t.connections})`);
	return layer("Connector", "SKIP", "connector state unknown");
}

function webhookLayer(f) {
	if (!f.wakeHost) return layer("Local webhook", "SKIP", "no wake hostname");
	const dns = f.wakeDns || {};
	if (dns.kind === "no-record" || dns.kind === "fail") return layer("Local webhook", "SKIP", "not checked (wake DNS failed)");
	if (f.tunnel && f.tunnel.grace) return layer("Local webhook", "SKIP", "not checked (connector still connecting)");
	if (!f.localServiceToken) {
		const where = f.serviceToken === "configured" ? "the Worker has an Access service token; this machine does not" : "no Access service token in the local config";
		return layer("Local webhook", "SKIP", `not probed (${where})`);
	}
	const p = f.authed;
	if (!p) return layer("Local webhook", "SKIP", "not checked");
	if (p.cf === "1033") return layer("Local webhook", "SKIP", "not reached (Cloudflare error 1033)");
	const origin = f.tunnel && f.tunnel.origin ? ` at ${f.tunnel.origin}` : "";
	if (p.error) return layer("Local webhook", "FAIL", `wake endpoint not reachable (${p.error}). Likely missing: local webhook${origin}`, "start the agent's webhook");
	const refusal = serviceTokenRefusal(p);
	if (refusal) return layer("Local webhook", "FAIL", `Likely mismatched: Access service token or Access policy. The service-token request was refused (${refusal})`, `${CLI} tunnel status`);
	if (p.status === 502 || p.status === 504 || p.status === 530)
		return layer("Local webhook", "FAIL", `wake endpoint HTTP ${p.status}. Likely missing: local webhook${origin}`, "start the agent's webhook");
	return layer("Local webhook", "PASS", `wake endpoint HTTP ${p.status}`);
}

/** Login host, Access path, Access error page, or an Access challenge. "Forbidden" alone is not a marker. */
const ACCESS_MARK = /cloudflareaccess\.com|\/cdn-cgi\/access\/|cloudflare[- ]access/i;

/** True when this response shows Cloudflare Access, from its headers or its body. */
function accessMarked(p) {
	const headers = Array.isArray(p.accessHeaders) ? p.accessHeaders : [];
	if (headers.some((n) => String(n).toLowerCase().startsWith("cf-access-"))) return true;
	return ACCESS_MARK.test(String(p.location || ""))
		|| ACCESS_MARK.test(String(p.wwwAuthenticate || ""))
		|| ACCESS_MARK.test(String(p.body || ""));
}

/** Access rejected the service token: a login redirect, or a 401/403 that carries Access markers.
 *  A 401/403 without those markers is not an Access refusal. The location URL is not repeated. */
function serviceTokenRefusal(p) {
	if (!p || p.error || p.status == null) return "";
	const loc = String(p.location || "");
	const login = /cloudflareaccess\.com|\/cdn-cgi\/access\//i.test(loc);
	if (p.status >= 300 && p.status < 400 && login) return `HTTP ${p.status} redirect to the Cloudflare Access login`;
	if ((p.status === 401 || p.status === 403) && accessMarked(p)) return `HTTP ${p.status} from Cloudflare Access`;
	return "";
}

function pairingLayer(f) {
	if (!f.deployed || !f.baseUrl) return layer("Pairing", "SKIP", "not checked (nothing deployed)");
	const p = f.pairing;
	if (!p) return layer("Pairing", "SKIP", "not checked (owner API did not report pairing)");
	if (p.mode === "off") return layer("Pairing", "PASS", "off (token issue only)");
	if (p.mode === "agent") return layer("Pairing", "PASS", "agent approval");
	if (p.mode === "human" && p.passwordSet) return layer("Pairing", "PASS", "approval password set");
	if (p.mode === "human" && p.oidcIssuer) return layer("Pairing", "PASS", `OpenID Connect (${p.oidcIssuer})`);
	if (p.mode === "human") return layer("Pairing", "FAIL", "Likely missing: approval password", `${CLI} pair set-password --web`);
	return layer("Pairing", "SKIP", "not checked");
}

/** The eight layers, in order. `f` is the snapshot gathered by `status` (no secrets). */
export function buildLayers(f) {
	const layers = [
		workerDnsLayer(f), workerLayer(f), ownerLayer(f), wakeDnsLayer(f),
		accessLayer(f), connectorLayer(f), webhookLayer(f), pairingLayer(f),
	];
	if (layers.length !== LAYER_NAMES.length || layers.some((l, i) => l.name !== LAYER_NAMES[i] || !["PASS", "FAIL", "SKIP"].includes(l.result)))
		throw new Error("status layers drifted");
	return layers;
}
