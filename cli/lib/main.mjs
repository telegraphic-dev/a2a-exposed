import { parseArgs } from "node:util";
import fs from "node:fs";
import { CliError } from "./a2a.mjs";
import * as C from "./config.mjs";
import * as cmd from "./commands.mjs";
import * as dep from "./deploy.mjs";
import * as tun from "./tunnel.mjs";
import * as st from "./status.mjs";
import * as pair from "./pair.mjs";
import * as upd from "./update.mjs";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const HELP = `a2a-over-webhook ${VERSION} - public A2A endpoint for any AI agent (Cloudflare Worker inbox + wake webhook)

Usage: a2a-over-webhook <command> [options]        (or: npx a2a-over-webhook <command>)

Setup (needs Node 22.18+, e.g. \`mise exec node@22 -- npx a2a-over-webhook ...\`, and a Cloudflare login:
npx cf auth login --no-browser)
  init [--hostname <host> | --workers-dev [--workers-dev-subdomain NAME]]
       [--agent-name N] [--agent-description D] [--agent-skills JSON]
       [--provider-organization O --provider-url U] [--preset P] [--worker-name W] [--d1-name D]
       [--account-id ID] [--cf-profile NAME] [--cli-command CMD] [--debounce S] [--max-per-hour N]
       [--pairing-approval human|agent|off] [--pbkdf2-iterations N] [--workers-logs on|off] [--cron]
       [--upstream URL [--upstream-card-url URL]] [--worker-dir DIR]
                                deploy the Worker + D1 to your account; wake secrets are read from
                                env WAKE_WEBHOOK_URL / WAKE_WEBHOOK_KEY / WAKE_HMAC_SECRET (never argv)
                                no --hostname: serve on https://<worker>.<account subdomain>.workers.dev
                                --workers-dev  move an existing custom-domain deployment to workers.dev (and
                                               --hostname H moves it back); the old URL answers 301/410
                                --workers-dev-subdomain  create the account's workers.dev subdomain if missing
                                --cf-profile   cf auth profile for a separate Cloudflare login
                                               (npx cf auth create NAME --no-browser); saved, used by every cf call
                                --d1-name      D1 database to create or reuse (default: worker name)
                                --pairing-approval  who approves device-flow pairing requests (default human:
                                               approval password on the /device page; agent: also \`pair approve\`;
                                               off: no pairing endpoints, \`token issue\` only)
                                --pbkdf2-iterations  approval-password hashing cost, 50000-100000 (default 100000,
                                               the Workers maximum; lower only if /device hits error 1102)
                                --workers-logs on|off  persisted Cloudflare Workers Logs (query strings redacted)
                                --upstream URL  proxy / expose mode: a public façade for an agent that already
                                               speaks A2A (JSON-RPC) on a private network. URL is its endpoint on
                                               a Cloudflare Tunnel hostname behind Access (never a Tailnet/LAN
                                               address). The card is the upstream's, rewritten to this public
                                               URL; paired peers' calls are forwarded with env UPSTREAM_TOKEN and
                                               UPSTREAM_ACCESS_CLIENT_ID / _SECRET (never argv). --upstream none
                                               switches back to the inbox
                                --upstream-card-url  the upstream's card (default <upstream origin>/.well-known/
                                               agent-card.json)
                                --cli-command  command shown in wake hints (default "npx a2a-over-webhook";
                                               e.g. "node /path/to/repo/cli/bin/a2a-over-webhook.mjs")
                                --worker-dir   where the Worker project (template copy) lives (default
                                               <config dir>/worker; --dir is the old name). Not the config dir:
                                               that is --config-dir / A2A_CONFIG_DIR
  deploy [same flags]           redeploy with saved settings (secrets persist)
  wake set [--preset P] [--agent-id A] [--key-header H] [--key-prefix X] [--body-template JSON]
           [--cli-command CMD] [--debounce S] [--max-per-hour N]
                                save wake settings, upload wake secrets from env, and redeploy (one step)
  wake preview                  rendered wake request (partially masked) + sha256 fingerprints of the
                                uploaded URL/key/HMAC secret; compared with local env values if exported
  wake fingerprint              fingerprints (first 12 hex of sha256) of WAKE_* in the local environment
  wake test                     send a test wake now and print the HTTP status
  wake unset                    remove wake secrets (fall back to polling)

Tunnel (local-only webhooks: OpenClaw gateway, Hermes, ...; needs Zero Trust/Access and a Cloudflare zone
anywhere on the account: the inbox itself can be on workers.dev or a custom hostname)
  tunnel create [--tunnel-zone Z | --tunnel-hostname H] [--tunnel-origin URL] [--tunnel-path /p] [--show-token]
                [--zero-trust-org TEAM]
                                named Cloudflare Tunnel + proxied DNS + Access app that admits ONE service token;
                                the Worker sends that token (CF-Access-Client-Id/Secret) on every wake.
                                Wake hostname: wake-<random>.<zone>, on the inbox hostname's zone, else the account's
                                only zone; with several zones pass --tunnel-zone. Safe to re-run (no duplicates).
                                Defaults: openclaw-* -> http://127.0.0.1:18789 /hooks/wake|agent, hermes -> :8644
                                (pass --tunnel-path /webhooks/<name>). Token -> <config dir>/tunnel-token (chmod 600)
  tunnel status                 tunnel/Access/Worker state + probes (bare request blocked? connector up?)
  tunnel rm                     delete Worker wake secrets, DNS record, tunnel, Access app + service token
  init ... --tunnel             init, then tunnel create (also with --workers-dev)

Status
  status [--json]               deployment, base URL, agent card check (fetched by the CLI: no curl needed), wake
                                mode (webhook / tunnel / none = polling), tunnel state, proxy-mode upstream and
                                card-leak check (--upstream), and the next step to run.
                                Read-only; run it after an interruption and continue from "next step". Exit 1 = broken
  url                           print the public base URL (exit 1 if none is configured)
  config                        print config (secrets masked) and its location

Inbox (owner side)
  inbox [--context C] [--all] [--json]     unhandled inbound tasks (peer text is UNTRUSTED), then pending pairing
                                           requests (tell your human; --json: tasks on stdout, requests on stderr)
  show <taskId>                            full task JSON
  working <taskId>                         mark task working
  reply <taskId> (--text T | --stdin) [--state completed|input-required|rejected|failed|working]
        [--artifact] [--artifact-name N] [--force]
  history <contextId> [-n 50] [--json]     conversation log
  contexts                                 recent conversations

Pairing (OAuth 2.0 device flow, RFC 8628: agents connect without pasting tokens into chat)
  connect <base-or-card-url> [--alias A] [--name N] [--card-url URL] [--replace] [--no-wait] [--json]
                          ask another inbox for a token: prints a code + link for your human (who confirms the
                          code with that inbox's owner), waits for approval, stores the token as outbound peer A
                          (never printed). --no-wait: print the code and exit; run the same command again to
                          check (same code). An expired code exits 1 (nothing new is requested silently).
                          An alias whose token still works is refused unless --replace (alias --force): the
                          peer then swaps the old token for the new one under the same label (older peers
                          keep the old token until their owner revokes it). --card-url: the card to name in
                          the request (default: this deployment's); a *.ts.net / LAN card is sent as
                          informational (flagged "not publicly reachable"), a non-https one is left out
  pair set-password --web [--ttl MIN] [--json]
                          one-time link (default 15 min, single use) where your human sets or changes the
                          approval password on a web page. Send it to them privately; never open or fill it
                          yourself. A new link invalidates the previous one
  pair set-password       the same in a terminal, no echo (the human runs it; never via argv/stdin)
  pair list [--json]      pending pairing requests (code, claimed name/card, address), the approval mode and
                          when the approval password was set
  pair approve <code>     approve (only with --pairing-approval agent, after your human said yes)
  pair deny <code>        deny (any mode; on the /device page deny needs no password)

Inbound peer tokens (one per peer label; paired agents get one too)
  token issue <label>     print a new token once (fails if the label is active); manual fallback to \`connect\`
  token rotate <label>    replace the label's token
  token list | token revoke <label>        list shows how each token was created (pairing: code + date);
                                           revoke of an unknown label exits 1

Outbound (agents you call)
  peers add <alias> <url> [--token-env VAR | --token-stdin]
  peers list | peers rm <alias>
                          a token variable set in the environment overrides config.env; when a peer token
                          differs between the two, connect/send/poll/peers warn on stderr (values never shown)
  send --to <alias|url> [--text T | stdin] [--context C] [--task T] [--push] [--proto 0.3|1.0]
  poll --to <alias|url> <taskId> [--proto 0.3|1.0]
  outbound <taskId>       stored state of a task you sent (incl. pushed updates)

Presets: grok-bot | claude-code | openclaw-wake | openclaw-agent | hermes | generic
Config: ${C.CONFIG_FILE}  (override dir with --config-dir DIR or A2A_CONFIG_DIR; env vars override file values)
Update notice: at most a daily background check of the npm registry; off with A2A_NO_UPDATE_CHECK=1 (or DO_NOT_TRACK=1)`;

const S = { type: "string" }, B = { type: "boolean" };
const tunnelOpts = { "tunnel-hostname": S, "tunnel-zone": S, "tunnel-origin": S, "tunnel-path": S, "show-token": B, "zero-trust-org": S, dir: S, "worker-dir": S };
const deployOpts = {
	...Object.fromEntries(dep.DEPLOY_FLAGS.map((f) => [f, S])), dir: S, "worker-dir": S, cron: B, "skip-install": B, "rotate-owner-token": B,
	"workers-dev": B, "workers-dev-subdomain": S,
};
const SPEC = {
	init: { ...deployOpts, ...tunnelOpts, tunnel: B }, deploy: deployOpts, wake: deployOpts, tunnel: tunnelOpts,
	inbox: { context: S, all: B, json: B },
	reply: { text: S, stdin: B, state: { type: "string", default: "completed" }, artifact: B, "artifact-name": { type: "string", default: "response" }, force: B },
	history: { n: { type: "string", short: "n", default: "50" }, json: B },
	token: { rotate: B },
	peers: { "token-env": S, "token-stdin": B },
	send: { to: S, text: S, context: S, task: S, push: B, proto: S },
	poll: { to: S, proto: S },
	status: { json: B },
	connect: { alias: S, name: S, json: B, "no-wait": B, replace: B, force: B, "card-url": S },
	pair: { json: B, web: B, ttl: S },
};
const STATES = ["completed", "input-required", "failed", "rejected", "working"];

function need(v, usage) {
	if (!v) throw new CliError(`usage: a2a-over-webhook ${usage}`);
	return v;
}

export async function main(argv) {
	const [name, ...rest] = argv;
	if (!name || name === "help" || name === "--help" || name === "-h") return console.log(HELP);
	if (name === "--version" || name === "-v") return console.log(VERSION);
	if (rest.includes("--help") || rest.includes("-h")) return console.log(HELP);
	if (name === "pair" && rest[0] === "set-password") {
		// only --web [--ttl M] [--json]: the password itself never comes from argv, stdin or the environment
		const extra = rest.slice(1);
		const ok = extra.includes("--web") && extra.every((a, i) => ["--web", "--json", "--ttl"].includes(a) || /^--ttl=\d+$/.test(a) || (extra[i - 1] === "--ttl" && /^\d+$/.test(a)));
		if (extra.length && !ok)
			throw new CliError("`pair set-password` takes no password argument: it reads the password from the terminal, without echo (never from argv, stdin or the environment). For a one-time web link instead: `pair set-password --web [--ttl MIN] [--json]`");
	}
	upd.check(VERSION);
	const { values: o, positionals: p } = parseArgs({ args: rest, options: SPEC[name] || {}, allowPositionals: true, strict: true });
	if (o["worker-dir"] !== undefined) o.dir = o["worker-dir"];
	switch (name) {
		case "init":
			if (o.tunnel) tun.preflight(o); // refuse early (hosted preset, missing --tunnel-path) before anything is deployed
			await dep.init(o);
			if (!o.tunnel) return;
			try { return await tun.create(o); } catch (e) {
				if (e instanceof CliError) e.message += "\n(the inbox is deployed and works; fix the above, then run `a2a-over-webhook tunnel create`, or check `a2a-over-webhook status`)";
				throw e;
			}
		case "tunnel": return tun.tunnel(need(p[0], "tunnel create|status|rm"), o);
		case "deploy": return dep.deploy(o);
		case "status": return st.status(o);
		case "wake": return dep.wake(p[0], o);
		case "url": {
			const u = cmd.baseUrl();
			if (!u) throw new CliError(`no base URL configured in ${C.CONFIG_FILE}: run \`a2a-over-webhook init\` (or pass --config-dir / A2A_CONFIG_DIR for another deployment)`);
			return console.log(u);
		}
		case "config": {
			const f = C.fileConfig();
			console.log(`# ${C.CONFIG_FILE}`);
			for (const [k, v] of Object.entries(f)) console.log(`${k}=${/TOKEN|KEY|SECRET/.test(k) ? "(set)" : v}`);
			return;
		}
		case "inbox": return cmd.inbox(o);
		case "show": return cmd.show(need(p[0], "show <taskId>"));
		case "working": return cmd.working(need(p[0], "working <taskId>"));
		case "reply":
			if (!STATES.includes(o.state)) throw new CliError(`--state must be one of ${STATES.join(", ")}`);
			return cmd.reply(need(p[0], "reply <taskId> --text ..."), o);
		case "history": return cmd.history(need(p[0], "history <contextId>"), o);
		case "contexts": return cmd.contexts();
		case "token": return cmd.token(need(p[0], "token issue|list|revoke|rotate [label]"), p[1], o);
		case "peers": return cmd.peers(p[0] || "list", p.slice(1), o);
		case "connect": return pair.connect(need(p[0], "connect <base-or-card-url> [--alias A] [--no-wait] [--json]"), o);
		case "pair": {
			const sub = need(p[0], "pair set-password|list|approve <code>|deny <code>");
			if (sub === "set-password") return pair.setPassword(o);
			if (sub === "list") return pair.list(o);
			if (sub === "approve" || sub === "deny") return pair.decide(sub, need(p[1], `pair ${sub} <code>`));
			throw new CliError(`unknown pair action ${sub} (set-password|list|approve|deny)`);
		}
		case "send": return cmd.send(o);
		case "poll": return cmd.poll(need(p[0], "poll --to <peer> <taskId>"), o);
		case "outbound": return cmd.outbound(need(p[0], "outbound <taskId>"));
		default: throw new CliError(`unknown command ${name} (see --help)`);
	}
}
