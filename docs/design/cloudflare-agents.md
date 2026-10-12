# Cloudflare agents

A Cloudflare setup is an agent on the dashboard, the same list as a hosted agent. It does not use a hosted agent slot.

## Model

`cloudflare_inbox` is one agent. `id` is the primary key. An older row keeps its `userId` as `id` (`0014_cloudflare_inbox_agent`). A new agent gets its own id, Worker, and D1 database. The saved Cloudflare grant is reused when its scopes already cover the choice, so a second agent does not ask for consent again.

`/app` lists every agent by hostname:

- Hosted: `name.TENANT_DOMAIN`, for example `the-agent.agent-to-agent.party` or `some-other.a2a.exposed`. The link is `/app/agents/<name>`.
- Your Cloudflare, free address: `name.account-subdomain.workers.dev`.
- Your Cloudflare, your own domain: `myagent.example.com`.
- Not ready yet: the hostname known so far, or "Setting up".

A Cloudflare hostname links to `/app/cloudflare/<id>`. The marker is "In your Cloudflare".

`FREE_AGENT_LIMIT` and `user.agent_limit` count rows in `tenants` only. The limit trigger is `tenants_agent_limit`. A Cloudflare row is not a tenant.

## Steps

The choice comes first: "A free workers.dev address" or "My own domain". Your own domain lists zones (`zone.read`) and you pick one. A short name makes `name.domain`. A blank name uses the domain itself.

Each check names what it checked, such as "Inbox name my-agent-2: free", "Address my-agent-2.jean-de-bot.workers.dev", or "Domain agent.example.com".

After the inbox answers, the page links to the Worker, the D1 database, the DNS records when this setup attached a domain, and the workers.dev name settings. The account workers.dev name is shared, so removal does not delete it.

`/setup.js` posts the step and replaces `[data-setup-root]`. A wait uses `data-refresh-seconds` and "Check again". It does not reload on a timer. Without JavaScript the forms still post.

## Tear-down

On the agent page, "Remove from my Cloudflare" lists the Worker, the database, and the address when this setup attached one. Each deletion is one step, with retry.

The Worker is deleted only when its provision tag still equals the tag stored for this setup. The database is deleted only when its id and name match the row. A custom hostname is deleted only when that workers domain is on this Worker. A resource you already deleted is "Already gone." A resource this setup did not create stays, and the page says so.

"Forget only" deletes the dashboard row and does not call Cloudflare.

A sign-in from the last 10 minutes is required. An older session signs in again and then continues that remove or forget.
