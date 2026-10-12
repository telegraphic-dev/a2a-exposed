// Bindings the control plane reads. Every one is optional. With none of them set, the Worker
// serves the neutral shell and static assets and does not call an identity provider.
import type { PlaneEnv } from "./tenants/push.ts";

export interface ControlEnv extends PlaneEnv {
	ASSETS?: { fetch(input: Request | URL | string, init?: RequestInit): Promise<Response> };
	BRAND_NAME?: string;
	/** Public origin of this control plane, https, no path. Unset: sitemap is omitted. */
	SITE_URL?: string;
	/** OIDC issuer origin. Unset until a provider is configured. */
	ISSUER?: string;
	/** Parent domain for tenant hosts. Unset: this deployment has no tenant hosts. */
	TENANT_DOMAIN?: string;
	/** `eu` or `fedramp`. Unset: the platform's default placement. */
	DATA_REGION?: string;
	DB?: import("./auth/invites.ts").Sql;
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
	/** `1` requires an invite code before the first account is created. */
	INVITES_REQUIRED?: string;
	/** Comma-separated exact emails and `*@domain` wildcards. Unset or empty: sign-in is open. */
	SIGNUP_ALLOWLIST?: string;
	/** Default agents per account. Unset or empty: no cap, unless that account sets agent_limit. An explicit non-negative integer sets the cap. */
	FREE_AGENT_LIMIT?: string;
	/** Same secret as the data-plane Worker. Seals wake secrets. Unset: a new key cannot be saved. */
	TENANT_SECRETS_KEY?: string;
	/**
	 * Fine-grained token with Issues write on FEEDBACK_REPO only. A secret, not a var.
	 * Fallback when the GitHub App below is unset. Not a GITHUB_* name: that prefix is the sign-in OAuth app.
	 */
	FEEDBACK_GITHUB_TOKEN?: string;
	/** GitHub App id that files feedback issues. A plain var. With the private key, preferred over the token. */
	FEEDBACK_GITHUB_APP_ID?: string;
	/**
	 * PEM private key for that app. A secret, not a var. PKCS#1 (`BEGIN RSA PRIVATE KEY`) or PKCS#8 (`BEGIN PRIVATE KEY`).
	 * A one-line value may encode newlines as `\n`. Text outside the BEGIN and END lines is ignored.
	 */
	FEEDBACK_GITHUB_APP_PRIVATE_KEY?: string;
	/** Installation id on FEEDBACK_REPO. Unset: look it up with the app JWT. A plain var. */
	FEEDBACK_GITHUB_APP_INSTALLATION_ID?: string;
	/** owner/repo that receives feedback issues. Required with the app or the token, or the route is 404. */
	FEEDBACK_REPO?: string;
}
