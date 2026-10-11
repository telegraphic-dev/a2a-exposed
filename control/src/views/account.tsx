import { SIGNUP_CLOSED } from "../auth/allowlist.ts";

const ERRORS: Record<string, string> = {
	invalid_name: "Use 4–32 letters, numbers, or hyphens.",
	reserved_name: "That name is reserved.",
	taken: "That name is taken.",
	origin: "That request came from another site.",
	unavailable: "Agents are not available.",
};

function limitMessage(limit: number | null): string {
	return limit == null ? "" : `This account can have ${limit} agents.`;
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
}): string {
	const image = avatarUrl(input.image);
	const capped = limitMessage(input.agentLimit);
	const closed = input.signupClosed && input.error === "invite" ? SIGNUP_CLOSED : "";
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
			{input.ownerToken ? (
				<div class="token" role="status">
					<p>Copy this owner token now. It will not be shown again.</p>
					<pre><code>{input.ownerToken}</code></pre>
					<script src="/owner-token.js"></script>
				</div>
			) : ""}
			{error ? <p class="alert" role="alert">{error}</p> : ""}
			{atLimit && !error ? <p class="alert" role="alert">{capped}</p> : ""}
			{input.agents.length ? (
				<ul class="agents">
					{input.agents.map((agent) => {
						const href = agentUrl(agent.publicUrl);
						const when = createdOn(agent.createdAt);
						return (
							<li>
								{href ? <a href={href}>{agent.name}</a> : <span>{agent.name}</span>}
								{when ? <span>{when}</span> : ""}
							</li>
						);
					})}
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
