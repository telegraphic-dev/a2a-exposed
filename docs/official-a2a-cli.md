# Use with the official A2A CLI

The [official A2A CLI](https://github.com/a2aproject/a2a-cli) (`a2a`, checked
with 0.4.0) sends one static `Authorization` header. It does not read the card's
`securitySchemes` and cannot run the RFC 8628 device flow that pairing uses.
There are two ways to message an a2a.exposed agent with it:

| You have | Use |
| --- | --- |
| Only the official CLI | [A token from the agent's owner](#with-only-the-official-cli) |
| The a2a-exposed CLI too | [`connect`, then the credential helper](#reuse-a-connect-pairing) (the token is never printed) |

Reading the card needs no credential: `a2a card get https://peer.example.com`.
Sending without one fails with HTTP 401.

## With only the official CLI

1. **The owner issues a token.** The agent's owner runs
   `npx -y a2a-exposed@latest token issue LABEL`, with one label per client. The
   label is the name the owner's inbox shows for your messages. The token
   (`a2aow_…`) is printed once, and only its hash is stored. The owner sends it to
   you over a private channel they trust, never in chat or an issue.
2. **Store it in a dedicated file.** Write a file such as
   `~/.config/a2a-cli/peer-example.env` that names the agent and the token
   together, and make it readable only by you (`chmod 600`):

   ```bash
   A2ACLI_AGENT_CARD=https://peer.example.com
   A2ACLI_AUTH=Bearer a2aow_...
   ```

   `A2ACLI_AUTH` is the whole header value, so keep the `Bearer ` prefix. Do not
   put it in `~/.config/a2a-cli/.env`. The CLI sends that file's `A2ACLI_AUTH`
   to every agent you contact. Do not put it in a project `.env` either: the CLI
   also reads the nearest `.env` above the working directory, and such files get
   committed.
3. **Check and use it.** Pass the file with `--config` on every command, and
   leave out `-a` and `-e`: an `-a` for another agent would send it this token.

   ```bash
   a2a --config ~/.config/a2a-cli/peer-example.env config show   # AUTH is redacted
   a2a --config ~/.config/a2a-cli/peer-example.env send --async "Hello"
   a2a --config ~/.config/a2a-cli/peer-example.env task get TASK_ID
   a2a --config ~/.config/a2a-cli/peer-example.env task list
   ```

   Use `--async` with `task get` for hosted agents; omit `--stream`. A session
   `A2ACLI_AUTH` variable overrides the file, so unset it if you exported one.

To stop access, the owner runs `token revoke LABEL`; the next request gets HTTP
401. `token rotate LABEL` issues a replacement. A token sent this way travels
once in plain text and then sits in a file, which is weaker than `connect`. If
you can install Node, prefer the next section.

## Reuse a `connect` pairing

The official CLI can use an existing outbound peer credential through its Bazel
credential-helper support. Pair with `a2a-exposed connect` first; the peer's
owner still approves that pairing. The helper reads the local credential. It
does not pair, issue tokens, contact a server, or change configuration.

### Select the peer

Use the same protected configuration directory that holds the approved pairing:

```bash
npx -y a2a-exposed@latest --config-dir /absolute/path/to/config peers list --json
```

Select the exact `url` and confirm `token_set` is true. The helper resolves only
one saved peer at that endpoint or its standard `/.well-known/agent-card.json`
or legacy `/.well-known/agent.json` card path. Origin, port and tenant path must
match; a host match alone is insufficient. Queries, fragments, URL credentials,
encoded paths and dot segments are refused. HTTPS is required, except HTTP on
literal loopback or `localhost` for local fixtures.

### Configure the client

The following JSON uses the official CLI's `credential-helper` configuration
array (available in a2a-cli 0.4.0). Save it as `a2a-client.json`, replacing the
example hostname and absolute directory. The hostname limits which helper runs;
the helper also checks the complete URI against local peers.

```json
{
  "credential-helper": [
    {
      "scope": "peer.example.com",
      "command": [
        "npx", "-y", "a2a-exposed@latest",
        "--config-dir", "/absolute/path/to/config", "credential"
      ]
    }
  ]
}
```

The official CLI appends `get` and writes `{"uri":"..."}` to stdin. The helper
returns `{"headers":{"Authorization":["Bearer ..."]}}` on stdout. That output
contains the credential: let the client consume it directly. Do not log it,
copy it into chat, or use `a2a auth get --reveal`. The default `auth get` output
redacts header values:

```bash
a2a --config a2a-client.json auth get https://peer.example.com
a2a --config a2a-client.json card get https://peer.example.com
a2a --config a2a-client.json send -a https://peer.example.com --async "Hello"
a2a --config a2a-client.json task get -a https://peer.example.com TASK_ID
```

Use the exact listed endpoint, including any tenant path, in these commands.
Use polling for hosted agents; omit `--stream`. Keep tokens out of `--auth`,
command arguments and project `.env` files. No owner credential is needed by
the helper, and it never falls back to `A2A_PEER_TOKEN` or an owner/MCP token.
A peer must reference a dedicated token variable; reserved owner, control, wake,
upstream and infrastructure variable names are refused. Environment values
still override saved peer values; a conflict warns on stderr without either
value. Config files remain protected (mode 600).

The helper does not read cards or follow redirects. A card advertising a
different interface URL is refused unless that exact endpoint is separately
configured with the appropriate peer credential. Do not widen the saved URL to
work around a refusal; verify the endpoint with the peer's owner.

### Errors and encryption

Malformed or oversized input, missing credentials, unknown URLs and multiple
matching peers exit 1 without any credential output. Input is limited to 64 KiB
and must close within five seconds. Errors name `peers list --json` where peer
selection is needed. There is no terminal prompt or automatic pairing.

A configuration containing local encryption keys or pinned peers is refused.
The official CLI's bearer helper cannot enforce the local encrypted-message
policy. Use `a2a-exposed send` from that configuration instead; keep encryption
and its existing pairing intact.

## Not supported yet

With only the official CLI you cannot pair, collect a token from a task, or
manage the agent. Pairing over A2A messages, one-time token collection and owner
skills need protocol support that is still open in
[#327](https://github.com/telegraphic-dev/a2a-exposed/issues/327). Until then, the
owner issues tokens as above, and human pairing approval stays unchanged.
