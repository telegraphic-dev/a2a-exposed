# ClawHub publishing

The release workflow publishes `skills/a2a-exposed` and
`skills/a2a-exposed-setup` to [ClawHub](https://clawhub.ai) after both npm
packages and the GitHub release succeed. The slugs match the skill folder
names; the version matches `cli/package.json` and the maintainer's `v<version>`
tag. Stable releases use `latest`; prereleases use `next`.

## Credentials and owner

Add a ClawHub API token as the repository Actions secret `CLH_TOKEN`, the same
secret name used by the ClawBuddy release workflows. The token must be allowed
to publish both slugs. Create it in [ClawHub settings](https://clawhub.ai/settings);
account authorization remains a human action. Supply it through GitHub's secret
UI or protected stdin to `gh secret set CLH_TOKEN`, never a command argument.

The default publisher is the token's account. Set the repository Actions
variable `CLAWHUB_OWNER` to publish under a specific user or organization handle
that the token can access. Select that handle from the publishers shown in
ClawHub for the signed-in account; `clawhub --no-input whoami` confirms the
account associated with a locally configured token.

The workflow pins `clawhub@0.25.0`, runs with `--no-input`, and writes the token
to a temporary mode-600 config file. It removes that file even after failure.
PRs and previews receive no publishing token and cannot publish. A missing token
fails a real publish with configuration guidance; publishing errors fail the job.

## Preview and release

Pull requests affecting the skills or publishing workflow preview both skills
without uploading. The manual workflow defaults to preview mode too:

```bash
gh workflow run clawhub.yml --ref main -f dry_run=true
```

The preview uses ClawHub's read-only registry resolution, so it needs network
access. It prints JSON with the intended version, file count and fingerprint.
It does not verify publishing permissions or reserve either slug.

Maintainers publish by pushing the release tag through the existing
[release process](../../AGENTS.md#release). To publish the skills for an existing
tag, explicitly select the tag and turn off preview:

```bash
gh workflow run clawhub.yml --ref v<version> -f dry_run=false
```

The selected tag must contain this workflow, and its version must match the
committed packages and skill metadata. The workflow records the source repo,
commit, ref and skill path on each submission. ClawHub may hold a submission for
security scans before it becomes public.

Each skill has its own matrix job. After a partial failure, rerun only failed
jobs with `gh run rerun <run-id> --failed`; do not republish a successful immutable
version. A ClawHub failure does not undo npm packages or the GitHub release.
