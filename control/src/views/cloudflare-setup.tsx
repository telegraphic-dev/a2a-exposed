import { CLOUDFLARE_REAUTH } from "../auth/cloudflare-link.ts";
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

const ERRORS: Record<string, string> = {
	choice: "Choose what to set up, and where it should live.",
	auth: "Cloudflare did not finish. Try again.",
	origin: "That request came from another site.",
};

function stateWord(state: SetupReport["lines"][number]["state"]): string {
	if (state === "granted") return "Granted.";
	if (state === "declined") return "Not granted.";
	return "Cloudflare did not say.";
}

export function renderCloudflareSetup(input: {
	brand: string;
	error?: string;
	recent: boolean;
	linked: boolean;
	connected?: boolean;
	/** Saved consent. Shown on the page after Cloudflare returns, and on later visits. */
	report?: SetupReport | null;
	/** The explanation for the choice they just made, before the browser leaves for Cloudflare. */
	review?: { choice: SetupChoice; host: SetupHost } | null;
}): string {
	const brand = input.brand.trim() || "Inbox";
	const error = input.error ? ERRORS[input.error] ?? "" : "";
	const review = input.review ?? null;
	const scopes = review ? setupScopes(review.choice, review.host) : [];
	const report = input.report ?? null;
	return (
		<div class="setup">
			<p>Lets {brand} set this up in your Cloudflare account. It is not used to sign in. {EVERY_PLAN} This page asks for permission only. Creating the Worker, the database, and any tunnel comes later.</p>
			{error ? <p class="alert" role="alert">{error}</p> : ""}
			{input.recent ? "" : <p class="alert" role="status">{CLOUDFLARE_REAUTH}</p>}
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
					<p>{SETUP_NOT_PROVISIONED}</p>
					{report.refreshSaved ? (
						<p>A refresh token is saved encrypted, so a later step can continue. Cloudflare treats that token as single-use. This page does not use it yet.</p>
					) : (
						<p>No refresh token is saved, so this dashboard cannot continue the setup after you leave this page.</p>
					)}
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
					<fieldset>
						<legend>What should we set up?</legend>
						<p>
							<label>
								<input type="radio" name="choice" value="inbox" checked required />
								{" "}
								A new inbox
							</label>
						</p>
						<p>
							<label>
								<input type="radio" name="choice" value="facade" />
								{" "}
								A façade for an existing A2A agent, through a Cloudflare Tunnel
							</label>
						</p>
						<p>
							<label>
								<input type="radio" name="choice" value="both" />
								{" "}
								Both
							</label>
						</p>
					</fieldset>
					<fieldset>
						<legend>Where should it live?</legend>
						<p>
							<label>
								<input type="radio" name="host" value="workers" checked required />
								{" "}
								A free workers.dev address
							</label>
						</p>
						<p class="hint">Suggested for an inbox that does not use a tunnel. That path does not ask to list your domains or edit DNS.</p>
						<p>
							<label>
								<input type="radio" name="host" value="zone" />
								{" "}
								A domain already on your Cloudflare account
							</label>
						</p>
						<p class="hint">The domain has to be a zone in that account already. This step cannot change nameservers.</p>
					</fieldset>
					<input type="hidden" name="action" value="review" />
					<p><button class="action" type="submit">Review permissions</button></p>
				</form>
			)}
			<p><a href="/app">Back to your agents</a></p>
		</div>
	).toString();
}
