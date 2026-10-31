# Feedback

A hosted A2A endpoint files the issue. A self-hosted one prints a prefilled GitHub link. `feedback --json` returns `{ "filed": false, "url": "…" }` for a link, or `{ "filed": true, "issue": "…" }` for a posted report.

`npx -y a2a-exposed@latest feedback "message"` reports a bug or an idea. The report is a public GitHub issue. Do not include confidential information: secrets, tokens, owner or pairing tokens, private URLs or hostnames, message contents, or personal data.

The command names the repository before it sends, prints that warning, and asks before sending. `--yes` skips the question. Off a terminal, posting requires `--yes`. Printing a prefilled link needs no confirmation.

```bash
npx -y a2a-exposed@latest feedback "messages stay in submitted" \
  --kind bug --steps "1. peer sent SendMessage" \
  --expected "a wake" --actual "the inbox command shows the task, no wake" \
  --agent "the agent you run" --environment local \
  --connection webhook --yes
```

| Flag | Values |
| --- | --- |
| `--kind` | `bug`, `idea`, or `other` (the default). A bug needs `--steps` |
| `--steps`, `--expected`, `--actual`, `--logs` | Optional detail. A bug needs steps. Redact `--logs` before you send them |
| `--agent` | Which agent, for example Claude Code, Grok Bot, or custom |
| `--environment` | `local`, `cloud VM`, `CI`, `cloud agent sandbox`, or `other` |
| `--connection` | `webhook`, `proxy`, or `polling`. Overrides detection |
| `--contact` | Optional |

## What is included

Every report includes the a2a-exposed version, the connection, and the deployment, under the same headings as the GitHub bug report form (`a2a-exposed version`, `Connection type`, `Deployment`). A missing value is `unknown`.

- **Version.** The CLI version, and the A2A endpoint Worker version when `GET /owner/feedback` reports one, for example `0.8.0 (worker 0.8.0)`.
- **Connection.** `webhook`, `proxy` (a façade, `--upstream`), or `polling`. The A2A endpoint report wins. Without one, the CLI uses `A2A_UPSTREAM_URL`, then `WAKE_WEBHOOK_URL`, then polling.
- **Deployment.** `hosted` when the A2A endpoint reports hosted. `self-hosted` when the A2A endpoint reports self-hosted, or when this machine has no A2A endpoint config.

The OS, the Node version, `--environment`, and `--logs` are included when they are known. Owner, peer, and MCP tokens, Bearer values, a PEM private key, and common API-key prefixes are removed from the text that is sent.

## Where it goes

When the A2A endpoint reports a feedback URL, the command posts the message there. The filed issue uses the labels of the matching form: `bug` and `feedback` for a bug, `enhancement` and `feedback` for an idea, and `feedback` otherwise. A report from the CLI or from MCP also gets `from-agent`.

Otherwise the command prints a link to the bug report form (`template=bug_report.yml`, fields filled in) on `telegraphic-dev/a2a-exposed`. The A2A endpoint names the repository that receives a filed report.

## MCP

The MCP tool `send_feedback` takes the same fields. An approved connector calls it. Its description says the issue is public. The result names the repository in the issue URL. On a self-hosted A2A endpoint the form is on `telegraphic-dev/a2a-exposed`. A bug needs steps. Version, connection, and deployment are filled by the A2A endpoint when the tool call omits them.

Blank GitHub issues are off. The forms under `.github/ISSUE_TEMPLATE/` are the issue templates, and they carry the same public-issue warning.
