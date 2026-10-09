// a2a-exposed Worker configuration. Everything deployment-specific comes from environment
// variables at deploy time (set by `npx -y a2a-exposed@latest init|deploy`, or export them yourself;
// see deploy.env.example). Nothing account- or owner-specific is committed here.
import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as selfHost from "./src/index.ts" with { type: "cf-worker" };
import * as hostedEntry from "./src/hosted.ts" with { type: "cf-worker" };

const e: Record<string, string | undefined> = (globalThis as any).process?.env ?? {};
const v = (k: string) => (e[k] ?? "").trim();

const name = v("A2A_WORKER_NAME") || "a2a-exposed";
const hostname = v("A2A_HOSTNAME"); // e.g. agent.example.com (on a zone in your account)
// No hostname: serve on <name>.<account subdomain>.workers.dev instead of a custom domain (and the other way round:
// with a hostname, the workers.dev route is switched off).
const workersDev = !hostname;
const wdSubdomain = v("A2A_WORKERS_DEV_SUBDOMAIN"); // the account's workers.dev subdomain, once known
// Public base URL for the agent card, derived only from where the Worker is served (no override: a local webhook,
// Tailnet or tunnel URL must never end up in the card). If still unknown, the Worker uses the request's origin.
const publicUrl = hostname ? `https://${hostname}` : wdSubdomain ? `https://${name}.${wdSubdomain}.workers.dev` : "";

// Plain (non-secret) vars exposed to the Worker; empty values are omitted.
const plain: Record<string, string> = {
	PUBLIC_URL: publicUrl,
	AGENT_NAME: v("A2A_AGENT_NAME"),
	AGENT_DESCRIPTION: v("A2A_AGENT_DESCRIPTION"),
	AGENT_VERSION: v("A2A_AGENT_VERSION"),
	AGENT_SKILLS: v("A2A_AGENT_SKILLS"), // JSON array of A2A AgentSkill objects
	PROVIDER_ORGANIZATION: v("A2A_PROVIDER_ORGANIZATION"),
	PROVIDER_URL: v("A2A_PROVIDER_URL"),
	DOCUMENTATION_URL: v("A2A_DOCUMENTATION_URL"),
	WAKE_PRESET: v("WAKE_PRESET") || "generic", // grok-bot | claude-code | openclaw-wake | openclaw-agent | hermes | generic
	WAKE_AGENT_ID: v("WAKE_AGENT_ID"), // openclaw presets (default "main")
	WAKE_KEY_HEADER: v("WAKE_KEY_HEADER"), // generic preset (default "authorization")
	WAKE_KEY_PREFIX: e.WAKE_KEY_PREFIX ?? "", // generic preset; unset = "Bearer "
	WAKE_BODY_TEMPLATE: v("WAKE_BODY_TEMPLATE"), // generic preset JSON template
	WAKE_CLI_COMMAND: v("WAKE_CLI_COMMAND"), // how the woken agent runs the CLI (default "npx -y a2a-exposed@latest")
	WAKE_DEBOUNCE_SECONDS: v("WAKE_DEBOUNCE_SECONDS"),
	WAKE_MAX_PER_HOUR: v("WAKE_MAX_PER_HOUR"),
	MAX_BODY: v("A2A_MAX_BODY"),
	RATE_PER_MIN: v("A2A_RATE_PER_MIN"),
	RETIRED_HOSTNAMES: v("A2A_RETIRED_HOSTNAMES"), // custom domains this agent moved away from (see movedResponse)
	PAIRING_APPROVAL: v("PAIRING_APPROVAL") || "human", // device-flow pairing: human (approval password on /device) | agent | off
	MCP: v("A2A_MCP"), // remote MCP server at /mcp (connector for Claude etc.): on unless "off"; never in proxy mode
	PBKDF2_ITERATIONS: v("A2A_PBKDF2_ITERATIONS"), // approval password hashing; default 100000 (the Workers maximum), at least 50000
	// proxy / expose mode: forward A2A to an agent that already speaks it, published through a Tunnel hostname behind
	// Access (never a Tailnet / LAN URL: the Worker can't reach those, and they never appear in the public card)
	UPSTREAM_URL: v("A2A_UPSTREAM_URL"),
	UPSTREAM_CARD_URL: v("A2A_UPSTREAM_CARD_URL"), // default <upstream origin>/.well-known/agent-card.json
	// Hosted multi-tenant gates. All empty by default, and empty is omitted, so a self-host deploy is unchanged.
	// TENANCY=host switches the entrypoint to src/hosted.ts and adds TENANT_DO + TENANT_DIRECTORY below.
	// QUOTAS, USAGE_SINK, WAKE_TARGET_POLICY, SIGNUP_URL and BRANDING are parsed and reserved.
	// APPROVAL_OIDC_* turn on OpenID Connect approval when issuer, client id, secret and allowlist are all set.
	TENANCY: v("TENANCY"),
	TENANT_DOMAIN: v("TENANT_DOMAIN"),
	DATA_REGION: v("DATA_REGION"), // eu | fedramp; unset = Cloudflare's default placement
	QUOTAS: v("QUOTAS"),
	USAGE_SINK: v("USAGE_SINK"),
	WAKE_TARGET_POLICY: v("WAKE_TARGET_POLICY"),
	SIGNUP_URL: v("SIGNUP_URL"),
	BRANDING: v("BRANDING"),
	APPROVAL_OIDC_ISSUER: v("APPROVAL_OIDC_ISSUER"),
	APPROVAL_OIDC_CLIENT_ID: v("APPROVAL_OIDC_CLIENT_ID"),
	APPROVAL_OIDC_ALLOWED_SUBJECTS: v("APPROVAL_OIDC_ALLOWED_SUBJECTS"),
	APPROVAL_METHODS: v("APPROVAL_METHODS"),
};
const hosted = v("TENANCY") === "host";
// Daily R2 snapshots. Unset: no binding and no extra cron, so a self-host deploy stays the single-tenant Worker.
const backups = v("A2A_BACKUP_BUCKET") === "1";
const envBindings: Record<string, any> = {
	DB: bindings.d1(v("A2A_D1_ID") ? { name: v("A2A_D1_NAME") || name, id: v("A2A_D1_ID") } : { name: v("A2A_D1_NAME") || name }),
};
// Per-tenant SQLite and the name directory exist only on a hosted deploy. A self-host build does not export the
// Durable Object class and does not declare these bindings, so `cf deploy` stays the single-tenant Worker on D1.
if (hosted) {
	envBindings.TENANT_DO = bindings.durableObject({ worker: name, exportName: "TenantStore" });
	envBindings.TENANT_DIRECTORY = bindings.kv();
}
if (backups) {
	const region = v("DATA_REGION");
	const bucketName = v("A2A_BACKUP_BUCKET_NAME");
	envBindings.BACKUP_BUCKET = bindings.r2({
		...(bucketName ? { name: bucketName } : {}),
		...(region === "eu" || region === "fedramp" ? { jurisdiction: region } : {}),
	});
}
const crons = [
	...(v("A2A_ENABLE_CRON") === "1" ? [triggers.scheduled({ schedule: "* * * * *" })] : []),
	...(backups ? [triggers.scheduled({ schedule: "0 3 * * *" })] : []),
];
for (const [k, val] of Object.entries(plain)) if (val !== "" || (k === "WAKE_KEY_PREFIX" && "WAKE_KEY_PREFIX" in e)) envBindings[k] = bindings.text(val);

// Secrets are uploaded separately (never in this file): OWNER_TOKEN, WAKE_WEBHOOK_URL, WAKE_WEBHOOK_KEY, WAKE_HMAC_SECRET,
// and in proxy mode UPSTREAM_TOKEN, UPSTREAM_ACCESS_CLIENT_ID, UPSTREAM_ACCESS_CLIENT_SECRET.
// They are declared only in development mode (`cf dev`), so local dev reads them from .dev.vars while
// production deploys never fail because an optional wake secret is unset.
const SECRETS = ["OWNER_TOKEN", "WAKE_WEBHOOK_URL", "WAKE_WEBHOOK_KEY", "WAKE_HMAC_SECRET", "UPSTREAM_TOKEN", "UPSTREAM_ACCESS_CLIENT_ID", "UPSTREAM_ACCESS_CLIENT_SECRET",
	// Declared for `cf dev` only when a deploy asks for them, so a self-host .dev.vars without these still starts.
	...(v("TENANCY") === "host" ? ["TENANT_SECRETS_KEY"] : []),
	...(v("TENANCY") === "host" || v("APPROVAL_OIDC_ISSUER") ? ["APPROVAL_OIDC_CLIENT_SECRET"] : [])];

export default defineConfig((ctx) => ({
	...(v("CLOUDFLARE_ACCOUNT_ID") ? { accountId: v("CLOUDFLARE_ACCOUNT_ID") } : {}),
	worker: {
		name,
		compatibilityDate: "2026-10-06",
		entrypoint: hosted ? hostedEntry : selfHost,
		...(hosted ? { exports: { TenantStore: exports.durableObject({ storage: "sqlite" }) } } : {}),
		...(hostname ? { domains: [hostname] } : {}),
		workersDev,
		// Optional persisted Workers Logs (A2A_WORKERS_LOGS=1, `init|deploy --workers-logs`): the JSON event lines plus
		// invocation logs with CPU time. Query strings are redacted, so one-time setup links never reach the logs.
		...(v("A2A_WORKERS_LOGS") === "1" ? { observability: { enabled: true, redactQueryString: true, logs: { enabled: true, invocationLogs: true } } } : {}),
		env: ctx.mode === "development" ? { ...envBindings, ...Object.fromEntries(SECRETS.map((k) => [k, bindings.secret()])) } : envBindings,
		// Optional cron flush of debounced wakes (the Worker also flushes opportunistically on every request).
		// Requires a workers.dev subdomain on the account (always the case for workers.dev deployments).
		// A2A_BACKUP_BUCKET=1 adds a second trigger, 03:00 UTC, which writes SQL snapshots and does not flush wakes.
		...(crons.length ? { triggers: crons } : {}),
	},
}));
