// `status`: where a setup stands and what to do next. Safe to run any time (read-only: GET requests and cf list/get
// calls only), so an agent that was interrupted can resume from the printed next step. The CLI fetches the agent card
// itself, so agents need no curl (some agent sandboxes flag *.dev URLs in shell commands).
import fs from "node:fs";
import * as C from "./config.mjs";
import { cardUrlProblem, cfErrorCode, describeHttp, fingerprint, httpJson } from "./a2a.mjs";
import { baseUrl, owner } from "./commands.mjs";
import * as D from "./deploy.mjs";
import * as T from "./tunnel.mjs";

const CLI = "a2a-over-webhook";
/** Presets whose webhook usually listens only locally: wakes need the tunnel (or another reverse proxy). */
export const LOCAL_PRESETS = ["openclaw-wake", "openclaw-agent", "hermes"];

/** Agent card check: { ok, name, versions, urls, urlProblem } or { ok: false, error }. urlProblem is "" when every
 *  endpoint URL in the card is the base URL (peers send requests there). */
export async function checkCard(base) {
	try {
		const { status, data } = await httpJson(`${base}/.well-known/agent-card.json`, { timeout: 15000 });
		if (status !== 200 || !data || typeof data !== "object" || !data.name) {
			const cf = cfErrorCode(typeof data === "string" ? data : "");
			return { ok: false, error: status === 200 ? "HTTP 200 (no agent card)" : describeHttp(status, data), ...(cf ? { cfError: cf } : {}) };
		}
		return { ok: true, name: data.name, versions: (data.supportedInterfaces || []).map((i) => i.protocolVersion).filter(Boolean),
			urls: [...new Set((data.supportedInterfaces || []).map((i) => i && i.url).filter(Boolean))], urlProblem: cardUrlProblem(data, base) };
	} catch (e) { return { ok: false, error: e.message }; }
}

/** One line describing how wakes reach the agent. */
export function wakeLine(s) {
	if (!s.wake) return "unknown (owner API not reachable)";
	const w = s.wake;
	if (!w.configured) return "none: no WAKE_WEBHOOK_URL on the Worker, so the agent is expected to poll the inbox";
	const auth = [w.hasKey && "bearer/API key", w.hasHmacSecret && "HMAC signature", w.hasAccessServiceToken && "Access service token"].filter(Boolean);
	return `webhook (preset ${w.preset}${s.tunnel ? ", through the tunnel" : ""}); auth: ${auth.join(" + ") || "none"}; URL fingerprint ${w.urlFingerprint || "-"}`;
}

/** The single most useful next step for a status snapshot (pure; unit-tested). `also`: optional extra hints, printed
 *  as separate lines (so the next step stays one short instruction). */
export function nextStep(s) {
	const fail = (text) => ({ ok: false, text, also: [] });
	const done = (text, also = []) => ({ ok: true, text, also });
	if (!s.deployed) return fail(`nothing is deployed from ${s.configFile}: run \`${CLI} init ...\` (setup skill, section 2). Another bot's deployment? Set A2A_CONFIG_DIR.`);
	if (s.baseUrlEnv)
		return fail(`A2A_BASE_URL is exported as ${s.baseUrlEnv}, but ${s.configFile} has ${s.baseUrlSaved || "(none)"}: CLI commands (and push URLs sent to peers) use the exported value. Unset A2A_BASE_URL (the inbox URL is always the deployment's own)`);
	if (!s.baseUrl || !s.hasOwnerToken)
		return fail(`the deployment is incomplete (no ${!s.baseUrl ? "base URL" : "owner token"} saved): re-run \`${CLI} init\` with the same flags (safe: it reuses the D1 database and the owner token)`);
	if (!s.card.ok && s.card.cfError === 1042)
		return fail(`the Worker is still propagating (Cloudflare error 1042, normal for up to ~30 s after a first deploy): run \`${CLI} status\` again in 30 seconds. Still 1042 after a few minutes? Run \`${CLI} deploy\``);
	if (!s.card.ok)
		return fail(`the agent card is not reachable (${s.card.error}). A new workers.dev subdomain or custom domain can take a few minutes: run \`${CLI} status\` again. Still failing? Run \`${CLI} deploy\``);
	if (s.card.urlProblem)
		return fail(`the agent card does not point peers at this deployment: ${s.card.urlProblem}, so peers would send requests there. Run \`${CLI} deploy\`: the card URL comes from the deployment (custom hostname or workers.dev), never from a local webhook, Tailnet or tunnel URL; don't edit the card by hand`);
	if (!s.ownerApi.ok)
		return fail(/HTTP 401/.test(s.ownerApi.error)
			? `the owner token in ${s.configFile} does not match the Worker: run \`${CLI} init --rotate-owner-token\` from the machine that owns this deployment`
			: `the owner API failed (${s.ownerApi.error}): run \`${CLI} deploy\``);
	// proxy / expose mode: the upstream answers peers, so wakes are optional (pairing notifications only)
	const fc = s.facade;
	if (fc) {
		if (fc.mode !== "proxy")
			return fail(`${s.configFile} has A2A_UPSTREAM_URL, but the Worker is not in proxy mode (an older template or an interrupted deploy): run \`${CLI} deploy\``);
		if (fc.upstreamProblem) return fail(`the upstream URL is unusable: ${fc.upstreamProblem}. Fix it with \`${CLI} deploy --upstream <tunnel URL>\``);
		if (fc.upstreamCard !== "ok")
			return fail(`the Worker can't fetch the upstream's agent card (${fc.upstreamCard}): is the tunnel connector running on the agent's machine, and does the Access app admit the service token you exported as UPSTREAM_ACCESS_CLIENT_ID / UPSTREAM_ACCESS_CLIENT_SECRET (re-run \`${CLI} deploy\` with them exported)?`);
		if (fc.publicCardLeaks && fc.publicCardLeaks.length)
			return fail(`the public card still names a private URL (${fc.publicCardLeaks[0]}): report this as a bug; meanwhile override the field with --agent-description / --agent-skills and run \`${CLI} deploy\``);
		const also = [];
		if (!fc.hasUpstreamAccessServiceToken) also.push("no Access service token for the upstream: unless the upstream hostname is protected another way, put it behind Cloudflare Access and export UPSTREAM_ACCESS_CLIENT_ID / UPSTREAM_ACCESS_CLIENT_SECRET, then deploy");
		if (s.pairing && s.pairing.mode === "human" && !s.pairing.passwordSet)
			also.push(`peers can't connect yet: run \`${CLI} pair set-password --web\` and send your human the one-time link (or they run \`${CLI} pair set-password\` in a terminal); never set it yourself`);
		if (s.pairing && s.pairing.pending) also.push(`${s.pairing.pending} pending pairing request(s): \`${CLI} pair list\`, then tell your human (never approve on your own)`);
		return done(`none: the façade is up and forwards paired peers' A2A calls to the upstream. Peers connect with \`${CLI} connect ${s.baseUrl}\``, also);
	}
	const t = s.tunnel;
	if (t && !t.complete) return fail(`a previous \`tunnel create\` did not finish: run \`${CLI} tunnel rm\`, then \`${CLI} tunnel create\``);
	if (t && !t.tokenFileOk)
		return fail(`the tunnel's connector token file (${t.tokenFile}) is missing or empty: run \`${CLI} tunnel create\` again (it downloads the token again; nothing new is created)`);
	const agentSecret = s.wake.preset === "hermes" ? "WAKE_HMAC_SECRET" : "WAKE_WEBHOOK_KEY";
	const needsAgentSecret = LOCAL_PRESETS.includes(s.wake.preset) && !s.wake.hasKey && !s.wake.hasHmacSecret;
	if (t && !(s.wake.hasAccessServiceToken && t.workerUrlMatches))
		return fail(`the Worker does not have the tunnel's wake secrets: ${needsAgentSecret ? `export ${agentSecret} and ` : ""}run \`${CLI} tunnel create\` again (it re-uploads them; nothing new is created)`);
	if (t && t.connections === 0)
		return fail(`the tunnel has no running connector: on the agent's machine run \`cloudflared tunnel run --token-file ${t.tokenFile}\` (outbound port 7844 must be open), then \`${CLI} wake test\``);
	if (s.wake.configured && needsAgentSecret)
		return fail(`the Worker sends no webhook auth, so the ${s.wake.preset} webhook will reject wakes: export ${agentSecret} (${s.wake.preset === "hermes" ? "the route secret" : "the hooks token"}), then run \`${CLI} ${t ? "tunnel create" : "wake set"}\``);
	// not broken, but peers can't pair until the human sets the approval password
	const also = [];
	if (s.pairing && s.pairing.mode === "human" && !s.pairing.passwordSet)
		also.push(`peers can't connect yet: run \`${CLI} pair set-password --web\` and send your human the one-time link (or they run \`${CLI} pair set-password\` in a terminal); never set it yourself`);
	if (s.pairing && s.pairing.pending)
		also.push(`${s.pairing.pending} pending pairing request(s): \`${CLI} pair list\`, then tell your human (never approve on your own)`);
	const done2 = (text, extra = []) => done(text, [...extra, ...also]);
	if (!s.wake.configured) {
		const poll = "the agent must check the inbox on a schedule (setup skill: polling; Hermes and OpenClaw have copy-paste commands there)";
		if (s.wake.preset && !LOCAL_PRESETS.includes(s.wake.preset) && s.wake.preset !== "generic")
			return done2(`no wake webhook: export WAKE_WEBHOOK_URL and WAKE_WEBHOOK_KEY, then run \`${CLI} wake set --preset ${s.wake.preset}\`; or ${poll}`);
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

/** Collect the snapshot. Each probe tolerates failure; nothing is created or changed. */
export async function collect() {
	const s = {
		configFile: C.CONFIG_FILE,
		deployed: !!(C.get("A2A_D1_ID") && C.get("A2A_WORKER_NAME")),
		worker: C.get("A2A_WORKER_NAME"), d1: C.get("A2A_D1_NAME"), account: C.get("CLOUDFLARE_ACCOUNT_ID"), cfProfile: C.get("CF_PROFILE"),
		baseUrl: baseUrl(), urlKind: C.get("A2A_HOSTNAME") ? "custom domain" : "workers.dev", cron: C.get("A2A_ENABLE_CRON") === "1",
		hasOwnerToken: !!C.get("A2A_OWNER_TOKEN"), baseUrlSaved: (C.fileConfig().A2A_BASE_URL || "").replace(/\/$/, ""), baseUrlEnv: "",
		card: { ok: false, error: "not checked" }, ownerApi: { ok: false, error: "not checked" }, wake: null, tunnel: null, zones: null, pairing: null,
		upstream: C.get("A2A_UPSTREAM_URL") || null, facade: null,
	};
	const envBase = (process.env.A2A_BASE_URL || "").replace(/\/$/, "");
	if (envBase && envBase !== s.baseUrlSaved) s.baseUrlEnv = envBase;
	if (!s.deployed || !s.baseUrl) return s;
	s.card = await checkCard(s.baseUrl);
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
						setupLinkExpiresAt: pr.setupLinkExpiresAt || null, pending: (pr.pending || []).length };
			} catch { /* older Worker (no pairing yet): leave unknown */ }
			if (s.upstream) {
				try { s.facade = await owner("GET", "/owner/facade"); }
				catch (e) { s.facade = { mode: "unknown", error: e.message }; }
			}
		}
	}
	const dir = D.workerDir({});
	const haveCf = fs.existsSync(dir);
	const host = C.get("A2A_TUNNEL_HOSTNAME");
	if (host || C.get("A2A_TUNNEL_ID")) {
		const url = T.wakeUrl(host || "?", C.get("A2A_TUNNEL_PATH") || "/");
		s.tunnel = { hostname: host, wakeUrl: url, origin: C.get("A2A_TUNNEL_ORIGIN"), complete: T.tunnelComplete(), tokenFileOk: T.tokenFileOk(),
			tokenFile: C.get("A2A_TUNNEL_TOKEN_FILE") || "<config dir>/tunnel-token", workerUrlMatches: s.wake?.urlFingerprint === fingerprint(url), connections: null };
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
	return s;
}

export async function status(o) {
	const s = await collect();
	const next = nextStep(s);
	if (o.json) console.log(JSON.stringify({ ...s, nextStep: next.text, also: next.also, ok: next.ok }, null, 2));
	else {
		const rows = [
			["config", s.configFile],
			["deployment", s.deployed ? `Worker ${s.worker}, D1 ${s.d1 || s.worker}${s.account ? `, account ${s.account}` : ""}${s.cfProfile ? `, cf profile ${s.cfProfile}` : ""}${s.cron ? ", cron flush on" : ""}` : "none"],
			["base URL", s.baseUrl ? `${s.baseUrl} (${s.baseUrlEnv ? `from the exported A2A_BASE_URL; ${s.configFile} has ${s.baseUrlSaved || "none"}` : s.urlKind})` : "(not saved)"],
		];
		if (s.deployed && s.baseUrl) {
			rows.push(["agent card", !s.card.ok ? `FAILED: ${s.card.error}` : s.card.urlProblem ? `WRONG URL: "${s.card.name}", but ${s.card.urlProblem}`
				: `OK: "${s.card.name}" (A2A ${s.card.versions.join(", ") || "?"})`]);
			rows.push(["owner API", s.ownerApi.ok ? "OK" : `FAILED: ${s.ownerApi.error}`]);
			if (s.upstream) {
				const f = s.facade || {};
				rows.push(["upstream", `${s.upstream} (proxy mode)${f.mode === "proxy" ? `; card ${f.upstreamCard}${f.upstreamVersions && f.upstreamVersions.length ? ` (A2A ${f.upstreamVersions.join(", ")})` : ""}; credential ${f.hasUpstreamToken ? "set" : "none"}; Access service token ${f.hasUpstreamAccessServiceToken ? "set" : "NONE"}; public card ${f.publicCardLeaks && f.publicCardLeaks.length ? "LEAKS a private URL" : "clean"}` : f.error ? `; ${f.error}` : "; the Worker is not in proxy mode"}`]);
			}
			rows.push(["wake", wakeLine(s)]);
			const t = s.tunnel;
			rows.push(["tunnel", !t ? "none" : `${t.wakeUrl} -> ${t.origin || "?"}; ${!t.complete ? "INCOMPLETE" : t.tokenFileOk ? "set up" : "set up, but the connector token file is MISSING"}` +
				(t.connections != null ? `; ${t.state || "?"}, ${t.connections} connector connection(s)` : t.error ? `; state unknown (${t.error})` : "")]);
			if (s.zones) rows.push(["zones", s.zones.length ? s.zones.join(", ") : "none on this account"]);
			const pg = s.pairing;
			if (pg) rows.push(["pairing", pg.mode === "off" ? "off (token issue only)"
				: `${pg.mode} approval; approval password ${pg.passwordSet ? `set${pg.passwordSetAt ? ` ${pg.passwordSetAt}` : ""}${pg.passwordSetVia ? ` (via ${pg.passwordSetVia})` : ""}` : `NOT SET${pg.setupLinkExpiresAt ? ` (a setup link is open until ${pg.setupLinkExpiresAt})` : ""}`}${pg.pending ? `; ${pg.pending} pending request(s): ${CLI} pair list` : ""}`]);
		}
		rows.push(["next step", next.text]);
		for (const a of next.also || []) rows.push(["also", a]);
		for (const [k, v] of rows) console.log(`${(k + ":").padEnd(12)} ${v}`);
	}
	if (!next.ok) process.exitCode = 1;
}
