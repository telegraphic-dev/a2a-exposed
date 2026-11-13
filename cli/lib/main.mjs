import { parseArgs } from "node:util";
import fs from "node:fs";
import { CLI, CliError } from "./a2a.mjs";
import * as C from "./config.mjs";
import * as cmd from "./commands.mjs";
import * as dep from "./deploy.mjs";
import * as tun from "./tunnel.mjs";
import * as st from "./status.mjs";
import * as pair from "./pair.mjs";
import * as address from "./address.mjs";
import * as account from "./account.mjs";
import * as hosted from "./hosted.mjs";
import * as upd from "./update.mjs";
import * as fb from "./feedback.mjs";
import * as un from "./uninstall.mjs";
import { relay } from "./relay.mjs";
import { relayHttp } from "./http-relay.mjs";
import { finishLink, createLink, linkOutput, linkUsage } from "./link-finish.mjs";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const HELP = `a2a-exposed ${VERSION} - public A2A endpoint for any AI agent (Cloudflare Worker + wake webhook)

Usage: npx -y a2a-exposed@latest <command> [options]
       (optional speed-up: npm i -g a2a-exposed, then a2a-exposed <command>)
       --version, -v                 print the version
       --help, -h                    print this help

Setup options: --skip-install skips dependency installation when dependencies already exist.
Local option and missing-deployment errors appear before Node version guidance; deployment still requires Node 22.18+.

Local encrypted CLI draft (disabled by default):
  keys stores --json          list optional local key stores before init
  keys init --store file|keychain --card-url URL --json
                                fresh local keys; keychain requires --allow-os-consent
                                turns off ordinary send in this config directory
  keys status --json          list local key IDs and public bundles; no private keys
  keys publish --id ID --json publish only the selected public bundle to this inbox
  connect URL --sealed-key-id ID --alias ALIAS --no-wait --json
                                existing human pairing approval binds the exact public bundles
  keys pairings --json        list active approved inbound pairings before pinning
  keys pin --id ID --peer LABEL --user-code CODE --json
                                import that exact approval as trust on first use (TOFU)
  keys code --id ID --peer ALIAS_OR_LABEL --json
                                ALIAS on connecting side; LABEL from keys pairings on approving side
                                compare safety code through another trusted channel
  peers list --json           list aliases and whether their keys are pinned
  send --to ALIAS --text TEXT [--allow-os-consent]
                                seal for the pinned peer; no plaintext fallback
                                max 200000 Unicode characters / 307072 encoded content bytes; checked before key access
                                encrypted sends refuse --push, --wake and --intent
  inbox --json / history CONTEXT --json
                                open locally; --allow-os-consent permits keychain access
  If codes differ: do not use the pairing; ask approving owner to token revoke LABEL
  (select LABEL with keys pairings --json), and tell the other owner.
  Install matching optional @a2a-exposed/encryption in the config directory first.
  A2A_SEALED_ENABLED=1 is reserved for approved local tests until enablement approval.

Hosted setup:
  hosted capabilities --json   list setup scopes, wake presets and service capabilities
                                unsupported/404: check --control-url; use dashboard or hosted MCP with human confirmation
  login --machine NAME --scopes SCOPES [--control-url URL] --json
                                approve the explicit scopes using the printed website link once;
                                save the scoped grant locally (mode 600), never print it
  hosted names --name NAME --json
                                check one name anonymously before device approval; never lists other agents
  hosted capacity --json      read account room with agents:read (or agents:create); reserves nothing
  hosted list --json           list hosted agents with agents:read or agents:create before choosing an agent
  hosted upstream preview|set|clear|verify --agent NAME --json
                                list scopes with hosted capabilities and agents with hosted list first
                                preview returns version; set/clear/verify require --version N
                                set takes --url URL and --upstream-token-file FILE|--upstream-token-env VAR,
                                --access-client-id-file FILE|--access-client-id-env VAR and
                                --access-client-secret-file FILE|--access-client-secret-env VAR
                                files require mode 600; defaults UPSTREAM_TOKEN/UPSTREAM_ACCESS_CLIENT_ID/
                                UPSTREAM_ACCESS_CLIENT_SECRET; never pass secret values as arguments
  hosted create --name NAME --json
                                create and save the owner credential in this config directory;
                                use a separate --config-dir for each agent
                                manual fallback: human creates the address in a signed-in dashboard session,
                                then saves A2A_BASE_URL + A2A_OWNER_TOKEN in protected config or routine secrets
  wake preview|test|set --agent NAME [--url URL] [--preset P] --json
                                hosted settings: read, test a draft, or test then save it
                                cloudflare-target-unsupported: when verified_import is advertised and recovery_url
                                is returned, ask the human to open Import or manage your existing tunnel,
                                authorize the exact existing route and Access pair, then test and save again
                                no automatic import or retry; without recovery use supported HTTPS, polling,
                                or an explicitly authorized self-hosted Worker; keep Access and hook auth enabled
                                secrets: --key-file|--key-env|--key-stdin; --hmac-secret-file|--hmac-secret-env
                                hosted capabilities --json lists route support; the human uses dashboard
                                Import your existing tunnel or Create secure link to authorize Access
  wake prepare --agent NAME --url URL --preset P --reference-file FILE --json
                                when the service lists secret_reference, upload the draft and save a
                                ten-minute single-use reference in a new protected file; never print it
  wake set --agent NAME --reference-file FILE --json
                                test and save exactly that reference's draft; --reference-env VAR also works
                                MCP set_wake accepts secretReference on services listing that capability
  Hosted reference capacity failures report too_many_references and a retry wait; never auto-retry.
  wake remove --agent NAME --version N --json
                                read wake preview --json first; remove only the version explicitly selected
                                wake unset is an alias; credentials remain in protected storage
  wake prepare --agent NAME --clear --version N --reference-file FILE --json
                                prepare a removal reference for MCP set_wake clear: true, secretReference;
                                without that reference MCP keeps browser confirmation
  Listings and previews show result fields; --json provides structured output.

Local MCP (stdio; local encryption remains disabled by default)
  mcp [--allow-os-consent]      newline-delimited JSON-RPC on stdin/stdout; no listening port
                                tools: list_peers, send, inbox, history; use list_peers before send
                                uses --config-dir DIR; credentials/keys stay local
                                sends only to pinned peers through the encrypted CLI path
                                A2A_SEALED_ENABLED=1 is for approved local fixtures only
                                inbox acknowledges wakes; use all:true or history to revisit rows
                                repeated cursor: narrow contextId/from or use history
                                keychain access needs this startup flag and a human OS prompt
                                no pairing, trust changes, plaintext sends or automatic retries

Setup (needs Node 22.18+, e.g. \`mise exec node@22 -- npx -y a2a-exposed@latest ...\`, and a Cloudflare login:
npx cf auth login --no-browser; on a VPS where it fails with HTTP 403 before showing a code, export
CLOUDFLARE_API_TOKEN instead: setup skill, Troubleshooting. a2a.exposed hosts the A2A endpoint and is open to everyone
(https://a2a.exposed/pricing). When to use it:
https://github.com/telegraphic-dev/a2a-exposed/blob/main/docs/getting-started.md#hosted-inbox)
  env [--json]                 print export A2A_CONFIG_DIR=<absolute dir> (no credentials; read-only).
                                Pin scheduled jobs: mise exec node@22 -- npx -y a2a-exposed@latest
                                --config-dir DIR inbox; use an absolute mise path outside your shell.
  init [--hostname <host> | --workers-dev [--workers-dev-subdomain NAME]]
       [--agent-name N] [--agent-description D] [--agent-skills JSON]
       [--provider-organization O --provider-url U] [--preset P] [--worker-name W] [--d1-name D]
       [--account-id ID] [--cf-profile NAME] [--cli-command CMD] [--debounce S] [--busy S] [--max-per-hour N]
       [--wake-routing shadow|enforce]
       [--pairing-approval human|agent|off] [--pbkdf2-iterations N] [--workers-logs on|off] [--mcp on|off] [--cron]
       [--manage-url URL] [--event-url URL] [--event-secret-stdin]
       [--dry-run [--json]] [--rotate-owner-token]
       [--upstream URL [--upstream-card-url URL] [--upstream-token-stdin | --no-upstream-token]] [--worker-dir DIR]
                                deploy the Worker + D1 to your account; wake secrets are read from
                                env WAKE_WEBHOOK_URL / WAKE_WEBHOOK_KEY / WAKE_HMAC_SECRET (never argv)
                                no --hostname: serve on https://<worker>.<account subdomain>.workers.dev
                                --workers-dev  move an existing custom-domain deployment to workers.dev (and
                                               --hostname H moves it back); the old URL answers 301/410
                                --workers-dev-subdomain  create the account's workers.dev subdomain if missing
                                               Uses system script on macOS/Linux, including under automation.
                                --dry-run      offline plan only: no writes, network, stdin reads, or deployment.
                                               --json prints structured config/actions; secret names only.
                                               Account/resource readiness is checked only during real init.
                                --cf-profile   cf auth profile for a separate Cloudflare login
                                               (npx cf auth create NAME --no-browser); saved, used by every cf call.
                                               When whoami lists no accounts, init reads cf accounts list
                                               outside the Worker directory. A failed list prints cf's error unless --account-id is set
                                --d1-name      D1 database to create or reuse (default: worker name)
                                --pairing-approval  who approves device-flow pairing requests (default human:
                                               the owner token via \`pair approve\`, or the approval password
                                               on the /device page; agent: the agent runs \`pair approve\` after
                                               the human says yes; off: no pairing endpoints, \`token issue\` only)
                                init reports readiness when password approval is enabled; when missing, use
                                               \`pair set-password --web\` for the human-owned setup page.
                                --pbkdf2-iterations  approval-password hashing cost, 50000-100000 (default 100000,
                                               the Workers maximum; lower only if /device hits error 1102)
                                --workers-logs on|off  persisted Cloudflare Workers Logs (query strings redacted)
                                --mcp on|off   remote MCP server at <url>/mcp for Claude and other MCP clients
                                               (default on; each client needs your approval password once).
                                               Plugin manifests leave MCP unset: the URL differs per deploy.
                                               When GET /owner/mcp reports enabled and the agent card is reachable,
                                               \`status\` prints \`claude mcp add --transport http a2a-exposed <url>/mcp\`
                                --manage-url   https URL of this agent's dashboard page (MANAGE_URL). A pairing
                                               wake, the MCP inbox line, \`pair list\`, and \`inbox\` include it
                                               when it is set. \`none\` clears it. No user name or password in the URL
                                --event-url    https URL that receives a signed pairing event when a request is
                                               created, approved, or denied (EVENT_URL). \`none\` clears it.
                                               The post also needs EVENT_SECRET
                                --event-secret-stdin
                                               read EVENT_SECRET from stdin (hidden prompt on a terminal).
                                               Uploaded on this deploy. Not an argument, not printed, and not
                                               saved in config.env. Or export EVENT_SECRET
                                --rotate-owner-token  on init, replace the owner token; other settings come from config.env.
                                               Then update A2A_OWNER_TOKEN wherever this A2A endpoint is called, and run \`peers sync\`
                                --upstream URL  proxy / expose mode: a public façade for an agent that already
                                               speaks A2A (JSON-RPC) on a private network. URL is its endpoint on
                                               a Cloudflare Tunnel hostname behind Access (never a Tailnet/LAN
                                               address). The card is the upstream's, rewritten to this public
                                               URL; paired peers' calls are forwarded with env UPSTREAM_TOKEN and
                                               UPSTREAM_ACCESS_CLIENT_ID / _SECRET (never argv). --upstream none
                                               switches back to the A2A endpoint
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
                                               e.g. "node /path/to/repo/cli/bin/a2a-exposed.mjs"). Non-default config dirs
                                               are included in default hints; init saves the Node path and prints
                                               a pinned command if PATH selects another Node.
                                --worker-dir   where the Worker project (template copy) lives (default
                                               <config dir>/worker). The config dir is --config-dir / A2A_CONFIG_DIR
  deploy [same flags]           redeploy with saved settings (secrets persist); tag the Worker version as a2a-exposed-<version>
  wake set [--preset P] [--agent-id A] [--key-header H] [--key-prefix X] [--body-template JSON]
           [--cli-command CMD] [--debounce S] [--busy S] [--max-per-hour N] [--wake-routing shadow|enforce]
                                self-hosted: save wake settings, upload wake secrets from env, and redeploy
                                hosted config: use the saved address and owner token to test then save; no deploy
                                hosted CLI: list hosted capabilities --json for presets; scoped setup selects --agent from hosted list --json
                                use the same --config-dir DIR for login and hosted create (requires agents:create agents:owner-token).
                                hosted wake prepare/test/set and relay wake test read secrets only with explicit
                                --key-file|--key-env|--key-stdin or --hmac-secret-file|--hmac-secret-env.
                                Hosted Access keys use dashboard Import your existing tunnel or Create secure link.
                                Ambient WAKE_* credentials are ignored; --key-env WAKE_WEBHOOK_KEY opts in.
                                mausbot: HTTPS /hooks/<endpointId> + WAKE_WEBHOOK_KEY Bearer auth from protected env
                                openbot: human supplies WAKE_HMAC_SECRET via protected env/secret storage, never chat or argv
                                the Worker refuses unsigned openbot wakes (a webhook key is not a signing secret)
                                --busy S        seconds a conversation stays busy after a sent wake.
                                               0 disables it. Unset uses the preset default:
                                               300 for claude-code, 180 for the others
                                --max-per-hour  hourly cap; 0 or unset is unlimited, except Claude Code,
                                               which defaults to 25 when this is unset
                                --wake-routing shadow (default) or enforce. shadow counts the wakes auto
                                               would skip and still wakes. enforce stores an ack and an idle
                                               or unchanged status without a wake, and batches a changed status.
                                               Set shadow again to roll enforce back
  wake status [--json]          read pending/retrying wakes and last HTTP acceptance; does not clear them
  wake preview                  rendered wake request (a credential is Bearer •••• or ••••, none of the secret)
                                openbot includes a sample delivery ID and canonical signing-input description
                                + sha256 fingerprints of the uploaded URL/key/HMAC secret; compared with
                                local env values when WAKE_WEBHOOK_URL, WAKE_WEBHOOK_KEY, and WAKE_HMAC_SECRET
                                are exported in this shell. match: the exported value is the one on the Worker.
                                DIFFERENT: they differ (absent from this shell, or still propagating, about
                                15 to 40 seconds after wake set, wake unset, or tunnel create). Wait about
                                30 seconds and run it again
  wake fingerprint              fingerprints (first 12 hex of sha256) of WAKE_* exported in this shell
  wake test                     send a test wake now and print the HTTP status
                                mausbot: verify and enable the first sample in MausBot, then test again
  wake check [--local-url URL]   Hermes: require unsigned local 401/403, then Worker test 2xx (delivery only)
                                Defaults to the saved tunnel origin/path; --json prints both checks
  wake unset                    webhook transport: remove wake secrets (relay transport: use relay revoke)
                                handler prompts save autonomous, review-all or escalate mode and owner notices;
                                see docs/receiving-messages.md for setup and the every 6h webhook fallback

Tunnel (local-only webhooks: OpenClaw gateway, Hermes, ...; needs Zero Trust/Access and a Cloudflare zone
anywhere on the account: the A2A endpoint itself can be on workers.dev or a custom hostname)
  tunnel create [--tunnel-zone Z | --tunnel-hostname H] [--tunnel-origin URL] [--tunnel-path /p] [--show-token]
                [--zero-trust-org TEAM] [--preset hermes --hermes-route a2a-wake --hmac-secret-stdin]
                                named Cloudflare Tunnel + proxied DNS + Access app that admits ONE service token;
                                the Worker sends that token (CF-Access-Client-Id/Secret) on every wake.
                                Wake hostname: wake-<word>-<word>-<4 hex>.<zone>, on the A2A endpoint hostname's zone, else the
                                account's only zone; with several zones pass --tunnel-zone. A finished tunnel
                                creates nothing when you run it again. A partial tunnel stops and asks for tunnel rm.
                                The tunnel, the Access app, and the service token are named "a2a-exposed wake <worker>".
                                The DNS host is wake-<word>-<word>-<4 hex>.<zone> unless --tunnel-hostname is set.
                                Export WAKE_WEBHOOK_KEY (hermes/openbot: WAKE_HMAC_SECRET) so tunnel create uploads it.
                                The connector machine needs cloudflared installed
                                (https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/).
                                Defaults: openclaw-* -> http://127.0.0.1:18789 /hooks/wake|agent, hermes -> :8644
                                /webhooks/a2a-wake (override with --hermes-route NAME). Token -> <config dir>/tunnel-token (chmod 600).
                                Worker secrets show up in about 15 to 40 seconds. Wait about 30 seconds and check again
                                Creation prints resource, connector, and optional persistent-service states.
                                status reports connections and ephemeral/unknown persistence; macOS service install needs an admin terminal.
  tunnel zones [--json]         list available Cloudflare zones before selecting --tunnel-zone
  tunnel status                 tunnel/Access/Worker state + probes (bare request blocked? connector up?)
                                A network error says DNS may still be propagating; retry in 30 seconds
  tunnel rm                     delete the DNS record, the tunnel, the Access app, and the service token
                                (each printed by name), plus Worker secrets WAKE_ACCESS_CLIENT_ID,
                                WAKE_ACCESS_CLIENT_SECRET, WAKE_WEBHOOK_KEY, and WAKE_HMAC_SECRET. The wake URL
                                goes too when it is this tunnel's. Prints one line per object removed.
                                With nothing saved, prints "nothing to remove"
  init ... --tunnel             init, then tunnel create (also with --workers-dev)

Remove
  uninstall [--yes] [--dry-run] [--dir DIR | --worker-dir DIR]
                                remove the Worker, the wake tunnel (when the config has one), and the D1 database.
                                Prints the plan first (Worker, D1, account, and the wake hostname when a tunnel
                                is saved). Removal is permanent and takes the messages and paired peers with it.
                                --dry-run prints the plan and changes nothing. Asks first; off a terminal, pass --yes.
                                An empty config exits 1. The config directory stays: the owner token and WAKE_* values
                                stay, and a later init reuses the owner token. Remove that directory to delete them.
                                --dir and --worker-dir are the Worker project directory (default <config dir>/worker)

Status
  status --agent NAME [--control-url URL] [--json]
                                read selected hosted agent wake configuration; select NAME with hosted list --json.
                                Uses setup approval or that agent's matching owner credential; no delivery test.
  Hosted-only configs report deployment: hosted and hosted recovery guidance.
  Hosted status lists capability/preview next steps; saved wake settings do not prove delivery.
  Offer webhook or polling after checking hook support and hosted route compatibility.
  A listed OpenClaw preset does not prove route reachability; check delivery preflight before tunnel setup.
  status [--json]               deployment, Worker version, base URL, agent card check (fetched by the CLI), wake
                                mode (webhook / tunnel / none = no webhook), tunnel state, proxy mode (--upstream):
                                upstream card, Access credential and upstream bearer configured (separately), the
                                live upstream check, the last failed peer call, card-leak check; warnings for peer
                                token variables shadowing saved tokens; Node version/path and wake runtime mismatch; the next step.
                                Older Workers need deploy (exit 1); npm latest hints use the local update cache.
                                When GET /owner/mcp reports enabled and the agent card is reachable, prints
                                \`claude mcp add --transport http a2a-exposed <base URL>/mcp\`.
                                A failed probe, an unreachable card, or a Worker that reports MCP off leaves that line out.
                                Read-only; run it after an interruption and continue from "next step". Exit 1 = broken.
                                Prints eight layers in order, each PASS, FAIL, or SKIP, and still checks the
                                later layers after one fails: Worker DNS (system lookup, then DNS-over-HTTPS
                                when that lookup fails), Worker (TLS, the agent card, and /health), Owner API,
                                Wake DNS, Access (protected or not, and whether a service token is configured;
                                the token is never printed), Connector, Local webhook (HTTP status of the wake
                                endpoint), and Pairing. A 401 or 403 fails the local webhook layer only when the
                                response shows Cloudflare Access. The webhook's own auth refusal reports the HTTP
                                status and passes, as does a 401 or 403 with no Access marker. A failure names the
                                missing or mismatched object and a fix. --json includes layers (eight objects).
                                Exit 1 if any layer fails.
                                For about a minute after tunnel create, while the connector reports 0 connections,
                                status prints "waiting for the connector to connect" and exits 0. After that,
                                0 connections is broken. A tunnel status of inactive is "never connected".
                                Worker secrets from tunnel create, wake set, and wake unset show up in about
                                15 to 40 seconds. Wait about 30 seconds and check again
  upstream verify [--json]      proxy mode: check the façade's whole path, layer by layer: façade peer auth
                                (unauthenticated call -> 401), then the Worker calls the upstream with its stored
                                secrets (never sent to the CLI) using a JSON-RPC method that doesn't exist (no task
                                is created): Cloudflare Access, the agent's bearer check, the A2A app. Exit 1 unless
                                the app answered. \`status\` runs the same check
  url                           print the public base URL (exit 1 if none is configured)
  config                        print config (secrets masked) and its location

Wake relay (optional Worker feature, no tunnel or service install)
  relay create --token-file FILE [--config-version N]
                                enroll/rotate; writes a NEW mode-600 credential file, never prints the secret
  relay status [--json]          authenticated runtime capability and connection/enrollment status
  relay revoke                  revoke the enrollment shown by status, close its current socket
  relay run --local-url http://127.0.0.1:8644/webhooks/a2a-wake
            (--token-file FILE | --token-env VAR) [--url wss://agent.example.com/relay/connect]
                                foreground fixed-loopback connector; no JSON/stdout stream, safe diagnostics on stderr
                                exit 0 on Ctrl-C/SIGTERM; exit 1 on setup/protocol/policy failure
                                reconnect waits 500ms–30s; stop after 3 failed 10s handshakes
                                busy/uncertain tests are unconfirmed: check receiver and inbox before retesting
                                self-host deploy --wake-relay 1 --wake-transport relay enables it;
                                application bearer/HMAC credentials still apply. See docs/wake-relay.md

Hosted relay wake configuration (only on services advertising wake.relay)
  relay wake status --agent NAME [--json]
                                read config version, connector id/generation and connection status
  relay wake test --agent NAME --config-version N --connector-id default --generation N
            --preset PRESET --receipt-file NEW_FILE [--hmac-secret-file FILE | --hmac-secret-env VAR]
            [--key-file FILE | --key-env VAR | --key-stdin] [--key-header HEADER] [--json]
                                test without saving; store a five-minute single-use receipt mode 600
  relay wake save --agent NAME --config-version N --receipt-file FILE --confirm [--json]
                                save exactly the tested settings; no new delivery or secret entry
  relay wake remove --agent NAME --config-version N --confirm [--receipt-file FILE] [--json]
                                remove the saved wake; connector revocation remains relay revoke
  relay wake prepare --agent NAME --config-version N --clear --receipt-file NEW_FILE --confirm [--json]
                                prepare a five-minute MCP removal reference
  Select NAME with hosted list --json and PRESET with hosted capabilities --json.
  These commands accept --control-url ORIGIN and use approved hosted setup scopes
  wake:test,wake:write or that agent's owner credential. Read status before each change.
  MCP set_wake accepts the protected receipt as secretReference with confirmed:true,
  and clear:true for removal; never pass raw application/connector credentials to MCP.

HTTP endpoint relays (separate opt-in Worker feature; --http-relay 1 on init/deploy)
  relay http|a2a create --token-file FILE --ingress-token-file FILE [--forward-headers LIST]
                                enroll/rotate; reserves two NEW mode-600 credential files; no inline secrets
  relay http|a2a status [--json]  nonsecret enrollment and connection readiness
  relay http|a2a revoke          fence this profile and disconnect its connector
  relay http|a2a run --token-file FILE --local-url http://127.0.0.1:8644/fixed
             [--url wss://agent.example.com/relay/http/PROFILE/connect] [--card-url URL]
             [--local-headers-file FILE]
                                --url defaults from A2A_BASE_URL; CLI http maps to wire PROFILE webhook
                                fixed loopback receiver; a2a profile uses optional same-origin card URL
                                create/status/revoke always print JSON; run is silent on stdout
                                foreground only: keep running; exit 0 on Ctrl-C/SIGTERM, 1 on failure
                                retries 500ms-30s; stops after 3 failed 10s handshakes
                                ingress callers need X-A2A-Relay-Authorization: Bearer <ingress token>
                                required for discovery too: invited callers, not URL-only public access
                                --forward-headers explicitly allows original app bearer/signature headers
                                local app owns per-peer/task authorization; shared ingress is NOT peer auth
                                native A2A is separate from Worker inbox/pairing/facade. No push callbacks.

Inbox (owner side)
  inbox [--context C] [--from PEER] [--all] [--json]
                                           unhandled inbound tasks, and a reply to a message you sent until
                                           this list is read (peer text is UNTRUSTED). --from is one peer
                                           (the wake hint includes it). A reply line says to read it with
                                           history and continue with send. Then pending pairing
                                           requests (tell your human; the dashboard URL when MANAGE_URL is set;
                                           --json: rows on stdout, requests on stderr). Follows every page; past
                                           10000 pages it errors instead of a short list. Reading marks returned replies
                                           seen and clears matching pending wakes; task state is unchanged.
                                           Direct reply messages are completed without a new-work wake;
                                           read them with history or inbox --all
  show <taskId>                            full task JSON
  working <taskId>                         mark task working
  reply <taskId> (--text T | --stdin) [--state completed|input-required|rejected|failed|working]
        [--artifact] [--artifact-name N] [--force]
                                           delivery waits at most 18 s; identical retries read the first result
                                           --force changes a terminal task again; peers see every change
                                           push results show role/host/URL fingerprint; task state saved confirms storage
  history <contextId> [--from PEER] [-n 50] [--json]
                                           conversation log with forced transitions and current state per task.
                                           --from is one peer (the wake hint includes it)
  contexts                                 recent conversations
  export [--sql]                       JSON dump of this A2A endpoint on stdout (peer-token hashes and
                                       encrypted peer tokens are in the dump; the owner token stays
                                       a Worker secret). --sql prints the same tables as SQL

Pairing (OAuth 2.0 device flow, RFC 8628: agents connect without pasting tokens into chat)
  connect <base-or-card-url> [--alias A] [--name N] [--card-url URL] [--replace] [--no-wait] [--json]
                          ask another A2A endpoint for a token: prints a code + link for your human (the code lasts
                          60 minutes; they confirm the code with that A2A endpoint's owner), waits for approval, stores
                          the token as outbound peer A
                          (never printed). --no-wait: print the code and exit; run the same command again to
                          check (same code). An expired code exits 1 (nothing new is requested silently).
                          An alias whose token still works is refused unless --replace (alias --force): the
                          peer swaps the token under the same label when it accepts the replacement. When
                          it keeps the previous token active, that owner revokes it. --card-url: the card to name in
                          the request (default: this deployment's); a *.ts.net / LAN card is sent as
                          informational (flagged "not publicly reachable"), a non-https one is left out.
                          The name sent is the card named in the request (--card-url, otherwise this
                          deployment's). --name overrides it. If that card can't be read, the name is the
                          configured agent name, the worker name, or the public host's first label. The
                          other A2A endpoint labels the token from that name and adds -2, -3, … when it is taken
  pair set-password --web [--ttl MIN] [--json]
                          one-time link (default 15 min, --ttl 1 to 60, single use) where your human sets or
                          changes the approval password on a web page. Send it to them privately; never open
                          or fill it yourself. A new link invalidates the previous one
  pair set-password       the same in a terminal, no echo (the human runs it; never via argv/stdin)
  pair set-oidc --issuer URL --client-id ID --subjects SUB[,SUB...] [--methods password,oidc] [--secret-stdin]
                          optional OpenID Connect approval on /device and the MCP consent page. The client
                          secret deploy uploads is APPROVAL_OIDC_CLIENT_SECRET in the environment you use for
                          deploy. --secret-stdin checks one line and discards it, so export the variable
                          before deploy. config.env keeps the issuer and client id.
                          Leave the issuer unset and approval stays the password page
  pair list [--json]      pending pairing requests (code, claimed name/card, address), the approval mode,
                          when the approval password was set, and the dashboard URL (manageUrl) when
                          MANAGE_URL is set. JSON adds expiresIn (local remaining seconds, rounded up, minimum zero;
                          null if expiry is unknown)
  pair approve <code> [--json]  approve with the owner token (human mode records the owner; in agent
                          mode, run it only after your human said yes)
  pair deny <code> [--json]     deny (any mode; on the /device page deny needs no password)

Inbound peer tokens (one per peer label; paired agents get one too)
  token issue <label>     print a new token once (fails if the label is active); manual fallback to \`connect\`
  token rotate <label>    replace the label's token
  token list [--json] | token revoke <label>        list shows how each token was created (pairing: code + date)
                                           and MCP connectors (label mcp-*); revoke works for both;
                                           revoke of an unknown label exits 1

Outbound (agents you call)
  peers add <alias> <url> [--token-env VAR | --token-stdin]
  peers list [--json] | peers rm <alias>
  peers sync [alias...] | peers unsync <alias>
                          upload peers (URL + token, encrypted on the Worker) so the MCP connector can send to
                          them; default: all peers. Re-run after connect, token changes or an owner-token rotation
  peer announce (--to <alias> | --all) [--reissue] [--json]
                          tell paired peers this inbox's current card URL. They switch only after the card
                          proves the same pairing identity. A peer that does not support this keeps the
                          current pairing. A revoked return token stays revoked unless --to and --reissue.
                          The return token is not printed
  peer forward --to <card-url> [--hours N] | peer forward --off
                          on the old inbox, forward direct replies and answer with a moved pointer for N hours
                          (default 168, max 720)
                          a token variable set in the environment overrides config.env; when a peer token
                          differs between the two, connect/send/poll/peers/status warn (values never shown)
  send --to <alias|url> [--text T | stdin] [--context C] [--task T] [--push]
                          [--wake auto|always|never] [--intent handoff|blocker|question|status|ack]
                          [--proto 0.3|1.0]
                          Set intent on every send. auto wakes a handoff, blocker, or question.
                          An ack, and an idle or unchanged status, stay stored. A changed status
                          is batched. always asks for an immediate wake, still subject to the
                          peer's authorization and rate limits. never only stores the message.
                          Omit both for a legacy sender: the peer wakes as before. Do not send
                          an acknowledgement-only message, and do not answer an ack with an ack.
  poll --to <alias|url> <taskId> [--proto 0.3|1.0]
                          send/poll need only peer config; owner history/task storage is optional.
                          Storage failures warn on stderr; the peer response still prints and exits 0
                          Self-hosted MCP: poll_outbound fetches current state; cancel_outbound asks the peer
                          to cancel a sent task. Ask the human before canceling consequential work
  outbound <taskId>       stored state of a task you sent (incl. pushed updates)

Owner
  One A2A endpoint. The owner token from init authenticates inbox, reply, export, and the other owner
  commands. Owner HTTP 401 responses advertise WWW-Authenticate: Bearer realm="owner"; check the
  configured owner credential. Peer and MCP tokens cannot authorize owner calls.
  GET / in a browser shows the agent card. /device approves or denies a pairing request.
  pair set-password sets the approval password. pair set-oidc adds OpenID Connect on /device and
  the MCP consent page when the issuer, client id, client secret, and allowlist are all set.

Feedback
  feedback "message" [--json] [--kind bug|idea|other] [--contact x]
            [--steps S] [--expected S] [--actual S] [--logs S] [--agent A]
            [--environment local|cloud VM|CI|cloud agent sandbox|other]
            [--connection webhook|proxy|polling] [--yes]
                                report a bug or an idea. A bug needs --steps.
                                The report is a public GitHub issue. The warning names
                                the repository before it sends. A hosted A2A endpoint names
                                that repository. Otherwise the link opens
                                the form on telegraphic-dev/a2a-exposed. Do not include
                                confidential information: secrets, tokens, owner or pairing
                                tokens, private URLs or hostnames, message contents, or
                                personal data. Prints that warning and asks before sending,
                                unless --yes is set. Off a terminal, posting requires --yes.
                                Posts when this A2A endpoint names a feedback URL.
                                Otherwise prints Not filed and a link to the bug
                                report form and does not open a browser. The CLI adds its
                                version, the A2A endpoint Worker version when the A2A endpoint reports it,
                                the OS, the Node version, the connection (webhook, proxy, or
                                polling), and hosted or self-hosted. --connection overrides
                                that detection. Remove tokens from the message and from --logs.

Presets: grok-bot | claude-code | openclaw-wake | openclaw-agent | hermes | openbot | mausbot | generic
         Clients and how to load them:
         https://github.com/telegraphic-dev/a2a-exposed/blob/main/docs/getting-started.md#clients
Config: ${C.CONFIG_FILE}  (override dir with --config-dir DIR or A2A_CONFIG_DIR; env vars override file values)
Update notice: at most a daily background check of the npm registry; off with A2A_NO_UPDATE_CHECK=1 (or DO_NOT_TRACK=1)`;

const HELP_TUNNEL = `tunnel create|zones|status|rm

Self-hosted only. Hosted configs use hosted webhook settings or polling. Check status --json first.

  tunnel create [--tunnel-zone Z | --tunnel-hostname H] [--tunnel-origin URL] [--tunnel-path /p]
                [--show-token] [--zero-trust-org TEAM] [--dir DIR | --worker-dir DIR]
                [--preset hermes --hermes-route a2a-wake --hmac-secret-stdin]
                                Hermes defaults to :8644/webhooks/a2a-wake. --hermes-route selects another route.
                                --preset must match the deployed preset (configure with wake set --preset first).
                                --hmac-secret-stdin reads the existing subscription secret from protected stdin,
                                never prompts or saves it in config.env. See docs/hermes.md for the receiver recipe.
                                Named Cloudflare Tunnel, proxied DNS, and an Access app that admits one service token.
                                The tunnel, the Access app, and the service token are named "a2a-exposed wake <worker>".
                                The DNS host is wake-<word>-<word>-<4 hex>.<zone> unless --tunnel-hostname is set.
                                A finished tunnel creates nothing when you run it again. A partial tunnel stops and
                                asks for tunnel rm. Prints the Access application name and ids, then how to undo it
                                with tunnel rm. Worker secrets show up in about 15 to 40 seconds. Wait about 30 seconds.
                                Creation prints resource, connector, and optional persistent-service states.
                                status reports connections and ephemeral/unknown persistence; macOS service install needs an admin terminal.
  tunnel zones [--json]         List active zones before choosing --tunnel-zone; no resource changes.
  tunnel status                 Tunnel, Access, and Worker state, plus two probes.
                                A network error says DNS may still be propagating; retry in 30 seconds.
                                Warns about Access only when the bare request returns an HTTP status other than 401 or 403.
  tunnel rm                     Delete the DNS record, the tunnel, the Access app, and the service token, plus the
                                Worker secrets this tunnel uploaded. A missing Worker (Cloudflare 10007) is already gone.
                                With nothing saved, prints "nothing to remove".

--dir and --worker-dir are the Worker project directory (default <config dir>/worker).`;

const HELP_UNINSTALL = `uninstall [--yes] [--dry-run] [--dir DIR | --worker-dir DIR]

Self-hosted only. Hosted agents are deleted through hosted settings and confirmation.
Remove the Worker, the wake tunnel when the config has one, and the D1 database.
Prints the plan first: Worker name, D1 name and id, account, and the wake hostname
when a tunnel is saved. Removal is permanent and takes the messages and paired peers with it.

  --yes        skip the prompt (required off a terminal)
  --dry-run    print the plan and change nothing
  --dir        Worker project directory (same as --worker-dir)
  --worker-dir Worker project directory (default <config dir>/worker)

An empty config exits 1: nothing is deployed from that directory. Set A2A_CONFIG_DIR for another deployment.
The config directory stays. The owner token and WAKE_* values stay in config.env. A later init reuses the owner token.
Takes no other arguments.`;

const S = { type: "string" }, B = { type: "boolean" };
const tunnelOpts = { "tunnel-hostname": S, "tunnel-zone": S, "tunnel-origin": S, "tunnel-path": S, "show-token": B, "zero-trust-org": S, dir: S, "worker-dir": S };
const deployOpts = {
	...Object.fromEntries(dep.DEPLOY_FLAGS.map((f) => [f, S])), dir: S, "worker-dir": S, cron: B, "skip-install": B, "rotate-owner-token": B,
	"workers-dev": B, "workers-dev-subdomain": S, "upstream-token-stdin": B, "no-upstream-token": B, "event-secret-stdin": B,
};
const SPEC = {
 mcp: { "allow-os-consent": B },
 keys: { id: S, peer: S, store: S, "card-url": S, "user-code": S, "allow-os-consent": B, json: B },
	hosted: { url: S, version: S, "upstream-token-file": S, "upstream-token-env": S, "access-client-id-file": S, "access-client-id-env": S, "access-client-secret-file": S, "access-client-secret-env": S, name: S, json: B, agent: S, hostname: S, origin: S, path: S, preset: S, "control-url": S, "secret-file": S, "secret-env": S, "secret-from": S, "hermes-home": S, route: S, "token-file": S, "no-run": B },
	init: { ...deployOpts, ...tunnelOpts, tunnel: B, "dry-run": B, json: B }, deploy: deployOpts,
	wake: { ...deployOpts, "local-url": S, json: B, url: S, "reference-file": S, "reference-env": S, clear: B, version: S, agent: S, "control-url": S, "key-header": S, "key-file": S, "key-env": S, "key-stdin": B, "hmac-secret-file": S, "hmac-secret-env": S, "access-client-id-file": S, "access-client-id-env": S, "access-client-secret-file": S, "access-client-secret-env": S }, tunnel: { ...tunnelOpts, preset: S, "hermes-route": S, "hmac-secret-stdin": B, json: B },
	inbox: { context: S, from: S, all: B, json: B, "allow-os-consent": B },
	reply: { text: S, stdin: B, state: { type: "string", default: "completed" }, artifact: B, "artifact-name": { type: "string", default: "response" }, force: B },
	history: { "allow-os-consent": B, from: S, n: { type: "string", short: "n", default: "50" }, json: B },
	token: { rotate: B, json: B },
	peers: { "token-env": S, "token-stdin": B, json: B },
	peer: { to: S, all: B, reissue: B, hours: S, off: B, json: B },
	send: { "allow-os-consent": B, to: S, text: S, context: S, task: S, push: B, proto: S, wake: S, intent: S },
	poll: { to: S, proto: S },
	status: { json: B, agent: S, "control-url": S },
	env: { json: B },
	export: { sql: B },
	relay: { agent: S, "control-url": S, preset: S, "key-header": S, "key-file": S, "key-env": S, "key-stdin": B, "hmac-secret-file": S, "hmac-secret-env": S, "receipt-file": S, generation: S, "connector-id": S, confirm: B, clear: B, "forward-headers": S, "ingress-token-file": S, "local-headers-file": S, "card-url": S, "token-file": S, "token-env": S, "local-url": S, url: S, json: B, "config-version": S },
	upstream: { json: B },
	connect: { "sealed-key-id": S, alias: S, name: S, json: B, "no-wait": B, replace: B, force: B, "card-url": S },
	// Internal hosted-service integration commands. Keep out of public help until the production flow is available.
	signup: { "control-url": S, json: B },
	login: { "control-url": S, json: B, machine: S, scopes: S },
	pair: { json: B, web: B, ttl: S, issuer: S, "client-id": S, subjects: S, methods: S, "secret-stdin": B },
	feedback: { kind: S, contact: S, steps: S, expected: S, actual: S, logs: S, agent: S, environment: S, connection: S, yes: B, json: B },
	uninstall: { yes: B, "dry-run": B, dir: S, "worker-dir": S },
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
	if (rest.includes("--help") || rest.includes("-h")) {
		if (name === "uninstall") return console.log(HELP_UNINSTALL);
		if (name === "tunnel") return console.log(HELP_TUNNEL);
		return console.log(HELP);
	}
	if ((name === "init" || name === "deploy" || name === "wake") && rest.some((a) => /^--event-secret(=|$)/.test(a)))
		throw new CliError("export EVENT_SECRET or pass --event-secret-stdin. The secret is not an argument. It is not printed and it is not saved in config.env");
	if (name === "pair" && rest[0] === "set-oidc" && rest.some((a) => /^--(secret|client-secret)(=|$)/.test(a)))
		throw new CliError("export APPROVAL_OIDC_CLIENT_SECRET or pass --secret-stdin. --secret-stdin checks the line and discards it. Deploy uploads only the environment variable");
	if (name === "pair" && rest[0] === "set-password") {
		// only --web [--ttl M] [--json]: the password itself never comes from argv, stdin or the environment
		const extra = rest.slice(1);
		const ttlAt = extra.findIndex((a) => a === "--ttl" || a.startsWith("--ttl="));
		if (ttlAt >= 0) {
			const raw = extra[ttlAt].startsWith("--ttl=") ? extra[ttlAt].slice("--ttl=".length) : extra[ttlAt + 1];
			if (raw === undefined || String(raw).startsWith("--") || !/^\d+$/.test(String(raw)))
				throw new CliError("--ttl is the link lifetime in minutes, 1 to 60 (default 15)");
		}
		const ok = extra.includes("--web") && extra.every((a, i) => ["--web", "--json", "--ttl"].includes(a) || /^--ttl=\d+$/.test(a) || (extra[i - 1] === "--ttl" && /^\d+$/.test(a)));
		if (extra.length && !ok)
			throw new CliError("`pair set-password` takes no password argument: it reads the password from the terminal, without echo (never from argv, stdin or the environment). For a one-time web link instead: `pair set-password --web [--ttl MIN] [--json]`");
	}
	if (name !== "mcp" && name !== "env" && !(name === "init" && (rest.includes("--dry-run") || rest.includes("--json")))) upd.check(VERSION);
	let parsed;
	try {
		parsed = parseArgs({ args: rest, options: SPEC[name] || {}, allowPositionals: true, strict: true });
	} catch (e) {
		if (name === "hosted" && rest.includes("link") && rest.some(value => ["create", "finish"].includes(value)) && rest.includes("--json")) return linkOutput(linkUsage, { json: true });
		if (e && e.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
			const flag = (String(e.message).match(/'([^']+)'/) || [])[1] || "that flag";
			if (flag === "-y") throw new CliError("unknown flag -y. To skip a prompt, pass --yes.");
			throw new CliError(`unknown flag ${flag}. Run \`${CLI} --help\` and see the ${name} section.`);
		}
		if (e && String(e.code || "").startsWith("ERR_PARSE_ARGS")) throw new CliError(String(e.message));
		throw e;
	}
	const { values: o, positionals: p } = parsed;
	if (o["worker-dir"] !== undefined) o.dir = o["worker-dir"];
	switch (name) {
  case "mcp": {
   if (p.length) throw new CliError("mcp takes no positional arguments; select --config-dir DIR before starting it.");
   return (await import("./local-mcp.mjs")).serve(o);
  }
  case "keys": {
   try { return await (await import("./sealed-keys.mjs")).command(p, o); }
   catch (error) {
    if (error.constructor?.name === "LocalStateError" || error.name === "EncryptionError") throw new CliError(`${error.code}: ${error.next || "Key verification failed. Run keys status --json; preserve the original keys and pairing."}`);
    throw error;
   }
  }
		case "env":
			if (p.length) throw new CliError("env takes no arguments; use --config-dir DIR to select a directory");
			return console.log(o.json ? JSON.stringify({ A2A_CONFIG_DIR: C.CONFIG_DIR }) : `export A2A_CONFIG_DIR=${C.shellQuote(C.CONFIG_DIR)}`);
		case "init":
			if (p.length) throw new CliError("init takes no positional arguments; use --worker-name NAME");
			if (o.json && !o["dry-run"]) throw new CliError("init --json requires --dry-run");
			if (o.tunnel) tun.preflight(o); // refuse early (hosted preset, missing --tunnel-path) before anything is deployed
			await dep.init(o);
			if (!o.tunnel || o["dry-run"]) return;
			try { return await tun.create(o); } catch (e) {
				if (e instanceof CliError) e.message += `\n(the A2A endpoint is deployed and works; fix the above, then run \`${CLI} tunnel create\`, or check \`${CLI} status\`)`;
				throw e;
			}
		case "tunnel": {
			const sub = need(p[0], "tunnel create|zones|status|rm");
			if (p.length > 1) throw new CliError(`tunnel ${sub} takes no arguments (${p.slice(1).join(" ")}). Run \`${CLI} tunnel --help\`.`);
			return tun.tunnel(sub, o);
		}
		case "uninstall":
			if (p.length) throw new CliError(`uninstall takes no arguments (${p.join(" ")}). Run \`${CLI} uninstall --help\`.`);
			return un.uninstall(o);
		case "deploy": return dep.deploy(o);
		case "status": return o.agent !== undefined || o["control-url"] !== undefined ? hosted.output(() => hosted.status(o), o) : st.status(o);
		case "upstream": {
			const sub = need(p[0], "upstream verify [--json]");
			if (sub === "verify" || sub === "check") return st.upstreamVerify(o);
			throw new CliError(`unknown upstream action ${sub} (verify)`);
		}
		case "relay":
			if (p[0] === "wake" && p.length === 2) return hosted.output(() => hosted.relayWake(p[1], o), o);
			if (p[0] === "http" || p[0] === "a2a") return relayHttp(p, o);
			if (p.length !== 1) throw new CliError("usage: relay create|status|revoke|run");
			return relay(p[0], o);
		case "wake": {
			if (p[0] === "status") {
				if (p.length !== 1 || Object.keys(o).some(key => key !== "json")) throw new CliError("usage: wake status [--json] (select the owner config with --config-dir; hosted setup: wake preview --agent NAME --json)");
				return cmd.wakeStatus(o);
			}
			return C.deploymentKind() === "hosted" || o.agent ? hosted.output(() => hosted.wake(p[0], o), o) : dep.wake(p[0], o);
		}
		case "url": {
			const u = cmd.baseUrl();
			if (!u) throw new CliError(`no base URL configured in ${C.CONFIG_FILE}: run \`${CLI} init\` (or pass --config-dir / A2A_CONFIG_DIR for another deployment)`);
			return console.log(u);
		}
		case "config": {
			const f = C.fileConfig();
			console.log(`# ${C.CONFIG_FILE}`);
			const showValue = (k) => k === "A2A_TUNNEL_TOKEN_FILE" || k === "A2A_TUNNEL_SECRETS_AT";
			for (const [k, v] of Object.entries(f)) console.log(`${k}=${/TOKEN|KEY|SECRET/.test(k) && !showValue(k) ? "(set)" : v}`);
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
		case "peer": {
			const sub = need(p[0], "peer announce (--to <alias> | --all) | peer forward --to <card-url> [--hours N] | peer forward --off");
			if (sub === "announce") return address.announce(o);
			if (sub === "forward") return address.forward(o);
			throw new CliError(`unknown peer action ${sub} (announce|forward)`);
		}
		case "hosted": {
			if (p[0] === "upstream" && p.length === 2) return hosted.output(() => hosted.upstream(p[1], o), o);
			if (p.length === 1 && ["capabilities", "list", "create", "names", "capacity"].includes(p[0])) return hosted.output(() => hosted[p[0]](o), o);
			if (p.length !== 2 || p[0] !== "link" || !["finish", "create"].includes(p[1])) return linkOutput(linkUsage, o);
			return linkOutput(() => (p[1] === "create" ? createLink : finishLink)({ ...o, "control-url": o["control-url"] || C.get("CONTROL_URL") }), o);
		}
		case "signup":
		case "login": {
			if (o.machine || o.scopes) return hosted.output(() => hosted.login(o), o);
			const result = await account.deviceLogin({ controlUrl: o["control-url"] || C.get("CONTROL_URL"), intent: name });
			if (o.json) console.log(JSON.stringify({ control_url: result.controlUrl, email: result.email }));
			return;
		}
		case "connect": return pair.connect(need(p[0], "connect <base-or-card-url> [--alias A] [--no-wait] [--json]"), o);
		case "pair": {
			const sub = need(p[0], "pair set-password|set-oidc|list|approve <code>|deny <code>");
			if (sub === "set-password") return pair.setPassword(o);
			if (sub === "set-oidc") return pair.setOidc(o, p.slice(1));
			if (sub === "list") return pair.list(o);
			if (sub === "approve" || sub === "deny") return pair.decide(sub, need(p[1], `pair ${sub} <code>`), o);
			throw new CliError(`unknown pair action ${sub} (set-password|set-oidc|list|approve|deny)`);
		}
		case "send": return cmd.send(o);
		case "poll": return cmd.poll(need(p[0], "poll --to <peer> <taskId>"), o);
		case "outbound": return cmd.outbound(need(p[0], "outbound <taskId>"));
		case "feedback": {
			const message = p.join(" ").trim();
			need(message, `feedback "message" [--json] [--kind bug|idea|other] [--steps S] [--expected S] [--actual S] [--logs S] [--agent A] [--environment E] [--connection webhook|proxy|polling]`);
			const kind = o.kind || "other";
			if (!fb.KINDS.includes(kind)) throw new CliError("--kind must be bug, idea, or other");
			if (o.connection && !fb.CONNECTIONS.includes(o.connection)) throw new CliError("--connection must be webhook, proxy, or polling");
			if (kind === "bug" && !String(o.steps || "").trim()) throw new CliError("a bug report needs reproduction steps (--steps)");
			const repo = await fb.feedbackPublicRepo({ baseUrl: C.get("A2A_BASE_URL"), ownerToken: C.get("A2A_OWNER_TOKEN") });
			const result = await fb.runFeedback({
				beforePost: () => fb.confirmPublicIssue(Boolean(o.yes), undefined, undefined, repo),
				message, kind, contact: o.contact || "", version: VERSION,
				steps: o.steps || "", expected: o.expected || "", actual: o.actual || "", logs: o.logs || "",
				agent: o.agent || "", environment: o.environment || "",
				connection: o.connection || "",
				baseUrl: C.get("A2A_BASE_URL"), ownerToken: C.get("A2A_OWNER_TOKEN"),
			});
			if (!result.filed) console.error("Not filed: this A2A endpoint has no feedback inbox. Open this link to file it on GitHub:");
			console.log(o.json ? JSON.stringify(result.filed ? { filed: true, issue: result.url } : result) : result.url);
			return;
		}
		default: throw new CliError(`unknown command ${name} (see --help)`);
	}
}
