import { parseArgs } from "node:util";
import fs from "node:fs";
import { CLI, CliError } from "./a2a.mjs";
import * as C from "./config.mjs";
import * as cmd from "./commands.mjs";
import * as dep from "./deploy.mjs";
import * as tun from "./tunnel.mjs";
import * as st from "./status.mjs";
import * as pair from "./pair.mjs";
import * as upd from "./update.mjs";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const HELP = `a2a-exposed ${VERSION} - public A2A endpoint for any AI agent (Cloudflare Worker inbox + wake webhook)

Usage: npx -y a2a-exposed@latest <command> [options]
       (optional speed-up: npm i -g a2a-exposed, then a2a-exposed <command>)

Setup (needs Node 22.18+, e.g. \`mise exec node@22 -- npx -y a2a-exposed@latest ...\`, and a Cloudflare login:
npx cf auth login --no-browser; on a VPS where it fails with HTTP 403 before showing a code, export
CLOUDFLARE_API_TOKEN instead: setup skill, Troubleshooting)
  init [--hostname <host> | --workers-dev [--workers-dev-subdomain NAME]]
       [--agent-name N] [--agent-description D] [--agent-skills JSON]
       [--provider-organization O --provider-url U] [--preset P] [--worker-name W] [--d1-name D]
       [--account-id ID] [--cf-profile NAME] [--cli-command CMD] [--debounce S] [--max-per-hour N]
       [--pairing-approval human|agent|off] [--pbkdf2-iterations N] [--workers-logs on|off] [--mcp on|off] [--cron]
       [--upstream URL [--upstream-card-url URL] [--upstream-token-stdin | --no-upstream-token]] [--worker-dir DIR]
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
                                --mcp on|off   remote MCP server at <url>/mcp for Claude and other MCP clients
                                               (default on; each client needs your approval password once)
                                --upstream URL  proxy / expose mode: a public façade for an agent that already
                                               speaks A2A (JSON-RPC) on a private network. URL is its endpoint on
                                               a Cloudflare Tunnel hostname behind Access (never a Tailnet/LAN
                                               address). The card is the upstream's, rewritten to this public
                                               URL; paired peers' calls are forwarded with env UPSTREAM_TOKEN and
                                               UPSTREAM_ACCESS_CLIENT_ID / _SECRET (never argv). --upstream none
                                               switches back to the inbox
                                --upstream-card-url  the upstream's card (default <upstream origin>/.well-known/
                                               agent-card.json); must be on the --upstream origin (it is
                                               fetched with the upstream credentials)
                                               Setup reads that card: unless it declares no bearer auth, the
                                               façade needs UPSTREAM_TOKEN besides the Access token (Access only
                                               gets the Worker through the tunnel). Without it: a hidden prompt
                                               on a terminal, else exit 1 with what to do
                                --upstream-token-stdin  read UPSTREAM_TOKEN from stdin (hidden prompt on a terminal)
                                --no-upstream-token  the upstream needs no bearer token: skip that check (saved)
                                --cli-command  command shown in wake hints (default "npx -y a2a-exposed@latest";
                                               e.g. "node /path/to/repo/cli/bin/a2a-exposed.mjs")
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
                                mode (webhook / tunnel / none = polling), tunnel state, proxy mode (--upstream):
                                upstream card, Access credential and upstream bearer configured (separately), the
                                live upstream check, the last failed peer call, card-leak check; warnings for peer
                                token variables shadowing saved tokens; and the next step to run.
                                Read-only; run it after an interruption and continue from "next step". Exit 1 = broken
  upstream verify [--json]      proxy mode: check the façade's whole path, layer by layer: façade peer auth
                                (unauthenticated call -> 401), then the Worker calls the upstream with its stored
                                secrets (never sent to the CLI) using a JSON-RPC method that doesn't exist (no task
                                is created): Cloudflare Access, the agent's bearer check, the A2A app. Exit 1 unless
                                the app answered. \`status\` runs the same check
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
  export [--sql]                       JSON dump of this inbox on stdout (peer-token hashes and
                                       encrypted peer tokens are in the dump; the owner token stays
                                       a Worker secret). --sql prints the same tables as SQL

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
  pair set-oidc --issuer URL --client-id ID --subjects SUB[,SUB...] [--methods password,oidc] [--secret-stdin]
                          optional OpenID Connect approval on /device and the MCP consent page. The client
                          secret is APPROVAL_OIDC_CLIENT_SECRET in the environment, or one line on stdin with
                          --secret-stdin. It is not a flag and it is not saved in config.env. The next
                          \`npx -y a2a-exposed@latest deploy\` uploads that environment variable as a Worker
                          secret. Leave the issuer unset and approval stays the password page
  pair list [--json]      pending pairing requests (code, claimed name/card, address), the approval mode and
                          when the approval password was set
  pair approve <code>     approve (only with --pairing-approval agent, after your human said yes)
  pair deny <code>        deny (any mode; on the /device page deny needs no password)

Inbound peer tokens (one per peer label; paired agents get one too)
  token issue <label>     print a new token once (fails if the label is active); manual fallback to \`connect\`
  token rotate <label>    replace the label's token
  token list | token revoke <label>        list shows how each token was created (pairing: code + date)
                                           and MCP connectors (label mcp-*); revoke works for both;
                                           revoke of an unknown label exits 1

Outbound (agents you call)
  peers add <alias> <url> [--token-env VAR | --token-stdin]
  peers list | peers rm <alias>
  peers sync [alias...] | peers unsync <alias>
                          upload peers (URL + token, encrypted on the Worker) so the MCP connector can send to
                          them; default: all peers. Re-run after connect, token changes or an owner-token rotation
                          a token variable set in the environment overrides config.env; when a peer token
                          differs between the two, connect/send/poll/peers/status warn (values never shown)
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
	"workers-dev": B, "workers-dev-subdomain": S, "upstream-token-stdin": B, "no-upstream-token": B,
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
	export: { sql: B },
	upstream: { json: B },
	connect: { alias: S, name: S, json: B, "no-wait": B, replace: B, force: B, "card-url": S },
	pair: { json: B, web: B, ttl: S, issuer: S, "client-id": S, subjects: S, methods: S, "secret-stdin": B },
};
const STATES = ["completed", "input-required", "failed", "rejected", "working"];

function need(v, usage) {
	if (!v) throw new CliError(`usage: a2a-exposed ${usage}`);
	return v;
}

export async function main(argv) {
	const [name, ...rest] = argv;
	if (!name || name === "help" || name === "--help" || name === "-h") return console.log(HELP);
	if (name === "--version" || name === "-v") return console.log(VERSION);
	if (rest.includes("--help") || rest.includes("-h")) return console.log(HELP);
	if (name === "pair" && rest[0] === "set-oidc" && rest.some((a) => /^--(secret|client-secret)(=|$)/.test(a)))
		throw new CliError("the OpenID Connect client secret is not a flag: export APPROVAL_OIDC_CLIENT_SECRET or pass --secret-stdin (it is not saved in config.env)");
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
				if (e instanceof CliError) e.message += `\n(the inbox is deployed and works; fix the above, then run \`${CLI} tunnel create\`, or check \`${CLI} status\`)`;
				throw e;
			}
		case "tunnel": return tun.tunnel(need(p[0], "tunnel create|status|rm"), o);
		case "deploy": return dep.deploy(o);
		case "status": return st.status(o);
		case "upstream": {
			const sub = need(p[0], "upstream verify [--json]");
			if (sub === "verify" || sub === "check") return st.upstreamVerify(o);
			throw new CliError(`unknown upstream action ${sub} (verify)`);
		}
		case "wake": return dep.wake(p[0], o);
		case "url": {
			const u = cmd.baseUrl();
			if (!u) throw new CliError(`no base URL configured in ${C.CONFIG_FILE}: run \`${CLI} init\` (or pass --config-dir / A2A_CONFIG_DIR for another deployment)`);
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
		case "export": return cmd.exportInbox(o);
		case "token": return cmd.token(need(p[0], "token issue|list|revoke|rotate [label]"), p[1], o);
		case "peers": return cmd.peers(p[0] || "list", p.slice(1), o);
		case "connect": return pair.connect(need(p[0], "connect <base-or-card-url> [--alias A] [--no-wait] [--json]"), o);
		case "pair": {
			const sub = need(p[0], "pair set-password|set-oidc|list|approve <code>|deny <code>");
			if (sub === "set-password") return pair.setPassword(o);
			if (sub === "set-oidc") return pair.setOidc(o, p.slice(1));
			if (sub === "list") return pair.list(o);
			if (sub === "approve" || sub === "deny") return pair.decide(sub, need(p[1], `pair ${sub} <code>`));
			throw new CliError(`unknown pair action ${sub} (set-password|set-oidc|list|approve|deny)`);
		}
		case "send": return cmd.send(o);
		case "poll": return cmd.poll(need(p[0], "poll --to <peer> <taskId>"), o);
		case "outbound": return cmd.outbound(need(p[0], "outbound <taskId>"));
		default: throw new CliError(`unknown command ${name} (see --help)`);
	}
}
