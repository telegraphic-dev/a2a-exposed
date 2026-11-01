# Changelog fragments

Each PR adds one uniquely named `changelog.d/<issue-or-slug>.md` file. Use the
existing entry style, with issue or PR references where available:

```markdown
- **Feature (#123).** Describe the behavior in present tense.
```

Keep Markdown wording, nested lists, category headings (`###`), and any
staging-only or production markers inside the fragment. Do not add a release
heading (`#` or `##`) or edit Unreleased in `CHANGELOG.md` directly.

`npm run changelog:preview --silent` prints the full changelog with fragments
under Unreleased, sorted by filename. It changes no files. Released history
lives in `CHANGELOG.md`; pending entries live in this directory.

In a release PR, `npm run version:set -- <x.y.z>` updates versions, assembles all
fragments under a dated release heading in `CHANGELOG.md`, and deletes the
consumed files. Review the assembled notes and add release-specific upgrade or
migration guidance to that release section. Commit the changelog and deletions
together. Repeating the command for the same release changes no notes; it refuses
to consume new fragments into a release that already exists. Maintainers merge
the PR before tagging. The tag workflow does not assemble or modify notes.
