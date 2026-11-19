# CLI, skills, MCP and dashboard parity

This page tracks what an owner or agent can do on each a2a.exposed surface, so that gaps are deliberate and not accidental:

- **CLI**: `npx -y a2a-exposed@latest <command>`, including the local stdio `a2a-exposed mcp`.
- **Skill guidance**: what `skills/a2a-exposed` and `skills/a2a-exposed-setup` tell an agent to do.
- **Hosted MCP**: `https://a2a.exposed/mcp`, the account-level connector for hosted agents.
- **Self-hosted MCP**: a self-hosted Worker's own `/mcp`, owner-only.
- **Web dashboard**: the hosted owner app at `https://a2a.exposed/app`, plus the Worker's own owner pages (`/device`, `/device/setup`, the MCP consent page at `/oauth/authorize`).

**Reflects:** a2a-exposed **v0.8.62**, checked 2026-11-15. The hosted column reflects the site pin at OSS **0.8.61**. Hosted MCP cells come from the live tool list of a signed-in hosted connection. Hosted `/app` dashboard cells were confirmed in a signed-in staging check on 2026-11-16, except the safety-code display and message-log paging, which stay marked *(unverified-live)* (see those rows for why). Linked Worker pages were not part of that tour and stay marked where they already were.

## Legend

- **yes**: the surface does this end to end.
- **partial**: some of it, or only with a detour. The cell says what's missing.
- **no**: not available on this surface.
- **n/a**: doesn't apply to this surface.
- **(by design)**: an intentional gap. See [Intentional gaps](#intentional-gaps).
- *(unverified-live)*: read from code. Not yet seen in a signed-in browser.
- Paths: `main.mjs`, `commands.mjs`, `pair.mjs`, `sealed-keys.mjs` and `local-mcp.mjs` are in `cli/lib/`. `index.ts`, `mcp.ts` and `pairing.ts` are in `worker/src/`. A bare `SKILL.md` is `skills/a2a-exposed/SKILL.md`; "setup `SKILL.md`" is `skills/a2a-exposed-setup/SKILL.md`. `references/...` is relative to the skill named in the same cell.
- Hosted MCP cells name the live tool; "(live)" means confirmed on the live tool list.

## Matrix

| Capability | CLI (`a2a-exposed`) | Skill guidance | Hosted MCP (`a2a.exposed/mcp`) | Self-hosted MCP (Worker `/mcp`) | Web dashboard (hosted `/app` + Worker pages) |
| --- | --- | --- | --- | --- | --- |
| **Account and access** | | | | | |
| Owner sign-in / identity | yes: `login`, `signup` device login (`cli/lib/main.mjs:769`, `account.mjs`) | yes: setup `SKILL.md:91`, `:93` | yes: OAuth sign-in = owner  | yes: OAuth 2.1 + approval password or OIDC consent (`worker/src/index.ts:4719`, `docs/mcp.md:180`) | yes: hosted `/app/sign-in`; Worker: no account, approval password only |
| Scoped setup grant (machine login) | yes: `login --machine --scopes` (`main.mjs:65` help, `hosted.mjs`) | yes: setup `SKILL.md:93` | n/a (OAuth grant per connection) | n/a | yes: approve on `/app/device`, list/revoke `/app/settings#setup-grants` |
| **Hosted agents** | | | | | |
| Create hosted agent (+ name/capacity preflight) | yes: `hosted create / names / capacity` (`main.mjs:763`, help `:68`-`:80`) | yes: setup `SKILL.md:91`, `:149` | yes: `create_agent`, `name_availability`, `creation_capacity` (live) | n/a | yes: `+ New agent` on `/app` |
| List / select hosted agents | yes: `hosted list` (`main.mjs:764`) | yes: setup `SKILL.md:146` | yes: `list_agents` (live) | n/a | yes: `/app` Agents list |
| Delete hosted agent | no: "the CLI has no delete command" (`skills/a2a-exposed/SKILL.md`) | yes: dashboard or hosted MCP `delete_agent` with browser confirm ([#460](https://github.com/telegraphic-dev/a2a-exposed/issues/460)) | yes: `delete_agent`, browser confirm (live) | n/a | yes: Danger zone on `/app/agents/:name` |
| **Agent card and address** | | | | | |
| Set card name, description, skills | yes (self-host): `init --agent-name/--agent-description/--agent-skills` (`docs/cli.md:121`) | partial: setup `references/deploy.md` | no | no | no: no card editor on the hosted agent pages |
| Share own address / connect text | partial: `url` (`main.mjs:733`) prints base URL only | yes: `references/connect.md` | yes: `connect_message` (live) | no | partial: Get started connect command and pasteable "Message for your agent"; Worker `GET /`, `/index.md`, `/llms.txt` (`index.ts:4739`) |
| **Pairing** | | | | | |
| Request outbound pairing (RFC 8628 device flow) | yes: `connect <url>` polls the device code (`main.mjs:776`, `pair.mjs:363`) | yes: `references/connect.md`, `SKILL.md:77` | yes: `request_pairing`, secret kept on the host (live) | yes: `request_pairing`; the device code stays sealed on the Worker and the first `send` redeems it ([#461](https://github.com/telegraphic-dev/a2a-exposed/issues/461)) | no: hosted `/app/pair` only redirects to the agent page |
| List pending pairing requests | yes: `pair list` (ordered emoji/name quick check; full code retained), also at the end of `inbox` (`main.mjs:781`) | yes: `SKILL.md:79` | yes: `pairing_requests` (live) | yes: `pairing_requests`, additive `safetyEmoji` and unchanged `safetyCode`, read-only (`worker/src/mcp.ts:404`, `index.ts:4506`) | yes: hosted Pairing section; Worker `/device?user_code=` with named emoji quick check and full-code details (`index.ts:4730`) |
| Approve / deny pairing | yes: `pair approve / deny` with the owner token (`main.mjs:782`) | yes: human-only rules (`SKILL.md:115`-`:122`) | yes: `approve_pairing` (confirm page), `deny_pairing` (live) | no (by design): `docs/mcp.md:136` | yes: hosted Approve/Deny *(unverified-live)*; linked Worker *(unverified-live)*; Worker `/device` with password or OIDC (`index.ts:4730`) |
| Approval password / OIDC setup | yes: `pair set-password [--web]`, `pair set-oidc` (`main.mjs:779`-`:780`) | yes: `SKILL.md:121` | n/a (account sign-in) | no (by design) | yes: Worker `/device/setup` one-time link (`index.ts:4722`); hosted n/a |
| List peers (inbound + outbound) | yes: `token list`, `peers list` (local pins add `safety_emoji`, unchanged full `safety_code`) (`main.mjs:754`, `:756`) | yes: `references/pairing.md:9` | yes: `peers` (live) | yes: `list_peers` (`mcp.ts:395`) | yes: hosted Peers section, inbound/outbound; linked Worker `/app/cloudflare/:id/peers` *(unverified-live)* |
| Revoke inbound peer / remove outbound peer | yes: `token revoke`, `peers rm` | yes: `references/tokens.md` | yes: `revoke_peer`, `remove_outbound_peer`, browser confirm (live) | no (by design) | yes: hosted revoke / remove-outbound *(unverified-live)*; linked Worker |
| Sync peers to MCP / announce address / forward | yes: `peers sync`, `peer announce [--reissue]`, `peer forward` (`main.mjs:756`-`:761`) | yes: `SKILL.md:49`, `references/connect.md:39` | partial: no `announce_address`, no forward; sync not needed (pairing is server-side) | partial: `announce_address`, no reissue (`mcp.ts:398`); needs CLI `peers sync` first (CLI `peer announce --to` syncs it) | no |
| **Messaging** | | | | | |
| Send | yes: `send --to --intent --wake [--push]` (`main.mjs:785`) | yes: `SKILL.md:49`, `references/messaging.md` | yes: `send` (live) | yes: `send` (`mcp.ts:382`) | no |
| Reply (states, intent/wake) | yes: `reply` with `--state/--intent/--wake/--artifact/--force` (`main.mjs:748`) | yes: `SKILL.md:95`-`:111` | partial: `reply` with state/intent/wake; no owner-wait fields, no force/artifact (live) | yes: `reply` incl. `waitReason/waitNote`, outputSchema (`mcp.ts:363`) | no |
| Owner-decision wait (`--wait-reason owner-decision`) | yes: `reply --wait-reason --wait-note` (`main.mjs:605`) | yes: `SKILL.md:147` | **no**: not in live `reply` schema | yes: `mcp.ts:366`-`:367` | no |
| Mark working | yes: `working` (`main.mjs:747`) | yes: `SKILL.md:94` | yes: `mark_working`  | yes: `mark_working` (`mcp.ts:360`) | no |
| Poll / stored outbound state | yes: `poll`, `outbound` (`main.mjs:786`-`:787`) | yes: `SKILL.md:75` | partial: `poll_outbound`; no stored `outbound` read | partial: `poll_outbound` (`mcp.ts:389`) | no |
| Cancel a sent task | yes: `cancel --to <alias\|url> <taskId>`, recorded in history like `poll` ([#461](https://github.com/telegraphic-dev/a2a-exposed/issues/461)) | yes: `SKILL.md` messaging commands | yes: `cancel_outbound`  | yes: `cancel_outbound` (`mcp.ts:392`) | no |
| Show one task (full messages + artifacts) | yes: `show` (`main.mjs:746`) | yes: `SKILL.md:73` | **no**: no `show_task` (live) | yes: `show_task` (`mcp.ts:354`) | no |
| **Inbox and history** | | | | | |
| Inbox (open tasks, replies, filters) | yes: `inbox` follows all pages (`main.mjs:745`, `commands.mjs:170`) | yes: `SKILL.md:69`-`:80` | yes: `inbox` one page + cursor  | yes: `inbox` one page + cursor (`mcp.ts:345`) | partial: hosted Message log = latest 5 exchanges, read-only *(unverified-live: the staging log was empty, so the latest-5 cap and paging could not be re-checked)* |
| History of a conversation | yes: `history <ctx> [--from] [-n]` (`main.mjs:751`) | yes: `SKILL.md:74` | yes: `history` with paging  | yes: `history` (`mcp.ts:357`) | partial: Message log only *(unverified-live: same empty log as the inbox row)* |
| Recent contexts list | yes: `contexts` (`main.mjs:752`) | partial: command reference only | no | no | no |
| Message counts by state | partial: `status` (no per-state count) | no | partial: `agent_status` open-task counts  | no | yes: Overview > Messages counts (Waiting, Working, Needs input, Completed, Failed) |
| **Wake setup** | | | | | |
| Set wake (presets, browser confirm, references) | yes: `wake set` (self-host + hosted), `wake request` (browser confirm), `wake prepare` (`main.mjs:724`, help `:85`-`:111`) | yes: setup `SKILL.md:91`, `references/wake.md` | yes: `set_wake`: confirm page or CLI `secretReference` / relay receipt (live) | **no** | yes: Wake settings save; Worker: none |
| Test wake | yes: `wake test`, `wake check` (Hermes) | yes | yes: `test_wake`  | no | yes: Wake settings test + latest 10 test wakes |
| Preview / remove / pending status / policy / receipts | yes: `wake preview / remove / status / policy / receipts` (`main.mjs:724`-`:731`, help `:235`-`:256`) | yes: `SKILL.md:132`, `:149` | partial: removal via `set_wake clear:true`; no preview, pending-status, policy or receipts | partial: read-only `wake_status` (pending, retrying, last attempt and last accepted; never flushes) ([#461](https://github.com/telegraphic-dev/a2a-exposed/issues/461)); no preview, policy or receipts | partial: Remove wake *(unverified-live)*; no pending-status, policy or receipts |
| Relay / tunnel / secure link / tunnel import | yes: `relay ...` (Node 22.18+/24/26; handshake errors include Node version), `tunnel ...`, `hosted link create/finish` (`main.mjs:704`, `:719`, `:767`) | yes: setup `SKILL.md:97`, `references/wake.md` | partial: relay receipt via `set_wake`; `create/remove_secure_link` behind a flag (absent from live list) | no | yes: `/app/agents/:name/secure-link`, `/wake-relay`, `/secure-link?import=1` |
| ACP stdio relay / existing-session targeting | yes: `relay a2a run --acp --acp-cwd --acp-peers-file --acp-mode MODE [--acp-session --acp-session-peer] [--acp-diagnostics-file NEWFILE]`; mode acknowledged before every prompt, drift/stopped binding fenced, fixed phase errors and private bounded stderr | yes: operate `references/relay.md`, setup `references/acp.md` | no (trusted local process only) | no (trusted local process only) | no; requires separately enabled HTTP relay |
| Façade upstream (proxy to own A2A agent) | yes: `init --upstream`, `upstream verify`, `hosted upstream preview/set/clear/verify` (`main.mjs:714`, `:765`) | yes: `references/troubleshooting.md` | yes: `create_agent kind:facade`, `set_upstream` (confirm), `verify_upstream`  | no | none: no façade or upstream section on `/app/agents/:name` |
| **Status and owner inspection** | | | | | |
| Health / diagnostics | yes: `status [--json]` eight layers, `status --agent`, `tunnel status`, `upstream verify` (`main.mjs:713`) | yes: setup `SKILL.md:99`, both `troubleshooting.md` | partial: `agent_status` (address, wake, open counts), `verify_upstream` | **no**: no status tool | partial: Overview status/connection (shows Polling when no wake is set); linked Worker version/upgrade *(unverified-live)*; Worker `/health` (`index.ts:4711`) |
| **Encryption (sealed/v1)** | | | | | |
| Keys init / publish / pin / code, sealed send/read | yes: `keys stores/init/status/publish/pairings/pin/code/verify/revoke/rotate/outbox/backup/restore`, `send --recover`, `connect --sealed-key-id`, local stdio `mcp` (`list_peers` adds emoji/name pairs and full code for local pins; history preserves text-free state/push events; stdio MCP marks `eventOnly`; `main.mjs:684`, `sealed-keys.mjs:77`, `local-mcp.mjs:18`) | yes: `SKILL.md:123`, `:147`, `references/messaging.md:85` | no (intentional, #458) | no (intentional, #458) | no (intentional: no private keys on the server) |
| Safety code shown on an encrypted pairing request | yes: `pair list` shows `sealed`, `safetyCode` (`docs/cli.md:270`) | yes: `references/messaging.md:155` | yes: `pairing_requests` and `approve_pairing` show it  | yes: `pairing_requests` passes through `sealed` and `safetyCode`, no key material ([#461](https://github.com/telegraphic-dev/a2a-exposed/issues/461)) | yes: hosted sealed block *(unverified-live: the safety code is only shown when a pairing request is pending; pairings were out of scope for the tour)*; Worker `/device` (`worker/src/pairing.ts:245`) |
| **Tokens** | | | | | |
| Owner token rotation | partial: self-host `init --rotate-owner-token`; a hosted config refuses it and points to the dashboard or MCP `rotate_owner_token` ([#461](https://github.com/telegraphic-dev/a2a-exposed/issues/461)) | yes: setup `SKILL.md:107` | yes: `rotate_owner_token`, shown only on the confirm page  | no (by design) | yes: Advanced > Rotate owner token; linked Worker |
| Manual peer token issue / rotate | yes: `token issue / rotate` (`main.mjs:754`) | yes: `references/tokens.md` | no (by design: shown-once secret) | no (by design) | no |
| MCP client grants (list / revoke) | yes: `token list` shows `mcp-*`; `token revoke mcp-<client>` | partial: `docs/mcp.md:134` only | n/a | n/a | yes: hosted Connected clients |
| **Export and backup** | | | | | |
| Export / backup | yes: `export [--sql]` full dump (`main.mjs:753`, `commands.mjs:516`) | yes: `references/troubleshooting.md:39` | no | no | yes: hosted redacted "Download SQL"; linked Worker backup *(unverified-live)*; restore: nowhere |
| **Self-host** | | | | | |
| Deploy / redeploy / uninstall / upgrade | yes: `init`, `deploy`, `uninstall`, update reminders (`main.mjs:694`-`:712`) | yes: setup `SKILL.md`, `references/deploy.md`, `teardown.md` | n/a | n/a | partial: hosted Cloudflare wizard create/upgrade/remove for linked Workers *(unverified-live)* |
| **Troubleshooting** | | | | | |
| Feedback report | yes: `feedback` (`main.mjs:788`) | yes: setup `SKILL.md:121`-`:142` | yes: `send_feedback` (browser confirm)  | yes: `send_feedback` (`mcp.ts:407`) | yes: `/app/feedback` |
| Official A2A CLI credential helper | yes: `credential get` (`main.mjs:755`) | yes: `SKILL.md:47` | no | no | no |

## Gaps

### Accidental

| Gap | Surfaces | Severity | Issue |
| --- | --- | --- | --- |
| Hosted MCP `reply` has no owner-wait fields, and there's no `show_task` | Hosted MCP | P2 | [site #742](https://github.com/telegraphic-dev/a2a-exposed-site/issues/742) (refs #421) |
| No wake diagnostics on the hosted MCP (`wake status`, preview, policy, receipts); the Worker MCP has read-only `wake_status` only | Hosted MCP (Worker MCP partial) | P2 | [site #742](https://github.com/telegraphic-dev/a2a-exposed-site/issues/742) |
| Tool names differ between servers (`peers` vs `list_peers`), and none are namespaced. The skills and `docs/mcp.md` now name the differences ([#460](https://github.com/telegraphic-dev/a2a-exposed/issues/460)); the names themselves are unchanged | Both MCPs | P3 | none yet: renaming a tool needs a product decision |
| Dashboard shows only the latest five exchanges, with no paging or task view | Dashboard | P2 | [#430](https://github.com/telegraphic-dev/a2a-exposed/issues/430) |
| No hosted `announce_address` or forward | Hosted MCP | P3 | [site #742](https://github.com/telegraphic-dev/a2a-exposed-site/issues/742) |
| No `contexts` list outside the CLI | MCPs, dashboard | P3 | [#430](https://github.com/telegraphic-dev/a2a-exposed/issues/430) (gap 11) and [site #742](https://github.com/telegraphic-dev/a2a-exposed-site/issues/742) |
| Hosted agent card name and description can't be edited after create | Hosted surfaces | P3 | [site #742](https://github.com/telegraphic-dev/a2a-exposed-site/issues/742) |
| No façade or upstream section on the hosted dashboard (CLI `hosted upstream` and hosted MCP `set_upstream` / `verify_upstream` exist) | Dashboard | P2 | [site #745](https://github.com/telegraphic-dev/a2a-exposed-site/issues/745) |

### Intentional

| Gap | Why |
| --- | --- |
| No encryption key tools (`keys ...`, sealed send/read) on remote MCPs or the dashboard | No private keys on the server. Use the CLI or the local stdio `a2a-exposed mcp`. MCP end-to-end encryption is tracked in #458. |
| Self-hosted MCP can't approve or deny, revoke, issue tokens or change settings | The connector token is deliberately weaker than the owner token. The human decides on `/device` or the dashboard. |
| No manual peer token issue on MCPs or the dashboard | Shown-once secrets stay out of MCP results. Pairing is the preferred path. |
| No export on MCPs; the dashboard export is redacted | The dump holds token hashes and encrypted peer tokens. The full dump is CLI-only with the owner token. |
| No hosted agent delete in the CLI | Destructive. It needs a fresh browser sign-in (dashboard or MCP confirm page). |
| Wake secrets never in MCP arguments | `set_wake` uses a browser confirm page or a CLI-prepared `secretReference`. |
| No self-host deploy on MCPs or the hosted dashboard for unlinked Workers | Needs a Cloudflare login and the human's consent. |

## How to keep this current

- **Same PR, same row.** [AGENTS.md](../AGENTS.md) requires this: a PR that adds, renames or removes any of the following updates the matching row here:
  - a CLI command or flag;
  - a skill section that tells agents which surface to use;
  - a Worker MCP tool (`worker/src/mcp.ts` `TOOLS`);
  - a local stdio MCP tool (`cli/lib/local-mcp.mjs`);
  - a Worker owner page (`/device`, `/device/setup`, `/oauth/authorize`).

  If the change opens or closes a gap, update [Gaps](#gaps) too.
- **Hosted changes.** The hosted MCP and the dashboard ship from the private site repo. When a hosted MCP tool or an owner page in `/app` changes, the site PR author files a one-line update here, or asks a maintainer to. Re-check the hosted MCP column against the live tool list after each site release that bumps the pinned OSS version.
- **Dashboard column.** Update it whenever owner UI changes: a new section, button or action on `/app/agents/:name`, `/app/cloudflare/:id`, `/app/settings` or the Worker's own pages. Clear an *(unverified-live)* mark only after a signed-in check on staging.
- **CI idea.** A small script can parse:
  - the tool names from `worker/src/mcp.ts` `TOOLS` and `cli/lib/local-mcp.mjs` `TOOLS`;
  - the command names from `cli/lib/main.mjs` `switch (name)`;

  and fail when a name is missing from this page. For hosted tools, a scheduled job can compare `tools/list` from a staging test connection with the hosted column, and open an issue on drift. It shouldn't block PRs.
- **Skills point, they don't copy.** Skills link to this page and to `https://a2a.exposed/docs/hosted-mcp` for the hosted tool list. They don't duplicate either.

Local encrypted history preserves text-free state and push events as unauthenticated
metadata; stdio MCP returns `eventOnly: true` for these rows and withholds push
status text. Inbound plaintext with text still fails for a pinned peer.
