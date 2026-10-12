# Feedback

`npx -y a2a-exposed@latest feedback "message"` reports a bug or an idea. The report is a public GitHub issue. Do not include confidential information: secrets, tokens, owner or pairing tokens, private URLs or hostnames, message contents, or personal data.

The command names the repository before it sends, prints that warning, and asks before sending. `--yes` skips the question. Off a terminal, `--yes` is required.

```bash
npx -y a2a-exposed@latest feedback "messages stay in submitted" \
  --kind bug --steps "1. peer sent SendMessage" \
  --expected "a wake" --actual "inbox shows the task, no wake" \
  --agent "the agent you run" --environment local \
  --connection webhook --yes
```

| Flag | Values |
| --- | --- |
| `--kind` | `bug`, `idea`, or `other` (the default). A bug needs `--steps` |
| `--steps`, `--expected`, `--actual`, `--logs` | Optional detail. A bug needs steps. Redact `--logs` before you send them |
| `--agent` | Which agent, for example Claude Code, Grok Bot, n8n, or custom |
| `--environment` | `local`, `cloud VM`, `CI`, `cloud agent sandbox`, or `other` |
| `--connection` | `webhook`, `proxy`, or `polling`. Overrides detection |
| `--contact` | Optional |

## What is included

Every report includes the a2a-exposed version, the connection, and the deployment, under the same headings as the GitHub bug report form (`a2a-exposed version`, `Connection type`, `Deployment`). A missing value is `unknown`.

- **Version.** The CLI version, and the inbox Worker version when `GET /owner/feedback` reports one, for example `0.7.0 (worker 0.7.0)`.
- **Connection.** `webhook`, `proxy` (a façade, `--upstream`), or `polling`. The inbox report wins. Without one, the CLI uses `A2A_UPSTREAM_URL`, then `WAKE_WEBHOOK_URL`, then polling.
- **Deployment.** `hosted` when the inbox says it is hosted, and `self-hosted` when the inbox says it is not, or when this machine has no inbox config.

The OS, the Node version, `--environment`, and `--logs` are included when they are known. Owner, peer, and MCP tokens, Bearer values, a PEM private key, and common API-key prefixes are removed from the text that is sent.

## Where it goes

When this inbox is hosted and its control plane accepts feedback, the command posts the message there. The filed issue uses the labels of the matching form: `bug` and `feedback` for a bug, `enhancement` and `feedback` for an idea, and `feedback` otherwise. A report from the CLI or from MCP also gets `from-agent`.

Otherwise the command prints a link to the bug report form (`template=bug_report.yml`, fields filled in) on `telegraphic-dev/a2a-exposed` and does not open a browser. A hosted inbox uses the control plane's `FEEDBACK_REPO`. `GET /api/feedback` returns `{ repo }` when that route is on.

## MCP and the web form

The MCP tool `send_feedback` takes the same fields. An approved connector can call it. A peer token or the owner token cannot. Its description says the issue is public. The result names the repository in the issue URL. A hosted inbox does not name the prefilled-form repository in that description. On a self-hosted inbox the form is on `telegraphic-dev/a2a-exposed`. A bug needs steps. Version, connection, and deployment are filled by the inbox when the tool call omits them.

A control plane with `FEEDBACK_REPO` and either the GitHub App (`FEEDBACK_GITHUB_APP_ID` and `FEEDBACK_GITHUB_APP_PRIVATE_KEY`) or `FEEDBACK_GITHUB_TOKEN` also serves `/app/feedback`, with the same fields. The form, next to the submit button, names that repository and says the issue is public. The agent page links to the form with `hosted` and the connection filled in, from that agent's settings. With neither credential, or with the repo unset, that route is 404.

The app is used when both the app id and the private key are set. If that id is not numeric, or the key is not a PEM, the post answers 502 and the personal access token is not used. `FEEDBACK_GITHUB_APP_INSTALLATION_ID` is optional. Unset, the app looks the installation up. A non-numeric installation id answers 502 and does not look the installation up. The token is the fallback only when the app id or the private key is unset. The private key accepts GitHub's PKCS#1 PEM. Browser posts use the same Turnstile check as sign-in when that check is configured.

Blank GitHub issues are off. The forms under `.github/ISSUE_TEMPLATE/` are the issue templates, and they carry the same public-issue warning.
