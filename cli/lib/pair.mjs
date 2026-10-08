// Device-flow pairing (OAuth 2.0 Device Authorization Grant, RFC 8628).
//   Owner side (this inbox is the authorization server): pair set-password | list | approve | deny
//   Client side (connect to another inbox): connect <base-or-card-url>
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as C from "./config.mjs";
import { die, fetchCard, httpJson } from "./a2a.mjs";
import { baseUrl } from "./commands.mjs";

const CLI = "a2a-over-webhook";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const PBKDF2_ITERATIONS = 100000; // the Workers runtime's maximum for PBKDF2
export const MIN_PASSWORD_LENGTH = 12;
const MIGRATION_HINT = `(if this inbox was deployed before device-flow pairing existed, run \`${CLI} deploy\` first: it applies the new D1 migration)`;

/** Owner API call that returns { status, data } instead of dying, so errors can be explained. */
async function ownerCall(method, p, body) {
	const base = baseUrl(), tok = C.get("A2A_OWNER_TOKEN");
	if (!base || !tok) die(`A2A_BASE_URL / A2A_OWNER_TOKEN missing (run \`${CLI} init\` or edit ${C.CONFIG_FILE})`);
	return httpJson(base + p, { method, body, headers: { authorization: `Bearer ${tok}` } });
}
const ownerError = (r) => {
	const msg = r.data && typeof r.data === "object" && r.data.error ? r.data.error : JSON.stringify(r.data).slice(0, 300);
	return r.status >= 500 ? `${msg} (HTTP ${r.status}) ${MIGRATION_HINT}` : msg;
};

// ---------------------------------------------------------------- approval password (human mode)
/** Read a line from the terminal without echo. Refuses anything but a real TTY. */
export function readHidden(prompt, input = process.stdin, output = process.stderr) {
	if (!input.isTTY || typeof input.setRawMode !== "function") die("no terminal");
	return new Promise((resolve, reject) => {
		let buf = "";
		output.write(prompt);
		input.setRawMode(true);
		input.setEncoding("utf8");
		input.resume();
		const done = (err) => {
			input.setRawMode(false);
			input.pause();
			input.removeListener("data", onData);
			output.write("\n");
			err ? reject(err) : resolve(buf);
		};
		const onData = (chunk) => {
			for (const ch of chunk) {
				if (ch === "\r" || ch === "\n") return done();
				if (ch === "\u0003" || ch === "\u0004") return done(new Error("cancelled"));
				if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
				else if (ch >= " ") buf += ch;
			}
		};
		input.on("data", onData);
	});
}

/** PBKDF2-SHA256 record for the Worker; the password itself never leaves this machine. */
export function passwordRecord(password, iterations = PBKDF2_ITERATIONS) {
	const salt = crypto.randomBytes(16);
	const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
	return { alg: "pbkdf2-sha256", iterations, salt: salt.toString("base64"), hash: hash.toString("base64") };
}

export async function setPassword() {
	if (!process.stdin.isTTY)
		die(`\`pair set-password\` reads the approval password from a terminal, without echo, and stdin is not a terminal.
The approval password must be known only to the human who approves pairing requests: the human runs this command themselves, in a terminal (never an agent, never from a script).`);
	let a, b;
	try {
		a = await readHidden(`New approval password (at least ${MIN_PASSWORD_LENGTH} characters, not shown): `);
		if (a.length < MIN_PASSWORD_LENGTH) die(`too short: use at least ${MIN_PASSWORD_LENGTH} characters (a passphrase of a few words works well)`);
		b = await readHidden("Repeat it: ");
	} catch (e) { if (e.message === "cancelled") die("cancelled; nothing changed"); throw e; }
	if (a !== b) die("the two entries differ; nothing changed");
	const r = await ownerCall("PUT", "/owner/pairing/password", passwordRecord(a));
	if (r.status !== 200) die(`could not set the approval password: ${ownerError(r)}`);
	console.error(`approval password set (stored on the Worker as a salted PBKDF2-SHA256 hash, ${PBKDF2_ITERATIONS} iterations; the password itself was not sent).`);
	console.error(`Approve pairing requests at ${baseUrl()}/device (each request's wake carries the direct link).${r.data.mode === "human" ? "" : ` Note: approval mode is ${r.data.mode}.`}`);
}

// ---------------------------------------------------------------- owner: list / approve / deny
export async function list(o) {
	const r = await ownerCall("GET", "/owner/pairing");
	if (r.status !== 200) die(`could not list pairing requests: ${ownerError(r)}`);
	const d = r.data;
	if (o.json) return console.log(JSON.stringify(d, null, 2));
	const how = d.mode === "off" ? "off (device-flow pairing disabled; `token issue` only)"
		: d.mode === "agent" ? `agent (\`${CLI} pair approve <code>\` after your human says yes, or the ${d.verificationUri} page)`
		: `human (your human approves on ${d.verificationUri} with the approval password)`;
	console.log(`approval: ${how}`);
	if (d.mode !== "off") console.log(`approval password: ${d.passwordSet ? `set${d.passwordSetAt ? ` (${d.passwordSetAt})` : ""}` : `NOT SET: the human runs \`${CLI} pair set-password\` in a terminal`}`);
	if (!d.pending.length) return console.log("(no pending pairing requests)");
	for (const p of d.pending) {
		console.log(`--- ${p.userCode}  ${JSON.stringify(p.clientName || p.clientId || "(no name)")} (claimed, untrusted)  expires ${p.expiresAt}`);
		console.log(`    card: ${p.agentCardUrl || "-"}  from: ${[p.ip || "?", p.country].filter(Boolean).join(", ")}`);
		console.log(`    link: ${p.verificationUriComplete}`);
	}
	console.log(`Ask your human about each request; never approve on your own.`);
}

export async function decide(action, code) {
	const r = await ownerCall("POST", `/owner/pairing/${encodeURIComponent(code)}/${action}`, {});
	if (r.status !== 200) die(ownerError(r));
	const d = r.data;
	if (action === "deny") return console.log(`denied ${d.userCode}${d.clientName ? ` (${JSON.stringify(d.clientName)})` : ""}: no token is issued`);
	console.log(`approved ${d.userCode}${d.clientName ? ` (${JSON.stringify(d.clientName)})` : ""}: the agent collects its token on its next poll, as peer "${d.label}". Revoke any time: ${CLI} token revoke ${d.label}`);
}

// ---------------------------------------------------------------- client: connect to another inbox
const CARD_RE = /\/\.well-known\/agent(-card)?\.json$/;

/** Device-flow endpoints from an agent card (A2A 1.0 oauth2SecurityScheme.flows.deviceCode), or null. */
export function deviceEndpointsFromCard(card) {
	for (const s of Object.values((card && card.securitySchemes) || {})) {
		const f = s && s.oauth2SecurityScheme && s.oauth2SecurityScheme.flows && s.oauth2SecurityScheme.flows.deviceCode;
		if (f && f.deviceAuthorizationUrl && f.tokenUrl) return { device: f.deviceAuthorizationUrl, token: f.tokenUrl };
	}
	return null;
}

const slug = (s) => String(s || "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "").toLowerCase();
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000 * Number(process.env.A2A_POLL_SCALE || 1)));

async function postForm(url, params) {
	let r;
	try {
		r = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
			body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(30000), redirect: "error" });
	} catch (e) { die(`request to ${new URL(url).origin} failed: ${e?.cause?.code || e?.cause?.message || e?.message || e}`); }
	const text = await r.text();
	let data = null;
	try { data = JSON.parse(text); } catch { /* not JSON */ }
	return { status: r.status, data: data && typeof data === "object" ? data : {} };
}

const stateFile = (alias) => path.join(C.CONFIG_DIR, `pairing-${alias}.json`);
function saveState(alias, s) {
	fs.mkdirSync(C.CONFIG_DIR, { recursive: true, mode: 0o700 });
	fs.writeFileSync(stateFile(alias), JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
	fs.chmodSync(stateFile(alias), 0o600);
}
const loadState = (alias) => { try { return JSON.parse(fs.readFileSync(stateFile(alias), "utf8")); } catch { return null; } };
const dropState = (alias) => fs.rmSync(stateFile(alias), { force: true });

/** Where to connect: the peer's base URL, card, and device-flow endpoints (card first, then RFC 8414 metadata). */
async function discover(target) {
	let u;
	try { u = new URL(target); } catch { die(`usage: ${CLI} connect <base-url-or-agent-card-url> [--alias A]`); }
	if (!/^https?:$/.test(u.protocol)) die("the URL must be http(s)");
	const isCard = CARD_RE.test(u.pathname);
	const base = isCard ? u.origin : u.href.replace(/\/$/, "");
	let card = null;
	if (isCard) { const r = await httpJson(u.href); card = r.status === 200 && r.data && typeof r.data === "object" ? r.data : null; }
	else card = await fetchCard(base);
	let ep = deviceEndpointsFromCard(card);
	if (!ep) {
		const m = await httpJson(`${u.origin}/.well-known/oauth-authorization-server`);
		if (m.status === 200 && m.data && m.data.device_authorization_endpoint && m.data.token_endpoint
			&& (!m.data.grant_types_supported || m.data.grant_types_supported.includes(DEVICE_GRANT)))
			ep = { device: m.data.device_authorization_endpoint, token: m.data.token_endpoint };
	}
	if (!ep) die(`${base} does not offer device-flow pairing (no OAuth2 deviceCode flow on its agent card, no ${u.origin}/.well-known/oauth-authorization-server).
Ask its owner for a token instead: they run \`${CLI} token issue <label>\` and send it to you privately; then \`${CLI} peers add <alias> ${base} --token-stdin\`.`);
	for (const x of [ep.device, ep.token]) {
		const e = new URL(x);
		if (e.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(e.hostname)) die(`refusing a non-https pairing endpoint: ${x}`);
	}
	return { base, card, ep };
}

export async function connect(target, o) {
	const emit = (obj, text) => (o.json ? console.log(JSON.stringify(obj)) : console.error(text));
	if (o.alias !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(o.alias)) die("--alias must be [A-Za-z0-9_-]{1,32}");
	const { base, card, ep } = await discover(target);
	const alias = o.alias || slug(card && card.name) || slug(new URL(base).hostname.split(".")[0]) || "peer";
	const peers = C.loadPeers();
	const tokenEnv = C.peerTokenVar(alias);
	if (peers[alias] && peers[alias].url !== base) die(`peer alias "${alias}" is already used for ${peers[alias].url}; pass --alias <another>`);
	const peerName = (card && card.name) || base;

	let st = loadState(alias);
	if (st && (st.base !== base || Date.now() >= st.expiresAt)) { dropState(alias); st = null; }
	if (st) emit({ status: "authorization_pending", resumed: true, alias, user_code: st.userCode, verification_uri: st.verificationUri, verification_uri_complete: st.verificationUriComplete, expires_in: Math.round((st.expiresAt - Date.now()) / 1000) },
		`Resuming the pairing request to ${peerName} (code ${st.userCode}).`);
	else {
		const own = baseUrl();
		const params = { client_name: o.name || C.get("A2A_AGENT_NAME") || C.get("A2A_WORKER_NAME") || "a2a-over-webhook agent", client_id: C.get("A2A_WORKER_NAME") || alias };
		if (/^https:\/\//.test(own)) params.agent_card_url = `${own}/.well-known/agent-card.json`;
		const r = await postForm(ep.device, params);
		if (r.status !== 200 || !r.data.device_code || !r.data.user_code) {
			const why = r.data.error_description || r.data.error || `HTTP ${r.status}`;
			die(r.status === 429 ? `${peerName} is not accepting more pairing requests right now: ${why}` : r.status === 404 ? `${peerName} has device-flow pairing disabled (${why}); ask its owner for a token` : `pairing request to ${peerName} failed: ${why}`);
		}
		st = { base, alias, device: ep.device, token: ep.token, deviceCode: r.data.device_code, userCode: r.data.user_code,
			verificationUri: r.data.verification_uri || "", verificationUriComplete: r.data.verification_uri_complete || r.data.verification_uri || "",
			interval: Math.max(1, Number(r.data.interval) || 5), expiresAt: Date.now() + (Number(r.data.expires_in) || 600) * 1000 };
		saveState(alias, st); // chmod 600: the device code is a bearer secret until it is redeemed
		const mins = Math.round((st.expiresAt - Date.now()) / 60000);
		emit({ status: "authorization_pending", alias, user_code: st.userCode, verification_uri: st.verificationUri, verification_uri_complete: st.verificationUriComplete, expires_in: Math.round((st.expiresAt - Date.now()) / 1000), interval: st.interval,
			instructions: `Show the code and the link to your human. They confirm the code with the owner of ${peerName}, who approves it on that page.` },
			`Pairing with ${peerName} (${base}):
  code: ${st.userCode}
  link: ${st.verificationUriComplete}
Show this code and link to your human. They confirm the code with the owner of ${peerName}, who approves it on that page (expires in ${mins} minutes).`);
	}
	if (o["no-wait"]) {
		emit({ status: "started", alias, next: `${CLI} connect ${target}${o.alias ? ` --alias ${o.alias}` : ""}` },
			`Not waiting (--no-wait). Once approved, run \`${CLI} connect ${target}${o.alias ? ` --alias ${o.alias}` : ""}\` again: it continues this request (same code).`);
		return;
	}
	if (!o.json) console.error("waiting for approval...");
	let interval = st.interval;
	for (;;) {
		if (Date.now() >= st.expiresAt) { dropState(alias); die(`the code ${st.userCode} expired before it was approved; run \`${CLI} connect ${target}\` again for a new one`); }
		await sleep(interval);
		const r = await postForm(st.token, { grant_type: DEVICE_GRANT, device_code: st.deviceCode });
		if (r.status === 200 && r.data.access_token) {
			if (r.data.token_type && !/^bearer$/i.test(r.data.token_type)) die(`unexpected token_type ${r.data.token_type}`);
			C.saveConfig({ [tokenEnv]: r.data.access_token });
			peers[alias] = { url: base, token_env: tokenEnv, token_stored: true, paired: { userCode: st.userCode, at: new Date().toISOString() } };
			C.savePeers(peers);
			dropState(alias);
			emit({ status: "connected", alias, url: base, token_env: tokenEnv },
				`connected: peer "${alias}" -> ${base} (token stored in ${C.CONFIG_FILE} as ${tokenEnv}; not printed).
Send a message: ${CLI} send --to ${alias} --text "..."`);
			return;
		}
		const err = r.data.error;
		if (err === "authorization_pending") continue;
		if (err === "slow_down") { interval += 5; continue; }
		dropState(alias);
		if (err === "access_denied") die(`the owner of ${peerName} denied the pairing request (code ${st.userCode})`);
		if (err === "expired_token") die(`the code ${st.userCode} expired before it was approved; run \`${CLI} connect ${target}\` again for a new one`);
		if (err === "invalid_grant") die(`the pairing request is no longer valid (already used or expired); run \`${CLI} connect ${target}\` again`);
		die(`pairing with ${peerName} failed: ${r.data.error_description || err || `HTTP ${r.status}`}`);
	}
}
