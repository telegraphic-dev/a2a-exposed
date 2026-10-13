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
- **Library** (`@a2a-exposed/control-core`, `package.json` at the repository root): the source entry is `control/src/core/index.ts`. `prepare` compiles it to JavaScript and declarations on `npm pack` and on a `file:` install. `cd control && npm test && npx tsc --noEmit` runs the Node tests, a Vitest suite inside Miniflare, and the typecheck. The Vitest suite runs the Cloudflare provisioning calls in workerd against a mocked Cloudflare API, with no account credentials. The contract test installs the package and imports it. The `a2a-exposed` tarball does not include `control/`. See `control/README.md`.
- **Skills** (`skills/*/SKILL.md`): the frontmatter `name` must match the folder name. Check discovery with `npx -y skills add ./ --list`.
- **New wake presets:** add the preset to `worker/src/wake.ts` (`PRESETS` and `renderWake`), add a test in `worker/test/wake.test.ts`, list it in the CLI (`cli/lib/deploy.mjs`), and document the request shape in `docs/receiving-messages.md` and the setup skill, with a link to the target's docs. Say which agents were tested end to end. Describe any other webhook target as untested.
- Never commit secrets, account ids, or hostnames of real deployments.
- **Releases:** bump `version` in `cli/package.json`, in the root `package.json` (`@a2a-exposed/control-core`), and in both skills' frontmatter, add a `CHANGELOG.md` entry, merge, then push a `v<version>` tag; `.github/workflows/publish.yml` sets both package versions from the tag, publishes them to npm, and creates the GitHub release. `a2a-exposed` publishes with the `NPM_TOKEN` secret. `@a2a-exposed/control-core` publishes with npm trusted publishing. CI (`.github/workflows/ci.yml`) runs the same checks as above on every PR. See also [AGENTS.md](AGENTS.md).
