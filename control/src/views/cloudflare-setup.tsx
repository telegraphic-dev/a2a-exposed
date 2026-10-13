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
import type { InboxWizard, WizardStepView } from "../provision/inbox.ts";
import { PERMISSION_WAIT } from "../provision/permission-wait.ts";
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

function stepForm(step: WizardStepView, wizard: InboxWizard, auto = false) {
	if (!step.control || !step.button) return "";
	const fields = wizard.fields;
	const action = fields.inbox ? `/app/cloudflare/${fields.inbox}` : "/app/cloudflare";
	return (
		<form method="post" action={action} data-setup="1" data-auto={auto ? "1" : undefined}>
			{step.control === "account" && wizard.accounts?.length ? (
				<fieldset class="choices">
					<legend>Which Cloudflare account?</legend>
					{wizard.accounts.map((account) => (
						<label class="choice">
							<input type="radio" name="account" value={account.id} checked={fields.account === account.id} required />
							<span class="choice-body"><span class="choice-title">{account.name}</span></span>
						</label>
					))}
				</fieldset>
			) : ""}
			{step.control === "subdomain" ? (
				<p>
					<label>
						workers.dev name
						<input name="subdomain" value={fields.subdomain} autocomplete="off" required />
					</label>
					<span class="choice-hint">The account name, as in my-agent.yourname.workers.dev.</span>
				</p>
			) : ""}
			{step.control === "name" ? (
				<p>
					<label>
						Name
						<input name="name" value={fields.name} autocomplete="off" required />
					</label>
					<span class="choice-hint">The first part of the free address.</span>
				</p>
			) : ""}
			{step.control === "hostname" ? (
				<p>
					<label>
						Web address
						<input name="hostname" value={fields.hostname} placeholder="agent.example.com" autocomplete="off" required />
					</label>
					<span class="choice-hint">A domain already in this Cloudflare account.</span>
				</p>
			) : ""}
			{step.control === "zone" && wizard.zones?.some((zone) => zone.id) ? (
				<>
					<fieldset class="choices">
						<legend>Which domain?</legend>
						{wizard.zones.filter((zone) => zone.id).map((zone) => (
							<label class="choice">
								<input type="radio" name="zone" value={zone.id} required />
								<span class="choice-body"><span class="choice-title">{zone.name}</span></span>
							</label>
						))}
					</fieldset>
					<p>
						<label>
							Name on this domain
							<input name="name" autocomplete="off" />
						</label>
						<span class="choice-hint">Leave this blank to use the domain itself. A short name makes name.domain.</span>
					</p>
				</>
			) : ""}
			{step.control !== "account" && fields.account ? <input type="hidden" name="account" value={fields.account} /> : ""}
			{step.control !== "name" && step.control !== "zone" && fields.name ? <input type="hidden" name="name" value={fields.name} /> : ""}
			{fields.inbox ? <input type="hidden" name="inbox" value={fields.inbox} /> : ""}
			{step.control !== "hostname" && fields.hostname ? <input type="hidden" name="hostname" value={fields.hostname} /> : ""}
			{step.control !== "subdomain" && fields.subdomain ? <input type="hidden" name="subdomain" value={fields.subdomain} /> : ""}
			{step.control === "hostname" && wizard.zones?.length ? <p>Domains in this Cloudflare account: {wizard.zones.map((zone) => zone.name).join(", ")}.</p> : ""}
			<input type="hidden" name="action" value="step" />
			<input type="hidden" name="step" value={step.id} />
			<p><button class="action" type="submit">{step.button}</button></p>
		</form>
	);
}

function savedChoice(report: SetupReport): SetupChoice {
	if (report.inbox && report.facade) return "both";
	if (report.facade) return "facade";
	return "inbox";
}

function choiceForm(prompt: string, createAgent: boolean) {
	return (
		<form method="post" action="/app/cloudflare" data-setup="1">
			{prompt ? <p>{prompt}</p> : ""}
			<fieldset class="choices">
				<legend>Which web address?</legend>
				<label class="choice">
					<input type="radio" name="host" value="workers" checked required />
					<span class="choice-body">
						<span class="choice-title">A free workers.dev address</span>
						<span class="choice-detail">Recommended.</span>
						<span class="choice-example">https://my-agent.yourname.workers.dev</span>
						<span class="choice-hint">This does not ask to list your domains or edit DNS.</span>
					</span>
				</label>
				<label class="choice">
					<input type="radio" name="host" value="zone" />
					<span class="choice-body">
						<span class="choice-title">My own domain</span>
						<span class="choice-detail">Pick it from the domains already in your Cloudflare account.</span>
						<span class="choice-example">https://agent.example.com</span>
						<span class="choice-hint">This step cannot move a domain onto Cloudflare.</span>
					</span>
				</label>
			</fieldset>
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
			<input type="hidden" name="action" value={createAgent ? "create" : "review"} />
			<p><button class="action" type="submit">{createAgent ? "Create this agent" : "Review permissions"}</button></p>
		</form>
	);
}

function wizardSteps(wizard: InboxWizard) {
	const created = httpsUrl(wizard.publicUrl);
	return (
		<ol class="steps">
			{wizard.steps.map((step) => (
				<li class={step.state} data-step={step.id}>
					<p>
						<strong>{step.title}.</strong> <span class="choice-hint">{step.hint}</span>
					</p>
					{step.state === "fail" ? (
						<p class="alert" role="alert">{step.text}{step.cloudflare ? ` ${step.cloudflare}` : ""}</p>
					) : step.text === PERMISSION_WAIT ? (
						<p class="choice-hint" role="status">{step.text}</p>
					) : (
						<p>{step.text}</p>
					)}
					{step.state !== "fail" && step.cloudflare ? <p>{step.cloudflare}</p> : ""}
					{step.id === "verify" && step.state === "pass" && created ? (
						<p role="status">The inbox answers at <a href={created}>{created}</a>. Other agents find it at {created}/.well-known/agent-card.json. A new address can take a few minutes to answer.</p>
					) : ""}
					{step.text === PERMISSION_WAIT && wizard.refreshSeconds
						? stepForm({ ...step, control: "continue", button: "Check again" }, wizard)
						: stepForm(step, wizard)}
				</li>
			))}
		</ol>
	);
}

function dashboardLinks(wizard: InboxWizard) {
	if (!wizard.links?.length) return "";
	return (
		<div>
			<p>In your Cloudflare account:</p>
			<ul>
				{wizard.links.map((link) => (
					<li><a href={link.href}>{link.label}</a></li>
				))}
			</ul>
		</div>
	);
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
	/** Shown once, on the upload step. */
	ownerToken?: string;
	wizard?: InboxWizard | null;
	/** The saved grant can create another inbox without asking again. */
	createAgent?: boolean;
	/** This agent's id, when the page is that agent. */
	inboxId?: string;
	/** Confirmation or progress for Remove from my Cloudflare. */
	removal?: {
		items: { title: string; detail: string }[];
		steps: { id: string; title: string; state: "pass" | "fail" | "pending"; text: string; cloudflare: string }[];
		confirming: boolean;
	} | null;
}): string {
	const brand = input.brand.trim() || "Inbox";
	const error = input.error ? ERRORS[input.error] ?? "" : "";
	const review = input.review ?? null;
	const scopes = review ? setupScopes(review.choice, review.host) : [];
	const report = input.report ?? null;
	const created = httpsUrl(input.createdUrl);
	const reconnect = Boolean(report?.needsReconnect) && !created;
	const wizard = input.wizard && report?.inbox && !reconnect && !input.removal ? input.wizard : null;
	const finished = Boolean(wizard && wizard.steps.every((step) => step.state === "pass"));
	const setupBusy = Boolean(wizard && !finished && wizard.steps.some((step) => step.state !== "pass"));
	const holdChoices = reconnect || setupBusy;
	const refresh = wizard?.refreshSeconds && !input.removal ? String(wizard.refreshSeconds) : "";
	const removal = input.removal;
	const inboxId = input.inboxId || wizard?.fields.inbox || "";
	return (
		<div class="setup" data-setup-root data-refresh-seconds={refresh || undefined}>
			<p>{brand} creates a public address for your agent in your Cloudflare account, one step at a time. {EVERY_PLAN} It is not a way to sign in.</p>
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
					{reconnect ? (
						<form method="post" action="/app/cloudflare">
							<input type="hidden" name="action" value="consent" />
							<input type="hidden" name="choice" value={savedChoice(report)} />
							<input type="hidden" name="host" value={report.host} />
							<p><button class="action" type="submit">Connect again</button></p>
						</form>
					) : ""}
					{!wizard && created ? (
						<p role="status">Your agent has a public address at <a href={created}>{created}</a>. Other agents find it at {created}/.well-known/agent-card.json. A new address can take a few minutes to answer.</p>
					) : ""}
					{!wizard && created && input.ownerToken ? <TokenBlock token={input.ownerToken} lead="Copy this owner token now. It will not be shown again." /> : ""}
					{!wizard && created && !input.ownerToken ? <p>The owner token was shown once, when this address was created.</p> : ""}
					{!wizard && !created && !report.inbox ? <p>{SETUP_NOT_PROVISIONED}</p> : ""}
					{report.refreshSaved ? (
						wizard || created ? (
							<p>A refresh token is saved encrypted, so this page can continue. Cloudflare treats that token as single-use.</p>
						) : report.facade && !report.inbox ? (
							<p>A refresh token is saved encrypted. Cloudflare treats that token as single-use. This page does not create the tunnel, so it does not use that token yet.</p>
						) : (
							<p>A refresh token is saved encrypted, so a later step can continue. Cloudflare treats that token as single-use. This page does not use it yet.</p>
						)
					) : (
						<p>No refresh token is saved, so this dashboard cannot continue the setup after you leave this page.</p>
					)}
					{wizard && input.ownerToken ? <TokenBlock token={input.ownerToken} lead="Copy this owner token now. It will not be shown again." /> : ""}
					{wizard ? wizardSteps(wizard) : ""}
					{finished ? dashboardLinks(wizard!) : ""}
					{finished && inboxId ? (
						<p><a href={`/app/cloudflare/${inboxId}?remove=1`}>Remove from my Cloudflare</a></p>
					) : ""}
					{finished ? <p><a href="/app/cloudflare">In my Cloudflare account</a></p> : ""}
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
			) : holdChoices ? (
				<details class="restart">
					<summary>Start a different setup</summary>
					{choiceForm("", Boolean(input.createAgent))}
				</details>
			) : finished || removal ? (
				""
			) : (
				choiceForm(report ? "To ask for a different setup, choose again." : "", Boolean(input.createAgent))
			)}
			{removal ? (
				<div class="confirm">
					{removal.confirming ? (
						<>
							<p>Remove from my Cloudflare deletes only what this setup created:</p>
							{removal.items.length ? (
								<ul>
									{removal.items.map((item) => (
										<li><strong>{item.title}.</strong> {item.detail}</li>
									))}
								</ul>
							) : <p>Nothing was created in your Cloudflare account.</p>}
							<p>Anything else in your Cloudflare account stays.</p>
							<form method="post" action={inboxId ? `/app/cloudflare/${inboxId}` : "/app/cloudflare"} data-setup="1">
								<input type="hidden" name="action" value="remove" />
								<p><button class="action" type="submit">Remove from my Cloudflare</button></p>
							</form>
							<form method="post" action={inboxId ? `/app/cloudflare/${inboxId}` : "/app/cloudflare"}>
								<input type="hidden" name="action" value="forget" />
								<p>Forget only drops this agent from the dashboard. The Worker, database, and address stay in Cloudflare.</p>
								<p><button class="action" type="submit">Forget only</button></p>
							</form>
							<p><a href={inboxId ? `/app/cloudflare/${inboxId}` : "/app"}>Keep this agent</a></p>
						</>
					) : (
						<>
							<ol class="steps">
								{removal.steps.map((step) => (
									<li class={step.state === "pending" ? "wait" : step.state} data-step={step.id}>
										<p><strong>{step.title}.</strong></p>
										{step.state === "fail" ? (
											<p class="alert" role="alert">{step.text}{step.cloudflare ? ` ${step.cloudflare}` : ""}</p>
										) : <p>{step.text}</p>}
									</li>
								))}
							</ol>
							{removal.steps.some((step) => step.state === "fail") ? (
								<form method="post" action={inboxId ? `/app/cloudflare/${inboxId}` : "/app/cloudflare"} data-setup="1">
									<input type="hidden" name="action" value="remove" />
									<p><button class="action" type="submit">Try again</button></p>
								</form>
							) : removal.steps.some((step) => step.state === "pending") ? (
								<form method="post" action={inboxId ? `/app/cloudflare/${inboxId}` : "/app/cloudflare"} data-setup="1" data-auto="1">
									<input type="hidden" name="action" value="remove" />
									<p><button class="action" type="submit">Continue</button></p>
								</form>
							) : ""}
						</>
					)}
				</div>
			) : ""}
			<p><a href="/app">Back to your agents</a></p>
		</div>
	).toString();
}
