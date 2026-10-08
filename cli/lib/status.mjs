// `status`: where a setup stands and what to do next. Safe to run any time (read-only: GET requests and cf list/get
// calls only), so an agent that was interrupted can resume from the printed next step. The CLI fetches the agent card
// itself, so agents need no curl (some agent sandboxes flag *.dev URLs in shell commands).
import fs from "node:fs";
import * as C from "./config.mjs";
import { fingerprint, httpJson } from "./a2a.mjs";
import { baseUrl, owner } from "./commands.mjs";
import * as D from "./deploy.mjs";
import * as T from "./tunnel.mjs";

const CLI = "a2a-over-webhook";
/** Presets whose webhook usually listens only locally: wakes need the tunnel (or another reverse proxy). */
export const LOCAL_PRESETS = ["openclaw-wake", "openclaw-agent", "hermes"];

/** Agent card check: { ok, name, versions } or { ok: false, error }. */
export async function checkCard(base) {
	try {
		const { status, data } = await httpJson(`${base}/.well-known/agent-card.json`, { timeout: 15000 });
		if (status !== 200 || !data || typeof data !== "object" || !data.name) return { ok: false, error: `HTTP ${status}${data && !data.name ? " (no agent card)" : ""}` };
		return { ok: true, name: data.name, versions: (data.supportedInterfaces || []).map((i) => i.protocolVersion).filter(Boolean) };
	} catch (e) { return { ok: false, error: e.message }; }
}

/** One line describing how wakes reach the agent. */
export function wakeLine(s) {
	if (!s.wake) return "unknown (owner API not reachable)";
	const w = s.wake;
	if (!w.configured) return `none: no WAKE_WEBHOOK_URL on the Worker, so the agent is expected to poll the inbox (preset ${w.preset || "-"})`;
	const auth = [w.hasKey && "bearer/API key", w.hasHmacSecret && "HMAC signature", w.hasAccessServiceToken && "Access service token"].filter(Boolean);
	return `webhook (preset ${w.preset}${s.tunnel ? ", through the tunnel" : ""}); auth: ${auth.join(" + ") || "none"}; URL fingerprint ${w.urlFingerprint || "-"}`;
}

/** The single most useful next step for a status snapshot (pure; unit-tested). */
export function nextStep(s) {
	const fail = (text) => ({ ok: false, text });
	const done = (text) => ({ ok: true, text });
	if (!s.deployed) return fail(`nothing is deployed from ${s.configFile}: run \`${CLI} init ...\` (setup skill, section 2). Another bot's deployment? Set A2A_CONFIG_DIR.`);
	if (!s.baseUrl || !s.hasOwnerToken)
		return fail(`the deployment is incomplete (no ${!s.baseUrl ? "base URL" : "owner token"} saved): re-run \`${CLI} init\` with the same flags (safe: it reuses the D1 database and the owner token)`);
	if (!s.card.ok)
		return fail(`the agent card is not reachable (${s.card.error}). A new workers.dev subdomain or custom domain can take a few minutes: run \`${CLI} status\` again. Still failing? Run \`${CLI} deploy\``);
	if (!s.ownerApi.ok)
		return fail(/HTTP 401/.test(s.ownerApi.error)
			? `the owner token in ${s.configFile} does not match the Worker: run \`${CLI} init --rotate-owner-token\` from the machine that owns this deployment`
			: `the owner API failed (${s.ownerApi.error}): run \`${CLI} deploy\``);
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
	if (!s.wake.configured) {
		const poll = "the agent must check the inbox on a schedule (setup skill: polling; Hermes and OpenClaw have copy-paste commands there)";
		if (s.wake.preset && !LOCAL_PRESETS.includes(s.wake.preset) && s.wake.preset !== "generic")
			return done(`no wake webhook: export WAKE_WEBHOOK_URL and WAKE_WEBHOOK_KEY, then run \`${CLI} wake set --preset ${s.wake.preset}\`; or ${poll}`);
		const z = s.zones;
		const tunnel = !z ? `a local-only webhook can use \`${CLI} tunnel create\` (needs a zone on the account)`
			: !z.length ? "the account has no domain (zone), so the secure tunnel is not available"
			: z.length === 1 ? `for immediate wakes to a local-only webhook, run \`${CLI} tunnel create\` (it uses the account's zone ${z[0]}; no redeploy needed)`
			: `for immediate wakes to a local-only webhook, run \`${CLI} tunnel create --tunnel-zone <zone>\` with one of: ${z.join(", ")} (no redeploy needed)`;
		const pub = s.wake.preset === "generic" ? `; a public webhook: export WAKE_WEBHOOK_URL (and a key), then \`${CLI} wake set\`` : "";
		return done(`no wake webhook, so ${poll}. Optional: ${tunnel}${pub}`);
	}
	return done(`none: setup is complete. Check a real wake with \`${CLI} wake test\`; give a peer access with \`${CLI} token issue <peer>\``);
}

/** Collect the snapshot. Each probe tolerates failure; nothing is created or changed. */
export async function collect() {
	const s = {
		configFile: C.CONFIG_FILE,
		deployed: !!(C.get("A2A_D1_ID") && C.get("A2A_WORKER_NAME")),
		worker: C.get("A2A_WORKER_NAME"), d1: C.get("A2A_D1_NAME"), account: C.get("CLOUDFLARE_ACCOUNT_ID"), cfProfile: C.get("CF_PROFILE"),
		baseUrl: baseUrl(), urlKind: C.get("A2A_HOSTNAME") ? "custom domain" : "workers.dev", cron: C.get("A2A_ENABLE_CRON") === "1",
		hasOwnerToken: !!C.get("A2A_OWNER_TOKEN"),
		card: { ok: false, error: "not checked" }, ownerApi: { ok: false, error: "not checked" }, wake: null, tunnel: null, zones: null,
	};
	if (!s.deployed || !s.baseUrl) return s;
	s.card = await checkCard(s.baseUrl);
	if (s.hasOwnerToken) {
		try {
			const p = await owner("GET", "/owner/wake/preview");
			s.ownerApi = { ok: true };
			s.wake = { preset: p.preset, configured: !!p.configured, hasKey: !!p.hasKey, hasHmacSecret: !!p.hasHmacSecret,
				hasAccessServiceToken: !!p.hasAccessServiceToken, urlFingerprint: p.fingerprints?.url || null };
		} catch (e) { s.ownerApi = { ok: false, error: e.message }; }
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
	if (o.json) console.log(JSON.stringify({ ...s, nextStep: next.text, ok: next.ok }, null, 2));
	else {
		const rows = [
			["config", s.configFile],
			["deployment", s.deployed ? `Worker ${s.worker}, D1 ${s.d1 || s.worker}${s.account ? `, account ${s.account}` : ""}${s.cfProfile ? `, cf profile ${s.cfProfile}` : ""}${s.cron ? ", cron flush on" : ""}` : "none"],
			["base URL", s.baseUrl ? `${s.baseUrl} (${s.urlKind})` : "(not saved)"],
		];
		if (s.deployed && s.baseUrl) {
			rows.push(["agent card", s.card.ok ? `OK: "${s.card.name}" (A2A ${s.card.versions.join(", ") || "?"})` : `FAILED: ${s.card.error}`]);
			rows.push(["owner API", s.ownerApi.ok ? "OK" : `FAILED: ${s.ownerApi.error}`]);
			rows.push(["wake", wakeLine(s)]);
			const t = s.tunnel;
			rows.push(["tunnel", !t ? "none" : `${t.wakeUrl} -> ${t.origin || "?"}; ${!t.complete ? "INCOMPLETE" : t.tokenFileOk ? "set up" : "set up, but the connector token file is MISSING"}` +
				(t.connections != null ? `; ${t.state || "?"}, ${t.connections} connector connection(s)` : t.error ? `; state unknown (${t.error})` : "")]);
			if (s.zones) rows.push(["zones", s.zones.length ? s.zones.join(", ") : "none on this account"]);
		}
		rows.push(["next step", next.text]);
		for (const [k, v] of rows) console.log(`${(k + ":").padEnd(12)} ${v}`);
	}
	if (!next.ok) process.exitCode = 1;
}
