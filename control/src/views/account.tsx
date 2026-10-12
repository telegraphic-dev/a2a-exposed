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

function limitMessage(limit: number | null): string {
	if (limit == null) return "";
	const noun = limit === 1 ? "hosted agent" : "hosted agents";
	return `This account can have ${limit} ${noun}. An agent in your Cloudflare account does not use one of these.`;
}

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
		return url.href;
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

export function renderAccount(input: {
	name: string;
	email: string;
	image?: string;
	agents: { name: string; publicUrl: string | null; createdAt: string }[];
	ownerToken?: string;
	error?: string;
	canCreate: boolean;
	agentLimit: number | null;
	signupClosed?: boolean;
	closedMessage?: string;
	deleted?: boolean;
	/** Shown in the Cloudflare connect line. The neutral name is Inbox. */
	brand?: string;
	/** Cloudflare connect is configured. The button connects or disconnects it. */
	cloudflare?: boolean;
	cloudflareLinked?: boolean;
	disconnected?: boolean;
	/** Public address of an inbox created in the user's Cloudflare account. */
	cloudflareInbox?: string | null;
	/** Agents that live in the user's Cloudflare account. They do not use a hosted slot. */
	cloudflareAgents?: { id: string; host: string; createdAt: string }[];
	/** Shown after Forget only. */
	forgotCloudflare?: boolean;
	/** Shown after Remove from my Cloudflare finishes. */
	removedCloudflare?: boolean;
}): string {
	const image = avatarUrl(input.image);
	const cloudflareInbox = agentUrl(input.cloudflareInbox ?? null);
	const cloudflareAgents = input.cloudflareAgents ?? [];
	const capped = limitMessage(input.agentLimit);
	const closed = input.signupClosed && input.error === "invite" ? (input.closedMessage?.trim() || SIGNUP_CLOSED) : "";
	const error = input.error === "limit" ? capped : closed || (input.error ? ERRORS[input.error] ?? "" : "");
	const atLimit = input.agentLimit != null && input.agents.length >= input.agentLimit;
	return (
		<div>
			<div class="who">
				{image ? <img class="avatar" src={image} alt="" /> : ""}
				<p>{input.name ? <strong>{input.name}</strong> : ""}{input.name && input.email ? " " : ""}{input.email}</p>
			</div>
			<form method="post" action="/app/sign-out">
				<p><button class="action" type="submit">Sign out</button></p>
			</form>
			{input.cloudflare ? (
				<div>
					<p>Lets {input.brand?.trim() || "Inbox"} set things up in your Cloudflare account. It isn't used to sign in.</p>
					{input.cloudflareLinked ? <p>Cloudflare is connected.</p> : ""}
					{input.disconnected ? <p role="status">Cloudflare was disconnected.</p> : ""}
					<p><a href="/app/cloudflare">In my Cloudflare account</a></p>
					{cloudflareInbox && !cloudflareAgents.length ? <p>Your Cloudflare inbox is at <a href={cloudflareInbox}>{cloudflareInbox}</a>.</p> : ""}
					{input.cloudflareLinked ? (
						<form method="post" action="/app/account/cloudflare">
							<p>
								<input type="hidden" name="action" value="disconnect" />
								<button class="action" type="submit">Disconnect Cloudflare</button>
							</p>
						</form>
					) : ""}
				</div>
			) : ""}
			{input.ownerToken ? <TokenBlock token={input.ownerToken} lead="Copy this owner token now. It will not be shown again." /> : ""}
			{input.deleted ? <p role="status">{deletedNotice(input.agentLimit, input.agents.length)}</p> : ""}
			{input.removedCloudflare ? <p role="status">That agent was removed from your Cloudflare account.</p> : ""}
			{input.forgotCloudflare ? <p role="status">That agent was dropped from this dashboard. It is still in your Cloudflare account.</p> : ""}
			{error ? <p class="alert" role="alert">{error}</p> : ""}
			{atLimit && !error ? <p class="alert" role="alert">{capped}</p> : ""}
			{input.agents.length || cloudflareAgents.length ? (
				<ul class="agents">
					{input.agents.map((agent) => {
						const when = createdOn(agent.createdAt);
						return (
							<li>
								<span class="agent-name"><a href={`/app/agents/${agent.name}`}>{hostedHostname(agent.name, agent.publicUrl)}</a></span>
								{when ? <span>{when}</span> : ""}
							</li>
						);
					})}
					{cloudflareAgents.map((agent) => (
						<li>
							<span class="agent-name">
								<a href={`/app/cloudflare/${agent.id}`}>{agent.host}</a>
								<span class="where">In your Cloudflare</span>
							</span>
						</li>
					))}
				</ul>
			) : <p>No agents yet.</p>}
			{input.canCreate && !atLimit ? (
				<form method="post" action="/api/v1/tenants">
					<p>
						<label>
							Name
							<input name="name" autocomplete="off" minlength={4} maxlength={32} />
						</label>
					</p>
					<p><button class="action" type="submit">Create agent</button></p>
				</form>
			) : ""}
		</div>
	).toString();
}
