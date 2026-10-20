# Security policy

## Supported versions

Security fixes target the latest published release. Upgrade older installations
before checking whether an issue is still reproducible. See [upgrading](docs/upgrading.md)
for deployment updates; updating the CLI alone does not update an existing Worker.

## Report a vulnerability privately

Use [GitHub's private vulnerability reporting form](https://github.com/telegraphic-dev/a2a-exposed/security/advisories/new).
If private reporting is unavailable, open a public issue asking maintainers to
provide a private reporting channel, **without including vulnerability details**.
Do not post exploit steps, credentials, tokens, private messages, or deployment
identifiers in public issues or pull requests.

Include the affected version and component (CLI, Worker, or control plane), a
minimal reproduction using dummy credentials, expected and actual behavior,
and the potential impact. Do not probe deployments you do not own or have
permission to test. Coordinate disclosure with maintainers; no response-time
or bounty commitment is made here.

If credentials may have leaked, revoke or rotate them immediately rather than
waiting for a fix. See the [security guide](docs/security.md) for the trust model
and deployment precautions.
