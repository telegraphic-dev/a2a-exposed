import type { Sql } from "./invites.ts";
import type { Mailer } from "../mail/types.ts";
import { authBaseURL } from "./origin.ts";

export interface ProviderCredentials {
	clientId: string;
	clientSecret: string;
}

export interface TurnstileConfig {
	siteKey: string;
	secret: string;
}

/** Resolved login settings. Null when this deployment has not turned login on. */
export interface AuthOptions {
	baseURL: string;
	secret: string;
	database: Sql;
	github?: ProviderCredentials;
	google?: ProviderCredentials;
	cloudflare?: ProviderCredentials;
	mailer?: Mailer;
	mailFrom?: string;
	emailBinding?: { send(message: unknown): Promise<void> };
	turnstile?: TurnstileConfig;
	invitesRequired: boolean;
}

export interface AuthDeps {
	database?: Sql;
	mailer?: Mailer;
}

export interface AuthEnv {
	DB?: Sql;
	AUTH_SECRET?: string;
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	CLOUDFLARE_OAUTH_CLIENT_ID?: string;
	CLOUDFLARE_OAUTH_CLIENT_SECRET?: string;
	MAIL_FROM?: string;
	EMAIL?: { send(message: unknown): Promise<void> };
	TURNSTILE_SITE_KEY?: string;
	TURNSTILE_SECRET_KEY?: string;
	INVITES_REQUIRED?: string;
	SITE_URL?: string;
	ISSUER?: string;
}

const SECRET_MIN = 32;

function pair(id: string | undefined, secret: string | undefined): ProviderCredentials | undefined {
	const clientId = id?.trim() ?? "";
	const clientSecret = secret?.trim() ?? "";
	if (!clientId || !clientSecret) return undefined;
	return { clientId, clientSecret };
}

function attempted(env: AuthEnv, deps: AuthDeps): boolean {
	return Boolean(
		env.GITHUB_CLIENT_ID?.trim()
		|| env.GITHUB_CLIENT_SECRET?.trim()
		|| env.GOOGLE_CLIENT_ID?.trim()
		|| env.GOOGLE_CLIENT_SECRET?.trim()
		|| env.CLOUDFLARE_OAUTH_CLIENT_ID?.trim()
		|| env.CLOUDFLARE_OAUTH_CLIENT_SECRET?.trim()
		|| env.MAIL_FROM?.trim()
		|| deps.mailer
		|| env.AUTH_SECRET?.trim(),
	);
}

export function authBlockers(env: AuthEnv, deps: AuthDeps = {}): string[] {
	if (!attempted(env, deps)) return [];
	const blockers: string[] = [];
	const database = deps.database ?? env.DB;
	if (!database) blockers.push("D1 is not configured.");
	if ((env.AUTH_SECRET?.trim().length ?? 0) < SECRET_MIN) blockers.push("AUTH_SECRET is not set.");
	if (env.GITHUB_CLIENT_ID?.trim() && !env.GITHUB_CLIENT_SECRET?.trim()) blockers.push("GitHub is missing its client secret.");
	if (env.GOOGLE_CLIENT_ID?.trim() && !env.GOOGLE_CLIENT_SECRET?.trim()) blockers.push("Google is missing its client secret.");
	if (env.CLOUDFLARE_OAUTH_CLIENT_ID?.trim() && !env.CLOUDFLARE_OAUTH_CLIENT_SECRET?.trim()) blockers.push("Cloudflare is missing its client secret.");
	const mailer = deps.mailer ?? (env.EMAIL && env.MAIL_FROM?.trim() ? env.EMAIL : undefined);
	if (env.MAIL_FROM?.trim() && !mailer) blockers.push("Email is not configured.");
	const github = pair(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET);
	const google = pair(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
	const cloudflare = pair(env.CLOUDFLARE_OAUTH_CLIENT_ID, env.CLOUDFLARE_OAUTH_CLIENT_SECRET);
	if (!github && !google && !cloudflare && !mailer) blockers.push("No login provider is fully configured.");
	return blockers;
}

export function resolveAuth(env: AuthEnv, request: Request, deps: AuthDeps = {}): AuthOptions | null {
	if (authBlockers(env, deps).length) return null;
	if (!attempted(env, deps)) return null;
	const database = deps.database ?? env.DB;
	const secret = env.AUTH_SECRET?.trim() ?? "";
	if (!database || secret.length < SECRET_MIN) return null;
	const baseURL = authBaseURL(env, request);
	if (!baseURL) return null;
	const mailFrom = env.MAIL_FROM?.trim() || undefined;
	const turnstileSite = env.TURNSTILE_SITE_KEY?.trim() ?? "";
	const turnstileSecret = env.TURNSTILE_SECRET_KEY?.trim() ?? "";
	return {
		baseURL,
		secret,
		database,
		github: pair(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
		google: pair(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
		cloudflare: pair(env.CLOUDFLARE_OAUTH_CLIENT_ID, env.CLOUDFLARE_OAUTH_CLIENT_SECRET),
		mailer: deps.mailer,
		mailFrom,
		emailBinding: !deps.mailer && env.EMAIL && mailFrom ? env.EMAIL : undefined,
		turnstile: turnstileSite && turnstileSecret ? { siteKey: turnstileSite, secret: turnstileSecret } : undefined,
		invitesRequired: env.INVITES_REQUIRED?.trim() === "1",
	};
}
