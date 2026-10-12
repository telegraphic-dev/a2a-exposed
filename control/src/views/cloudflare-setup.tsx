import {
	ACCESS_NOT_REQUESTED,
	EVERY_PLAN,
	SETUP_NOT_PROVISIONED,
	TUNNEL_CONNECTOR_LATER,
	setupScopes,
	setupSummary,
	type SetupChoice,
	type SetupHost,
	type SetupReport,
} from "../auth/cloudflare-setup.ts";
import type { ProvisionFields } from "../provision/inbox.ts";
import { TokenBlock } from "./token-block.tsx";

const ERRORS: Record<string, string> = {
	choice: "Choose what to set up, and where it should live.",
	auth: "Cloudflare did not finish. Try again.",
	origin: "That request came from another site.",
	cancelled: "You cancelled the Cloudflare permissions.",
	refused: "Cloudflare refused the permissions. This app is not allowed to ask for one of them.",
	provider: "Cloudflare did not finish granting permissions.",
	name: "Use a short name: lowercase letters, numbers, and hyphens.",
	hostname: "Use a web address on a domain already in this Cloudflare account, such as agent.example.com.",
	subdomain: "Use a short workers.dev name: lowercase letters, numbers, and hyphens.",
	need_subdomain: "This Cloudflare account has no workers.dev name yet. Choose one below, then create the address again.",
	account: "Choose the Cloudflare account to use.",
	zone: "That address is not on a domain in this Cloudflare account.",
	taken: "A Worker or database with that name is already in this Cloudflare account. Choose another name.",
	busy: "A setup is already running. Try again in a moment.",
	invalid_grant: "The saved Cloudflare permission expired. Choose the setup again.",
	failed: "Cloudflare did not finish creating the inbox.",
	forbidden: "Cloudflare refused to create the Worker.",
	script: "This dashboard cannot upload the inbox right now.",
	partial: "Cloudflare did not finish uploading the inbox. The next try continues with the database already created.",
	blocked: "Cloudflare has not granted every permission this inbox needs.",
	no_grant: "Choose a setup before creating an inbox.",
};

function httpsUrl(value: string | null | undefined): string {
	if (!value) return "";
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password) return "";
		return url.origin;
	} catch {
		return "";
	}
}

function stateWord(state: SetupReport["lines"][number]["state"]): string {
	if (state === "granted") return "Granted.";
	if (state === "declined") return "Not granted.";
	return "Cloudflare did not say.";
}

export function renderCloudflareSetup(input: {
	brand: string;
	error?: string;
	linked: boolean;
	connected?: boolean;
	/** Saved consent. Shown on the page after Cloudflare returns, and on later visits. */
	report?: SetupReport | null;
	/** The explanation for the choice they just made, before the browser leaves for Cloudflare. */
	review?: { choice: SetupChoice; host: SetupHost } | null;
	/** Inbox already created in the user's Cloudflare account. */
	createdUrl?: string | null;
	/** Shown once, on the page that follows a successful create. */
	ownerToken?: string;
	canCreate?: boolean;
	accounts?: { id: string; name: string }[];
	zones?: { name: string }[];
	fields?: ProvisionFields | null;
}): string {
	const brand = input.brand.trim() || "Inbox";
	const error = input.error ? ERRORS[input.error] ?? "" : "";
	const review = input.review ?? null;
	const scopes = review ? setupScopes(review.choice, review.host) : [];
	const report = input.report ?? null;
	const created = httpsUrl(input.createdUrl);
	const fields = input.fields ?? { name: "", hostname: "", subdomain: "", account: "" };
	const canCreate = Boolean(input.canCreate && report?.inbox && !created);
	return (
		<div class="setup">
			<p>Lets {brand} set this up in your Cloudflare account. It is not used to sign in. {EVERY_PLAN} After Cloudflare allows it, this page creates a public address for messages in your account. A connection for an agent you already run is not created here.</p>
			{error ? <p class="alert" role="alert">{error}</p> : ""}
			{input.connected && input.linked && !report ? (
				<p role="status">Cloudflare is connected for your user profile only. Choose a setup below to grant the permissions that setup needs. Nothing has been created in your Cloudflare account.</p>
			) : ""}
			{report ? (
				<div>
					<p role="status">{report.summary} Cloudflare answered.</p>
					<ul>
						{report.lines.map((line) => (
							<li>
								<strong>{line.name}.</strong> {line.why} {stateWord(line.state)}
							</li>
						))}
					</ul>
					{report.blocked.map((text) => <p class="alert" role="alert">{text}</p>)}
					{created ? (
						<p role="status">Your agent has a public address at <a href={created}>{created}</a>. Other agents find it at {created}/.well-known/agent-card.json. A new address can take a few minutes to answer.</p>
					) : ""}
					{created && input.ownerToken ? <TokenBlock token={input.ownerToken} lead="Copy this owner token now. It will not be shown again." /> : ""}
					{created && !input.ownerToken ? <p>The owner token was shown once, when this address was created.</p> : ""}
					{!created && !canCreate ? <p>{SETUP_NOT_PROVISIONED}</p> : ""}
					{report.refreshSaved ? (
						canCreate || created ? (
							<p>A refresh token is saved encrypted, so this page can continue. Cloudflare treats that token as single-use.</p>
						) : report.facade && !report.inbox ? (
							<p>A refresh token is saved encrypted. Cloudflare treats that token as single-use. This page does not create the tunnel, so it does not use that token yet.</p>
						) : (
							<p>A refresh token is saved encrypted, so a later step can continue. Cloudflare treats that token as single-use. This page does not use it yet.</p>
						)
					) : (
						<p>No refresh token is saved, so this dashboard cannot continue the setup after you leave this page.</p>
					)}
					{canCreate ? (
						<form method="post" action="/app/cloudflare">
							<p>Create the public address in your Cloudflare account.</p>
							{report.host === "workers" ? (
								<p>
									<label>
										Name
										<input name="name" value={fields.name} autocomplete="off" required />
									</label>
								</p>
							) : (
								<p>
									<label>
										Web address
										<input name="hostname" value={fields.hostname} placeholder="agent.example.com" autocomplete="off" required />
									</label>
								</p>
							)}
							{report.host === "workers" ? (
								<p>
									<label>
										Account workers.dev name, if this account does not have one yet
										<input name="subdomain" value={fields.subdomain} autocomplete="off" />
									</label>
								</p>
							) : ""}
							{report.host === "workers" ? <p>The name is the first part of the free address, as in https://my-agent.yourname.workers.dev. The account name is the yourname, and it is chosen once for the whole Cloudflare account.</p> : <p>The address has to be on a domain already in this Cloudflare account. This step cannot move a domain onto Cloudflare.</p>}
							{input.zones?.length ? (
								<p>Domains in this Cloudflare account: {input.zones.map((zone) => zone.name).join(", ")}.</p>
							) : ""}
							{input.accounts?.length ? (
								<fieldset class="choices">
									<legend>Which Cloudflare account?</legend>
									{input.accounts.map((account) => (
										<label class="choice">
											<input type="radio" name="account" value={account.id} checked={fields.account === account.id} required />
											<span class="choice-body"><span class="choice-title">{account.name}</span></span>
										</label>
									))}
								</fieldset>
							) : ""}
							<input type="hidden" name="action" value="provision" />
							<p><button class="action" type="submit">Create it in Cloudflare</button></p>
						</form>
					) : ""}
					{report.facade ? <p>{TUNNEL_CONNECTOR_LATER}</p> : ""}
					{report.facade ? <p>{ACCESS_NOT_REQUESTED}</p> : ""}
				</div>
			) : ""}
			{review ? (
				<form method="post" action="/app/cloudflare">
					<p>{setupSummary(review.choice, review.host)}</p>
					<p>Cloudflare will be asked for these permissions and no others. Required ones stay on. You can turn the others off. If you turn one off, this page says which setup that blocks.</p>
					<ul>
						{scopes.map((scope) => (
							<li>
								<strong>{scope.name}.</strong> {scope.why}
							</li>
						))}
					</ul>
					{review.choice !== "inbox" ? <p>{TUNNEL_CONNECTOR_LATER}</p> : ""}
					{review.choice !== "inbox" ? <p>{ACCESS_NOT_REQUESTED}</p> : ""}
					<input type="hidden" name="action" value="consent" />
					<input type="hidden" name="choice" value={review.choice} />
					<input type="hidden" name="host" value={review.host} />
					<p>
						<button class="action" type="submit">Continue to Cloudflare</button>
						{" "}
						<a href="/app/cloudflare">Choose again</a>
					</p>
				</form>
			) : (
				<form method="post" action="/app/cloudflare">
					{report ? <p>To ask for a different setup, choose again.</p> : ""}
					<fieldset class="choices">
						<legend>What do you want?</legend>
						<label class="choice">
							<input type="radio" name="choice" value="inbox" checked required />
							<span class="choice-body">
								<span class="choice-title">Give my agent a public A2A address</span>
								<span class="choice-detail">It receives messages, and we wake it by webhook.</span>
								<span class="choice-hint">Inbox</span>
							</span>
						</label>
						<label class="choice">
							<input type="radio" name="choice" value="facade" />
							<span class="choice-body">
								<span class="choice-title">Make an agent I already run reachable by other agents</span>
								<span class="choice-detail">It already speaks A2A on my own machine or server. We connect it securely.</span>
								<span class="choice-hint">Façade, through a Cloudflare Tunnel</span>
							</span>
						</label>
						<label class="choice">
							<input type="radio" name="choice" value="both" />
							<span class="choice-body">
								<span class="choice-title">Both</span>
								<span class="choice-detail">A public address for messages, and a secure connection for an agent I already run.</span>
								<span class="choice-hint">Inbox and façade</span>
							</span>
						</label>
					</fieldset>
					<fieldset class="choices">
						<legend>Which web address?</legend>
						<label class="choice">
							<input type="radio" name="host" value="workers" checked required />
							<span class="choice-body">
								<span class="choice-title">A free address from Cloudflare</span>
								<span class="choice-detail">Recommended.</span>
								<span class="choice-example">https://my-agent.yourname.workers.dev</span>
								<span class="choice-hint">This does not ask to list your domains or edit DNS.</span>
							</span>
						</label>
						<label class="choice">
							<input type="radio" name="host" value="zone" />
							<span class="choice-body">
								<span class="choice-title">My own domain</span>
								<span class="choice-detail">It must already be in your Cloudflare account.</span>
								<span class="choice-example">https://agent.example.com</span>
								<span class="choice-hint">This step cannot move a domain onto Cloudflare.</span>
							</span>
						</label>
					</fieldset>
					<input type="hidden" name="action" value="review" />
					<p><button class="action" type="submit">Review permissions</button></p>
				</form>
			)}
			<p><a href="/app">Back to your agents</a></p>
		</div>
	).toString();
}
