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
- **CLI** (`cli/`): plain Node ESM with zero dependencies. Check it with `node cli/bin/a2a-exposed.mjs --help` and `cd cli && npm test` (uses a throwaway `A2A_CONFIG_DIR`; unset any real `WAKE_*` secrets first). `npm pack` bundles `worker/` through the prepack script. It does not bundle `control/`.
- **Control core** (`@a2a-exposed/control-core`, `package.json` at the repository root): the entry is `control/src/core/index.ts`. `cd control && npm test` includes the contract test for that entry. The `a2a-exposed` tarball does not include it.
- **Control plane** (`control/`): Hono on Workers plus static assets, deployed with `cf` the same way as `worker/`. `cd control && npm test && npx cf workers types && npx tsc --noEmit && npm run build`. Leave `BRAND_NAME` and the other `CONTROL_*` variables unset to see the neutral shell. Overlay rules are in `control/OVERLAY.md`.
- **Skills** (`skills/*/SKILL.md`): the frontmatter `name` must match the folder name. Check discovery with `npx -y skills add ./ --list`.
- **New wake presets:** add the preset to `worker/src/wake.ts` (`PRESETS` and `renderWake`), add a test in `worker/test/wake.test.ts`, list it in the CLI (`cli/lib/deploy.mjs`), and document the request shape in `docs/receiving-messages.md` and the setup skill, with a link to the target's docs. Say which agents were tested end to end. Describe any other webhook target as untested.
- Never commit secrets, account ids, or hostnames of real deployments.
- **Releases:** bump `version` in `cli/package.json`, in the root `package.json` (`@a2a-exposed/control-core`), and in both skills' frontmatter, add a `CHANGELOG.md` entry, merge, then push a `v<version>` tag; `.github/workflows/publish.yml` sets both package versions from the tag, publishes them to npm, and creates the GitHub release. CI (`.github/workflows/ci.yml`) runs the same checks as above on every PR. See also [AGENTS.md](AGENTS.md).
