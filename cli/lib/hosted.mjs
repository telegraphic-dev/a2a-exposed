// Hosted setup credentials never leave their origin or appear in command output.
import fs from "node:fs";
import * as C from "./config.mjs";
import { controlOrigin, deviceLogin } from "./account.mjs";
import { CliError, upstreamUrlProblem } from "./a2a.mjs";

export const SETUP_SCOPES = ["agents:read", "agents:create", "agents:owner-token", "wake:write", "wake:test"];
const NEXT = "Run hosted capabilities --json to list scopes and presets; login --machine NAME --scopes SCOPES to approve setup.";
const fail = (code, next) => { const error = new CliError(next); error.result = { ok: false, code, next }; throw error; };
const printable = value => typeof value === "string" && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);

function retryAfter(response, data) {
	const header = response.headers.get("retry-after");
	let seconds;
	if (header && /^\d+$/.test(header)) seconds = Number(header);
	else if (header && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header)) {
		const date = Date.parse(header);
		if (Number.isFinite(date)) seconds = Math.max(0, Math.ceil((date - Date.now()) / 1000));
	}
	if (Number.isSafeInteger(seconds) && seconds >= 0) return seconds;
	return Number.isSafeInteger(data.retry_after) && data.retry_after >= 0 ? data.retry_after : undefined;
}

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
		if (response.status === 429 && data.error === "too_many_references") {
			const seconds = retryAfter(response, data);
			const next = seconds === undefined
				? "Wait for an unused reference to expire before running wake prepare again; no automatic retry was made."
				: `Wait ${seconds} seconds before running wake prepare again with a new --reference-file; no automatic retry was made.`;
			// Retain the capacity message, but never reflect arbitrary service text or credentials.
			const message = typeof data.message === "string" && /^This setup grant has \d{1,10} unused references\. Wait \d{1,10} seconds before uploading another draft\.$/.test(data.message) ? data.message : undefined;
			const error = new CliError(next);
			error.result = { ok: false, code: "too_many_references", next, ...(message ? { message } : {}), ...(seconds === undefined ? {} : { retry_after: seconds }) };
			throw error;
		}
		const known = ["taken", "limit", "invalid_name", "reserved_name", "invalid_grant", "insufficient_scope", "conflict", "unavailable", "not_found", "test", "signing", "unreadable", "preset", "url", "header", "access", "invalid_reference", "body"];
		const code = known.includes(data.error) ? data.error : `http_${response.status}`;
		const next = code === "taken" || code === "reserved_name" ? "Choose another --name using hosted names --name NAME --json before creating."
			: code === "limit" ? "The account is at its agent limit. Read hosted capacity --json and review account plans."
			: code === "conflict" ? "Wake settings changed. Run wake preview --json, then test the draft again."
			: code === "invalid_reference" ? "The wake reference was already used, expired or does not match this draft. Run wake prepare again with the draft inputs and a new --reference-file."
			: code === "invalid_grant" || code === "insufficient_scope" ? NEXT
			: "Hosted setup refused the request. Run hosted capabilities --json and check the inputs; no automatic retry was made.";
		fail(code, next);
	}
	return data;
}

export async function capabilities(o = {}) {
	const data = await request(originFor(o), "/api/v1/setup/capabilities");
	if (!Array.isArray(data.scopes) || !Array.isArray(data.wake?.presets)) fail("unsupported", "This service does not expose hosted setup capabilities yet.");
	return { ok: true, code: "capabilities", next: "Select explicit scopes and a wake preset from this listing.", scopes: data.scopes.filter(s => SETUP_SCOPES.includes(s)), presets: data.wake.presets.filter(s => /^[a-z-]+$/.test(s)), preflight: data.preflight === true, secret_reference: data.wake.secret_reference === true, wake_removal: data.wake.removal === true, secure_link_create: data.wake.secure_link_create === true };
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
	return { ok: true, code: "agents", next: "This listing contains hosted agents only; Cloudflare-linked Workers remain in dashboard Your agents. Select an agent, or run hosted create --name NAME --json.", agents: data.tenants.map(row => ({ name: String(row.name || ""), status: String(row.status || ""), version: row.version })) };
}

export async function names(o = {}) {
 const name = String(o.name || "").trim().toLowerCase();
 if (!/^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$/.test(name)) fail("invalid_name", "Pass one explicit --name of 4–32 letters, numbers or hyphens, starting and ending with a letter or number. Use hosted names --name NAME --json before approving setup.");
 const origin = originFor(o);
 if (!(await capabilities(o)).preflight) fail("unsupported", "This service does not expose name preflight. Use hosted capabilities --json or the website.");
 const data = await request(origin, `/api/v1/setup/name?name=${encodeURIComponent(name)}`);
 if (data.name !== name || typeof data.available !== "boolean" || !["available", "invalid_name", "reserved_name", "taken"].includes(data.reason) || data.available !== (data.reason === "available")) fail("invalid_response", "The service did not return a valid name availability result. No creation was attempted.");
 return { ok: true, code: "name_availability", name, available: data.available, reason: data.reason, next: data.available ? "This name is available now, without a reservation. Run hosted capacity --json before hosted create --name NAME --json." : "Choose another --name and repeat hosted names --name NAME --json before requesting creation access." };
}

export async function capacity(o = {}) {
 const { origin, token } = accountCredential(o);
 if (!(await capabilities(o)).preflight) fail("unsupported", "This service does not expose capacity preflight. Use hosted capabilities --json or the website.");
 const data = await request(origin, "/api/v1/setup/capacity", { token });
 const count = value => Number.isSafeInteger(value) && value >= 0;
 if (!(data.limit === null || count(data.limit)) || !count(data.used) || !(data.remaining === null || count(data.remaining)) || data.remaining !== (data.limit === null ? null : Math.max(0, data.limit - data.used)) || data.can_create !== (data.remaining === null || data.remaining > 0)) fail("invalid_response", "The service did not return valid account capacity. No creation was attempted.");
 return { ok: true, code: "capacity", limit: data.limit, used: data.used, remaining: data.remaining, can_create: data.can_create, next: data.can_create ? "This is a read-only snapshot. Check hosted names --name NAME --json, then explicitly approve creation scopes if needed and run hosted create --name NAME --json." : "The account has no creation room. Review its agents and plan before another creation attempt." };
}

export async function create(o = {}) {
	const name = String(o.name || "").trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$/.test(name)) fail("invalid_name", "Pass --name with 4–32 letters, numbers or hyphens, starting and ending with a letter or number. Run hosted list --json first.");
	// Never replace an existing deployment or an environment-selected credential.
	if (C.get("A2A_BASE_URL") || C.get("A2A_OWNER_TOKEN") || C.get("A2A_WORKER_NAME") || C.get("A2A_D1_ID")) fail("config_in_use", "Use --config-dir with a separate directory for the new agent; keep the existing deployment configuration.");
	const { origin, token } = accountCredential(o);
 const service = await capabilities(o);
 if (service.preflight) {
  const available = await names(o);
  if (!available.available) fail(available.reason, "Choose a name with hosted names --name NAME --json before creating.");
  if (!(await capacity(o)).can_create) fail("limit", "The account is at its agent limit. Read hosted capacity --json and review its agents or plan.");
 }
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

function wakeCredential(o, preferOwner = false) {
	const origin = originFor(o), session = setupSession();
	let name = o.agent || C.get("HOSTED_AGENT_NAME");
	// Deployment halves come from one source, independently of setup selection.
	const saved = C.fileConfig();
	const source = process.env.A2A_BASE_URL || process.env.A2A_OWNER_TOKEN ? process.env : saved;
	const owner = source.A2A_OWNER_TOKEN || "", base = source.A2A_BASE_URL || "";
	if (!name && base) { try { name = new URL(base).hostname.split(".")[0]; } catch {} }
	if (!/^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$/.test(name || "")) fail("agent", "Pass --agent NAME selected from hosted list --json.");
	// An explicit agent must not borrow a different agent's owner token.
	let ownerOrigin = "";
	if (controlOrigin(base)) {
		const parsed = new URL(base);
		if (parsed.hostname.startsWith(`${name}.`)) ownerOrigin = controlOrigin(`${parsed.protocol}//${parsed.host.slice(name.length + 1)}`);
	}
	const ownerMatches = owner && base && ownerOrigin === origin && controlOrigin(base) && new URL(base).hostname.split(".")[0] === name;
	const token = preferOwner && ownerMatches ? owner : session.origin === origin && session.token ? session.token : ownerMatches ? owner : "";
	if (!token) fail("login_required", NEXT);
	return { origin, token, name };
}

// A webhook path or query may contain its credential. Show only the public destination.
function previewUrl(value) {
 try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? `${url.origin}${url.pathname === "/" ? "/" : "/…"}` : ""; }
 catch { return ""; }
}

export async function status(o = {}) {
	if (!/^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$/.test(o.agent || "")) fail("agent", "Pass --agent NAME selected from hosted list --json.");
	const preview = await wake("preview", o);
	return { ...preview, code: "status", agent: o.agent, next: preview.configured
		? "Wake settings are configured. Run wake test --agent NAME with explicit draft inputs to check delivery."
		: "No webhook is configured. Select a preset from hosted capabilities --json, then prepare a wake draft, or use polling." };
}

export async function wake(sub, o = {}) {
	if (!["preview", "test", "set", "prepare", "remove", "unset"].includes(sub)) fail("usage", "Use wake preview|test|set|prepare|remove. List presets with hosted capabilities --json.");
	const removing = sub === "remove" || sub === "unset";
 const preparingRemoval = sub === "prepare" && o.clear === true;
 if (o.clear && !preparingRemoval) fail("usage", "Use wake prepare --clear for an MCP removal reference, or wake remove --version N. Run wake preview --json to list the current version.");
 if (removing || preparingRemoval) {
  if (o.url || o.preset || Object.keys(o).some(key => /^(?:key|hmac-secret|access-client)/.test(key))) fail("removal_inputs", "Omit draft settings and secrets when removing a wake. Run wake preview --json first.");
  if (!/^(0|[1-9][0-9]*)$/.test(String(o.version ?? "")) || !Number.isSafeInteger(Number(o.version))) fail("version", "Pass --version N selected from wake preview --agent NAME --json. Removal never selects a version automatically.");
 }
	if (sub === "prepare") {
		if (!o["reference-file"]) fail("reference_file", "Pass a new --reference-file FILE. The reference is saved mode 600 and never printed.");
		try { fs.lstatSync(o["reference-file"]); fail("reference_file", "Choose a new --reference-file path; existing files are never replaced."); }
		catch (error) { if (error.result) throw error; if (error.code !== "ENOENT") fail("reference_file", "Cannot inspect --reference-file; check its path and permissions."); }
	}
	let reference;
	if ((sub === "set" || removing) && (o["reference-file"] || o["reference-env"])) {
		if (o.url || o.preset || o["key-file"] || o["key-env"] || o["key-stdin"] || o["hmac-secret-file"] || o["hmac-secret-env"]) fail("reference_inputs", "Use a reference without draft overrides; it saves exactly the uploaded settings.");
		const next = "Run wake prepare --agent NAME with the draft inputs and a new --reference-file FILE, then use that protected reference with wake set. Existing files are never replaced.";
		try { reference = secret(o, "reference", ""); }
		catch (error) {
			if (error.result?.code === "secret_input") fail("invalid_reference", next);
			throw error;
		}
		if (!/^a2awr_[a-f0-9]{64}$/.test(reference)) fail("invalid_reference", next);
	}
	const { origin, token, name } = wakeCredential(o, sub !== "prepare" && !o["reference-file"] && !o["reference-env"]), path = `/api/v1/agents/${encodeURIComponent(name)}/wake`;
	const current = await request(origin, path, { token });
	if (!Number.isSafeInteger(current.version)) fail("invalid_response", "The service did not return a valid wake version. Saved settings were not changed.");
	if (sub === "preview") return { ok: true, code: "preview", next: "Test an explicit draft before saving.", version: current.version, preset: current.preset, configured: Boolean(current.url), key_header: ["hermes", "openbot"].includes(current.preset) ? "" : ["grok-bot", "claude-code", "openclaw-wake", "openclaw-agent"].includes(current.preset) ? "Authorization" : current.keyHeader || "Authorization", url: previewUrl(current.url) };
 if (removing || preparingRemoval) {
  const version = Number(o.version);
  if (version !== current.version) fail("conflict", "Wake settings changed. Run wake preview --agent NAME --json, review them, then repeat removal with its explicit --version.");
  const available = await capabilities({ "control-url": origin });
  if (!available.wake_removal || (preparingRemoval && !available.secret_reference)) fail("unsupported", "This service does not support this removal operation. Use the agent's Wake settings on the website.");
  if (preparingRemoval) {
   const prepared = await request(origin, `${path}/reference`, { token, method: "POST", body: { version, clear: true } });
   if (!/^a2awr_[a-f0-9]{64}$/.test(prepared.reference || "")) fail("invalid_response", "The service did not return a valid removal reference. No wake was removed.");
   try { fs.writeFileSync(o["reference-file"], prepared.reference + "\n", { mode: 0o600, flag: "wx" }); }
   catch { fail("reference_file", "Cannot create --reference-file. Choose a new path in a private directory; existing files are never replaced."); }
   return { ok: true, code: "prepared", version, next: "Within ten minutes, use MCP set_wake with clear: true and secretReference, or wake remove --version N --reference-file FILE. The reference is single-use and never printed." };
  }
  const result = await request(origin, path, { token, method: "DELETE", body: { version, ...(reference ? { secretReference: reference } : {}) } });
  const ok = result.ok === true && (result.removed === true || result.already_removed === true);
  return { ok, code: ok ? result.already_removed === true ? "already_removed" : "removed" : "failed", removed: result.removed === true, already_removed: result.already_removed === true, version: result.version, next: ok ? "Use polling to read messages." : "Read wake preview --json before retrying removal with an explicit --version." };
 }
	if (reference) {
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
		if (o.json) console.log(JSON.stringify(result));
		else {
			console.log(`${result.code}: ${result.next}`);
			for (const [key, value] of Object.entries(result)) {
				if (!["ok", "code", "next"].includes(key)) console.log(`${key}: ${JSON.stringify(value, null, 2)}`);
			}
		}
		if (!result.ok) process.exitCode = 1;
	} catch (error) {
		const result = error.result || { ok: false, code: "unavailable", next: "Hosted setup did not finish. Check hosted list --json before retrying." };
		console.log(o.json ? JSON.stringify(result) : `${result.code}: ${result.next}${result.message ? `\nmessage: ${result.message}` : ""}`);
		process.exitCode = 1;
	}
}
