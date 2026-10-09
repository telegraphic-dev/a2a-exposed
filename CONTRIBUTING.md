# Contributing

Issues and pull requests are welcome.

- **Worker** (`worker/`, TypeScript):
  ```bash
  npm install
  npm test        # wake presets, A2A 1.0/0.3 serialisation, tokens; Node 22.18+
  npx tsc         # after `npx cf workers types`
  npx cf build
  ```
  To run it locally, use `npx cf dev` with a `.dev.vars` file containing `OWNER_TOKEN=...`. D1 migrations live in `worker/migrations/`; add new numbered files instead of editing old ones.
- **CLI** (`cli/`): plain Node ESM with zero dependencies. Check it with `node cli/bin/a2a-exposed.mjs --help` and `cd cli && npm test` (uses a throwaway `A2A_CONFIG_DIR`; unset any real `WAKE_*` secrets first). `npm pack` bundles `worker/` through the prepack script.
- **Skills** (`skills/*/SKILL.md`): the frontmatter `name` must match the folder name. Check discovery with `npx -y skills add ./ --list`.
- **New wake presets:** add the preset to `worker/src/wake.ts` (`PRESETS` and `renderWake`), add a test in `worker/test/wake.test.ts`, list it in the CLI (`cli/lib/deploy.mjs`), and document it in the setup skill and the README table, with a link to the target's docs.
- Never commit secrets, account ids, or hostnames of real deployments.
- **Releases:** bump `version` in `cli/package.json` and in both skills' frontmatter, add a `CHANGELOG.md` entry, merge, then push a `v<version>` tag; `.github/workflows/publish.yml` publishes to npm and creates the GitHub release. CI (`.github/workflows/ci.yml`) runs the same checks as above on every PR. See also [AGENTS.md](AGENTS.md).
