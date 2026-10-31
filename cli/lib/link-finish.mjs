import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { CliError } from "./a2a.mjs";
import { controlOrigin } from "./account.mjs";
import { readSigningSecret, validateSecretSource, writeTokenFile, startConnector, connectorCommand } from "./local-link.mjs";

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ERRORS = new Set(["access_denied", "expired_token", "link_not_ready", "invalid_grant", "already_delivered", "connector_not_connected", "not_found", "cloudflare_unavailable"]);

// Deliberately never echo server text, bodies, fetch errors, or child output.
function failure(status, body) {
	const code = ERRORS.has(body?.error) ? body.error : `HTTP ${status}`;
	return new CliError(`link finish failed (${code}); check the link on the website and run finish again for fresh approval`);
}

export async function finishLink(o, {
	fetchImpl = fetch, sleep = sleepDefault, now = Date.now,
	write = (line) => console.error(line), saveToken = writeTokenFile,
	readSecret = readSigningSecret, runConnector = startConnector,
} = {}) {
	validateSecretSource(o);
	const agent = o.agent;
	if (typeof agent !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(agent)) throw new CliError("--agent must be an agent name (letters, digits, underscores or hyphens)");
	const origin = controlOrigin(o["control-url"]);
	if (!origin) throw new CliError("--control-url must be an https origin with no path");
	const request = async (endpoint, body, grant, timeout = 15000) => {
		let response;
		try {
			response = await fetchImpl(`${origin}/api/link-finish/${endpoint}`, {
				method: body === undefined ? "GET" : "POST", redirect: "error",
				headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(grant ? { authorization: `Grant ${grant}` } : {}) },
				...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout),
			});
			const text = await response.text();
			if (text.length > 128 * 1024) throw new Error();
			const parsed = JSON.parse(text);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
			return { response, body: parsed };
		} catch { throw new CliError("link finish request failed; check the connection and run finish again for fresh approval"); }
	};
	const verifier = crypto.randomBytes(32).toString("base64url");
	const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
	const started = await request("requests", { agent, challenge });
	if (started.response.status !== 201) throw failure(started.response.status, started.body);
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
		if (!token.response.ok) throw failure(token.response.status, token.body);
		authorized = token.body; break;
	}
	if (!authorized) throw failure(410, { error: "expired_token" });
	const { grant, link } = authorized;
	if (typeof grant !== "string" || !/^[\x21-\x7e]+$/.test(grant) || grant.length > 4096 || link?.agent !== agent || typeof link.path !== "string" || !link.path.startsWith("/") || typeof link.preset !== "string" || !link.preset || typeof link.hostname !== "string" || typeof link.origin !== "string")
		throw new CliError("invalid approved link response");
	// Resolve and validate the source before spending the one-time connector delivery.
	const secret = readSecret(o, link);
	const connector = await request("connector", {}, grant);
	if (!connector.response.ok) throw failure(connector.response.status, connector.body);
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
		if (!status.response.ok) throw failure(status.response.status, status.body);
		if (status.body.connector === "connected" && Number.isInteger(status.body.connections) && status.body.connections > 0) { connected = true; break; }
		await sleep(Math.min(3000, Math.max(0, connectDeadline - now())));
	}
	if (!connected) throw new CliError("connector did not report connected within 60 seconds; check cloudflared and run finish again for fresh approval");
	const tested = await request("wake-test", { signing_secret: secret, preset: link.preset }, grant);
	if (!tested.response.ok) throw failure(tested.response.status, tested.body);
	if (tested.body.result !== "ok" || tested.body.saved !== true) {
		const result = ["dns-missing", "access-401", "access-403", "origin-4xx/5xx", "timeout"].includes(tested.body.result) ? tested.body.result : "unknown";
		throw new CliError(`wake test did not save settings (${result}); fix the receiver and run finish again for fresh approval`);
	}
	write("Connector connected. Wake test passed and settings saved.");
	return { saved: true, connectorStarted: true };
}
