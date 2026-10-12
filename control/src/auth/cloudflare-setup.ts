// Scopes for "Set me up on Cloudflare". Each id is what the authorize request sends.
//
// A dashboard OAuth client stores dot-delimited ids from GET /client/v4/oauth/scopes.
// The create-client API rejects colon-delimited scopes. Wrangler's account:read,
// user:read, d1:write, zone:read, and workers_routes:write are the first-party
// catalog, not those ids, except where the dotted form is the same word
// (d1.write, zone.read). A live probe refused the colon forms with the same
// invalid_scope error as an invented scope.
//
// Staging accepted user-details.read and account-settings.read, then refused
// workers-scripts.write. The client was registered with Workers Edit, which is
// wrangler's workers:write (scripts, routes, KV, and zones), not Workers Scripts
// Write. workers.write is not in the scope catalog. That is the one colon scope
// this request sends.
//
// Dashboard label → id:
// - User Details Read → user-details.read
// - Account Settings Read → account-settings.read
// - Workers Edit → workers:write
// - D1 Edit → d1.write
// - Workers Routes Edit → workers-routes.write
// - DNS Edit → dns.write
// - Zone Read → zone.read
// - Argo Tunnel (Legacy) Edit → argotunnel.write (catalog name Cloudflare Tunnel Write)
// - offline_access (a protocol scope added from the refresh_token grant, not the picker)
//
// Not requested: access-app.write (Access Apps Edit). A façade behind Access is
// not a choice here.
// Not requested: workers-platform.write, workers-scripts.write, and account.read.

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
/** Wrangler's Workers Edit scope. Not workers-scripts.write, which staging refused. */
export const WORKERS_WRITE = "workers:write";
export const D1_WRITE = "d1.write";
export const WORKERS_ROUTES_WRITE = "workers-routes.write";
export const DNS_WRITE = "dns.write";
export const ZONE_READ = "zone.read";
export const TUNNEL_WRITE = "argotunnel.write";
export const OFFLINE_ACCESS = "offline_access";

/** Shown when this page has not created anything and is not offering to create the inbox. */
export const SETUP_NOT_PROVISIONED = "Nothing has been created in your Cloudflare account yet.";

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
		? "give your agent a public A2A address"
		: choice === "facade"
			? "make an agent you already run reachable by other agents"
			: "give your agent a public A2A address and make an agent you already run reachable";
	const where = host === "workers"
		? "a free Cloudflare address such as my-agent.yourname.workers.dev"
		: "your own domain, such as agent.example.com";
	return `You chose to ${what}, on ${where}.`;
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
			id: WORKERS_WRITE,
			name: "Workers Edit",
			why: facade && !inbox
				? "Uploads the façade Worker into that account."
				: facade
					? "Uploads the inbox Worker and the façade Worker into that account."
					: "Uploads the inbox Worker into that account.",
			declined: `Without Workers Edit, the Worker cannot be uploaded. That blocks ${variant(choice)}.`,
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
				why: "Lists the domains on the Cloudflare account you pick, so this page can check that your address is on one of them.",
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
	inbox: boolean;
	host: SetupHost;
}

/**
 * True when the saved grant can create an inbox. A missing tunnel permission blocks
 * only the façade. The inbox does not need it.
 */
export function inboxCanProvision(row: {
	choice: string;
	host: string;
	granted_scope: string | null;
	refresh_enc: string | null;
}): boolean {
	const choice = parseSetupChoice(row.choice);
	const host = parseSetupHost(row.host);
	if (!choice || !host || !includesInbox(choice) || !row.refresh_enc) return false;
	const { known, granted } = grantedScopeSet(row.granted_scope);
	if (!known) return false;
	return setupScopes(choice, host).every((scope) => scope.id === TUNNEL_WRITE || granted.has(scope.id));
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
		inbox: includesInbox(choice),
		host,
	};
}
