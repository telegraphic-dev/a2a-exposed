// `tunnel create|status|rm`: wake a local-only webhook (OpenClaw gateway, Hermes, ...) through a named Cloudflare
// Tunnel whose hostname is locked down by Cloudflare Access to ONE service token held by the Worker.
//
// Layout:  Worker --(CF-Access-Client-Id/Secret + preset auth)--> https://wake-xxx.<zone><path>
//            --> Access (service-token-only policy) --> Tunnel --> cloudflared on the agent's machine --> local origin
// A Cloudflare zone on the account is required on purpose (no quick tunnels, no unprotected hostnames). Any zone
// on the account works: the inbox itself can stay on workers.dev or on another hostname.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import * as C from "./config.mjs";
import { CliError, die, fingerprint, httpJson } from "./a2a.mjs";
import { owner } from "./commands.mjs";
import * as D from "./deploy.mjs";

const step = (s) => console.error(`==> ${s}`);

/** Local webhook defaults per preset: [origin, path]. Hosted presets (grok-bot, claude-code) need no tunnel. */
export const ORIGIN_DEFAULTS = {
	"openclaw-wake": ["http://127.0.0.1:18789", "/hooks/wake"],
	"openclaw-agent": ["http://127.0.0.1:18789", "/hooks/agent"],
	hermes: ["http://127.0.0.1:8644", ""], // path is /webhooks/<subscription name>: pass --tunnel-path
	generic: ["", ""],
};
export const HOSTED_PRESETS = ["grok-bot", "claude-code"];
export const ACCESS_SESSION = "15m";
export const SERVICE_TOKEN_DURATION = "8760h"; // 1 year (Cloudflare's default); rotate with tunnel rm + create

// Config keys written by `tunnel create` (ids are recorded as soon as each object exists, so `tunnel rm`
// can clean up after a partial failure too).
export const TUNNEL_KEYS = [
	"A2A_TUNNEL_HOSTNAME", "A2A_TUNNEL_ORIGIN", "A2A_TUNNEL_PATH", "A2A_TUNNEL_ZONE_ID", "A2A_TUNNEL_ID", "A2A_TUNNEL_DNS_ID",
	"A2A_TUNNEL_ACCESS_APP_ID", "A2A_TUNNEL_ACCESS_TOKEN_ID", "A2A_TUNNEL_ACCESS_CLIENT_ID", "A2A_TUNNEL_ACCESS_CLIENT_SECRET",
	"A2A_TUNNEL_TOKEN_FILE",
];

// ------------------------------------------------------------------ pure helpers (unit-tested)
const WORDS = ["amber", "brisk", "cedar", "delta", "ember", "fable", "gale", "harbor", "iris", "jade", "kelp", "lumen", "maple",
	"nova", "onyx", "pebble", "quill", "raven", "sable", "tidal", "umber", "velvet", "willow", "zephyr", "otter", "lark", "fjord", "heron"];
export function randomLabel(rand = crypto.randomInt) {
	const w = () => WORDS[rand(WORDS.length)];
	return `wake-${w()}-${w()}-${rand(0x10000).toString(16).padStart(4, "0")}`;
}

export const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The account zone a hostname belongs to (longest matching suffix), or null. */
export function zoneFor(hostname, zones) {
	const h = hostname.toLowerCase();
	return (zones || []).filter((z) => h === z.name || h.endsWith("." + z.name)).sort((a, b) => b.name.length - a.name.length)[0] || null;
}

const usableZones = (zones) => (zones || []).filter((z) => z && z.name && (!z.status || z.status === "active"));
const zoneList = (zones) => zones.map((z) => `  ${z.name}`).join("\n");

/** Error text when the account has no usable zone: the tunnel is impossible, polling is the option. */
export function noZoneHelp(zones) {
	const inactive = (zones || []).filter((z) => z && z.name && z.status && z.status !== "active");
	return [
		inactive.length
			? `no active domain (zone) on this Cloudflare account (not active yet: ${inactive.map((z) => `${z.name} [${z.status}]`).join(", ")}).`
			: "this Cloudflare account has no domain (zone).",
		"The wake tunnel needs a zone anywhere on the account for its hostname and Access app (whether the inbox is on workers.dev or a custom hostname).",
		"Without one, use scheduled polling: the inbox works as it is (setup skill: \"Agents without inbound webhooks: polling\").",
		"To use the tunnel later, add a domain to the account and run `a2a-over-webhook tunnel create` (no redeploy needed).",
	].join("\n");
}

/** The wake hostname and its zone. Order: --tunnel-hostname, --tunnel-zone, the zone of the inbox's custom hostname,
 *  then the account's only zone. Several zones and no choice: stop and list them. No zone: point to polling. */
export function pickTunnelHostname({ tunnelHostname, tunnelZone, inboxHost, zones, label = randomLabel }) {
	const usable = usableZones(zones);
	if (tunnelHostname) {
		const hostname = tunnelHostname.toLowerCase();
		const zone = zoneFor(hostname, usable);
		const inactive = zone ? null : zoneFor(hostname, zones);
		if (inactive) die(`${hostname} is on the zone ${inactive.name}, which is not active yet (${inactive.status}); ` +
			(usable.length ? `pick a hostname on an active zone:\n${zoneList(usable)}` : "wait until it is active, or use polling meanwhile"));
		if (!zone) die(usable.length ? `${hostname} is not on a zone in this Cloudflare account; the wake hostname must be on one of:\n${zoneList(usable)}` : noZoneHelp(zones));
		return { hostname, zone, note: "" };
	}
	if (tunnelZone) {
		const want = tunnelZone.toLowerCase().replace(/\.$/, "");
		const zone = usable.find((z) => z.name.toLowerCase() === want);
		if (!zone) die(usable.length ? `--tunnel-zone ${want}: not an active zone on this Cloudflare account; pick one of:\n${zoneList(usable)}` : noZoneHelp(zones));
		return { hostname: `${label()}.${zone.name}`, zone, note: `wake hostname on the zone ${zone.name} (--tunnel-zone)` };
	}
	const own = inboxHost ? zoneFor(inboxHost, usable) : null;
	if (own) return { hostname: `${label()}.${own.name}`, zone: own, note: `wake hostname on ${own.name}, the zone of the inbox hostname` };
	if (usable.length === 1)
		return { hostname: `${label()}.${usable[0].name}`, zone: usable[0], note: `the account has one zone, ${usable[0].name}: the wake hostname goes there (the inbox URL is unchanged)` };
	if (!usable.length) die(noZoneHelp(zones));
	return die([
		`this Cloudflare account has ${usable.length} zones; choose one for the wake hostname (the inbox URL is unchanged):`,
		zoneList(usable),
		"Re-run with --tunnel-zone <zone>  (or --tunnel-hostname wake-<name>.<zone>).",
	].join("\n"));
}

export function validateOrigin(origin) {
	let u;
	try { u = new URL(origin); } catch { die(`--tunnel-origin must be a URL like http://127.0.0.1:18789 (got ${JSON.stringify(origin)})`); }
	if (!/^https?:$/.test(u.protocol) || (u.pathname !== "/" && u.pathname !== "") || u.search || u.username)
		die("--tunnel-origin must be scheme://host:port only (put the path in --tunnel-path)");
	return `${u.protocol}//${u.host}`;
}

export const wakeUrl = (hostname, p) => `https://${hostname}${p.startsWith("/") ? p : "/" + p}`;

export const tunnelCreateBody = (name) => ({ name, config_src: "cloudflare" });

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Remotely-managed ingress: only the wake path on the wake hostname reaches the origin (everything else: 404),
 *  and cloudflared also checks the Access JWT itself. */
export function tunnelConfigBody({ hostname, origin, wpath, teamName, audTag }) {
	const access = teamName && audTag ? { access: { required: true, teamName, audTag: [audTag] } } : {};
	const rule = { hostname, ...(wpath ? { path: `^${reEscape(wpath)}$` } : {}), service: origin, originRequest: { ...access } };
	return { config: { ingress: [rule, { service: "http_status:404" }] } };
}

export const dnsCnameBody = (hostname, tunnelId, comment) =>
	({ type: "CNAME", name: hostname, content: `${tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1, comment });

export const serviceTokenBody = (name) => ({ name, duration: SERVICE_TOKEN_DURATION });

/** Self-hosted Access app with exactly one policy: Service Auth (non_identity) for one service token. */
export function accessAppBody({ name, hostname, serviceTokenId }) {
	return {
		type: "self_hosted", name, domain: hostname, destinations: [{ type: "public", uri: hostname }],
		session_duration: ACCESS_SESSION, app_launcher_visible: false, auto_redirect_to_identity: false,
		service_auth_401_redirect: true, // blocked service-auth requests get 401 instead of a login redirect
		policies: [{ name: "a2a-over-webhook wake: service token only", decision: "non_identity", precedence: 1,
			include: [{ service_token: { token_id: serviceTokenId } }] }],
	};
}

/** Workers secrets-bulk body (JSON Merge Patch): value -> set, null -> delete. */
export function secretsPatch(map) {
	const secrets = {};
	for (const [k, v] of Object.entries(map)) secrets[k] = v == null ? null : { name: k, type: "secret_text", text: String(v) };
	return { secrets };
}

/** How to run the connector on the agent's machine. The token itself is only printed with --show-token. */
export function connectorInstructions(tokenFile, token = "") {
	const t = token || `"$(cat ${tokenFile})"`;
	return [
		"Run the connector on the agent's machine (outbound TCP/UDP 7844 to Cloudflare must be allowed):",
		`  cloudflared tunnel run --token-file ${tokenFile}        # cloudflared 2025.4+`,
		`  cloudflared tunnel run --token ${t}`,
		`  sudo cloudflared service install ${t}   # as a system service (starts on boot)`,
		token ? "  (token shown because of --show-token: treat it like a password)"
			: `  The tunnel token is in ${tokenFile} (chmod 600). Copy that file to the agent's machine if it is another machine.`,
	].join("\n");
}

/** Cloudflare edge error code in an error page (plain text or HTML), or "". Same rules as the Worker's. */
export function cloudflareErrorCode(body) {
	const m = /error code:?\s*(\d{4})|\bError\s+(\d{4})\b|errorCode:?\s*(\d{4})|cf-error-code[^>]*>\s*(\d{4})/i.exec(body || "");
	return m ? m[1] || m[2] || m[3] || m[4] : "";
}

// ------------------------------------------------------------------ cf calls (JSON in, JSON out, errors captured)
export function cfCall(dir, args, { body, file, allowNotFound = false } = {}) {
	const full = [...args];
	if (body !== undefined) full.push("--body", JSON.stringify(body));
	if (file) full.push("--file", file);
	const r = spawnSync(D.cfBin(dir), D.cfArgs(full), { cwd: dir, env: D.cfEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	if (r.error) die(`cf: ${r.error.message}`);
	if (r.status !== 0) {
		const err = (r.stderr || r.stdout || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
		if (allowNotFound && /404|not found|does not exist|could not be found/i.test(err)) return null;
		const msg = (err.match(/\[\d+\][^\n]*/g) || [err.trim().split("\n").slice(-3).join(" ")]).join("; ");
		throw new CliError(`cf ${args.slice(0, 3).join(" ")} failed: ${msg.slice(0, 400)}`);
	}
	const out = (r.stdout || "").trim();
	if (!out) return {};
	try { return JSON.parse(out); } catch { return { raw: out }; }
}

const ACCESS_HELP = (acct) => [
	"Cloudflare Access (Zero Trust) is not enabled on this account yet. It is required: the tunnel hostname is locked to a service token.",
	"  - dashboard: https://one.dash.cloudflare.com/ -> pick a team name and the Free plan (up to 50 users), then re-run",
	"  - or let the CLI create the organization: re-run with --zero-trust-org <team-name>  (gives <team-name>.cloudflareaccess.com)",
	`  account: ${acct || "(see cf auth whoami)"}`,
	"No tunnel? Use scheduled polling instead (setup skill: \"Agents without inbound webhooks: polling\").",
].join("\n");

function accessOrg(dir, o) {
	try {
		return cfCall(dir, ["zero-trust", "organization", "get"]);
	} catch (e) {
		if (!/not_enabled|not enabled/i.test(e.message)) throw e;
		const team = o["zero-trust-org"];
		if (!team) die(ACCESS_HELP(C.get("CLOUDFLARE_ACCOUNT_ID")));
		if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(team)) die("--zero-trust-org must be a DNS label (lowercase letters, digits, hyphens)");
		step(`creating the Zero Trust organization ${team}.cloudflareaccess.com (account-level, stays afterwards)`);
		return cfCall(dir, ["zero-trust", "organization", "create"], { body: { name: team, auth_domain: `${team}.cloudflareaccess.com` } });
	}
}

/** Zones of the deployment's account (the login may see other accounts' zones too), all pages. */
export function listZones(dir) {
	const acct = C.get("CLOUDFLARE_ACCOUNT_ID"), per = 50, all = [];
	for (let page = 1; page <= 40; page++) {
		const r = cfCall(dir, ["zones", "list", "--per-page", String(per), "--page", String(page), ...(acct ? ["--account-id", acct] : [])]);
		const zones = Array.isArray(r) ? r : Array.isArray(r?.result) ? r.result : [];
		all.push(...zones);
		if (zones.length < per) break;
	}
	return all.filter((z) => z && z.name && (!acct || !z.account?.id || z.account.id === acct));
}

// ------------------------------------------------------------------ commands
function needDeployment(o) {
	if (!C.get("A2A_D1_ID") || !C.get("A2A_WORKER_NAME")) die("no saved deployment; run `a2a-over-webhook init` first");
	const dir = D.workerDir(o);
	if (!fs.existsSync(dir)) die(`worker project not found at ${dir}; run \`a2a-over-webhook deploy\` once`);
	return dir;
}

/** Checks that need no Cloudflare calls (also used by `init --tunnel` before anything is deployed). */
export function preflight(o) {
	const preset = o.preset || C.get("WAKE_PRESET", "generic"); // o.preset: `init --tunnel` checks before saving flags
	if (HOSTED_PRESETS.includes(preset)) die(`preset ${preset} wakes a hosted service; a tunnel is only for local-only webhooks (openclaw-*, hermes, generic)`);
	const [dOrigin, dPath] = ORIGIN_DEFAULTS[preset] || ["", ""];
	const origin = o["tunnel-origin"] || C.get("A2A_TUNNEL_ORIGIN") || dOrigin;
	const wpath = o["tunnel-path"] || C.get("A2A_TUNNEL_PATH") || dPath;
	if (!origin) die(`--tunnel-origin is required for preset ${preset} (the local webhook, e.g. http://127.0.0.1:8080)`);
	if (!wpath || !wpath.startsWith("/")) die(`--tunnel-path is required for preset ${preset} and must start with / (e.g. /webhooks/a2a for Hermes)`);
	if (o["tunnel-hostname"] && !HOST_RE.test(o["tunnel-hostname"])) die("--tunnel-hostname must be a hostname like wake-abc.example.com");
	if (o["tunnel-zone"] && !HOST_RE.test(o["tunnel-zone"].toLowerCase())) die("--tunnel-zone must be a zone name like example.com");
	if (o["tunnel-zone"] && o["tunnel-hostname"]) die("pass --tunnel-zone or --tunnel-hostname, not both");
	if (process.env.WAKE_WEBHOOK_URL) die("unset WAKE_WEBHOOK_URL: `tunnel create` sets the wake URL to the tunnel hostname");
	return { preset, origin: validateOrigin(origin), wpath };
}

export async function create(o) {
	D.checkNode();
	const dir = needDeployment(o);
	if (tunnelStarted()) return resume(dir, o);
	const { preset, origin, wpath } = preflight(o);
	const worker = D.workerName();

	step("finding a zone for the wake hostname");
	const { hostname, zone, note } = pickTunnelHostname({
		tunnelHostname: o["tunnel-hostname"], tunnelZone: o["tunnel-zone"], inboxHost: C.get("A2A_HOSTNAME"), zones: listZones(dir),
	});
	if (note) step(note);
	const existing = cfCall(dir, ["dns", "records", "list", "-z", zone.id, "--name", hostname]);
	if (Array.isArray(existing) && existing.length) die(`${hostname} already has a DNS record; pick another --tunnel-hostname`);

	step("checking Cloudflare Access (Zero Trust)");
	const org = accessOrg(dir, o);
	const teamName = String(org.auth_domain || "").replace(/\.cloudflareaccess\.com$/, "");

	const label = `a2a-over-webhook wake ${worker}`;
	const save = (u) => C.saveConfig(u);
	save({ A2A_TUNNEL_HOSTNAME: hostname, A2A_TUNNEL_ORIGIN: origin, A2A_TUNNEL_PATH: wpath, A2A_TUNNEL_ZONE_ID: zone.id });
	try {
		step(`Access service token "${label}"`);
		const st = cfCall(dir, ["zero-trust", "access", "service-tokens", "create"], { body: serviceTokenBody(label) });
		if (!st.id || !st.client_id || !st.client_secret) die("unexpected response creating the service token");
		save({ A2A_TUNNEL_ACCESS_TOKEN_ID: st.id, A2A_TUNNEL_ACCESS_CLIENT_ID: st.client_id, A2A_TUNNEL_ACCESS_CLIENT_SECRET: st.client_secret });

		step(`Access application for ${hostname} (one policy: Service Auth, this token only; session ${ACCESS_SESSION})`);
		const app = cfCall(dir, ["zero-trust", "access", "applications", "create"], { body: accessAppBody({ name: label, hostname, serviceTokenId: st.id }) });
		if (!app.id) die("unexpected response creating the Access application");
		save({ A2A_TUNNEL_ACCESS_APP_ID: app.id });

		step(`tunnel "${label}" (remotely managed)`);
		const tun = cfCall(dir, ["tunnels", "create"], { body: tunnelCreateBody(label) });
		if (!tun.id) die("unexpected response creating the tunnel");
		save({ A2A_TUNNEL_ID: tun.id });
		cfCall(dir, ["tunnels", "config", "update", tun.id], { body: tunnelConfigBody({ hostname, origin, wpath, teamName, audTag: app.aud }) });

		step(`DNS: ${hostname} CNAME ${tun.id}.cfargotunnel.com (proxied)`);
		const rec = cfCall(dir, ["dns", "records", "create", "-z", zone.id], { body: dnsCnameBody(hostname, tun.id, label) });
		if (!rec.id) die("unexpected response creating the DNS record");
		save({ A2A_TUNNEL_DNS_ID: rec.id });

		const { tokenFile, token } = fetchTokenFile(dir, tun.id);

		const url = wakeUrl(hostname, wpath);
		step("uploading Worker secrets: WAKE_WEBHOOK_URL, WAKE_ACCESS_CLIENT_ID, WAKE_ACCESS_CLIENT_SECRET" +
			(process.env.WAKE_WEBHOOK_KEY ? ", WAKE_WEBHOOK_KEY" : "") + (process.env.WAKE_HMAC_SECRET ? ", WAKE_HMAC_SECRET" : ""));
		const secrets = { WAKE_WEBHOOK_URL: url, WAKE_ACCESS_CLIENT_ID: st.client_id, WAKE_ACCESS_CLIENT_SECRET: st.client_secret };
		for (const k of ["WAKE_WEBHOOK_KEY", "WAKE_HMAC_SECRET"]) if (process.env[k]) secrets[k] = process.env[k];
		await putSecrets(dir, worker, secrets);

		console.log(url);
		console.error(`\ntunnel ready: wakes go to ${url} -> ${origin}${wpath} on the agent's machine`);
		console.error(connectorInstructions(tokenFile, o["show-token"] ? token : ""));
		console.error(`\nThen (Worker secrets apply within ~15 s): a2a-over-webhook tunnel status   and   a2a-over-webhook wake test`);
		if (!process.env.WAKE_WEBHOOK_KEY && !process.env.WAKE_HMAC_SECRET && preset !== "generic")
			console.error(`note: no WAKE_WEBHOOK_KEY / WAKE_HMAC_SECRET in the environment; keep the ${preset} webhook's own auth too (export it and run \`wake set\`)`);
	} catch (e) {
		console.error(`error: ${e.message}\n==> rolling back what was created`);
		await remove(o, { quiet: true }).catch((r) => console.error(`rollback incomplete: ${r.message}; re-run \`a2a-over-webhook tunnel rm\``));
		throw e;
	}
}

/** Download the tunnel's connector token into <config dir>/tunnel-token (chmod 600) and save its path. */
function fetchTokenFile(dir, tunnelId) {
	const tok = cfCall(dir, ["tunnels", "token", "get", tunnelId]);
	const token = typeof tok === "string" ? tok.trim() : tok.raw || tok.token || tok.result || "";
	if (!token) die("could not read the tunnel token");
	const tokenFile = path.join(C.CONFIG_DIR, "tunnel-token");
	fs.writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
	fs.chmodSync(tokenFile, 0o600);
	C.saveConfig({ A2A_TUNNEL_TOKEN_FILE: tokenFile });
	return { tokenFile, token };
}

/** The saved connector token file exists and is not empty (`cloudflared --token-file` needs it). */
export function tokenFileOk() {
	const f = C.get("A2A_TUNNEL_TOKEN_FILE");
	try { return !!f && fs.statSync(f).isFile() && fs.readFileSync(f, "utf8").trim().length > 0; } catch { return false; }
}

/** Ids a `tunnel create` saves once each Cloudflare object exists. */
const tunnelStarted = () => ["A2A_TUNNEL_ID", "A2A_TUNNEL_ACCESS_APP_ID", "A2A_TUNNEL_ACCESS_TOKEN_ID", "A2A_TUNNEL_DNS_ID"].some((k) => C.get(k));
/** Every object's id and the token file path are saved (the token file itself: tokenFileOk; the Worker secrets are
 *  checked separately). */
export const tunnelComplete = () =>
	["A2A_TUNNEL_HOSTNAME", "A2A_TUNNEL_ID", "A2A_TUNNEL_DNS_ID", "A2A_TUNNEL_ACCESS_APP_ID", "A2A_TUNNEL_ACCESS_TOKEN_ID",
		"A2A_TUNNEL_ACCESS_CLIENT_ID", "A2A_TUNNEL_ACCESS_CLIENT_SECRET", "A2A_TUNNEL_TOKEN_FILE"].every((k) => C.get(k));

/** `tunnel create` again on an existing tunnel: safe to re-run. A complete tunnel creates nothing; its Worker secrets
 *  are re-uploaded if the Worker lacks them (e.g. the first run was interrupted), together with WAKE_WEBHOOK_KEY /
 *  WAKE_HMAC_SECRET when exported (as on a first run); a missing connector token file is downloaded again. A partial
 *  tunnel must be removed first. */
async function resume(dir, o) {
	if (!tunnelComplete())
		die("a previous `tunnel create` did not finish (some ids are saved, see `a2a-over-webhook status`); run `a2a-over-webhook tunnel rm`, then `a2a-over-webhook tunnel create` again");
	const host = C.get("A2A_TUNNEL_HOSTNAME");
	if (o["tunnel-hostname"] && o["tunnel-hostname"].toLowerCase() !== host)
		die(`a tunnel already exists on ${host}; to use another hostname run \`a2a-over-webhook tunnel rm\` first`);
	if (!tokenFileOk()) {
		step(`the connector token file ${C.get("A2A_TUNNEL_TOKEN_FILE")} is missing or empty: downloading the tunnel token again`);
		fetchTokenFile(dir, C.get("A2A_TUNNEL_ID"));
	}
	const url = wakeUrl(host, C.get("A2A_TUNNEL_PATH") || "/");
	let p = null;
	try { p = await owner("GET", "/owner/wake/preview"); } catch (e) { console.error(`warning: Worker not reachable (${e.message}); cannot check its wake secrets`); }
	const agentAuth = {};
	for (const k of ["WAKE_WEBHOOK_KEY", "WAKE_HMAC_SECRET"]) if (process.env[k]) agentAuth[k] = process.env[k];
	const lacksTunnel = p && (!p.hasAccessServiceToken || p.fingerprints?.url !== fingerprint(url));
	if (lacksTunnel || Object.keys(agentAuth).length) {
		const secrets = { WAKE_WEBHOOK_URL: url, WAKE_ACCESS_CLIENT_ID: C.get("A2A_TUNNEL_ACCESS_CLIENT_ID"), WAKE_ACCESS_CLIENT_SECRET: C.get("A2A_TUNNEL_ACCESS_CLIENT_SECRET"), ...agentAuth };
		step(`${lacksTunnel ? "the Worker lacks the tunnel's wake secrets: " : ""}uploading Worker secrets: ${Object.keys(secrets).join(", ")}`);
		await putSecrets(dir, D.workerName(), secrets);
	}
	const preset = C.get("WAKE_PRESET", "generic");
	if (p && !p.hasKey && !p.hasHmacSecret && !Object.keys(agentAuth).length && preset !== "generic")
		console.error(`warning: the Worker has no WAKE_WEBHOOK_KEY / WAKE_HMAC_SECRET, so the ${preset} webhook will reject wakes; export it and run \`a2a-over-webhook tunnel create\` again`);
	console.log(url);
	console.error(`tunnel already set up: wakes go to ${url} -> ${C.get("A2A_TUNNEL_ORIGIN")}${C.get("A2A_TUNNEL_PATH")} (nothing new created; to change it: tunnel rm, then tunnel create)`);
	console.error(connectorInstructions(C.get("A2A_TUNNEL_TOKEN_FILE")));
	console.error("Then: a2a-over-webhook tunnel status   and   a2a-over-webhook wake test");
}

function putSecrets(dir, worker, map) {
	return D.withSecretsFile(secretsPatch(map), (file) => cfCall(dir, ["workers", "secrets", "bulk", "--worker", worker], { file }));
}

export async function status(o) {
	const dir = needDeployment(o);
	const host = C.get("A2A_TUNNEL_HOSTNAME");
	if (!host) return console.log("no tunnel configured (a2a-over-webhook tunnel create)");
	const info = { hostname: host, wakeUrl: wakeUrl(host, C.get("A2A_TUNNEL_PATH") || "/"), origin: C.get("A2A_TUNNEL_ORIGIN") };
	const tid = C.get("A2A_TUNNEL_ID");
	if (tid) {
		const t = cfCall(dir, ["tunnels", "get", tid], { allowNotFound: true });
		info.tunnel = t ? { id: tid, status: t.status, connections: (t.connections || []).length } : "missing";
	}
	const app = C.get("A2A_TUNNEL_ACCESS_APP_ID");
	if (app) {
		const a = cfCall(dir, ["zero-trust", "access", "applications", "get", app], { allowNotFound: true });
		info.accessApp = a ? { id: app, domain: a.domain, policies: (a.policies || []).map((p) => `${p.decision}:${JSON.stringify(p.include)}`) } : "missing";
	}
	try {
		const p = await owner("GET", "/owner/wake/preview");
		info.worker = { hasAccessServiceToken: !!p.hasAccessServiceToken, wakeUrlMatches: p.fingerprints?.url === fingerprint(info.wakeUrl) };
	} catch (e) { info.worker = `unreachable: ${e.message}`; }
	// GET probes (never POST: that would wake the agent): Access must block the bare request; with the service
	// token the request reaches the tunnel (1033 = no connector running; anything from the origin = connector up)
	const probe = async (headers) => {
		try {
			const r = await fetch(info.wakeUrl, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(15000) });
			const body = (await r.text()).slice(0, 2000);
			const code = cloudflareErrorCode(body);
			const access = (r.headers.get("www-authenticate") || /cloudflareaccess\.com/.test(r.headers.get("location") || "")) ? " (Cloudflare Access)" : "";
			return `HTTP ${r.status}${code ? ` (Cloudflare error ${code})` : access}`;
		} catch (e) { return `network error: ${e.message}`; }
	};
	info.probe = { withoutToken: await probe({}) };
	const id = C.get("A2A_TUNNEL_ACCESS_CLIENT_ID"), sec = C.get("A2A_TUNNEL_ACCESS_CLIENT_SECRET");
	if (id && sec) info.probe.withServiceToken = await probe({ "CF-Access-Client-Id": id, "CF-Access-Client-Secret": sec });
	console.log(JSON.stringify(info, null, 2));
	const w = info.probe.withServiceToken || "";
	if (/1033/.test(w)) console.error("connector not running: start cloudflared on the agent's machine (tunnel create printed the command)");
	if (!/^HTTP 40[13]/.test(info.probe.withoutToken)) console.error("WARNING: the bare request was not blocked by Access; check the Access application");
}

export async function remove(o, { quiet = false } = {}) {
	const dir = needDeployment(o);
	const worker = D.workerName();
	const failures = [];
	const attempt = async (what, key, fn) => {
		if (key && !C.get(key)) return;
		try { await fn(); if (key) C.saveConfig({ [key]: null }); step(`removed ${what}`); }
		catch (e) { failures.push(`${what}: ${e.message}`); }
	};
	const host = C.get("A2A_TUNNEL_HOSTNAME");
	// 1. Worker secrets first, so no wake is sent to a half-removed hostname. WAKE_WEBHOOK_URL only if it is ours.
	if (host) await attempt("Worker wake secrets (Access token, tunnel URL)", null, async () => {
		const patch = { WAKE_ACCESS_CLIENT_ID: null, WAKE_ACCESS_CLIENT_SECRET: null };
		let ours = false;
		try { const p = await owner("GET", "/owner/wake/preview"); ours = p.fingerprints?.url === fingerprint(wakeUrl(host, C.get("A2A_TUNNEL_PATH") || "/")); }
		catch { /* Worker unreachable: leave the URL */ }
		if (ours) patch.WAKE_WEBHOOK_URL = null;
		await putSecrets(dir, worker, patch);
	});
	// 2. DNS before Access, so the hostname never resolves without its Access app
	await attempt("DNS record", "A2A_TUNNEL_DNS_ID", () => cfCall(dir, ["dns", "records", "delete", C.get("A2A_TUNNEL_DNS_ID"), "-z", C.get("A2A_TUNNEL_ZONE_ID"), "--force"], { allowNotFound: true }));
	await attempt("tunnel", "A2A_TUNNEL_ID", () => {
		cfCall(dir, ["tunnels", "connections", "cleanup", C.get("A2A_TUNNEL_ID")], { allowNotFound: true });
		cfCall(dir, ["tunnels", "delete", C.get("A2A_TUNNEL_ID"), "--force"], { allowNotFound: true });
	});
	await attempt("Access application (and its policy)", "A2A_TUNNEL_ACCESS_APP_ID", () => cfCall(dir, ["zero-trust", "access", "applications", "delete", C.get("A2A_TUNNEL_ACCESS_APP_ID"), "--force"], { allowNotFound: true }));
	await attempt("Access service token", "A2A_TUNNEL_ACCESS_TOKEN_ID", () => {
		cfCall(dir, ["zero-trust", "access", "service-tokens", "delete", C.get("A2A_TUNNEL_ACCESS_TOKEN_ID"), "--force"], { allowNotFound: true });
		C.saveConfig({ A2A_TUNNEL_ACCESS_CLIENT_ID: null, A2A_TUNNEL_ACCESS_CLIENT_SECRET: null });
	});
	await attempt("tunnel token file", "A2A_TUNNEL_TOKEN_FILE", () => fs.rmSync(C.get("A2A_TUNNEL_TOKEN_FILE"), { force: true }));
	if (failures.length) die(`some parts could not be removed (ids kept in ${C.CONFIG_FILE}; re-run \`tunnel rm\`):\n  ${failures.join("\n  ")}`);
	C.saveConfig(Object.fromEntries(TUNNEL_KEYS.map((k) => [k, null])));
	if (!quiet) console.error("tunnel removed. Stop cloudflared on the agent's machine (and `cloudflared service uninstall` if installed). Wakes are off until you set a new WAKE_WEBHOOK_URL (or use polling).");
}

export async function tunnel(sub, o) {
	if (sub === "create") return create(o);
	if (sub === "status") return status(o);
	if (sub === "rm") return remove(o);
	die("usage: tunnel create|status|rm");
}
