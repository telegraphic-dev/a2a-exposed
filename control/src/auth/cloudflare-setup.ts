// Scopes for "Set me up on Cloudflare". Each id is what the authorize request sends.
//
// Confirmed as scope ids in Cloudflare's own docs or blog:
// - user-details.read, workers-scripts.write, zone.read
//   (blog: task-based OAuth consent, the client JSON)
// - offline_access
//   (API reference for creating an OAuth client: a protocol scope added from the
//   refresh_token grant type, not from the scope picker)
//
// On the staging client (owner, 2026-10-12) and also reported as accepted ids
// outside those docs:
// - account-settings.read, d1.write, dns.write
//   (a published consent receipt lists them as granted ids)
// - workers-routes.write
//   (third parties report the authorize endpoint accepts it; not in the docs examples)
// - argotunnel.write
//   (the staging client allows it; a third-party table maps Cloudflare Tunnel Write
//   to this id). Not confirmed from Cloudflare's published scope list.
//
// Not requested: access-app.write. The staging client allows it. A façade behind
// Access is not a choice here. A third-party quote of GET /oauth/scopes includes
// access-app.read, not the write id.
// Not requested: workers-platform.write and account.read. The create-client docs
// show those ids and do not say they include D1, routes, DNS, Tunnel, or Access.

export type SetupChoice = "inbox" | "facade" | "both";
export type SetupHost = "workers" | "zone";

export interface ScopeReason {
	id: string;
	/** Name Cloudflare shows for this permission, when we know it. */
	name: string;
	why: string;
	/** Said when the user turns this optional permission off. */
	declined: string;
}

export const USER_DETAILS_READ = "user-details.read";
export const ACCOUNT_SETTINGS_READ = "account-settings.read";
export const WORKERS_SCRIPTS_WRITE = "workers-scripts.write";
export const D1_WRITE = "d1.write";
export const WORKERS_ROUTES_WRITE = "workers-routes.write";
export const DNS_WRITE = "dns.write";
export const ZONE_READ = "zone.read";
export const TUNNEL_WRITE = "argotunnel.write";
export const OFFLINE_ACCESS = "offline_access";

/** Shown after consent. Provisioning is not this step. */
export const SETUP_NOT_PROVISIONED = "Nothing has been created in your Cloudflare account yet. Creating the Worker, the database, and any tunnel is a later step.";

export const TUNNEL_CONNECTOR_LATER = "A tunnel needs cloudflared running on a machine you control. This page cannot start that, and that step is not built yet.";

export const ACCESS_NOT_REQUESTED = "This step does not ask for Cloudflare Access. Putting a façade behind Access is not part of this page yet.";

export const EVERY_PLAN = "This is available on every plan.";

const AUTHORIZE = "https://dash.cloudflare.com/oauth2/auth";

export function parseSetupChoice(value: unknown): SetupChoice | null {
	return value === "inbox" || value === "facade" || value === "both" ? value : null;
}

export function parseSetupHost(value: unknown): SetupHost | null {
	return value === "workers" || value === "zone" ? value : null;
}

function includesInbox(choice: SetupChoice): boolean {
	return choice === "inbox" || choice === "both";
}

function includesFacade(choice: SetupChoice): boolean {
	return choice === "facade" || choice === "both";
}

function variant(choice: SetupChoice): string {
	if (choice === "inbox") return "a new inbox";
	if (choice === "facade") return "the façade";
	return "the new inbox and the façade";
}

export function setupSummary(choice: SetupChoice, host: SetupHost): string {
	const what = choice === "inbox"
		? "a new inbox"
		: choice === "facade"
			? "a façade for an existing A2A agent"
			: "a new inbox and a façade for an existing A2A agent";
	const where = host === "workers"
		? "a free workers.dev address"
		: "a domain already on your Cloudflare account";
	return `You chose ${what} on ${where}.`;
}

/** Scopes this choice needs, in the order the consent URL sends them. */
export function setupScopes(choice: SetupChoice, host: SetupHost): ScopeReason[] {
	const inbox = includesInbox(choice);
	const facade = includesFacade(choice);
	const zone = host === "zone";
	const scopes: ScopeReason[] = [
		{
			id: USER_DETAILS_READ,
			name: "User Details Read",
			why: "Confirms which Cloudflare user this is. It is not used to sign in.",
			declined: "Without User Details Read, Cloudflare did not confirm the user. Choose the setup again.",
		},
		{
			id: ACCOUNT_SETTINGS_READ,
			name: "Account Settings Read",
			why: "Reads the Cloudflare account you pick on the consent screen. The token response does not name that account.",
			declined: "Without Account Settings Read, this dashboard cannot see which Cloudflare account you picked, so this setup cannot continue.",
		},
		{
			id: WORKERS_SCRIPTS_WRITE,
			name: "Workers Scripts Write",
			why: facade && !inbox
				? "Uploads the façade Worker into that account."
				: facade
					? "Uploads the inbox Worker and the façade Worker into that account."
					: "Uploads the inbox Worker into that account.",
			declined: `Without Workers Scripts Write, the Worker cannot be uploaded. That blocks ${variant(choice)}.`,
		},
		{
			id: D1_WRITE,
			name: "D1 Write",
			why: "Creates the D1 database that Worker uses.",
			declined: `Without D1 Write, the database cannot be created. That blocks ${variant(choice)}.`,
		},
	];
	if (zone) {
		scopes.push(
			{
				id: WORKERS_ROUTES_WRITE,
				name: "Workers Routes Write",
				why: "Attaches the Worker to a hostname on a domain you already have in Cloudflare.",
				declined: "Without Workers Routes Write, the Worker cannot be attached to a hostname on your domain. That blocks a setup on your own domain. A workers.dev address does not need it.",
			},
			{
				id: DNS_WRITE,
				name: "DNS Write",
				why: "Creates the DNS record for that hostname. This cannot move a domain onto Cloudflare.",
				declined: "Without DNS Write, the DNS record for your domain cannot be created. That blocks a setup on your own domain. A workers.dev address does not need it.",
			},
			{
				id: ZONE_READ,
				name: "Zone Read",
				why: "Lists the domains on the Cloudflare account you pick, so a later step can ask which one to use.",
				declined: "Without Zone Read, the domains on your Cloudflare account cannot be listed. That blocks a setup on your own domain. A workers.dev address does not need it.",
			},
		);
	}
	if (facade) {
		scopes.push({
			id: TUNNEL_WRITE,
			name: "Cloudflare Tunnel Write",
			why: "Creates a tunnel from the façade Worker to your existing agent. You still run cloudflared on a machine you control.",
			declined: inbox
				? "Without Cloudflare Tunnel Write, a tunnel cannot be created. That blocks the façade. The inbox does not need a tunnel."
				: "Without Cloudflare Tunnel Write, a tunnel cannot be created. That blocks the façade.",
		});
	}
	scopes.push({
		id: OFFLINE_ACCESS,
		name: "Refresh token (offline access)",
		why: "Lets this dashboard continue the setup after you leave this page. The token is stored encrypted. Cloudflare treats it as single-use. How long it lasts is not documented.",
		declined: "Without a refresh token, this dashboard cannot continue the setup after you leave this page. Nothing has been created in your Cloudflare account.",
	});
	return scopes;
}

export function consentScope(choice: SetupChoice, host: SetupHost): string {
	return setupScopes(choice, host).map((scope) => scope.id).join(" ");
}

export function cloudflareAuthorizeUrl(input: {
	clientId: string;
	redirectUri: string;
	scope: string;
	state: string;
	codeChallenge: string;
}): string {
	const url = new URL(AUTHORIZE);
	url.searchParams.set("client_id", input.clientId);
	url.searchParams.set("redirect_uri", input.redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", input.scope);
	url.searchParams.set("state", input.state);
	url.searchParams.set("code_challenge", input.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	return url.href;
}

/** Split a token `scope` value. Absent means Cloudflare did not say. A string, even empty, means it did. */
export function grantedScopeSet(scope: string | null): { known: boolean; granted: Set<string> } {
	if (scope == null) return { known: false, granted: new Set() };
	const granted = new Set(scope.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean));
	return { known: true, granted };
}

export interface SetupReport {
	summary: string;
	lines: { name: string; why: string; state: "granted" | "declined" | "unknown" }[];
	blocked: string[];
	refreshSaved: boolean;
	facade: boolean;
}

export function describeSetupGrant(row: {
	choice: string;
	host: string;
	granted_scope: string | null;
	refresh_enc: string | null;
}): SetupReport | null {
	const choice = parseSetupChoice(row.choice);
	const host = parseSetupHost(row.host);
	if (!choice || !host) return null;
	const requested = setupScopes(choice, host);
	const { known, granted } = grantedScopeSet(row.granted_scope);
	const lines = requested.map((scope) => ({
		name: scope.name,
		why: scope.why,
		state: !known ? "unknown" as const : granted.has(scope.id) ? "granted" as const : "declined" as const,
	}));
	const blocked = !known
		? ["Cloudflare did not say which permissions were granted, so this setup is not confirmed."]
		: requested.filter((scope) => !granted.has(scope.id)).map((scope) => scope.declined);
	return {
		summary: setupSummary(choice, host),
		lines,
		blocked,
		refreshSaved: Boolean(row.refresh_enc),
		facade: includesFacade(choice),
	};
}
