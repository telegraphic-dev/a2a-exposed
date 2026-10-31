# Create or finish your own hosted secure link

Run this on the receiving bot's own machine. No second bot or clipboard
handoff is needed. Obtain human authorization for setup and resource creation.
First sign the CLI in to the intended service with `login --control-url
<service-origin>`; the human approves the login. The saved session is used
only to start setup on that same service. A different service requires login
there first; never reuse an owner or peer credential.

For a new link:

```bash
npx -y a2a-exposed@latest hosted link create --agent example \
  --control-url https://control.example --hostname wake.example.com \
  --origin http://127.0.0.1:8644 --path /webhooks/inbox --preset hermes \
  --secret-from hermes --route inbox
```

The human approves the exact creation plan on the printed page before any
resources are created. The page offers Cloudflare reconnect if needed.
An identical ready link is reused. `link_exists` means a different link is
already present: explain the conflict, never remove it automatically.
`provision_failed` means check the approval page for the failing phase and
cleanup state before retrying. Retries need fresh approval and reuse the same
matching ready link; the CLI never silently reprovisions.

Creation then performs the finish steps below. The returned hostname, origin,
path and preset must match the request before local signing-secret access.
All four create fields are required. Hermes creation requires its exact
`/webhooks/<name>` path and the `hermes` preset.

For an existing ready link, use finish:
The CLI prints the approval URL and user code; the human signs in and approves.
Never open/fill the approval page, read secret values into chat, use the
clipboard, or pass secret values as arguments.

```bash
npx -y a2a-exposed@latest hosted link finish --agent example \
  --control-url https://control.example --secret-from hermes \
  --hermes-home /path/to/hermes-home --route inbox
```

Requires a site with link-finish enabled, a ready link, and cloudflared installed
on the receiving agent's machine. This command is awaiting staging end-to-end
testing; mocked tests do not establish client support.

`--control-url` defaults to saved `CONTROL_URL`. Exactly one signing source is
required: `--secret-file FILE`, `--secret-env VAR`, or `--secret-from hermes`.
Files must be regular files, mode 600, without symlinks. The Hermes adapter
reads `webhook_subscriptions.json` at `--hermes-home`, `HERMES_HOME`, or
`~/.hermes`. The approved path must be `/webhooks/<name>` and the preset
`hermes`; `--route`, if supplied, must match. It refuses missing, disabled, or
unsigned routes. Static routes in config.yaml may override subscriptions, so
use a private file or environment source when static routes are present. The
adapter does not guess across profiles or support profile-prefixed paths.

After human approval, the token goes to `~/.a2a-exposed/links/<agent>.token`,
or `--token-file FILE`, by a mode-600 atomic write. cloudflared starts in the
background with `--token-file`, without the token in its arguments or output.
No startup service is installed. The CLI polls the grant-authorized connector
status every three seconds for up to 60 seconds. It submits the signing secret
only after connected status. Only a passing wake test saves the settings.

`--no-run` writes the token and prints the connector command, stopping before
the wake test/save. Start it locally and rerun finish without `--no-run` for a
fresh approval. If delivery, writing, connection, or testing fails, fix the
reported phase and rerun; fresh approval reuses the same ready link without
provisioning. Never mark a failed or skipped wake test as saved.
