# Owner message inspection

This page defines what an owner can read about an agent's tasks and messages:
counts, paginated lists, retention, and who may read them. It covers the
self-hosted Worker owner HTTP API and the hosted owner RPC (the control
plane's in-process call into a tenant). Both run the same `handleOwner`
handler, so one contract applies to both, and the hosted RPC returns the same
bodies. The account-level hosted MCP connector is outside this repository; it
calls these routes.

The UI that uses this contract is out of scope.

## Routes

| Route | Self-host owner HTTP | Hosted owner RPC | Worker MCP tool | Read-only |
| --- | --- | --- | --- | --- |
| `GET /owner/summary` | ✓ | ✓ | — | ✓ |
| `GET /owner/tasks` | ✓ | ✓ | — | ✓ |
| `GET /owner/outbound` | ✓ | ✓ | — | ✓ |
| `GET /owner/history/<contextId>` | ✓ | ✓ | `history` | ✓ |
| `GET /owner/tasks/<id>` | ✓ | ✓ | `show_task` | ✓ |
| `GET /owner/outbound/<taskId>` | ✓ | ✓ | — | ✓ |
| `GET /owner/inbox` | ✓ | ✓ | `inbox` | — |
| `GET /owner/contexts` | ✓ | ✓ | — | ✓ |
| `GET /owner/log` | ✓ | ✓ | — | ✓ |
| `GET /owner/export` | ✓ (full) | ✓ (redacted) | — | ✓ |
| `POST /owner/purge` | ✓ | — | — | — |

A dashboard uses `summary`, `tasks`, `outbound` and paged `history`. They clear
no pending wake and mark no reply seen. `GET /owner/inbox` is the agent's
acknowledging read (below). `contexts` and `log` are diagnostics capped at 100
rows, with no cursor or filters.

## Counts: `GET /owner/summary`

```json
{
  "tasks": { "submitted": 2, "working": 1, "input-required": 1, "completed": 1, "failed": 1, "rejected": 0, "canceled": 0 },
  "pairingPending": 0,
  "groups": { "open": 3, "waiting": 1, "terminal": 2 },
  "peers": [
    { "peer": "ada", "revoked": false, "tasks": { "submitted": 2, "...": 0 }, "updated": "2026-01-01T00:00:06.000Z", "outbound": { "tasks": 1, "unseenReplies": 1 } }
  ],
  "outbound": { "tasks": 2, "unseenReplies": 1 }
}
```

| Field | Meaning |
| --- | --- |
| `tasks` | Inbound tasks in each of the seven states. A state with no tasks is `0`. An unknown stored state is not counted |
| `groups.open` | `submitted` + `working` |
| `groups.waiting` | `input-required` |
| `groups.terminal` | `completed` + `failed` + `rejected` + `canceled` |
| `peers[]` | One entry per peer label with at least one inbound task: `peer`, `revoked`, `tasks` by state, `updated` (newest task update) |
| `peers[].outbound` | Outbound tasks sent to an alias with the same name, when there are any |
| `outbound` | All tasks this agent sent, and how many have a reply not yet marked seen |
| `pairingPending` | Pairing requests that have not expired |

- A count is a number of tasks, never messages.
- Counts are a snapshot taken when the call runs. A list read a moment later
  can differ; do not present them as one atomic total.
- A revoked peer stays in `peers[]` with `revoked: true` while it has tasks.
- Sealed tasks are counted like any other task.
- The route returns no message text.

## Inbound list: `GET /owner/tasks`

| Parameter | Values |
| --- | --- |
| `state` | One state, a group `open`, `waiting`, `terminal`, or `all` (default) |
| `from` | One peer label |
| `context` | One context id |
| `order` | `newest` (default) or `oldest`, by `updated_at` then id |
| `limit` | 1–200, default 50 |
| `cursor` | `nextCursor` from the previous page |

The response is `{ items, nextCursor, asOf, updatedSince }`. `nextCursor` is
`null` on the last page.

- The cursor encodes the filters, the order, `asOf` and the position. A cursor
  used with different filters or order is refused with HTTP 400
  `cursor does not match`. An unreadable cursor is HTTP 400 `cursor is invalid`.
- The first page fixes `asOf`, the time of that read. The cursor carries it,
  and every page returns the same value.
- A task updated after `asOf` changes position while the caller pages. With
  `order=oldest` it can appear again on a later page; deduplicate by `taskId`.
  With `order=newest` it moves above the cursor and is **not** on later pages.
  A list is complete only for tasks not updated since `asOf`.
- `updatedSince` is the number of tasks matching the same filters with
  `updated_at` after `asOf`. When it is above `0`, offer a refresh from the
  first page instead of claiming the list is complete.
- Each item: `taskId`, `contextId`, `from`, `peerRevoked`, `state`,
  `createdAt`, `updated`, `messageCount`, `preview`, `sealed`, and
  `ownerWait` when the task waits for an owner decision.
- `preview` is the last user message with peer tokens, setup secrets and URL
  userinfo replaced by `[redacted]`, shortened to 280 characters. It is
  untrusted peer text.
- A sealed task has `sealed: true` and `preview: null`. The list never returns
  ciphertext or the envelope header. The full envelope stays on
  `GET /owner/tasks/<id>` for local decryption.

## Outbound list: `GET /owner/outbound`

Tasks this agent sent. Parameters: `to` (one outbound alias), `context`,
`order`, `limit` and `cursor`, with the same rules as the inbound list.

- The order is by send time, then task id. Send time does not change, so a
  task never moves while the caller pages. `updatedSince` counts tasks sent
  after `asOf`.
- There is no `state` filter: the outbound state comes from the peer's last
  update, not a stored column. Passing `state` is HTTP 400.
- Each item: `taskId`, `contextId`, `to`, `state` (from the last update,
  else the sent task; `null` when neither has one), `sentAt`, `updated` (the
  last update's arrival, else `sentAt`), `updateCount`, `unseen` (a reply
  that `GET /owner/inbox` has not yet returned).
- Reply text is not in this list. Read it with `GET /owner/outbound/<taskId>`
  or history.

## Messages: `GET /owner/history/<contextId>`

History rows for one context id: inbound and outbound messages, state changes
and local notes. Each row carries `currentState` for its task when known.

`from` keeps one peer's conversation. Without `from`, every peer that holds
this context id is included, and each row has `peer`.

Two forms:

- **Paged** (any of `limit`, `cursor`, `order`): `{ items, nextCursor }`.
  `limit` is 1–200, default 50. `order` is `oldest` (default) or `newest`. The
  cursor is keyed on the history sequence number and records the context id,
  `from` and the order; another combination is HTTP 400
  `cursor does not match`. New rows are appended, so with `order=newest` they
  appear above the first page, not on later pages. A sealed row has
  `text: "[encrypted message]"` and `sealed: true`, and `data.sealed` is
  removed.
- **Array** (`n`, or no paging parameter): the newest `n` rows, default 50, at
  most 1000, oldest first. A sealed row keeps its envelope under
  `data.sealed` for local decryption. `n` cannot be combined with the paged
  parameters (HTTP 400).

## Agent inbox: `GET /owner/inbox`

The agent's own read. It is not an inspection route.

- One page of inbound tasks, oldest first. Default: only `submitted` and
  `working`; `all=1` adds every other state. Filters: `context`, `from`.
- `limit` is 1–200, default 200 on the owner HTTP API. The Worker MCP `inbox`
  tool defaults to 20.
- The cursor (`x-a2a-next-cursor` header; `nextCursor` on the hosted RPC)
  records only the position, not the filters.
- The first page also lists replies to messages this agent sent, marked
  `kind: "outbound"`.
- A `GET` clears the pending wake for each returned task and marks each
  returned outbound reply seen. `HEAD` clears nothing and returns no body. The
  hosted RPC clears only after it decides to return the body.
- A sealed item has the text `[encrypted message]` and the envelope under
  `sealed`.

## Sealed (encrypted) messages

- The A2A endpoint stores a sealed message as its encrypted envelope. It
  cannot decrypt it. The envelope holds ciphertext and a routing header
  (sender, recipient, context and message ids, state, sent time).
- Inspection routes show only that a task or row is sealed: `sealed: true`,
  no preview, no envelope.
- `GET /owner/tasks/<id>`, array-form history and the inbox return the
  envelope for local decryption.
- A plaintext reply to a task with a sealed message is refused with HTTP 409
  and `code: "encrypted_reply_required"`.

## Retention

The policy is **kept until deleted**. Tasks, messages, history and outbound
records have no automatic expiry. Do not imply a time limit.

- Removal paths:
  - Self-host: `POST /owner/purge` with `{ contexts: [...] }` deletes every
    row for those context ids. It is meant for test cleanup. It is not on the
    hosted owner RPC.
  - Hosted: deleting the agent deletes all of its storage.
- Revoking a peer keeps that peer's tasks and history. They stay in the lists
  with `peerRevoked: true`.
- A sealed message follows the same policy as plaintext.
- Housekeeping deletes only operational rows: rate-limit and wake-budget
  counters, expired OAuth codes and device requests, and wake receipts seven
  days after issue.
- When a backup bucket is configured, a daily SQL snapshot is written per
  agent. Snapshots 30 or more days old are deleted. Backups are not part of
  inspection and are not readable through the owner RPC.
- If a retention period is added, it applies to tasks, messages, history and
  outbound records together. An expired item disappears from the lists, the
  counts and history in the same delete; no placeholder row is kept.

## Authorization

- Self-host: every `/owner/*` route needs the owner token as a bearer token.
  It is compared as a SHA-256 hash in constant time. A missing or wrong token
  is HTTP 401 with `WWW-Authenticate: Bearer realm="owner"`. Peer tokens and
  MCP OAuth tokens are not owner tokens.
- Hosted: the control plane checks that the signed-in account owns the agent,
  then calls the owner RPC. The RPC accepts only allowlisted routes and query
  parameters; an unknown or malformed parameter is HTTP 400
  `query is not allowed`. It scrubs owner claims and withholds any response
  that looks like it contains a secret (HTTP 500 `response withheld`). A
  suspended agent is 403, a deleting agent 410, an unknown agent 404.
- The Worker's own MCP server reaches `inbox`, `show_task` and `history` only
  through an MCP grant the owner approved. The inspection lists are not MCP
  tools.
- Peers and anonymous callers have no route to any of this. A `from`, `to` or
  `context` filter only narrows the owner's own data; it grants nothing across
  peers or tenants.

## Not covered

- **Hosted owner delete.** Hosted owners cannot delete single conversations;
  purge stays self-host only. Adding one is a product decision.
- **Worker MCP tools** for the inspection lists.
- **Outbound `state` filter**, which needs a stored outbound state.
- **Cursors on `contexts` and `log`**, which stay diagnostics.
