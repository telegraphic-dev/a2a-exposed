import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { domainToASCII } from "node:url";
import { isIP } from "node:net";
import { CliError } from "./a2a.mjs";
import { controlOrigin } from "./account.mjs";
import * as C from "./config.mjs";
import { readSigningSecret, validateSecretSource, writeTokenFile, startConnector, connectorCommand } from "./local-link.mjs";

// Keep JSON diagnostics local: never serialize arbitrary service fields or errors.
function resultShape(ok, code, next, details = {}) {
	return { ok, code, reason: null, field: null, phase: null, status: null, hostname: null, next, ...details };
}
function linkError(code, next, details = {}) {
	const error = new CliError(next);
	error.result = resultShape(false, code, next, details);
	return error;
}
const presetNext = "Pass --preset ID selected from hosted capabilities --json before requesting approval.";

export function normalizeHostname(value) {
	const invalid = (reason, next) => { throw linkError("invalid_hostname", next, { field: "hostname", reason, phase: "validation" }); };
	if (typeof value !== "string" || !value.trim()) invalid("required", "Pass --hostname with a full DNS hostname on your Cloudflare domain.");
	let hostname = value.trim();
	if (/[\s\\\x00-\x1f\x7f]/.test(hostname)) invalid("characters", "--hostname must not contain whitespace, control characters or backslashes.");
	if (hostname.includes("://")) {
		if (!/^https:\/\//i.test(hostname)) invalid("scheme", "--hostname accepts a DNS hostname or an HTTPS URL.");
		// Inspect authority before URL normalization can remove a default port or path.
		const authority = hostname.slice(8).split(/[/?#]/, 1)[0];
		if (authority.includes("@")) invalid("credentials", "--hostname must not contain URL credentials.");
		if (authority.includes(":")) invalid("port", "--hostname must not contain a port.");
		if (/[?#]/.test(hostname)) invalid("query_fragment", "--hostname must not contain a query or fragment.");
		const suffix = hostname.slice(8 + authority.length);
		if (suffix && suffix !== "/") invalid("path", "--hostname HTTPS URLs must have no path beyond /.");
		hostname = authority;
	} else {
		if (hostname.includes("@")) invalid("credentials", "--hostname must not contain URL credentials.");
		if (hostname.includes(":")) invalid("port", "--hostname must not contain a scheme or port; use an HTTPS URL or a DNS hostname.");
		if (/[/?#]/.test(hostname)) invalid("path", "--hostname must not contain a path, query or fragment.");
	}
	// IDNA also normalizes Unicode dot separators. Remove exactly one root dot.
	hostname = domainToASCII(hostname).toLowerCase().replace(/\.$/, "");
	if (isIP(hostname) || /^\d+(?:\.\d+)*$/.test(hostname)) invalid("ip_address", "--hostname must be a DNS hostname, not an IP address.");
	if (!hostname || hostname.length > 253 || !hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
		invalid("dns_labels", "--hostname needs DNS labels of 1–63 letters, digits or hyphens, with no empty labels or leading/trailing hyphens (253 characters maximum).");
	if (!hostname.includes(".") || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(hostname.split(".").at(-1)))
		invalid("domain", "--hostname must be a full DNS hostname with a valid domain suffix.");
	return hostname;
}

export function linkUsage() {
	throw linkError("usage", "Use hosted link create --agent NAME --hostname HOST --origin URL --path PATH --preset ID [--json], or hosted link finish --agent NAME --preset ID [--json]; choose exactly one protected --secret-file FILE, --secret-env VAR, or --secret-from hermes. List choices with hosted list --json and hosted capabilities --json.", { phase: "validation" });
}

export async function linkOutput(run, o = {}) {
	try {
		const result = await run();
		if (o.json) console.log(JSON.stringify(resultShape(true, result.saved ? "saved" : "connector_saved",
			result.saved ? "The connector connected; the wake test passed and settings were saved." : "Start cloudflared with the saved token file, then run hosted link finish with --preset ID for fresh approval.",
			{ phase: result.saved ? "wake-test" : "connector", hostname: result.hostname, ...result })));
	} catch (error) {
		if (!o.json) throw error;
		console.log(JSON.stringify(error.result || resultShape(false, "local_failure", "Hosted link setup did not finish. Check the local secret source, token-file permissions and cloudflared, then request fresh approval.")));
		process.exitCode = 1;
	}
}

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ERRORS = {
	expired_token: "The link request expired. Start a new one with hosted link create.",
	unauthorized: "Run a2a-exposed login, then run finish again.",
	invalid_request: "Check the agent name, hostname and link options before running the command again.",
	link_exists: "The link request was refused; review the approval page before changing or removing an existing link.",
	apex_hostname: "The domain itself cannot be a secure link. Choose a hostname below it, such as wake.example.com, then run create again.",
	outside_zone: "The hostname is not on a domain in your Cloudflare account. Choose a hostname on your domain, then run create again.",
	existing_dns: "The hostname already has a DNS record. Choose another hostname, then run create again.",
	existing_tunnel: "The hostname is already routed through another tunnel. Choose another hostname, then run create again.",
	provision_failed: "Check the approval page for the failing provisioning phase and cleanup state before running the command again.",
	preset: "Select a valid wake preset with --preset <id>, then run finish again.",
	signing_secret: "Check the local signing-secret source and receiver configuration before running the command again.",
	unreadable: "The secure link access key could not be read. Remove the secure link on the website, then run create again.",
	slow_down: "Too many pending requests for this agent. Deny an earlier request on the website or wait for it to expire, then run finish again.",
	access_denied: "The request was denied. Run finish again only if you still want to set up this link.",
	link_not_ready: "The secure link is not ready. Finish creating it in Wake settings on the website, then run finish again.",
	invalid_grant: "This grant is not valid. Run finish again and approve a new request.",
	already_delivered: "Credentials were already delivered for this request. Run finish again for fresh approval if you did not receive them.",
	connector_not_connected: "The connector is not connected. Start cloudflared with the saved token file, then run finish again for fresh approval.",
	not_found: "That agent or request was not found. Check --agent on the website, then run finish again.",
	cloudflare_unavailable: "Cloudflare could not be reached. Reconnect Cloudflare in Wake settings on the website, then run finish again.",
	unavailable: "The service is temporarily unavailable; retry later with fresh approval.",
};

// Fixed local guidance only: wake results must never expose server text.
const WAKE_NEXT_STEPS = {
	none: "Update the hosted Worker, then run finish again for fresh approval.",
	"dns-missing": "Wait for DNS propagation, then run finish again for fresh approval.",
	"access-401": "Check the signing secret and Access service-token pair, then run finish again for fresh approval.",
	"access-403": "Check the signing secret and Access service-token pair, then run finish again for fresh approval.",
	timeout: "Retry later by running finish again for fresh approval.",
	"origin-429": "Retry later by running finish again for fresh approval.",
	"origin-5xx": "Retry later by running finish again for fresh approval.",
	"origin-NNN": "Check the receiver's HTTP response, then run finish again for fresh approval.",
	tls: "Fix the receiver's TLS certificate, then run finish again for fresh approval.",
	private: "Use a public HTTPS wake URL, then run finish again for fresh approval.",
	dns: "Check the wake hostname's DNS records, then run finish again for fresh approval.",
	connection: "Check that the receiver is reachable, then run finish again for fresh approval.",
	unreadable: "Remove the secure link on the website, then run create again.",
	failed: "Check the receiver configuration, then run finish again for fresh approval.",
	unknown: "Update the CLI (npx a2a-exposed@latest) and send feedback.",
};

function wakeFailure(raw) {
	const value = typeof raw === "string" ? raw : "";
	const normalized = /^[1-5]\d{2}$/.test(value) ? `origin-${value}` : value;
	const result = Object.hasOwn(WAKE_NEXT_STEPS, normalized) && !["origin-5xx", "origin-NNN"].includes(normalized)
		? normalized : /^origin-\d{3}$/.test(normalized) ? normalized : "unknown";
	const guidance = WAKE_NEXT_STEPS[result] ?? WAKE_NEXT_STEPS[/^origin-5\d{2}$/.test(result) ? "origin-5xx" : "origin-NNN"];
	return { result, message: `wake test of the new secure link failed (${result}); saved wake settings were not changed. ${guidance}` };
}

// Only these public validation templates may cross the server-text boundary.
// Never echo arbitrary bodies, fetch errors, child output, or credential-bearing fields.
const VALIDATION_MESSAGES = new Set([
	"Choose a wake preset.", "Choose a wake preset and try again.",
	"Use a hostname on the selected domain.",
	"Use a full hostname such as wake.example.com.",
	"Remove the scheme (https://), port and path. Use a full hostname such as wake.example.com.",
	"Enter the local origin URL, such as http://127.0.0.1:8644.",
	"Use an http or https origin with no path or credentials.",
	"Use a path beginning with /, with no query or fragment.",
]);
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
function validationDetail(body, hostname) {
	if (typeof body?.message !== "string") return "";
	if (VALIDATION_MESSAGES.has(body.message)) return body.message.replace(/ and try again\.$/, ".");
	if (body.reason === "outside_zone" || body.error === "outside_zone") {
		const prefix = "That hostname is not on a domain in your Cloudflare account. ";
		if (body.message === prefix + "Add a domain to Cloudflare, then run create again.") return body.message;
		const match = body.message.match(/^That hostname is not on a domain in your Cloudflare account\. Use a hostname under (.+)\.$/);
		if (match && match[1].split(" or ").every((domain) => DOMAIN.test(domain))) return body.message;
	}
	const apex = `Use a hostname under ${hostname}, such as wake.${hostname}. The domain itself is not a secure link.`;
	return hostname && body.message === apex ? apex : "";
}

function provisionGuidance(body) {
	if (body.phase === "cleanup") return "Remove the unfinished secure link on the website, then run create again.";
	if (["hostname", "zone", "existing_dns", "existing_tunnel"].includes(body.phase))
		return "Choose another hostname on a domain in your Cloudflare account, then run create again.";
	if (body.status === 401 || body.status === 403)
		return "Cloudflare refused access. Reconnect Cloudflare on the website, then run create again.";
	if (body.status === 429 || (Number.isInteger(body.status) && body.status >= 500 && body.status <= 599))
		return "Cloudflare was busy. Run create again in a few minutes.";
	return ERRORS.provision_failed;
}

function failure(status, body, { command, hostname }, phase = "requests") {
	const known = (value) => typeof value === "string" && Object.hasOwn(ERRORS, value);
	const code = known(body?.reason) ? body.reason : known(body?.error) ? body.error : `HTTP ${status}`;
	const detail = phase === "requests" && ["invalid_request", "apex_hostname", "outside_zone"].includes(code) ? validationDetail(body, hostname) : "";
	let guidance = code === "provision_failed" ? provisionGuidance(body) : Object.hasOwn(ERRORS, code) ? ERRORS[code] : "check the link on the website and rerun the command for fresh approval";
	if (code === "expired_token") guidance = ["grant", "connector"].includes(phase)
		? `The approval grant expired. Run hosted link finish again for fresh approval; ${phase === "grant" ? "the saved connector token remains on disk and " : ""}wake settings were not saved.`
		: `The link request expired. Start a new one with hosted link ${command}.`;
	if (code === "invalid_request" && phase === "token") guidance = `The approval polling request was refused. Run hosted link ${command} again for fresh approval.`;
	const message = detail || guidance.replace(/run finish/gi, (match) => `${match.startsWith("R") ? "Run" : "run"} ${command}`);
	const reason = ["hostname_format", "origin_format", "path_format", "hostname_invalid", "preset_invalid", "origin_invalid", "path_invalid", "apex_hostname", "outside_zone", "existing_dns", "existing_tunnel"].includes(body?.reason) ? body.reason : known(body?.reason) ? body.reason : null;
	const field = ["hostname", "origin", "path", "preset"].includes(body?.field) ? body.field : null;
	const provisionPhase = ["cleanup", "hostname", "zone", "existing_dns", "existing_tunnel"].includes(body?.phase) ? body.phase : null;
	return linkError(code.startsWith("HTTP ") ? `http_${status}` : code,
		`link ${command} failed${hostname ? ` for ${hostname}` : ""} (${code}); ${message}`,
		{ reason, field, phase: code === "provision_failed" && provisionPhase ? provisionPhase : phase, status: code === "provision_failed" && Number.isInteger(body?.status) && body.status >= 100 && body.status <= 599 ? body.status : status, hostname: hostname || null });
}

export function savedLinkSession(origin, session = C.controlSession(), command = "finish") {
	if (controlOrigin(session.origin) !== origin || !session.token)
		throw linkError("login_required", `sign in to this service first: run login --control-url <service-origin>, then rerun hosted link ${command}; environment sessions require both CONTROL_URL and CONTROL_TOKEN`, { phase: "validation" });
	return session.token;
}

const CREATE_FIELDS = ["hostname", "origin", "path", "preset"];

function createPlan(o) {
	for (const key of CREATE_FIELDS) {
		if (typeof o[key] !== "string" || !o[key]) throw linkError("required", `hosted link create requires --${key}${key === "preset" ? "; " + presetNext : ""}`, { field: key, reason: "required", phase: "validation" });
	}
	const hostname = normalizeHostname(o.hostname);
	let origin;
	try { origin = new URL(o.origin); } catch { throw linkError("invalid_origin", "--origin must be an http or https origin", { field: "origin", phase: "validation" }); }
	if (!/^https?:$/.test(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
		throw linkError("invalid_origin", "--origin must be an http or https origin with no path or credentials", { field: "origin", phase: "validation" });
	if (!o.path.startsWith("/") || o.path.startsWith("//") || /[\s?#\\\x00-\x1f\x7f]/.test(o.path) || o.path.length > 1000)
		throw linkError("invalid_path", "--path must begin with / and have no query, fragment or whitespace", { field: "path", phase: "validation" });
	if (!/^[a-z][a-z0-9-]{0,63}$/.test(o.preset)) throw linkError("preset", presetNext, { field: "preset", reason: o.preset === undefined || o.preset === "" ? "required" : "preset_invalid", phase: "validation" });
	return { hostname, origin: origin.origin, path: o.path, preset: o.preset };
}

export function createLink(o, deps) {
	const create = createPlan(o);
	// Catch a wrong local route before asking the owner to create any resources.
	validateSecretSource(o);
	if (o["secret-from"] === "hermes" && (create.preset !== "hermes" || !/^\/webhooks\/[A-Za-z0-9_-]+$/.test(create.path) || (o.route && create.path !== `/webhooks/${o.route}`)))
		throw linkError("route_mismatch", "Hermes route does not match the create path and preset", { field: "path", phase: "validation" });
	return setupLink(o, deps, create);
}

export function finishLink(o, deps) {
	if (CREATE_FIELDS.filter((key) => key !== "preset").some((key) => o[key] !== undefined)) throw linkError("usage", "creation options require hosted link create; finish only reuses an existing link", { phase: "validation" });
	return setupLink(o, deps);
}

async function setupLink(o, {
	fetchImpl = fetch, sleep = sleepDefault, now = Date.now,
	write = (line) => console.error(line), saveToken = writeTokenFile,
	readSecret = readSigningSecret, runConnector = startConnector,
	sessionToken = savedLinkSession,
} = {}, create) {
	validateSecretSource(o);
	const context = { command: create ? "create" : "finish", hostname: create?.hostname };
	const agent = o.agent;
	if (typeof agent !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(agent)) throw linkError("agent", "--agent must be an agent name (letters, digits, underscores or hyphens); select it with hosted list --json", { field: "agent", phase: "validation" });
	if (typeof o.preset !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(o.preset)) throw linkError("preset", presetNext, { field: "preset", reason: o.preset === undefined || o.preset === "" ? "required" : "preset_invalid", phase: "validation" });
	const origin = controlOrigin(o["control-url"]);
	if (!origin) throw linkError("control_url", "--control-url must be an https origin with no path", { field: "control-url", phase: "validation" });
	const session = sessionToken(origin, undefined, context.command);
	const request = async (endpoint, body, grant, timeout = 15000) => {
		let response;
		try {
			response = await fetchImpl(`${origin}/api/link-finish/${endpoint}`, {
				method: body === undefined ? "GET" : "POST", redirect: "error",
				headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(endpoint === "requests" ? { authorization: `Bearer ${session}` } : grant ? { authorization: `Grant ${grant}` } : {}) },
				...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout),
			});
			const text = await response.text();
			if (text.length > 128 * 1024) throw new Error();
			const parsed = JSON.parse(text);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
			return { response, body: parsed };
		} catch { throw linkError("unavailable", `link ${context.command} request failed; check the connection and run ${context.command} again for fresh approval`, { phase: endpoint, hostname: context.hostname || null }); }
	};
	const verifier = crypto.randomBytes(32).toString("base64url");
	const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
	const started = await request("requests", { agent, challenge, ...(create ? { create } : {}) });
	if (started.response.status !== 201) throw failure(started.response.status, started.body, context);
	const setup = started.body;
	let approval;
	try { approval = new URL(setup.approve_url); } catch { throw linkError("invalid_response", "invalid approval response", { phase: "requests" }); }
	if (approval.origin !== origin || approval.username || approval.password || typeof setup.request_id !== "string" || !setup.request_id || typeof setup.user_code !== "string" || !/^[A-Za-z0-9-]{4,32}$/.test(setup.user_code))
		throw linkError("invalid_response", "invalid approval response", { phase: "requests" });
	write(`${setup.approve_url}\n${setup.user_code}`);
	const deadline = now() + Math.min(600, Math.max(1, Number(setup.expires_in) || 600)) * 1000;
	let interval = Math.min(60, Math.max(5, Number(setup.interval) || 5)), authorized;
	for (let poll = 0; poll < 120 && now() < deadline; poll++) {
		await sleep(Math.min(interval * 1000, deadline - now()));
		if (now() >= deadline) break;
		const token = await request("token", { request_id: setup.request_id, verifier });
		if (token.response.status === 428 && token.body.error === "authorization_pending") continue;
		if (token.response.status === 429 && token.body.error === "slow_down") { interval += 5; continue; }
		if (!token.response.ok) throw failure(token.response.status, token.body, context, "token");
		authorized = token.body; break;
	}
	if (!authorized) throw failure(410, { error: "expired_token" }, context, "token");
	const { grant, link } = authorized;
	if (typeof grant !== "string" || !/^[\x21-\x7e]+$/.test(grant) || grant.length > 4096 || link?.agent !== agent || typeof link.path !== "string" || !link.path.startsWith("/") || typeof link.preset !== "string" || typeof link.hostname !== "string" || typeof link.origin !== "string")
		throw linkError("invalid_response", "invalid approved link response", { phase: "token" });
	if (create && CREATE_FIELDS.some((key) => link[key] !== create[key]))
		throw linkError("plan_mismatch", "approved link differs from the requested creation plan; no connector or signing secret was transferred", { phase: "token", hostname: context.hostname || null });
	const hostname = normalizeHostname(link.hostname);
	context.hostname = hostname;
	const preset = o.preset;
	// Resolve and validate the source before spending the one-time connector delivery.
	const secret = readSecret(o, { ...link, preset });
	const connector = await request("connector", {}, grant);
	if (!connector.response.ok) throw failure(connector.response.status, connector.body, context, "connector");
	if (typeof connector.body.connector_token !== "string" || !connector.body.connector_token.trim() || /\s/.test(connector.body.connector_token)) throw linkError("invalid_response", "invalid connector response; run finish again for fresh approval", { phase: "connector" });
	const tokenFile = path.resolve(o["token-file"] || path.join(os.homedir(), ".a2a-exposed", "links", `${agent}.token`));
	saveToken(tokenFile, connector.body.connector_token);
	if (o["no-run"]) {
		write(connectorCommand(tokenFile));
		return { saved: false, connectorStarted: false, hostname };
	}
	await runConnector(tokenFile);
	let connected = false;
	const connectDeadline = now() + 60000;
	for (let poll = 0; poll < 20 && now() < connectDeadline; poll++) {
		const status = await request("status", undefined, grant, Math.min(15000, connectDeadline - now()));
		if (now() >= connectDeadline) break;
		if (!status.response.ok) throw failure(status.response.status, status.body, context, "grant");
		if (status.body.connector === "connected" && Number.isInteger(status.body.connections) && status.body.connections > 0) { connected = true; break; }
		await sleep(Math.min(3000, Math.max(0, connectDeadline - now())));
	}
	if (!connected) throw linkError("connector_timeout", "connector did not report connected within 60 seconds; check cloudflared and run finish again for fresh approval", { phase: "status", hostname });
	const tested = await request("wake-test", { signing_secret: secret, preset }, grant);
	// These 409 codes come from saveWakeSettings after a successful wake test.
	const saveRejected = tested.response.status === 409 && ["url", "preset", "header", "key", "unavailable", "unreadable", "conflict", "failed"].includes(tested.body.error);
	if (!tested.response.ok && !saveRejected) throw failure(tested.response.status, tested.body, context, "grant");
	if (saveRejected || (tested.body.result === "ok" && tested.body.saved !== true)) {
		write("wake_result=not-saved");
		throw linkError("not_saved", "The test wake was delivered, but the settings were not saved. Save them in Wake settings on the website, then test again. The saved connector token remains on disk.", { phase: "wake-test", status: tested.response.status, hostname });
	}
	if (tested.body.result !== "ok") {
		const { result, message } = wakeFailure(tested.body.result);
		write(`wake_result=${result}`);
		throw linkError("wake_failed", message, { reason: result, phase: "wake-test", status: tested.response.status, hostname });
	}
	write("wake_result=ok");
	write("Connector connected. Wake test passed and settings saved.");
	return { saved: true, connectorStarted: true, hostname };
}
