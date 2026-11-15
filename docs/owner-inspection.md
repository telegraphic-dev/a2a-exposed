# Owner message inspection contract

Status: **proposed contract**. Nothing on this page is implemented unless the
"What exists" section says so. The [gaps](#gaps) list is the API work that must
land before a dashboard can rely on it.

This page defines what an owner can read about an agent's tasks and messages:
counts, a paginated list, retention, and who may read them. It covers the
self-hosted Worker owner HTTP API and the hosted owner RPC (the control
plane's in-process call into a tenant). Both run the same `handleOwner`
handler, so one contract applies to both. The account-level hosted MCP
connector is outside this repository; it calls these routes.

The UI that uses this contract is out of scope.

## What exists

### Routes

| Route | Self-host owner HTTP | Hosted owner RPC | Worker MCP tool |
| --- | --- | --- | --- |
| `GET /owner/summary` | ✓ | ✓ | — |
| `GET /owner/inbox` | ✓ | ✓ | `inbox` |
| `GET /owner/tasks/<id>` | ✓ | ✓ | `show_task` |
| `GET /owner/history/<contextId>` | ✓ | ✓ | `history` |
| `GET /owner/outbound/<taskId>` | ✓ | ✓ | — |
| `GET /owner/contexts` | ✓ | ✓ | — |
| `GET /owner/log` | ✓ | ✓ | — |
| `GET /owner/export` | ✓ (full) | ✓ (redacted) | — |
| `POST /owner/purge` | ✓ | — | — |

### Counts: `GET /owner/summary`

- Returns `{ tasks: { <state>: n }, pairingPending: n }`.
- `tasks` always has all seven states: `submitted`, `working`,
  `input-required`, `completed`, `failed`, `rejected`, `canceled`. A state
  with no tasks is `0`. An unknown stored state is not counted.
- A count is one task, not one message. A task can hold several messages.
- Inbound tasks only. Outbound tasks (messages this agent sent) are not counted.
- No per-peer counts.
- Read-only: it returns no message text and clears no pending wake.

### List: `GET /owner/inbox`

- One page of inbound tasks, **oldest first**, ordered by `updated_at`, then id.
- Default: only `submitted` and `working`. `all=1` adds every other state,
  including `input-required`. There is no filter for one state.
- Filters: `context` (one context id), `from` (one peer label).
- `limit` is 1–200. The default and maximum is 200 on the owner HTTP API.
  The Worker MCP `inbox` tool defaults to 20.
- Cursor: opaque base64url of `updated_at` and the task id (a keyset cursor).
  The owner HTTP API returns it in the `x-a2a-next-cursor` header; the hosted
  RPC returns it as `nextCursor`. The body stays a JSON array.
- The cursor does not record the filters. A caller that changes filters
  between pages gets a page of the new query after the old position.
- A task updated during paging moves to the end of the order. It can appear on
  a later page again. A task is not skipped.
- Each item: `taskId`, `contextId`, `from`, `state`, `updated`, `text` (the
  last user message), and when present `wakeReceipt`, `ownerWait`,
  `continuation`, `sealed`.
- The first page (no cursor) also lists replies to messages this agent sent,
  marked `kind: "outbound"`.
- **Not read-only.** A `GET` clears the pending wake for each returned task
  and marks each returned outbound reply seen. `HEAD` clears nothing, but
  returns no body. The hosted RPC clears only after it decides to return the
  body.

### Messages: `GET /owner/history/<contextId>`

- History rows for one context id, oldest first. Rows include inbound and
  outbound messages, state changes, and local notes.
- `n` is the number of most recent rows, default 50, at most 1000. There is
  no cursor: rows older than the newest 1000 cannot be read here.
- `from` keeps one peer's conversation. Without `from`, every peer that holds
  this context id is included, and each row has `peer`.
- Each row carries `currentState` for its task when known.
- Read-only.

### Other reads

- `GET /owner/tasks/<id>` returns the full task, including all messages, and
  clears nothing.
- `GET /owner/contexts` returns the 100 most recent context ids with row
  counts. No cursor or filters.
- `GET /owner/log` returns the 100 most recent history rows, newest first,
  with text clipped to 2000 characters. No cursor or filters. Read-only.

### Sealed (encrypted) messages

- The A2A endpoint stores a sealed message as its encrypted envelope. It
  cannot decrypt it.
- `inbox` and history show the text `[encrypted message]`. `inbox` also
  returns the envelope as `sealed`; history stores it under `data.sealed`.
  The envelope holds ciphertext and a routing header (sender, recipient,
  context and message ids, state, sent time).
- A plaintext reply to a task with a sealed message is refused with HTTP 409
  and `code: "encrypted_reply_required"`.

### Retention

- Tasks, messages, history and outbound records have **no automatic expiry**.
  They stay until one of these removes them:
  - Self-host: `POST /owner/purge` with `{ contexts: [...] }` deletes every
    row for those context ids. It is meant for test cleanup. It is not on the
    hosted owner RPC.
  - Hosted: deleting the agent deletes all of its storage.
- Revoking a peer keeps that peer's tasks and history.
- Housekeeping deletes only operational rows: rate-limit and wake-budget
  counters, expired OAuth codes and device requests, and wake receipts seven
  days after issue.
- When a backup bucket is configured, a daily SQL snapshot is written per
  agent. Snapshots 30 or more days old are deleted. Hosted snapshots are not
  readable through the owner RPC.

### Authorization

- Self-host: every `/owner/*` route needs the owner token as a bearer token.
  It is compared as a SHA-256 hash in constant time. A missing or wrong token
  is HTTP 401. Peer tokens and MCP OAuth tokens are not owner tokens.
- Hosted: the control plane checks that the signed-in account owns the agent,
  then calls the owner RPC. The RPC accepts only allowlisted routes and query
  parameters, scrubs owner claims, and withholds any response that looks like
  it contains a secret (HTTP 500 `response withheld`). A suspended agent is
  403, a deleting agent 410, an unknown agent 404.
- The Worker's own MCP server reaches `inbox`, `show_task` and `history` only
  through an MCP grant the owner approved.
- Peers and anonymous callers have no route to any of this.

## Contract

### Counts

`GET /owner/summary` keeps its current shape and adds:

| Field | Meaning |
| --- | --- |
| `groups.open` | `submitted` + `working` |
| `groups.waiting` | `input-required` |
| `groups.terminal` | `completed` + `failed` + `rejected` + `canceled` |
| `peers[]` | One entry per peer label with at least one inbound task: `{ peer, revoked, tasks: { <state>: n }, updated }` |
| `outbound` | `{ tasks: n, unseenReplies: n }`, and per peer in `peers[].outbound` |

- A count is a number of tasks, never messages.
- Counts are a snapshot taken when the call runs. A list read a moment later
  can differ; the dashboard must not present them as one atomic total.
- A revoked peer stays in `peers[]` with `revoked: true` while it has tasks.
- Sealed tasks are counted like any other task.
- The route stays read-only and returns no message text.

### Paginated list

A new read-only route, `GET /owner/tasks` (no id), lists inbound tasks for
inspection. `GET /owner/inbox` keeps its acknowledging behaviour for agents.

| Parameter | Values |
| --- | --- |
| `state` | One state, or a group `open`, `waiting`, `terminal`, or `all` (default) |
| `from` | One peer label |
| `context` | One context id |
| `order` | `newest` (default) or `oldest`, by `updated_at` then id |
| `limit` | 1–200, default 50 |
| `cursor` | Opaque value from the previous page |

- The response is `{ items, nextCursor, asOf, updatedSince }`. `nextCursor` is `null` on the last
  page. The hosted RPC returns the same body.
- The cursor encodes the position **and** the filters and order. A cursor used
  with different filters is refused with HTTP 400 `cursor does not match`.
- The first page fixes `asOf`, the time of that read. The cursor carries it,
  and every page returns it.
- A task updated after `asOf` changes position while the caller pages. With
  `order=oldest` it can appear again on a later page; the dashboard
  deduplicates by `taskId`. With `order=newest` it moves above the cursor and
  is **not** on later pages. A list is complete only for tasks not updated
  since `asOf`.
- Every page returns `updatedSince`: the number of tasks matching the same
  filters with `updated_at` after `asOf`. When it is above `0`, the dashboard
  offers a refresh from the first page instead of claiming the list is
  complete.
- Each item: `taskId`, `contextId`, `from`, `peerRevoked`, `state`,
  `createdAt`, `updated`, `messageCount`, `preview`, `sealed`, and
  `ownerWait` when present.
- `preview` is the last user message, scrubbed of secrets and shortened to
  280 characters. It is untrusted peer text.
- A sealed task has `sealed: true` and `preview: null`. The list never returns
  ciphertext or the envelope header. The full envelope stays on
  `GET /owner/tasks/<id>` for local decryption.
- Reading the list clears no wake and marks no reply seen.

Outbound tasks get the same route shape at `GET /owner/outbound` (no id),
with `to` instead of `from` and `unseen` per item.

### Message list

`GET /owner/history/<contextId>` adds keyset pagination:

- `limit` 1–200, default 50, and `cursor`, keyed on the history sequence
  number. `order` is `oldest` (default, the current order) or `newest`.
- `n` keeps working for existing callers.
- The cursor records `from`, so a page cannot mix peers.
- Sealed rows show `[encrypted message]` and `sealed: true`; the list does not
  return `data.sealed`.

### Retention

- The documented policy is: **kept until deleted**. There is no automatic
  expiry. The dashboard says so instead of implying a time limit.
- Removal paths are the ones under [What exists](#retention), until an owner
  delete route is added.
- If a retention period is added later, it applies to tasks, messages,
  history and outbound records together. An expired item disappears from the
  list, the counts and history in the same delete; no placeholder row is kept.
- A sealed message follows the same policy as plaintext.
- Backups follow their own 30-day rule and are not part of inspection.

### Authorization

- Every inspection route is owner-only: the owner token on self-host, the
  account-ownership check plus the RPC allowlist on hosted.
- Each new route and each new query parameter is added to the hosted RPC
  allowlist explicitly. Unknown parameters are refused there, as today.
- The response-leak check applies to every new response.
- Peers and anonymous callers get the same refusals as other `/owner/*`
  routes. A `from` or `context` filter only narrows the owner's own data; it
  grants nothing across peers or tenants.
- Exposing the new routes as Worker MCP tools is a separate decision.

## Gaps

What must change before the contract holds. Each item can be its own API
issue.

1. **No read-only list.** `GET /owner/inbox` clears wakes and marks replies
   seen. Add `GET /owner/tasks` and `GET /owner/outbound` as specified.
2. **No state filter.** The inbox has open-only or `all=1`. Add `state` with
   single states and groups.
3. **Oldest-first only.** Add `order=newest`.
4. **Cursor not bound to filters, no change signal.** Encode filters, order
   and `asOf` in the cursor, refuse a mismatch, and return `updatedSince`.
5. **No per-peer or outbound counts.** Extend `GET /owner/summary` with
   `groups`, `peers[]` and `outbound`.
6. **No message count on list items.** Add `messageCount` without loading
   every task.
7. **History has no cursor.** Only the newest 1000 rows are readable. Add
   `limit`, `cursor` and `order`.
8. **Sealed envelopes in list views.** `inbox` returns the full envelope as
   `sealed`. The new list and history pages return only `sealed: true`.
9. **Revoked peers are not marked.** Add `peerRevoked` and `peers[].revoked`.
10. **No documented retention or owner delete.** Purge is self-host only and
    by context id. Decide whether hosted owners get a delete route; until
    then the policy is "kept until the agent is deleted".
11. **`contexts` and `log` are capped at 100.** Leave them as diagnostics or
    give them cursors; the dashboard should use the new routes.
12. **Parity tests.** Each new route needs tests on the owner HTTP API and the
    hosted owner RPC, on both storage backends, plus refusal tests for peers,
    anonymous callers and unknown RPC parameters.
