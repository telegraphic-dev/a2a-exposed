// Hosted setup credentials never leave their origin or appear in command output.
import fs from "node:fs";
import * as C from "./config.mjs";
import { controlOrigin, deviceLogin } from "./account.mjs";
import { CliError, upstreamUrlProblem } from "./a2a.mjs";

export const SETUP_SCOPES = ["agents:create", "agents:owner-token", "wake:write", "wake:test"];
const NEXT = "Run hosted capabilities --json to list scopes and presets; login --machine NAME --scopes SCOPES to approve setup.";
const fail = (code, next) => { const error = new CliError(next); error.result = { ok: false, code, next }; throw error; };
const printable = value => typeof value === "string" && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);

export function setupSession(env = process.env, saved = C.fileConfig()) {
	const source = env.HOSTED_SETUP_URL || env.HOSTED_SETUP_TOKEN ? env : saved;
	return { origin: controlOrigin(source.HOSTED_SETUP_URL), token: source.HOSTED_SETUP_TOKEN || "" };
}

function originFor(o = {}) {
	const origin = controlOrigin(o["control-url"] || setupSession().origin || C.controlSession().origin || "https://a2a.exposed");
	if (!origin) fail("control_url", "--control-url must be an HTTPS origin without a path or credentials.");
	return origin;
}

async function request(origin, path, { token = "", method = "GET", body, fetchImpl = fetch } = {}) {
	let response, data;
	try {
		response = await fetchImpl(`${origin}${path}`, {
			method, redirect: "error", signal: AbortSignal.timeout(30_000),
			headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		data = await response.json();
	} catch { fail("unavailable", "Hosted setup did not answer with JSON. Check the service and try again. Do not repeat a create request until hosted list confirms its result."); }
	if (!data || typeof data !== "object" || Array.isArray(data)) fail("invalid_response", "The hosted service returned an invalid setup response.");
	if (!response.ok) {
		const known = ["taken", "limit", "invalid_name", "reserved_name", "invalid_grant", "insufficient_scope", "conflict", "unavailable", "not_found", "test", "signing", "unreadable", "preset", "url", "header", "access", "invalid_reference"];
		const code = known.includes(data.error) ? data.error : `http_${response.status}`;
		const next = code === "taken" || code === "reserved_name" ? "Choose another --name and run hosted list --json before creating."
			: code === "limit" ? "The account is at its agent limit. Review hosted list --json and account plans."
			: code === "conflict" ? "Wake settings changed. Run wake preview --json, then test the draft again."
			: code === "invalid_grant" || code === "insufficient_scope" ? NEXT
			: "Hosted setup refused the request. Run hosted capabilities --json and check the inputs; no automatic retry was made.";
		fail(code, next);
	}
	return data;
}

export async function capabilities(o = {}) {
	const data = await request(originFor(o), "/api/v1/setup/capabilities");
	if (!Array.isArray(data.scopes) || !Array.isArray(data.wake?.presets)) fail("unsupported", "This service does not expose hosted setup capabilities yet.");
	return { ok: true, code: "capabilities", next: "Select explicit scopes and a wake preset from this listing.", scopes: data.scopes.filter(s => SETUP_SCOPES.includes(s)), presets: data.wake.presets.filter(s => /^[a-z-]+$/.test(s)), secret_reference: data.wake.secret_reference === true, secure_link_create: data.wake.secure_link_create === true };
}

export async function login(o = {}) {
	const origin = originFor(o), machine = o.machine || "";
	if (!machine.trim() || machine.length > 80 || !printable(machine)) fail("machine", "Pass --machine NAME (1–80 printable characters). " + NEXT);
	const scopes = [...new Set(String(o.scopes || "").split(/[ ,]+/).filter(Boolean))];
	if (!scopes.length || scopes.some(s => !SETUP_SCOPES.includes(s))) fail("scope", "Pass --scopes with choices from hosted capabilities --json.");
	const available = await capabilities({ "control-url": origin });
	if (scopes.some(s => !available.scopes.includes(s))) fail("unsupported_scope", NEXT);
	await deviceLogin({ controlUrl: origin, scope: scopes.join(" "), machine: machine.trim(), save: updates => C.saveConfig(updates) });
	return { ok: true, code: "approved", next: "Run hosted list --json, then hosted create --name NAME --json.", control_url: origin };
}

function accountCredential(o) {
	const session = setupSession(), origin = originFor(o);
	if (!session.token || session.origin !== origin) fail("login_required", NEXT);
	return { origin, token: session.token };
}

export async function list(o = {}) {
	const { origin, token } = accountCredential(o);
	const data = await request(origin, "/api/v1/tenants", { token });
	if (!Array.isArray(data.tenants)) fail("invalid_response", "The service did not return an agent listing.");
	return { ok: true, code: "agents", next: "Select an agent, or run hosted create --name NAME --json.", agents: data.tenants.map(row => ({ name: String(row.name || ""), status: String(row.status || ""), version: row.version })) };
}

export async function create(o = {}) {
	const name = String(o.name || "").trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$/.test(name)) fail("invalid_name", "Pass --name with 4–32 letters, numbers or hyphens, starting and ending with a letter or number. Run hosted list --json first.");
	// Never replace an existing deployment or an environment-selected credential.
	if (C.get("A2A_BASE_URL") || C.get("A2A_OWNER_TOKEN") || C.get("A2A_WORKER_NAME") || C.get("A2A_D1_ID")) fail("config_in_use", "Use --config-dir with a separate directory for the new agent; keep the existing deployment configuration.");
	const { origin, token } = accountCredential(o);
	const before = await list(o);
	if (before.agents.some(row => row.name === name && row.status !== "deleted")) fail("taken", "That name already belongs to this account. Select it from hosted list --json or choose another --name.");
	const data = await request(origin, "/api/v1/tenants", { token, method: "POST", body: { name } });
	const base = data.base_url || data.public_url;
	if (data.name !== name || !/^a2aot_[A-Za-z0-9_-]{43}$/.test(data.owner_token || "") || !controlOrigin(base)) fail("invalid_response", "Creation returned an invalid credential response. Check hosted list --json before retrying; the agent may already exist.");
	try { C.saveConfig({ A2A_BASE_URL: base, A2A_OWNER_TOKEN: data.owner_token, HOSTED_AGENT_NAME: name, HOSTED_SETUP_URL: origin }); }
	catch { fail("credential_save", "The agent was created, but its one-time credential could not be saved. Do not create it again. Use the agent's account page to recover access."); }
	return { ok: true, code: "created", next: "Run wake set with an explicit URL and preset, reading credentials from protected files or named environment variables.", name, base_url: base };
}

function secret(o, name, envName) {
	const file = o[`${name}-file`], env = o[`${name}-env`], stdin = name === "key" && o["key-stdin"];
	if ([file, env, stdin].filter(Boolean).length > 1) fail("secret_source", `Choose one --${name}-file or --${name}-env${name === "key" ? " or --key-stdin" : ""}.`);
	let value = "";
	try {
		if (file) {
			const stat = fs.lstatSync(file);
			if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 4098) fail("secret_file", `--${name}-file needs a regular protected file (chmod 600), at most 4098 bytes.`);
			value = fs.readFileSync(file, "utf8").replace(/\r?\n$/, "");
		} else if (stdin) {
			if (process.stdin.isTTY) fail("secret_stdin", "Pipe the key on stdin; terminal prompts are not supported.");
			value = fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");
		} else value = process.env[env || envName] || "";
	} catch (error) { if (error.result) throw error; fail("secret_file", `Could not read --${name}-file; check its path and permissions.`); }
	if (!printable(value) || ((file || env || stdin) && !value)) fail("secret_input", `The ${name} credential must contain 1–4096 printable characters.`);
	return value;
}

function wakeCredential(o) {
	const origin = originFor(o), session = setupSession();
	let name = o.agent || C.get("HOSTED_AGENT_NAME");
	const owner = C.get("A2A_OWNER_TOKEN"), base = C.get("A2A_BASE_URL");
	if (!name && base) { try { name = new URL(base).hostname.split(".")[0]; } catch {} }
	if (!/^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$/.test(name || "")) fail("agent", "Pass --agent NAME selected from hosted list --json.");
	// An explicit agent must not borrow a different agent's owner token.
	let ownerOrigin = controlOrigin(C.get("HOSTED_SETUP_URL"));
	if (!ownerOrigin && controlOrigin(base)) {
		const parsed = new URL(base);
		if (parsed.hostname.startsWith(`${name}.`)) ownerOrigin = controlOrigin(`${parsed.protocol}//${parsed.host.slice(name.length + 1)}`);
	}
	const ownerMatches = owner && base && ownerOrigin === origin && controlOrigin(base) && new URL(base).hostname.split(".")[0] === name;
	const token = session.origin === origin && session.token ? session.token : ownerMatches ? owner : "";
	if (!token) fail("login_required", NEXT);
	return { origin, token, name };
}

export async function wake(sub, o = {}) {
	if (!["preview", "test", "set", "prepare", "remove", "unset"].includes(sub)) fail("usage", "Use wake preview|test|set|prepare|remove. List presets with hosted capabilities --json.");
	if (sub === "remove" || sub === "unset") fail("unsupported", "This hosted API does not support wake removal yet. Remove it in the agent's Wake settings; saved settings were not changed.");
	if (sub === "prepare") {
		if (!o["reference-file"]) fail("reference_file", "Pass a new --reference-file FILE. The reference is saved mode 600 and never printed.");
		try { fs.lstatSync(o["reference-file"]); fail("reference_file", "Choose a new --reference-file path; existing files are never replaced."); }
		catch (error) { if (error.result) throw error; if (error.code !== "ENOENT") fail("reference_file", "Cannot inspect --reference-file; check its path and permissions."); }
	}
	const { origin, token, name } = wakeCredential(o), path = `/api/v1/agents/${encodeURIComponent(name)}/wake`;
	const current = await request(origin, path, { token });
	if (!Number.isSafeInteger(current.version)) fail("invalid_response", "The service did not return a valid wake version. Saved settings were not changed.");
	if (sub === "preview") return { ok: true, code: "preview", next: "Test an explicit draft before saving.", version: current.version, preset: current.preset, configured: Boolean(current.url), key_header: current.keyHeader || "" };
	if (sub === "set" && (o["reference-file"] || o["reference-env"])) {
		if (o.url || o.preset || o["key-file"] || o["key-env"] || o["key-stdin"] || o["hmac-secret-file"] || o["hmac-secret-env"]) fail("reference_inputs", "Use a reference without draft overrides; it saves exactly the uploaded settings.");
		const reference = secret(o, "reference", "");
		if (!/^a2awr_[a-f0-9]{64}$/.test(reference)) fail("invalid_reference", "Read a valid reference from a protected --reference-file or --reference-env.");
		const result = await request(origin, path, { token, method: "PUT", body: { version: current.version, secretReference: reference } });
		return { ok: result.ok === true && result.saved === true, code: result.saved === true ? "saved" : "failed", saved: result.saved === true, next: result.saved === true ? "Check the receiver for the test wake." : "The reference is spent. Check saved settings before preparing another draft." };
	}
	const url = o.url || process.env.WAKE_WEBHOOK_URL || current.url;
	const preset = o.preset || current.preset || "generic";
	const problem = upstreamUrlProblem(url);
	if (problem) fail("url", "Pass --url with a public HTTPS webhook URL without credentials. Use polling if no public webhook is available.");
	const available = await capabilities({ "control-url": origin });
	if (!available.presets.includes(preset)) fail("preset", "Select --preset from hosted capabilities --json.");
	const draft = { version: current.version, url, preset, keyHeader: o["key-header"] ?? current.keyHeader ?? "", key: secret(o, "key", "WAKE_WEBHOOK_KEY"), hmacSecret: secret(o, "hmac-secret", "WAKE_HMAC_SECRET"), accessClientId: secret(o, "access-client-id", "WAKE_ACCESS_CLIENT_ID"), accessClientSecret: secret(o, "access-client-secret", "WAKE_ACCESS_CLIENT_SECRET") };
	if (Boolean(draft.accessClientId) !== Boolean(draft.accessClientSecret)) fail("access", "Supply both Access credentials through protected files or named environment variables.");
	let body = draft;
	if (sub === "prepare" || (sub === "set" && available.secret_reference && token.startsWith("a2asg_"))) {
		if (!available.secret_reference) fail("unsupported", "This service does not support wake references. Use wake set or browser confirmation.");
		if (sub === "prepare" && !o["reference-file"]) fail("reference_file", "Pass a new --reference-file FILE. The reference is saved mode 600 and never printed.");
		const prepared = await request(origin, `${path}/reference`, { token, method: "POST", body: draft });
		if (!/^a2awr_[a-f0-9]{64}$/.test(prepared.reference || "")) fail("invalid_response", "The service did not return a valid reference. No wake was saved.");
		if (sub === "prepare") {
			try { fs.writeFileSync(o["reference-file"], prepared.reference + "\n", { mode: 0o600, flag: "wx" }); }
			catch { fail("reference_file", "Cannot create --reference-file. Choose a new path in a private directory; existing files are never replaced."); }
			return { ok: true, code: "prepared", next: "Use the protected reference with wake set --reference-file FILE, or MCP set_wake secretReference and the same draft settings, within ten minutes. It is single-use even when a test fails." };
		}
		body = { version: current.version, secretReference: prepared.reference };
	}
	const result = await request(origin, sub === "test" ? `${path}/test` : path, { token, method: sub === "test" ? "POST" : "PUT", body });
	// Do not print proofs, arbitrary service text, webhook URLs or unexpected fields.
	const code = typeof result.code === "string" && /^(?:[1-5][0-9]{2}|access-40[13]|none|timeout|tls|private|dns|dns-missing|transport-delivery|transport-native|transport-socket|cloudflare-target-unsupported|connection|failed|unreadable|signing)$/.test(result.code) ? result.code : result.saved === true ? "saved" : "failed";
	const ok = result.ok === true && (sub !== "set" || result.saved === true);
	return { ok, code, saved: result.saved === true, next: ok ? sub === "set" ? "Check the receiver for the test wake." : "The draft passed. Run wake set with the same inputs to test and save." : code === "cloudflare-target-unsupported" ? "Use polling or a self-hosted Worker for this Cloudflare-proxied webhook." : "Saved settings were not changed. Check the receiver, credentials and draft, then test again." };
}

export async function output(run, o = {}) {
	try {
		const result = await run();
		console.log(o.json ? JSON.stringify(result) : `${result.code}: ${result.next}`);
		if (!result.ok) process.exitCode = 1;
	} catch (error) {
		const result = error.result || { ok: false, code: "unavailable", next: "Hosted setup did not finish. Check hosted list --json before retrying." };
		console.log(o.json ? JSON.stringify(result) : `${result.code}: ${result.next}`);
		process.exitCode = 1;
	}
}
