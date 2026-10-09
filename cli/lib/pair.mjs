// Device-flow pairing (OAuth 2.0 Device Authorization Grant, RFC 8628).
//   Owner side (this inbox is the authorization server): pair set-password | set-oidc | list | approve | deny
//   Client side (connect to another inbox): connect <base-or-card-url>
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as C from "./config.mjs";
import { CLI, describeHttp, die, fetchCard, httpJson, isPrivateHost, pickEndpoint } from "./a2a.mjs";
import { baseUrl, peerToken, warnPeerTokenEnv } from "./commands.mjs";

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const PBKDF2_ITERATIONS = 100000; // default (the Workers runtime's maximum); the Worker advertises its own setting
export const MIN_PASSWORD_LENGTH = 12;
const MIGRATION_HINT = `(if this inbox was deployed before device-flow pairing existed, run \`${CLI} deploy\` first: it applies the new D1 migration)`;

/** Owner API call that returns { status, data } instead of dying, so errors can be explained. */
async function ownerCall(method, p, body) {
	const base = baseUrl(), tok = C.get("A2A_OWNER_TOKEN");
	if (!base || !tok) die(`A2A_BASE_URL / A2A_OWNER_TOKEN missing (run \`${CLI} init\` or edit ${C.CONFIG_FILE})`);
	return httpJson(base + p, { method, body, headers: { authorization: `Bearer ${tok}` } });
}
const ownerError = (r) => {
	const msg = r.data && typeof r.data === "object" && typeof r.data.error === "string" ? r.data.error : describeHttp(r.status, r.data);
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

/** `pair set-password --web`: a one-time link for the human to set the password on a web page. */
async function passwordLink(o) {
	let ttlSeconds;
	if (o.ttl !== undefined) {
		const m = Number(o.ttl);
		if (!Number.isInteger(m) || m < 1 || m > 60) die("--ttl is the link lifetime in minutes, 1 to 60 (default 15)");
		ttlSeconds = m * 60;
	}
	const r = await ownerCall("POST", "/owner/pairing/password-link", ttlSeconds ? { ttlSeconds } : {});
	if (r.status === 404)
		die(`this inbox's Worker predates \`pair set-password --web\`: run \`${CLI} deploy\` first, or let your human run \`${CLI} pair set-password\` in a terminal`);
	if (r.status !== 200) die(`could not create a setup link: ${ownerError(r)}`);
	const d = r.data, mins = Math.round(d.expiresIn / 60);
	const tell = `Send this link to your human, privately (it lets whoever opens it ${d.passwordSet ? "change" : "set"} the approval password). They open it and type the password themselves. Never open the link, fill in the page, or ask for the password yourself. Creating a new link invalidates this one.`;
	if (o.json) return console.log(JSON.stringify({ url: d.url, expiresAt: d.expiresAt, expiresIn: d.expiresIn, singleUse: true, passwordSet: d.passwordSet, instructions: tell }));
	console.log(d.url);
	console.error(`One-time link to ${d.passwordSet ? "change" : "set"} the approval password (valid ${mins} minute${mins === 1 ? "" : "s"}, until ${d.expiresAt}; single use).\n${tell}`);
}

export async function setPassword(o = {}) {
	if (o.web) return passwordLink(o);
	if (!process.stdin.isTTY)
		die(`\`pair set-password\` reads the approval password from a terminal, without echo, and stdin is not a terminal.
The approval password must be known only to the human who approves pairing requests: the human runs this command themselves, in a terminal (never an agent, never from a script).
No terminal? \`${CLI} pair set-password --web\` prints a one-time link where your human sets it on a web page instead.`);
	let a, b;
	try {
		a = await readHidden(`New approval password (at least ${MIN_PASSWORD_LENGTH} characters, not shown): `);
		if (a.length < MIN_PASSWORD_LENGTH) die(`too short: use at least ${MIN_PASSWORD_LENGTH} characters (a passphrase of a few words works well)`);
		b = await readHidden("Repeat it: ");
	} catch (e) { if (e.message === "cancelled") die("cancelled; nothing changed"); throw e; }
	if (a !== b) die("the two entries differ; nothing changed");
	// the iteration count the Worker is configured for (an older Worker doesn't say: the default)
	let iterations = PBKDF2_ITERATIONS;
	try { const info = await ownerCall("GET", "/owner/pairing"); if (info.status === 200 && Number.isInteger(info.data.pbkdf2Iterations)) iterations = info.data.pbkdf2Iterations; } catch { /* default */ }
	const r = await ownerCall("PUT", "/owner/pairing/password", passwordRecord(a, iterations));
	if (r.status !== 200) die(`could not set the approval password: ${ownerError(r)}`);
	console.error(`approval password set${r.data.setAt ? ` at ${r.data.setAt}` : ""} (stored on the Worker as a salted PBKDF2-SHA256 hash, ${iterations} iterations; the password itself was not sent).`);
	console.error(`Approve pairing requests at ${baseUrl()}/device: a webhook wake carries each request's direct link; polling agents see requests in \`${CLI} inbox\` and \`${CLI} pair list\`.${r.data.mode === "human" ? "" : ` Note: approval mode is ${r.data.mode}.`}`);
}

/** `pair set-oidc`: non-secret settings in config.env. The client secret stays in the environment (or was read from stdin and discarded). */
export async function setOidc(o, extra = []) {
	if (extra.length) die("pair set-oidc takes no extra arguments. The client secret is not an argument: export APPROVAL_OIDC_CLIENT_SECRET or pass --secret-stdin");
	if (!o.issuer || !o["client-id"] || !o.subjects) die("usage: pair set-oidc --issuer https://idp.example --client-id ID --subjects sub@example.com[,other] [--methods password,oidc] [--secret-stdin]");
	let issuer;
	try { issuer = new URL(String(o.issuer).trim()); } catch { die("--issuer must be an https URL"); }
	if (issuer.protocol !== "https:" || issuer.username || issuer.password) die("--issuer must be an https URL with no user name or password");
	const clientId = String(o["client-id"]).trim();
	if (!clientId || clientId.length > 200 || /\s/.test(clientId)) die("--client-id must be a single token, at most 200 characters");
	const subjects = String(o.subjects).split(",").map((s) => s.trim()).filter(Boolean);
	if (!subjects.length || subjects.some((s) => s.length > 320 || /[\r\n]/.test(s))) die("--subjects is a comma-separated list of allowed sub or email values");
	let methods;
	if (o.methods !== undefined) {
		const parts = String(o.methods).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
		if (!parts.length || parts.some((p) => p !== "password" && p !== "oidc")) die("--methods is a comma-separated list of password and oidc");
		methods = [...new Set(parts)].join(",");
	}
	let sawStdin = false;
	if (o["secret-stdin"]) {
		if (process.stdin.isTTY) die("--secret-stdin reads the client secret from a pipe. Or export APPROVAL_OIDC_CLIENT_SECRET. It is not saved in config.env");
		const chunks = [];
		for await (const c of process.stdin) chunks.push(c);
		const secret = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
		if (!secret || /[\r\n]/.test(secret)) die("the client secret must be a single non-empty line on stdin");
		sawStdin = true;
		const fromEnv = process.env.APPROVAL_OIDC_CLIENT_SECRET || "";
		if (fromEnv && fromEnv !== secret) console.error("The secret on stdin differs from APPROVAL_OIDC_CLIENT_SECRET. Deploy uploads the environment variable. Neither value was printed or saved.");
	} else if (!(process.env.APPROVAL_OIDC_CLIENT_SECRET || "").trim()) {
		die("export APPROVAL_OIDC_CLIENT_SECRET or pass --secret-stdin. The client secret is not a flag and is not saved in config.env");
	}
	C.saveConfig({
		APPROVAL_OIDC_ISSUER: String(o.issuer).trim(),
		APPROVAL_OIDC_CLIENT_ID: clientId,
		APPROVAL_OIDC_ALLOWED_SUBJECTS: subjects.join(","),
		...(methods !== undefined ? { APPROVAL_METHODS: methods } : {}),
	});
	console.error(`OpenID Connect approval saved in ${C.CONFIG_FILE} (issuer, client id, allowed subjects${methods !== undefined ? ", methods" : ""}).`);
	console.error("The client secret was not written there and was not printed.");
	if (sawStdin && !(process.env.APPROVAL_OIDC_CLIENT_SECRET || "").trim())
		console.error(`Export APPROVAL_OIDC_CLIENT_SECRET in the environment you use for deploy. This command did not store it.`);
	console.error(`The next \`npx -y a2a-exposed@latest deploy\` uploads APPROVAL_OIDC_CLIENT_SECRET from the environment as a Worker secret.`);
	console.error("Password approval stays available unless --methods oidc (and only once the issuer, client id, secret and allowlist are all set).");
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
	if (d.mode !== "off") {
		console.log(`approval password: ${d.passwordSet ? `set${d.passwordSetAt ? ` ${d.passwordSetAt}` : ""}${d.passwordSetVia ? ` (via ${d.passwordSetVia})` : ""}`
			: `NOT SET: run \`${CLI} pair set-password --web\` and send your human the one-time link (or they run \`${CLI} pair set-password\` in a terminal)`}`);
		if (d.oidcIssuer) console.log(`OpenID Connect: ${(d.approvalMethods || []).join(" and ")} (${d.oidcIssuer})`);
		if (d.setupLinkExpiresAt) console.log(`setup link: one is open until ${d.setupLinkExpiresAt} (a new \`pair set-password --web\` replaces it)`);
	}
	if (!d.pending.length) return console.log("(no pending pairing requests)");
	for (const p of d.pending) {
		console.log(`--- ${p.userCode}  ${JSON.stringify(p.clientName || p.clientId || "(no name)")} (claimed, untrusted)  expires ${p.expiresAt}${p.replacesLabel ? `  replaces the active token "${p.replacesLabel}"` : ""}`);
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
	console.log(`approved ${d.userCode}${d.clientName ? ` (${JSON.stringify(d.clientName)})` : ""}: the agent collects its token on its next poll, as peer "${d.label}"${d.replaced ? " (its old token stops working)" : ""}. Revoke any time: ${CLI} token revoke ${d.label}`);
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

async function postForm(url, params, bearer = null) {
	let r;
	const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
	if (bearer) headers.authorization = `Bearer ${bearer}`;
	try {
		r = await fetch(url, { method: "POST", headers,
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

/** agent_card_url for a pairing request: --card-url (e.g. an agent that already speaks A2A on a Tailnet and pairs out
 *  before it has a public façade), else this deployment's card. Only https is sent (inboxes reject anything else); a
 *  private-network card (*.ts.net, LAN) is sent as informational, and the peer's approval page flags it as not
 *  publicly reachable. */
export function cardUrlToSend(flag, own, quiet = false) {
	const note = (m) => { if (!quiet) console.error(m); };
	if (flag) {
		let u;
		try { u = new URL(flag); } catch { die(`--card-url must be a URL (your agent card, e.g. https://agent.example.com/.well-known/agent-card.json)`); }
		if (u.protocol !== "https:" || u.username || u.password) { note(`note: --card-url ${u.origin} is not a plain https URL, so it is left out of the pairing request (inboxes accept only public https cards). Peers can't call an agent there: to be reachable, expose it through a public façade (setup skill: "Already have A2A on a Tailnet or LAN") and pass the façade's card`); return ""; }
		if (u.href.length > 300) { note("note: --card-url is longer than 300 characters, so it is left out of the pairing request"); return ""; }
		if (isPrivateHost(u.hostname)) note(`note: ${u.hostname} is on a private network: the peer's owner sees the card as informational ("not publicly reachable"). Expose your agent through a public façade for others to reach it (setup skill: "Already have A2A on a Tailnet or LAN").`);
		return u.href;
	}
	return /^https:\/\//.test(own || "") ? `${own}/.well-known/agent-card.json` : "";
}

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

/** Shell-quote one argument for a copy-paste hint. */
const shq = (v) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(v) ? v : `'${String(v).replace(/'/g, `'\\''`)}'`);

/** Does `token` still work at the peer? A GetTask for a random id answers 401 for a bad token and a JSON-RPC
 *  "task not found" (or a task) for a good one. Unknown (network or odd answer): null. */
async function tokenWorks(base, card, token) {
	const [url, version] = pickEndpoint(base, card);
	const v1 = version.startsWith("1");
	try {
		const r = await fetch(url, { method: "POST", signal: AbortSignal.timeout(15000), redirect: "error",
			headers: { "content-type": "application/json", accept: "application/json", "A2A-Version": v1 ? "1.0" : "0.3", authorization: `Bearer ${token}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: "pairing-probe", method: v1 ? "GetTask" : "tasks/get", params: { id: crypto.randomUUID() } }) });
		if (r.status === 401 || r.status === 403) return false;
		return r.status === 200 ? true : null;
	} catch { return null; }
}

export async function connect(target, o) {
	const emit = (obj, text) => (o.json ? console.log(JSON.stringify(obj)) : console.error(text));
	if (o.alias !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(o.alias)) die("--alias must be [A-Za-z0-9_-]{1,32}");
	const replace = !!(o.replace || o.force);
	const { base, card, ep } = await discover(target);
	const alias = o.alias || slug(card && card.name) || slug(new URL(base).hostname.split(".")[0]) || "peer";
	const peers = C.loadPeers();
	const tokenEnv = (peers[alias] && peers[alias].token_env) || C.peerTokenVar(alias);
	if (peers[alias] && peers[alias].url !== base) die(`peer alias "${alias}" is already used for ${peers[alias].url}; pass --alias <another>`);
	const peerName = (card && card.name) || base;
	// the exact command to run again: same target, same alias (also when it was derived), same flags
	const rerun = (extra = {}) => {
		const f = { "no-wait": !!o["no-wait"], ...extra };
		return [CLI, "connect", shq(target), "--alias", alias, o.name ? `--name ${shq(o.name)}` : "", replace ? "--replace" : "", f["no-wait"] ? "--no-wait" : "", o.json ? "--json" : ""].filter(Boolean).join(" ");
	};
	const oldLabel = peers[alias] && peers[alias].paired && peers[alias].paired.label;

	let st = loadState(alias);
	if (st && st.base !== base) { dropState(alias); st = null; }
	const resumed = !!st;
	if (st && Date.now() >= st.expiresAt) {
		// never start a new request silently: a new code means a new approval prompt for the peer's owner
		dropState(alias);
		die(`the earlier pairing request to ${peerName} (code ${st.userCode}) expired before it was approved; nothing was stored.
For a new code (a new approval request to its owner), run: ${rerun()}`);
	}
	const oldToken = peerToken(tokenEnv); // warns when the environment shadows a different saved token
	if (!st && oldToken) {
		const works = await tokenWorks(base, card, oldToken);
		if (works !== false && !replace)
			die(`peer "${alias}" already has a token${works ? " that works" : ""} (${tokenEnv}). Nothing to do: send with \`${CLI} send --to ${alias} ...\`.
To replace it anyway (for example after a leak), run: ${rerun({})} --replace
A different agent at the same URL? Pass another --alias.`);
		if (works === false && !o.json) console.error(`note: peer "${alias}" rejects the stored token (HTTP 401: revoked or rotated); requesting a new one.`);
	}
	if (st) emit({ status: "authorization_pending", resumed: true, alias, user_code: st.userCode, verification_uri: st.verificationUri, verification_uri_complete: st.verificationUriComplete, expires_in: Math.round((st.expiresAt - Date.now()) / 1000) },
		`Resuming the pairing request to ${peerName} (code ${st.userCode}, link ${st.verificationUriComplete}).`);
	else {
		const own = baseUrl();
		const params = { client_name: o.name || C.get("A2A_AGENT_NAME") || C.get("A2A_WORKER_NAME") || "a2a-exposed agent", client_id: C.get("A2A_WORKER_NAME") || alias };
		const card = cardUrlToSend(o["card-url"], own, o.json);
		if (card) params.agent_card_url = card;
		// replacing: present the old token, so a peer that supports it swaps the token under the same label (no orphan)
		const r = await postForm(ep.device, params, replace && oldToken ? oldToken : null);
		if (r.status !== 200 || !r.data.device_code || !r.data.user_code) {
			const why = r.data.error_description || r.data.error || `HTTP ${r.status}`;
			const privateCard = !!card && (() => { try { return isPrivateHost(new URL(card).hostname); } catch { return false; } })();
			die(r.status === 429 ? `${peerName} is not accepting more pairing requests right now: ${why}` : r.status === 404 ? `${peerName} has device-flow pairing disabled (${why}); ask its owner for a token`
				: `pairing request to ${peerName} failed: ${why}${privateCard && r.status === 400 ? `. The card URL sent (${new URL(card).host}) is not publicly reachable, and inboxes may accept only public https cards: retry with --card-url set to a public card, or expose your agent through a public façade first (setup skill: "Already have A2A on a Tailnet or LAN")` : ""}`);
		}
		st = { base, alias, device: ep.device, token: ep.token, deviceCode: r.data.device_code, userCode: r.data.user_code,
			verificationUri: r.data.verification_uri || "", verificationUriComplete: r.data.verification_uri_complete || r.data.verification_uri || "",
			interval: Math.max(1, Number(r.data.interval) || 5), expiresAt: Date.now() + (Number(r.data.expires_in) || 600) * 1000,
			replacesLabel: r.data.replaces_label || null, replacing: replace && !!oldToken };
		saveState(alias, st); // chmod 600: the device code is a bearer secret until it is redeemed
		const mins = Math.round((st.expiresAt - Date.now()) / 60000);
		const swap = !st.replacing ? "" : st.replacesLabel
			? ` On approval the peer replaces our token "${st.replacesLabel}" (the old one stops working).`
			: ` This peer does not swap tokens: our old token${oldLabel ? ` (label "${oldLabel}" on its side)` : ""} stays active until its owner revokes it${oldLabel ? ` (\`${CLI} token revoke ${oldLabel}\`)` : ""}; tell them.`;
		emit({ status: "authorization_pending", alias, user_code: st.userCode, verification_uri: st.verificationUri, verification_uri_complete: st.verificationUriComplete, expires_in: Math.round((st.expiresAt - Date.now()) / 1000), interval: st.interval,
			...(st.replacing ? { replaces_label: st.replacesLabel } : {}),
			instructions: `Show the code and the link to your human. They confirm the code with the owner of ${peerName}, who approves it on that page.${swap}` },
			`Pairing with ${peerName} (${base}):
  code: ${st.userCode}
  link: ${st.verificationUriComplete}
Show this code and link to your human. They confirm the code with the owner of ${peerName}, who approves it on that page (expires in ${mins} minutes).${swap}`);
	}

	const finish = (r) => {
		if (r.data.token_type && !/^bearer$/i.test(r.data.token_type)) die(`unexpected token_type ${r.data.token_type}`);
		C.saveConfig({ [tokenEnv]: r.data.access_token });
		// a stale PEER_<ALIAS>_TOKEN in the environment would keep winning over the token just saved (on stderr, also with --json)
		const envOverrides = warnPeerTokenEnv(tokenEnv, true);
		const label = r.data.peer_label || null;
		peers[alias] = { url: base, token_env: tokenEnv, token_stored: true, paired: { userCode: st.userCode, at: new Date().toISOString(), ...(label ? { label } : {}) } };
		C.savePeers(peers);
		dropState(alias);
		const orphan = st.replacing && !r.data.replaced ? (st.replacesLabel || oldLabel || null) : null;
		const note = r.data.replaced ? ` It replaced our previous token there (label "${label}").`
			: st.replacing ? ` Our previous token${orphan ? ` ("${orphan}")` : ""} is still active on the peer until its owner revokes it${orphan ? `: \`${CLI} token revoke ${orphan}\`` : ""}.` : "";
		emit({ status: "connected", alias, url: base, token_env: tokenEnv, ...(label ? { peer_label: label } : {}), ...(st.replacing ? { replaced: !!r.data.replaced } : {}), ...(envOverrides ? { env_overrides_token: true } : {}) },
			`connected: peer "${alias}" -> ${base}${label ? ` (we are "${label}" there)` : ""}; token stored in ${C.CONFIG_FILE} as ${tokenEnv} (not printed).${note}
Send a message: ${CLI} send --to ${alias} --text "..."`);
	};
	const fail = (r) => {
		const err = r.data.error;
		dropState(alias);
		if (err === "access_denied") die(`the owner of ${peerName} denied the pairing request (code ${st.userCode})`);
		if (err === "expired_token") die(`the code ${st.userCode} expired before it was approved; nothing was stored. For a new code, run: ${rerun()}`);
		if (err === "invalid_grant") die(`the pairing request (code ${st.userCode}) is no longer valid (already used, or expired long ago); nothing was stored. For a new code, run: ${rerun()}`);
		die(`pairing with ${peerName} failed: ${r.data.error_description || err || `HTTP ${r.status}`}`);
	};

	if (o["no-wait"]) {
		// a resumed request checks once, so `--no-wait` can be re-run to see whether it was approved
		if (resumed) {
			const r = await postForm(st.token, { grant_type: DEVICE_GRANT, device_code: st.deviceCode });
			if (r.status === 200 && r.data.access_token) return finish(r);
			if (r.data.error && !["authorization_pending", "slow_down"].includes(r.data.error)) return fail(r);
		}
		emit({ status: "not_waiting", alias, user_code: st.userCode, expires_in: Math.round((st.expiresAt - Date.now()) / 1000), next: rerun() },
			`Not waiting (--no-wait). Run \`${rerun()}\` again to check (same code), or \`${rerun({ "no-wait": false })}\` to wait for approval.`);
		return;
	}
	if (!o.json) console.error("waiting for approval...");
	let interval = st.interval;
	for (;;) {
		if (Date.now() >= st.expiresAt) { dropState(alias); die(`the code ${st.userCode} expired before it was approved; nothing was stored. For a new code, run: ${rerun()}`); }
		await sleep(interval);
		const r = await postForm(st.token, { grant_type: DEVICE_GRANT, device_code: st.deviceCode });
		if (r.status === 200 && r.data.access_token) return finish(r);
		const err = r.data.error;
		if (err === "authorization_pending") continue;
		if (err === "slow_down") { interval += 5; continue; }
		fail(r);
	}
}
