# AGENTS.md

Guide for coding agents (and humans) changing this repository. User-facing docs are in `README.md` and `skills/`.

## Layout

- `worker/`: Cloudflare Worker (TypeScript, D1, `cf` CLI config in `cloudflare.config.ts`). Migrations in `worker/migrations/` are append-only: add a new numbered file, never edit an old one. Each number is used once. `cf d1 migrations apply` (run by `init`/`deploy`) applies every file not yet recorded in `d1_migrations`, in numeric order, so a lower number added later still runs on existing databases. `worker/test/migrations.test.ts` checks the numbering and replays upgrades from older databases.
- `cli/`: the npm package `a2a-exposed` (Node 22.18+ ESM, **zero dependencies**: keep it that way). `npm pack` bundles `../worker` as the deploy template via `cli/scripts/sync-worker.mjs` (prepack); `cli/worker/` and `cli/LICENSE` are generated, not committed.
- `skills/<name>/SKILL.md`: the two agent skills. The frontmatter `name` must match the folder name; keep `version` in step with `cli/package.json`, and keep `related_skills` pointing at each other (plus the optional companion skills by their skill `name`: `mise`, `cloudflare`).
- `.github/workflows/`: `ci.yml` (pushes to main and PRs) and `publish.yml` (`v*` tags: npm publish + GitHub release).

## Checks (what CI runs)

Run with any real `WAKE_*`, `A2A_*`, `CF_*`, `CLOUDFLARE_*` variables unset: the CLI tests use a throwaway `A2A_CONFIG_DIR` and a stub `cf`.

```bash
cd worker && npm ci && npm test && npx cf workers types && npx tsc --noEmit && npx cf build
cd ../cli && npm test && npm pack --dry-run
cd .. && npx --yes skills add ./ --list
```

None of these need Cloudflare credentials. Never deploy to a real account from tests.

## Rules

- Never commit secrets, account ids, zone names, or hostnames of real deployments; examples use `example.com`.
- Never print secret values: previews mask them, and comparisons use SHA-256 fingerprints.
- A user-visible change (command, flag, preset, output) updates `README.md`, the relevant `SKILL.md`, `cli/lib/main.mjs` help, and `CHANGELOG.md` in the same PR.
- New wake presets: see `CONTRIBUTING.md`.
- Releases: bump `version` in `cli/package.json` and both skills, add a `CHANGELOG.md` entry, merge, then push a `v<version>` tag. The workflow sets the npm version from the tag.
