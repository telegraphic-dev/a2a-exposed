# Portable MCP Skills packaging

The portable MCP edition is a separate generated artifact. It is not a replacement
for the canonical filesystem skills or plugin packages. The native Worker serves this edition behind its existing MCP authorization.
The hosted account connector consumes an upstream release through its separate
package pin; it does not inherit native capability advertisement automatically.

## Identity and source

`skills/a2a-exposed/` and `skills/a2a-exposed-setup/` remain the canonical source.
Their nested Hermes/OpenClaw metadata and operating dependency metadata are
unchanged. Existing filesystem and plugin packages continue to use those files.

The MCP edition publishes only these separate identities:

- `skill://portable/a2a-exposed/SKILL.md`
- `skill://portable/a2a-exposed-setup/SKILL.md`

Supporting files use the same `portable/` prefix. The server publishes one edition
per logical skill on a surface; it never changes file bytes based on the client.
Cache identities include the originating server and complete resource URI.

## Frontmatter contract

The generated portable files retain `name`, `description`, `license`,
`compatibility` and `allowed-tools` when present. Their metadata contains the
string fields `version`, `author` and `homepage`. The generator omits canonical
platform-only `hermes`, `openclaw` and `required_skills` fields from both the
portable file and its published frontmatter. Unknown fields fail generation until
the packaging contract assigns them a meaning. This is an explicit edition,
not filtering frontmatter independently of its file.

The Markdown body stays byte-identical. Operating instructions retain the
required companion setup link. Relative supporting links and the companion link
resolve within the portable namespace. Each skill still needs its own host
approval; loading one does not approve its companion. Supporting files retain
all their original bytes. The generator calculates every manifest digest and size
from the portable edition's actual bytes, including its generated frontmatter.

## Generation and verification

Run `node worker/scripts/mcp-portable-skills-catalog.mjs` to generate the catalog;
add `--check` to fail on drift. Generation requires a Git source inventory and
rejects untracked or ignored files under the skills tree. Review source changes
before generating release artifacts. File-count and aggregate byte budgets apply
before storing source bytes; per-skill limits apply to complete manifests.

The official SDK strict catalog loader validates the portable files. The runtime
prototype uses the official `SkillsExtension`, with exact published resource
membership and lossless UTF-8 Markdown text responses. Binary content stays a
blob. It does not fetch resource URLs or open files at request time.

Tests cover deterministic generation, unchanged canonical bytes and bodies,
unassigned-field refusal, companion discovery, resource sizes and SHA-256 digests,
and the official `SkillsClient` loading both skills and all supporting files.
A loose wire-schema pass alone does not establish Agent Skills format
conformance. Canonical nested metadata remains incompatible with the strict SDK
helper and must not be advertised as portable.

The public `version:set` command regenerates the edition after changing source
versions. Worker tests and CLI packaging reject catalog drift. Every Worker build
checks embedded identities, version and resource integrity without requiring Git
or canonical sources in an installed CLI template. Run full repository suites
and prove discovery, separate approval and verified lazy reads from the exact
integrated compiled Worker in a supported host before release.
Hosted integration must consume a released pinned upstream catalog, never a
hand-maintained copy. Runtime authorization, limits, origin checks, package
contents, and hosted/native/local-client capability matrices remain separate gates.
