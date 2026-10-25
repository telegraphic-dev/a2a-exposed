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

- **New wake presets:** add the preset to `worker/src/wake.ts` (`PRESETS` and `renderWake`), add a test in `worker/test/wake.test.ts`, list it in the CLI (`cli/lib/deploy.mjs`), and document the request shape in `docs/receiving-messages.md` and the setup skill, with a link to the target's docs. Say which agents were tested end to end. Describe any other webhook target as untested.
- Never commit secrets, account ids, or hostnames of real deployments.
- **Releases:** maintainers cut releases; agents do not publish or push tags.
  Follow the complete version and manifest checklist in [AGENTS.md](AGENTS.md#release).
  The tag workflow publishes both npm packages and creates the GitHub release.
- Infrastructure belongs to the separate Terraform repository. Real self-host QA
  uses a dedicated maintainer-provided test account/profile, never the owner's
  main account. Automated checks need no Cloudflare credentials and never deploy.
- Write docs for outsiders, in present tense, with no decision log. Keep README
  short and `docs/` authoritative. Mark platforms without end-to-end testing
  `untested` or `in testing`, following the client compatibility table.
