import { SIGNUP_CLOSED } from "../auth/allowlist.ts";
import { CLOUDFLARE_UNLINKED } from "../auth/cloudflare-link.ts";
import { REAUTH_MESSAGE } from "../auth/recent.ts";
import { TokenBlock } from "./token-block.tsx";

const ERRORS: Record<string, string> = {
	invalid_name: "Use 4–32 letters, numbers, or hyphens.",
	reserved_name: "That name is reserved.",
	taken: "That name is taken.",
	origin: "That request came from another site.",
	unavailable: "Agents are not available.",
	reauth: REAUTH_MESSAGE,
	auth: "Sign-in did not complete.",
	state_mismatch: "Sign-in expired. Try again.",
	no_code: "The provider did not finish sign-in. Try again.",
	deadline: "Sign-in took too long. Try again.",
	invalid_code: "The provider rejected the sign-in. Try again.",
	unable_to_get_user_info: "The provider did not return an account.",
	account_already_linked_to_different_user: "That account is already linked to someone else.",
	cloudflare_unlinked: CLOUDFLARE_UNLINKED,
};

const HOSTED_STATUS: Record<string, string> = {
	active: "Active",
	suspended: "Suspended",
	deleting: "Deleting",
	deleted: "Deleted",
};

/** How many hosted creates remain after a delete. A count above the cap is still at the limit. */
export function deletedNotice(limit: number | null, agents: number): string {
	const gone = "That agent was deleted. Its inbox, peers, connectors, and wake settings are gone.";
	if (limit == null) return `${gone} You can create another hosted agent.`;
	const left = limit - agents;
	if (left === 1) return `${gone} You can create 1 more hosted agent.`;
	if (left > 1) return `${gone} You can create ${left} more hosted agents.`;
	return `${gone} You're at your limit of ${limit} hosted ${limit === 1 ? "agent" : "agents"}.`;
}

const AVATAR_HOSTS = new Set(["avatars.githubusercontent.com", "lh3.googleusercontent.com"]);

/** HTTPS avatar on a host the page CSP allows, or "". */
export function avatarUrl(value: string | null | undefined): string {
	if (!value) return "";
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password || url.port) return "";
		if (!AVATAR_HOSTS.has(url.hostname)) return "";
		return url.href;
	} catch {
		return "";
	}
}

export function avatarOrigin(value: string): string {
	return value ? new URL(value).origin : "";
}

function createdOn(value: string): string {
	return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : "";
}

function agentUrl(value: string | null): string {
	if (!value) return "";
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password) return "";
		if (url.pathname === "/" && !url.search && !url.hash) return url.origin;
		return url.href;
	} catch {
		return "";
	}
}

function cardUrl(value: string): string {
	const href = agentUrl(value);
	if (!href) return "";
	try {
		return new URL("/.well-known/agent-card.json", href).href;
	} catch {
		return "";
	}
}

/** The hostname on the public address, or the agent name when there is no address yet. */
export function hostedHostname(name: string, publicUrl: string | null): string {
	const href = agentUrl(publicUrl);
	if (!href) return name;
	try {
		return new URL(href).hostname;
	} catch {
		return name;
	}
}

function cloudflareStatus(status: string): string {
	if (status === "working") return "Working";
	if (status === "ready") return "Ready";
	if (status === "removing") return "Removing";
	return "Setting up";
}

function usageLine(count: number, limit: number | null): string {
	if (limit == null) return "";
	return `${count} of ${limit} hosted · agents in your Cloudflare don't count`;
}

function copyButtons(url: string) {
	const card = cardUrl(url);
	if (!url && !card) return "";
	return (
		<p class="card-actions">
			{url ? <button type="button" class="button" data-copy={url}>Copy URL</button> : ""}
			{card ? <button type="button" class="button" data-copy={card}>Copy card URL</button> : ""}
		</p>
	);
}

export function renderAccount(input: {
	name: string;
	email: string;
	image?: string;
	agents: { name: string; publicUrl: string | null; createdAt: string; status?: string; pairingPending?: number | null }[];
	ownerToken?: string;
	error?: string;
	canCreate: boolean;
	agentLimit: number | null;
	signupClosed?: boolean;
	closedMessage?: string;
	deleted?: boolean;
	/** Shown in the Cloudflare connect line. The neutral name is Inbox. */
	brand?: string;
	/** Parent domain for a hosted address, such as example.com. */
	tenantDomain?: string;
	/** Cloudflare connect is configured. The button connects or disconnects it. */
	cloudflare?: boolean;
	cloudflareLinked?: boolean;
	disconnected?: boolean;
	/** Public address of an inbox created in the user's Cloudflare account. */
	cloudflareInbox?: string | null;
	/** Agents that live in the user's Cloudflare account. They do not use a hosted slot. */
	cloudflareAgents?: { id: string; host: string; createdAt: string; status?: string; publicUrl?: string | null }[];
	/** Shown after Forget only. */
	forgotCloudflare?: boolean;
	/** Shown after Remove from my Cloudflare finishes. */
	removedCloudflare?: boolean;
}): string {
	const brand = input.brand?.trim() || "Inbox";
	const domain = (input.tenantDomain ?? "").trim().replace(/^\.+|\.+$/g, "");
	const cloudflareAgents = input.cloudflareAgents ?? [];
	const usage = usageLine(input.agents.length, input.agentLimit);
	const closed = input.signupClosed && input.error === "invite" ? (input.closedMessage?.trim() || SIGNUP_CLOSED) : "";
	const error = input.error === "limit" ? "" : closed || (input.error ? ERRORS[input.error] ?? "" : "");
	const atLimit = input.agentLimit != null && input.agents.length >= input.agentLimit;
	const hostedOpen = input.canCreate && !atLimit;
	const showNew = hostedOpen || Boolean(input.cloudflare);
	const empty = input.agents.length === 0 && cloudflareAgents.length === 0;
	const cloudflareLine = `Lets ${brand} set things up in your Cloudflare account. It isn't used to sign in.`;
	return (
		<div class="dashboard">
			{usage ? <p class={atLimit ? "alert usage" : "usage"} role={atLimit ? "alert" : undefined}>{usage}</p> : ""}
			{input.disconnected ? <p role="status">Cloudflare was disconnected.</p> : ""}
			{input.ownerToken ? <TokenBlock token={input.ownerToken} lead="Copy this owner token now. It will not be shown again." /> : ""}
			{input.deleted ? <p role="status">{deletedNotice(input.agentLimit, input.agents.length)}</p> : ""}
			{input.removedCloudflare ? <p role="status">That agent was removed from your Cloudflare account.</p> : ""}
			{input.forgotCloudflare ? <p role="status">That agent was dropped from this dashboard. It is still in your Cloudflare account.</p> : ""}
			{error ? <p class="alert" role="alert">{error}</p> : ""}
			{showNew ? (
				<details id="new-agent" class="new-agent">
					<summary class="action">+ New agent</summary>
					<div class="chooser">
						{hostedOpen ? (
							<section>
								<h2>Hosted by {brand}</h2>
								<form id="hosted-form" method="post" action="/api/v1/tenants">
									<p>
										<label>
											Name
											<input id="hosted-name" name="name" data-hosted-name autocomplete="off" minlength={4} maxlength={32} />
										</label>
									</p>
									{domain ? <p class="host-preview"><span data-hosted-label>name</span>.{domain}</p> : ""}
									<p><button class="button" type="submit">Create hosted agent</button></p>
								</form>
							</section>
						) : ""}
						{input.cloudflare ? (
							<section>
								<h2>In my Cloudflare account</h2>
								<p>{cloudflareLine}</p>
								<p><a class="button" href="/app/cloudflare">In my Cloudflare account</a></p>
							</section>
						) : ""}
					</div>
				</details>
			) : ""}
			{empty ? (
				<div class="empty-cards">
					<p>No agents yet.</p>
					<article class="empty-card">
						<h2>Hosted by {brand}</h2>
						<p>{domain ? `This agent gets a public address on ${domain}.` : "This agent gets a public address."}</p>
						{hostedOpen ? <p><button type="button" class="button" data-open-new="hosted-name">Create a hosted agent</button></p> : ""}
					</article>
					{input.cloudflare ? (
						<article class="empty-card">
							<h2>In my Cloudflare account</h2>
							<p>{cloudflareLine}</p>
							<p><a class="button" href="/app/cloudflare">In my Cloudflare account</a></p>
						</article>
					) : ""}
				</div>
			) : (
				<div class="agent-cards">
					{input.agents.map((agent) => {
						const when = createdOn(agent.createdAt);
						const host = hostedHostname(agent.name, agent.publicUrl);
						const href = `/app/agents/${agent.name}`;
						const url = agentUrl(agent.publicUrl);
						const pending = agent.pairingPending;
						return (
							<article class="agent-card">
								<h2><a href={href}>{host}</a></h2>
								<p><span class="badge">Hosted</span> <span>{HOSTED_STATUS[agent.status ?? ""] ?? "Active"}</span></p>
								{when ? <p>Created <time datetime={when}>{when}</time></p> : ""}
								{typeof pending === "number" && pending > 0 ? <p><span class="badge pending">{pending === 1 ? "1 pending" : `${pending} pending`}</span></p> : ""}
								{copyButtons(url)}
								<p><a href={href}>Manage</a></p>
							</article>
						);
					})}
					{cloudflareAgents.map((agent) => {
						const when = createdOn(agent.createdAt);
						const href = `/app/cloudflare/${agent.id}`;
						const url = agentUrl(agent.publicUrl ?? (agent.host.includes(".") ? `https://${agent.host}` : null));
						return (
							<article class="agent-card">
								<h2><a href={href}>{agent.host}</a></h2>
								<p><span class="badge where">In your Cloudflare</span> <span>{cloudflareStatus(agent.status ?? "")}</span></p>
								{when ? <p>Created <time datetime={when}>{when}</time></p> : ""}
								{copyButtons(url)}
								<p><a href={href}>Manage</a></p>
							</article>
						);
					})}
				</div>
			)}
		</div>
	).toString();
}

export function renderSettings(input: {
	name: string;
	email: string;
	brand?: string;
	cloudflare?: boolean;
	cloudflareLinked?: boolean;
	confirmDisconnect?: boolean;
	disconnected?: boolean;
}): string {
	const brand = input.brand?.trim() || "Inbox";
	return (
		<div class="settings">
			<section>
				<h2>Account</h2>
				{input.name ? <p><strong>{input.name}</strong></p> : ""}
				{input.email ? <p>{input.email}</p> : ""}
			</section>
			<section>
				<h2>Cloudflare</h2>
				<p>Lets {brand} set things up in your Cloudflare account. It isn't used to sign in.</p>
				{input.cloudflare ? (
					input.cloudflareLinked ? (
						input.confirmDisconnect ? (
							<form method="post" action="/app/account/cloudflare">
								<p>Connected.</p>
								<p>Disconnect Cloudflare? Setups on this page stop until you connect again.</p>
								<input type="hidden" name="action" value="disconnect" />
								<p>
									<button class="danger" type="submit">Disconnect Cloudflare</button>
									{" "}
									<a href="/app/settings">Cancel</a>
								</p>
							</form>
						) : (
							<div>
								<p>Connected.</p>
								<p><a class="danger" href="/app/settings?confirm=disconnect">Disconnect Cloudflare</a></p>
							</div>
						)
					) : (
						<div>
							{input.disconnected ? <p role="status">Cloudflare was disconnected.</p> : ""}
							<p><a class="button" href="/app/cloudflare">In my Cloudflare account</a></p>
						</div>
					)
				) : <p>Cloudflare setup is off.</p>}
			</section>
			<p><a href="/app">Your agents</a></p>
		</div>
	).toString();
}
