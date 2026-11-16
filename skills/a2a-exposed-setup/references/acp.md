# ACP session relay setup

When the owner wants a local ACP v1 stdio agent rather than a wake receiver, use
[the ACP setup/session contract](https://github.com/telegraphic-dev/a2a-exposed/blob/main/docs/http-relay.md#local-acp-agent-and-session-targeting).
Obtain approval for relay enrollment and the exact local executable/cwd first.
Use `relay a2a run --acp` with JSON argv, `--acp-cwd` and a mode-600
`--acp-peers-file` of independent application token hashes; forward `authorization`
at enrollment. Worker pairing and shared ingress are not application peer auth.
Prefer `--acp-session ID --acp-session-peer NAME` when exposing an existing
conversation. Require advertised `loadSession` and fail rather than creating a
replacement; never accept session selection from peer text. Keep native tool
permissions enabled; cwd is not a sandbox, and canceled permission requests need
local owner resolution. Hosted wake-relay support does not imply HTTP-relay
support; verify the separate runtime feature before enrollment. No deployment,
credential changes or real provider inference is authorized by this guidance.
