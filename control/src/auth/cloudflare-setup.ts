// Scopes for "Set me up on Cloudflare". Each id is what the authorize request sends.
//
// The staging OAuth client allows these ids: d1.write, workers-scripts.admin,
// workers-scripts.edit, workers-routes.write, dns.write, zone.read,
// zone-access.read, zone-access.write, argotunnel.read, argotunnel.write,
// account-settings.read, user-details.read.
// offline_access is not in that list. It is a protocol scope, and the request
// still includes it so Cloudflare can issue a refresh token.
//
// Cloudflare refused workers:write and workers-scripts.write. workers-scripts.edit
// can create D1 and run migrations, and the script upload answers
// "No access to the specified resource". Uploading a script uses
// workers-scripts.admin (Workers Admin). workers-scripts.edit is not requested.
// Colon scopes such as wrangler's account:read, user:read, and
// workers_routes:write are not registered on this client.
//
// Dashboard label → id:
// - User Details Read → user-details.read
// - Account Settings Read → account-settings.read
// - Workers Admin → workers-scripts.admin
// - D1 Write → d1.write
// - Workers Routes Write → workers-routes.write
// - DNS Write → dns.write
// - Zone Read → zone.read
// - Cloudflare Tunnel Write → argotunnel.write
// - offline_access (refresh token; not a picker permission)
//
// Not requested, even when the client allows them: workers-scripts.edit,
// zone-access.read, and zone-access.write (Access). A façade behind Access is
// not a choice here. argotunnel.read is not requested. Creating a tunnel uses
// argotunnel.write. Not requested: workers:write, workers-scripts.write,
// workers-platform.write, access-app.write, and account.read.

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
/** Workers Admin. Script upload needs this. workers-scripts.edit does not upload. */
export const WORKERS_SCRIPTS_ADMIN = "workers-scripts.admin";
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
			id: WORKERS_SCRIPTS_ADMIN,
			name: "Workers Admin",
			why: facade && !inbox
				? "Uploads the façade Worker into your account."
				: facade
					? "Uploads the inbox Worker and the façade Worker into your account."
					: "Uploads the inbox Worker into your account.",
			declined: `Without Workers Admin, the Worker cannot be uploaded. Connect again to grant it. That blocks ${variant(choice)}.`,
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
	/** Saved grant did not include Workers Admin. The page asks them to connect again. */
	needsReconnect: boolean;
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
	if (!choice || !host) return false;
	return grantCoversInbox(row, choice, host);
}

/** True when the saved grant can create this inbox. Tunnel permission blocks only a façade. */
export function grantCoversInbox(row: {
	granted_scope: string | null;
	refresh_enc: string | null;
}, choice: SetupChoice, host: SetupHost): boolean {
	if (!includesInbox(choice) || !row.refresh_enc) return false;
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
		needsReconnect: !known || !granted.has(WORKERS_SCRIPTS_ADMIN),
	};
}
