# Contributor verification and QA

Read [AGENTS.md](../../AGENTS.md) first for credential isolation and safety rules.
Run commands from the repository root unless a subshell changes directory.
Use Node 22.18+ and Python 3. This is the complete local checklist before pushing;
a focused test is useful during editing but does not replace it.

## Install and hygiene

```bash
node --version
(cd worker && npm ci --no-audit --no-fund)
(cd control && npm ci --no-audit --no-fund)
npm run lint
npm run format:check
npm run test:checks
```

The root checks need no npm install. Lint checks JS and Python syntax, JSON,
and immutable GitHub Action references. Formatting checks tracked text for
trailing whitespace, LF endings, and a final newline without imposing an
indentation style. Check new files too before staging: the tracked-file scan
does not see untracked files.

## Full tests, typechecks, builds, and packaging

Use a clean shell without real deployment configuration, as described in
AGENTS.md. This loop also checks time-sensitive tests in both required zones:

```bash
for timezone in Europe/Prague UTC; do
  (cd worker && TZ="$timezone" npm test) || exit
  (cd cli && TZ="$timezone" npm test) || exit
  (cd control && TZ="$timezone" npm test) || exit
  (cd worker && TZ="$timezone" STORAGE_BACKEND=d1 npm test) || exit
  (cd worker && TZ="$timezone" STORAGE_BACKEND=do npm test) || exit
done
(cd worker && npx cf workers types && npx tsc --noEmit && npx cf build)
(cd cli && npm pack --dry-run)
(cd control && npx cf workers types && npx tsc --noEmit && npm run build && node scripts/check-build.mjs)
(cd control && CONTROL_HOSTNAME=control.example.com CONTROL_ROUTE='example.com/*' CONTROL_ROUTE_ZONE=example.com npx cf build && node scripts/check-build.mjs --routes)
npm pack --dry-run
node cli/bin/a2a-exposed.mjs --help
```

CI runs the default Node suite and both storage backends, but does not explicitly
set a timezone matrix. Run the time-sensitive tests in `Europe/Prague` and in `UTC`.
Control `npm test` runs Node tests serially, then Vitest in Miniflare with a
mock Cloudflare API. If Node tests fail, the shell skips Vitest: fix the failure
and rerun the full command; use `npx vitest run` separately to diagnose it.
The library contract test performs a temporary `file:` install and import.

Inspect CLI pack output: it must contain `worker/cloudflare.config.ts` and must
not contain `control/`. Root packing builds the separate control-core library.
The route check uses example settings and bundles locally, without deploying.

For coverage matching CI, create `coverage/` at root, then run
`npm run test:coverage` in each component. CI uploads source-only LCOV artifacts
for 14 days. Coverage covers Node source only, not subprocess execution,
Vitest/workerd, or the storage matrix. There is no blanket percentage threshold.

## Skills and plugin validation

These commands mirror the tools and pins in `.github/workflows/ci.yml` and need
network access for installation and schemas, but no Cloudflare credentials:

```bash
npx -y skills add ./ --list
python3 -m venv .skills-ref-venv
.skills-ref-venv/bin/pip install -q "skills-ref @ git+https://github.com/agentskills/agentskills.git@69ef37e9424c0a7ea9dd2293b559e43ec8176379#subdirectory=skills-ref" jsonschema pyyaml
.skills-ref-venv/bin/skills-ref validate skills/a2a-exposed
.skills-ref-venv/bin/skills-ref validate skills/a2a-exposed-setup
.skills-ref-venv/bin/python scripts/check-skill-metadata.py
.skills-ref-venv/bin/python scripts/check-plugin-schemas.py
node scripts/check-skill-plugin.mjs
node scripts/check-claude-plugin.mjs
```

Discovery must list both `a2a-exposed` and `a2a-exposed-setup`. Schema checks,
metadata checks, discovery, and Claude validation cover different contracts;
none replaces the others.

## Staging hosted link refusal contract

The internal hosted link integration remains staging-only and outside public
CLI help. Its create failures name the requested hostname and the operation.
Only recognized public validation templates are shown from server messages;
unknown text, extra fields and transport errors are hidden. The apex template
must exactly name the requested hostname, including its example subdomain.

Site refusal codes `apex_hostname`, `outside_zone`, `existing_dns` and
`existing_tunnel` have distinct local guidance. These codes are supplied by
site PR #415. For validation failures, a recognized `reason` takes precedence
over `error`; unknown reasons fall back to a recognized error or HTTP status.
Outside-zone validation shows only the exact public template with DNS domain
names, or the no-domain template. Pending-request limits tell the owner to deny
an earlier request or wait for expiry; token polling still backs off on
`slow_down`. Provisioning failures distinguish hostname/zone conflicts,
unfinished cleanup, Cloudflare authorization (401/403), temporary failures
(429/5xx), and unknown failures. Phase and status select local messages; they
never expose arbitrary server text. Approval refusal codes each explain their
recovery. An unreadable secure-link access key requires removing and recreating
the link, rather than reconnecting Cloudflare.

An older `link_exists` is ambiguous, so it points to the approval
page without assuming a different link exists. A refusal never retries
provisioning, reads a signing secret or requests a connector credential.
An `expired_token` response or local approval deadline uses fixed local text:
the link request expired; start a new one with the same create/finish command.
Grant expiry after approval instead names the grant and requests fresh approval
with `hosted link finish`. After connector delivery, diagnostics state that the
local token remains and wake settings were not saved. Polling validation errors
do not suggest editing creation options. Missing-session errors name the failed
create/finish command before any network request.
`cli/test/link-finish.test.mjs` covers these boundaries for create and finish,
including expiry before approval and local timeout without secret transfer.

## Manual QA

For affected pages, use local
`npx cf dev` with ignored `.dev.vars` and dummy credentials. Check landing-page
HTML versus JSON negotiation, setup-link expiry/single use, approval and denial,
MCP consent/redirect behavior, error messages, CSP, and timezone display as
applicable. Do not weaken script-free approval pages to add a browser test.

For endpoint behavior, start from the existing user contracts:

| Area | Contract and tests |
| --- | --- |
| A2A versions, task/context ownership, pagination, HEAD | [Protocol](../protocol.md); `worker/test/a2a.test.ts`, `context-peer.test.ts`, `list-tasks.test.ts`, `owner-rpc.test.ts` |
| Pairing, password, OIDC, peer addresses | [Security](../security.md); `worker/test/pairing.test.ts`, `approval-oidc.test.ts`, `address.test.ts` |
| MCP/OAuth | [MCP](../mcp.md); `worker/test/mcp.test.ts`, `owner-mcp.test.ts` |
| Wake delivery/retries and presets | [Receiving messages](../receiving-messages.md); `worker/test/wake*.test.ts`, `inbox-wake.test.ts` |
| Façade and SSRF defenses | [Self-hosting](../self-hosting.md), [Security](../security.md); `worker/test/facade.test.ts`, `wake-target.test.ts` |
| Export, backup, migrations | [Upgrading](../upgrading.md); `worker/test/export.test.ts`, both components' `migrations.test.ts` |
| Provisioning, tenant isolation, sealed secrets | [Control library](../../control/README.md); `control/test/`, `worker/test/tenancy.test.ts`, `hosted.test.ts` |
| CLI configuration and packaging | [CLI](../cli.md); `cli/test/`, `cli/scripts/sync-worker.mjs` |
| Skills and platforms | [Client table](../getting-started.md#clients); `skills/` and root validation scripts |

Real self-host testing uses a Cloudflare account the maintainers provide for
that purpose, and only with their explicit authorization. Do not run the public
setup commands against infrastructure this repository does not own. Confirm the
test scope, use dummy messages, check auth rejection as well as success, verify
cleanup, and record the version and the client or preset you exercised. A mock
or a successful webhook status does not show that a client works.

The Claude check stages the installable manifests, skills, assets, license, and
README, then runs the pinned validator with `--strict`. Repository-only
`CLAUDE.md` points coding contributors at AGENTS.md; it is not plugin context.
The validator warns about that file when run against the whole checkout, so CI
validates the plugin payload separately without weakening strict validation.
