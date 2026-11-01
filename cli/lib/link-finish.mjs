import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { CliError } from "./a2a.mjs";
import { controlOrigin } from "./account.mjs";
import * as C from "./config.mjs";
import { readSigningSecret, validateSecretSource, writeTokenFile, startConnector, connectorCommand } from "./local-link.mjs";

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ERRORS = {
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
	expired_token: "This request or grant expired. Run finish again for fresh approval.",
	link_not_ready: "The secure link is not ready. Finish creating it in Wake settings on the website, then run finish again.",
	invalid_grant: "This grant is not valid. Run finish again and approve a new request.",
	already_delivered: "Credentials were already delivered for this request. Run finish again for fresh approval if you did not receive them.",
	connector_not_connected: "The connector is not connected. Start cloudflared with the saved token file, then run finish again for fresh approval.",
	not_found: "That agent or request was not found. Check --agent on the website, then run finish again.",
	cloudflare_unavailable: "Cloudflare could not be reached. Reconnect Cloudflare in Wake settings on the website, then run finish again.",
	unavailable: "The service is temporarily unavailable; retry later with fresh approval.",
};

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
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
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

function failure(status, body, { command, hostname }) {
	const known = (value) => typeof value === "string" && Object.hasOwn(ERRORS, value);
	const code = known(body?.reason) ? body.reason : known(body?.error) ? body.error : `HTTP ${status}`;
	const detail = ["invalid_request", "apex_hostname", "outside_zone"].includes(code) ? validationDetail(body, hostname) : "";
	const guidance = code === "provision_failed" ? provisionGuidance(body) : Object.hasOwn(ERRORS, code) ? ERRORS[code] : "check the link on the website and rerun the command for fresh approval";
	const message = detail || guidance.replace(/run finish/gi, (match) => `${match.startsWith("R") ? "Run" : "run"} ${command}`);
	return new CliError(`link ${command} failed${hostname ? ` for ${hostname}` : ""} (${code}); ${message}`);
}

export function savedLinkSession(origin, session = C.controlSession()) {
	if (controlOrigin(session.origin) !== origin || !session.token)
		throw new CliError("sign in to this service first: run login --control-url <service-origin>, then rerun link setup; environment sessions require both CONTROL_URL and CONTROL_TOKEN");
	return session.token;
}

const CREATE_FIELDS = ["hostname", "origin", "path", "preset"];

function createPlan(o) {
	for (const key of CREATE_FIELDS) {
		if (typeof o[key] !== "string" || !o[key]) throw new CliError(`hosted link create requires --${key}`);
	}
	const hostname = o.hostname.trim().toLowerCase();
	if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname))
		throw new CliError("--hostname must be a DNS hostname on your Cloudflare domain");
	let origin;
	try { origin = new URL(o.origin); } catch { throw new CliError("--origin must be an http or https origin"); }
	if (!/^https?:$/.test(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
		throw new CliError("--origin must be an http or https origin with no path or credentials");
	if (!o.path.startsWith("/") || o.path.startsWith("//") || /[\s?#\\\x00-\x1f\x7f]/.test(o.path) || o.path.length > 1000)
		throw new CliError("--path must begin with / and have no query, fragment or whitespace");
	if (!/^[a-z][a-z0-9-]{0,63}$/.test(o.preset)) throw new CliError("--preset must be a wake preset id");
	return { hostname, origin: origin.origin, path: o.path, preset: o.preset };
}

export function createLink(o, deps) {
	const create = createPlan(o);
	// Catch a wrong local route before asking the owner to create any resources.
	validateSecretSource(o);
	if (o["secret-from"] === "hermes" && (create.preset !== "hermes" || !/^\/webhooks\/[A-Za-z0-9_-]+$/.test(create.path) || (o.route && create.path !== `/webhooks/${o.route}`)))
		throw new CliError("Hermes route does not match the create path and preset");
	return setupLink(o, deps, create);
}

export function finishLink(o, deps) {
	if (CREATE_FIELDS.filter((key) => key !== "preset").some((key) => o[key] !== undefined)) throw new CliError("creation options require hosted link create; finish only reuses an existing link");
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
	if (typeof agent !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(agent)) throw new CliError("--agent must be an agent name (letters, digits, underscores or hyphens)");
	if (o.preset !== undefined && (typeof o.preset !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(o.preset))) throw new CliError("--preset must be a wake preset id");
	const origin = controlOrigin(o["control-url"]);
	if (!origin) throw new CliError("--control-url must be an https origin with no path");
	const session = sessionToken(origin);
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
		} catch { throw new CliError(`link ${context.command} request failed; check the connection and run ${context.command} again for fresh approval`); }
	};
	const verifier = crypto.randomBytes(32).toString("base64url");
	const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
	const started = await request("requests", { agent, challenge, ...(create ? { create } : {}) });
	if (started.response.status !== 201) throw failure(started.response.status, started.body, context);
	const setup = started.body;
	let approval;
	try { approval = new URL(setup.approve_url); } catch { throw new CliError("invalid approval response"); }
	if (approval.origin !== origin || approval.username || approval.password || typeof setup.request_id !== "string" || !setup.request_id || typeof setup.user_code !== "string" || !/^[A-Za-z0-9-]{4,32}$/.test(setup.user_code))
		throw new CliError("invalid approval response");
	write(`${setup.approve_url}\n${setup.user_code}`);
	const deadline = now() + Math.min(600, Math.max(1, Number(setup.expires_in) || 600)) * 1000;
	let interval = Math.min(60, Math.max(5, Number(setup.interval) || 5)), authorized;
	for (let poll = 0; poll < 120 && now() < deadline; poll++) {
		await sleep(Math.min(interval * 1000, deadline - now()));
		if (now() >= deadline) break;
		const token = await request("token", { request_id: setup.request_id, verifier });
		if (token.response.status === 428 && token.body.error === "authorization_pending") continue;
		if (token.response.status === 429 && token.body.error === "slow_down") { interval += 5; continue; }
		if (!token.response.ok) throw failure(token.response.status, token.body, context);
		authorized = token.body; break;
	}
	if (!authorized) throw failure(410, { error: "expired_token" }, context);
	const { grant, link } = authorized;
	if (typeof grant !== "string" || !/^[\x21-\x7e]+$/.test(grant) || grant.length > 4096 || link?.agent !== agent || typeof link.path !== "string" || !link.path.startsWith("/") || typeof link.preset !== "string" || typeof link.hostname !== "string" || typeof link.origin !== "string")
		throw new CliError("invalid approved link response");
	if (create && CREATE_FIELDS.some((key) => link[key] !== create[key]))
		throw new CliError("approved link differs from the requested creation plan; no connector or signing secret was transferred");
	const preset = o.preset ?? link.preset;
	if (!/^[a-z][a-z0-9-]{0,63}$/.test(preset)) throw new CliError("approved link has no valid preset; rerun finish with --preset <id> before requesting fresh approval");
	// Resolve and validate the source before spending the one-time connector delivery.
	const secret = readSecret(o, { ...link, preset });
	const connector = await request("connector", {}, grant);
	if (!connector.response.ok) throw failure(connector.response.status, connector.body, context);
	if (typeof connector.body.connector_token !== "string" || !connector.body.connector_token.trim() || /\s/.test(connector.body.connector_token)) throw new CliError("invalid connector response; run finish again for fresh approval");
	const tokenFile = path.resolve(o["token-file"] || path.join(os.homedir(), ".a2a-exposed", "links", `${agent}.token`));
	saveToken(tokenFile, connector.body.connector_token);
	if (o["no-run"]) {
		write(connectorCommand(tokenFile));
		return { saved: false, connectorStarted: false };
	}
	await runConnector(tokenFile);
	let connected = false;
	const connectDeadline = now() + 60000;
	for (let poll = 0; poll < 20 && now() < connectDeadline; poll++) {
		const status = await request("status", undefined, grant, Math.min(15000, connectDeadline - now()));
		if (now() >= connectDeadline) break;
		if (!status.response.ok) throw failure(status.response.status, status.body, context);
		if (status.body.connector === "connected" && Number.isInteger(status.body.connections) && status.body.connections > 0) { connected = true; break; }
		await sleep(Math.min(3000, Math.max(0, connectDeadline - now())));
	}
	if (!connected) throw new CliError("connector did not report connected within 60 seconds; check cloudflared and run finish again for fresh approval");
	const tested = await request("wake-test", { signing_secret: secret, preset }, grant);
	if (!tested.response.ok) throw failure(tested.response.status, tested.body, context);
	if (tested.body.result !== "ok" || tested.body.saved !== true) {
		const result = (["dns-missing", "access-401", "access-403", "timeout"].includes(tested.body.result) || /^origin-\d{3}$/.test(tested.body.result)) ? tested.body.result : "unknown";
		throw new CliError(`wake test did not save settings (${result}); fix the receiver and run finish again for fresh approval`);
	}
	write("Connector connected. Wake test passed and settings saved.");
	return { saved: true, connectorStarted: true };
}
