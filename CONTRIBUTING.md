# Contributing

Issues and pull requests are welcome.

Start with [AGENTS.md](AGENTS.md) for repository layout, setup, commands,
security invariants, PR/review rules, and releases. The complete local and CI
checklist is [Contributor verification and QA](docs/agents/verification.md).
Use Node 22.18+; install locked dependencies with `npm ci` in `worker/` and
`control/`. The CLI has zero dependencies. Run the full suite before pushing,
including both storage backends and time-sensitive tests in Prague and UTC.

Work on a branch from up-to-date `main` and open a PR against `main`. Reference
the issue with `Closes #N` or `Refs #N`. Keep dependency bumps separate from
feature work. Merge requires green CI, `jean-ci` approval of the current head
from `jean-de-bot`, and zero unresolved review threads. Address all failures and
comments in one pass, validate, push once, then resolve addressed threads.

- **New wake presets:** add the preset to `worker/src/wake.ts` (`PRESETS` and `renderWake`), add a test in `worker/test/wake.test.ts`, list it in the CLI (`cli/lib/deploy.mjs`), and document the request shape in `docs/receiving-messages.md` and the setup skill, with a link to the target's docs. Describe what works with that preset.
- Never commit secrets, account ids, or hostnames of real deployments.
- **Releases:** maintainers cut releases; agents do not publish or push tags.
  Follow the complete version and manifest checklist in [AGENTS.md](AGENTS.md#release).
  Open a PR running `npm run version:set -- <x.y.z>`, merge it into `main`,
  then a maintainer pushes the matching `vX.Y.Z` tag from the merged commit.
  The tag workflow checks committed versions, publishes both npm packages, and
  creates the GitHub release with `gh release create --generate-notes`. The generated notes follow
  `.github/release.yml` and accompany the installation and upgrade instructions.
- Infrastructure belongs to the separate Terraform repository. Real self-host QA
  uses a dedicated maintainer-provided test account/profile, never the owner's
  main account. Automated checks need no Cloudflare credentials and never deploy.
- Write docs for outsiders, in present tense, with no decision log. Keep README
  short and `docs/` authoritative. Describe what works. Do not add product
  verification or maturity labels.

## PR titles and release notes

[GitHub Releases](https://github.com/telegraphic-dev/a2a-exposed/releases) is the
single source of release notes. Write a clear PR title describing the resulting
behavior for users, and add the appropriate label before merge. Never edit a
changelog or add a shared Unreleased section. Keep upgrade requirements and
migration instructions in the relevant user documentation and link them from
the PR description.

| Label | Release category |
| --- | --- |
| `breaking-change` | Breaking changes; takes precedence over other categories |
| `enhancement` | Features |
| `bug` | Fixes |
| `documentation` | Documentation |
| `dependencies` | Dependencies |
| `skip-release-notes` | Excluded from public notes, including staging work and internal changes with no user-facing effect |

The first matching category wins in the order shown. PRs without a matching
label appear in Other changes. `skip-release-notes` excludes a PR regardless of
its other labels. Split internal staging work from user-facing changes when
only part of a PR belongs in public notes. Maintainers create missing labels
before using them. The configuration also applies to manual
`gh release create --generate-notes`; release creation and tagging remain
maintainer actions.

## Release note seed

Maintainers can preview the one-time release-body seed with
`node scripts/seed-release-notes.mjs --dry-run`. The command prints a JSON plan
from the frozen `scripts/fixtures/release-notes-seed.json` input and performs no
network requests or writes. It includes versioned entries only, never pending
work. Maintainers review the plan and copy each body into the matching existing
GitHub release, preserving any useful existing instructions. Do not create
missing releases or tags as part of this step. The seed is migration input,
not an ongoing notes file; PRs never update it.
