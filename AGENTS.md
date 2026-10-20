# AGENTS.md

Guide for coding agents (and humans) changing this repository. User-facing docs are in `README.md` (short intro), `docs/`, and `skills/`.

## Layout

- `worker/`: Cloudflare Worker (TypeScript, D1, `cf` CLI config in `cloudflare.config.ts`). Migrations in `worker/migrations/` are append-only: add a new numbered file, never edit an old one. Each number is used once. `cf d1 migrations apply` (run by `init`/`deploy`) applies every file not yet recorded in `d1_migrations`, in numeric order, so a lower number added later still runs on existing databases. `worker/test/migrations.test.ts` checks the numbering and replays upgrades from older databases.
- `control/`: the `@a2a-exposed/control-core` library and a Worker for health, feedback, and static assets (`control/README.md`). `npm test` in `control/` runs the Node tests and a Vitest suite inside Miniflare (`control/test/workers/`). That suite runs the Cloudflare provisioning calls in workerd against a mocked Cloudflare API. Keep `control/` out of the `a2a-exposed` CLI package. `@a2a-exposed/control-core` is the repository root (`package.json`). The source entry is `control/src/core/index.ts` (inbox provisioning, routing, `ControlEnv`, and `control/migrations/`). The published module is the compiled JavaScript and declarations from that entry. `prepare` builds it on `npm pack` and on a `file:` install. The Worker serves HTTP on its own. Migrations in `control/migrations/` follow the same append-only rule as `worker/migrations/`.
- `cli/`: the npm package `a2a-exposed` (Node 22.18+ ESM, **zero dependencies**: keep it that way). `npm pack` bundles `../worker` as the deploy template via `cli/scripts/sync-worker.mjs` (prepack); `cli/worker/` and `cli/LICENSE` are generated, not committed.
- `skills/<name>/SKILL.md`: the two agent skills ([Agent Skills](https://agentskills.io/specification)). Frontmatter may only use `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`. `name` must match the folder name. `metadata.version` matches `cli/package.json`. `metadata.hermes` and `metadata.openclaw` stay nested: `hermes.related_skills` is a list (the two skills name each other, plus `mise` and `cloudflare` on the setup skill), and `openclaw.envVars` uses booleans for `required` and `sensitive`. Long setup detail lives under `skills/a2a-exposed-setup/references/`. Day-to-day tables live under `skills/a2a-exposed/references/`. Which clients are supported is in the [compatibility table](docs/getting-started.md#clients).
- Plugin manifests (same `skills/` tree; do not duplicate skills):
  - `plugin.json` — portable [Agent Plugins](https://agent-plugins.org/) 1.0.0. `extensions.com.openai.onboardingSkill` points at the setup skill.
  - `.cursor-plugin/plugin.json` — sets `logo` and `skills`.
  - `.grok-plugin/plugin.json` — that marketplace publishes no schema.
  - `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` — Claude Code. The marketplace plugin entry carries the same version as `plugin.json`.
  - No separate overlay is required when `plugin.json` is present. Bare repo skill discovery without installing the plugin uses `.agents/skills/` (not used here — install the plugin or `npx -y skills add`).
- `.github/workflows/`: `ci.yml` (pushes to main and PRs) and `publish.yml` (`v*` tags: npm publish + GitHub release).

## Checks (what CI runs)

At the repository root, run `npm run lint`, `npm run format:check`, and
`npm run test:checks` (Node and Python only; no install). Lint checks JavaScript
and Python syntax, JSON parsing, and immutable Action references. Format checks
tracked text files for trailing whitespace, LF endings, and a final newline; it
does not impose a new indentation style. TypeScript checking remains in the
component jobs below.

CI runs `npm run test:coverage` instead of `npm test` in `worker/`, `cli/`,
and `control/`, and publishes source-only LCOV artifacts for 14 days. For local
coverage runs, create `coverage/` at the repository root first. These reports
cover the Node tests (not subprocess execution, Vitest/workerd, or the storage
matrix); control still runs its Vitest suite without coverage. Coverage is
informational, with no blanket percentage threshold.

Run with any real `WAKE_*`, `A2A_*`, `CF_*`, `CLOUDFLARE_*` variables unset: the CLI tests use a throwaway `A2A_CONFIG_DIR` and a stub `cf`.

```bash
cd worker && npm ci && npm test && npx cf workers types && npx tsc --noEmit && npx cf build
cd ../cli && npm test && npm pack --dry-run
cd ../control && npm ci && npm test && npx cf workers types && npx tsc --noEmit && npm run build && node scripts/check-build.mjs
cd .. && npx -y skills add ./ --list
# Agent Skills + Agent Plugins (same as CI):
python3 -m venv .skills-ref-venv && .skills-ref-venv/bin/pip install -q "skills-ref @ git+https://github.com/agentskills/agentskills.git@69ef37e9424c0a7ea9dd2293b559e43ec8176379#subdirectory=skills-ref" jsonschema
.skills-ref-venv/bin/skills-ref validate skills/a2a-exposed
.skills-ref-venv/bin/skills-ref validate skills/a2a-exposed-setup
.skills-ref-venv/bin/pip install -q pyyaml
.skills-ref-venv/bin/python scripts/check-skill-metadata.py
.skills-ref-venv/bin/python scripts/check-plugin-schemas.py
node scripts/check-skill-plugin.mjs
npx --yes @anthropic-ai/claude-code@2.1.296 plugin validate . --strict
```

None of these need Cloudflare credentials. Never deploy to a real account from tests.

The same Worker tests also run in CI against workerd storage (`STORAGE_BACKEND=d1` and `STORAGE_BACKEND=do` in `worker/`). `migrations.test.ts` stays on node:sqlite via `d1On`. Do not set `STORAGE_BACKEND` for the CLI tests: they import `worker/test/d1.ts`.

## Rules

- Never commit secrets, account ids, zone names, or hostnames of real deployments; examples use `example.com`.
- Never print secret values: previews mask them, and comparisons use SHA-256 fingerprints.
- A user-visible change (command, flag, preset, output) updates `README.md` when the short intro changes, the relevant page under `docs/`, the relevant `SKILL.md`, `cli/lib/main.mjs` help, and `CHANGELOG.md` in the same PR.
- New wake presets: see `CONTRIBUTING.md`.
- Releases: bump `version` in `cli/package.json`, the root `package.json` (`@a2a-exposed/control-core`), both skills' `metadata.version`, and every plugin manifest (`plugin.json`, `.cursor-plugin/`, `.grok-plugin/`, `.claude-plugin/`, including the marketplace plugin entry). Copy `description` and `keywords` from `plugin.json` into the other manifests. `node scripts/check-skill-plugin.mjs` fails when those copies drift. Add a `CHANGELOG.md` entry, merge, then push a `v<version>` tag. The workflow sets both npm versions from the tag. `a2a-exposed` publishes with `NPM_TOKEN`. `@a2a-exposed/control-core` publishes with npm trusted publishing.
