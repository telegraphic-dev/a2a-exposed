# Use with the official A2A CLI

The [official A2A CLI](https://github.com/a2aproject/a2a-cli) can use an existing
outbound peer credential through its Bazel credential-helper support. Pair with
`a2a-exposed connect` first; the peer's owner still approves that pairing.
The helper reads the local credential. It does not pair, issue tokens, contact a
server, or change configuration.

## Select the peer

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

## Configure the client

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

## Errors and encryption

Malformed or oversized input, missing credentials, unknown URLs and multiple
matching peers exit 1 without any credential output. Input is limited to 64 KiB
and must close within five seconds. Errors name `peers list --json` where peer
selection is needed. There is no terminal prompt or automatic pairing.

A configuration containing local encryption keys or pinned peers is refused.
The official CLI's bearer helper cannot enforce the local encrypted-message
policy. Use `a2a-exposed send` from that configuration instead; keep encryption
and its existing pairing intact.

This helper does not implement pairing over A2A messages, one-time token
collection, or owner administration through the official CLI. Those require
separate protocol support; existing human pairing approval remains required.
