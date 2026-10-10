// Bindings the control plane reads. Every one is optional. With none of them set, the Worker
// serves the neutral shell and static assets and does not call an identity provider.
export interface ControlEnv {
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
}
