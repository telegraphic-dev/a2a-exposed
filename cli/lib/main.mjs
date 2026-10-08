import { parseArgs } from "node:util";
import fs from "node:fs";
import { CliError } from "./a2a.mjs";
import * as C from "./config.mjs";
import * as cmd from "./commands.mjs";
import * as dep from "./deploy.mjs";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const HELP = `a2a-over-webhook ${VERSION} - public A2A endpoint for any AI agent (Cloudflare Worker inbox + wake webhook)

Usage: a2a-over-webhook <command> [options]        (or: npx a2a-over-webhook <command>)

Setup (needs Node 22.18+ and a Cloudflare login: npx cf auth login --no-browser)
  init [--hostname <host> | --workers-dev [--workers-dev-subdomain NAME]]
       [--agent-name N] [--agent-description D] [--agent-skills JSON]
       [--provider-organization O --provider-url U] [--preset P] [--worker-name W] [--d1-name D]
       [--account-id ID] [--cli-command CMD] [--debounce S] [--max-per-hour N] [--cron] [--dir DIR]
                                deploy the Worker + D1 to your account; wake secrets are read from
                                env WAKE_WEBHOOK_URL / WAKE_WEBHOOK_KEY / WAKE_HMAC_SECRET (never argv)
                                no --hostname: serve on https://<worker>.<account subdomain>.workers.dev
                                --workers-dev-subdomain  create the account's workers.dev subdomain if missing
                                --d1-name      D1 database to create or reuse (default: worker name)
                                --cli-command  command shown in wake hints (default "npx a2a-over-webhook";
                                               e.g. "node /path/to/repo/cli/bin/a2a-over-webhook.mjs")
  deploy [same flags]           redeploy with saved settings (secrets persist)
  wake set [--preset P] [--agent-id A] [--key-header H] [--key-prefix X] [--body-template JSON]
           [--cli-command CMD] [--debounce S] [--max-per-hour N]
                                save wake settings, upload wake secrets from env, and redeploy (one step)
  wake preview                  rendered wake request (partially masked) + sha256 fingerprints of the
                                uploaded URL/key/HMAC secret; compared with local env values if exported
  wake fingerprint              fingerprints (first 12 hex of sha256) of WAKE_* in the local environment
  wake test                     send a test wake now and print the HTTP status
  wake unset                    remove wake secrets (fall back to polling)
  url                           print the public base URL
  config                        print config (secrets masked) and its location

Inbox (owner side)
  inbox [--context C] [--all] [--json]     unhandled inbound tasks (peer text is UNTRUSTED)
  show <taskId>                            full task JSON
  working <taskId>                         mark task working
  reply <taskId> (--text T | --stdin) [--state completed|input-required|rejected|failed|working]
        [--artifact] [--artifact-name N] [--force]
  history <contextId> [-n 50] [--json]     conversation log
  contexts                                 recent conversations

Inbound peer tokens (one per peer label)
  token issue <label>     print a new token once (fails if the label is active)
  token rotate <label>    replace the label's token
  token list | token revoke <label>

Outbound (agents you call)
  peers add <alias> <url> [--token-env VAR | --token-stdin]
  peers list | peers rm <alias>
  send --to <alias|url> [--text T | stdin] [--context C] [--task T] [--push] [--proto 0.3|1.0]
  poll --to <alias|url> <taskId> [--proto 0.3|1.0]
  outbound <taskId>       stored state of a task you sent (incl. pushed updates)

Presets: grok-bot | claude-code | openclaw-wake | openclaw-agent | hermes | generic
Config: ${C.CONFIG_FILE}  (override dir with A2A_CONFIG_DIR; env vars override file values)`;

const S = { type: "string" }, B = { type: "boolean" };
const deployOpts = {
	...Object.fromEntries(dep.DEPLOY_FLAGS.map((f) => [f, S])), dir: S, cron: B, "skip-install": B, "rotate-owner-token": B,
	"workers-dev": B, "workers-dev-subdomain": S,
};
const SPEC = {
	init: deployOpts, deploy: deployOpts, wake: deployOpts,
	inbox: { context: S, all: B, json: B },
	reply: { text: S, stdin: B, state: { type: "string", default: "completed" }, artifact: B, "artifact-name": { type: "string", default: "response" }, force: B },
	history: { n: { type: "string", short: "n", default: "50" }, json: B },
	token: { rotate: B },
	peers: { "token-env": S, "token-stdin": B },
	send: { to: S, text: S, context: S, task: S, push: B, proto: S },
	poll: { to: S, proto: S },
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
	const { values: o, positionals: p } = parseArgs({ args: rest, options: SPEC[name] || {}, allowPositionals: true, strict: true });
	switch (name) {
		case "init": return dep.init(o);
		case "deploy": return dep.deploy(o);
		case "wake": return dep.wake(p[0], o);
		case "url": return console.log(cmd.baseUrl() || "(not configured: run init)");
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
		case "send": return cmd.send(o);
		case "poll": return cmd.poll(need(p[0], "poll --to <peer> <taskId>"), o);
		case "outbound": return cmd.outbound(need(p[0], "outbound <taskId>"));
		default: throw new CliError(`unknown command ${name} (see --help)`);
	}
}
