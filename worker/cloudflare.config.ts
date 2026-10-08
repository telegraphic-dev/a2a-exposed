// a2a-over-webhook Worker configuration. Everything deployment-specific comes from environment
// variables at deploy time (set by `npx a2a-over-webhook init|deploy`, or export them yourself;
// see deploy.env.example). Nothing account- or owner-specific is committed here.
import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const e: Record<string, string | undefined> = (globalThis as any).process?.env ?? {};
const v = (k: string) => (e[k] ?? "").trim();

const name = v("A2A_WORKER_NAME") || "a2a-over-webhook";
const hostname = v("A2A_HOSTNAME"); // e.g. agent.example.com (on a zone in your account)
// No hostname (or A2A_WORKERS_DEV=1): serve on <name>.<account subdomain>.workers.dev instead of a custom domain.
const workersDev = !hostname || v("A2A_WORKERS_DEV") === "1";
const wdSubdomain = v("A2A_WORKERS_DEV_SUBDOMAIN"); // the account's workers.dev subdomain, once known
// Public base URL for the agent card; if still unknown, the Worker uses the request's origin.
const publicUrl = v("A2A_PUBLIC_URL") || (hostname ? `https://${hostname}` : wdSubdomain ? `https://${name}.${wdSubdomain}.workers.dev` : "");

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
	WAKE_CLI_COMMAND: v("WAKE_CLI_COMMAND"), // how the woken agent runs the CLI (default "npx a2a-over-webhook")
	WAKE_DEBOUNCE_SECONDS: v("WAKE_DEBOUNCE_SECONDS"),
	WAKE_MAX_PER_HOUR: v("WAKE_MAX_PER_HOUR"),
	MAX_BODY: v("A2A_MAX_BODY"),
	RATE_PER_MIN: v("A2A_RATE_PER_MIN"),
};
const envBindings: Record<string, any> = {
	DB: bindings.d1(v("A2A_D1_ID") ? { name: v("A2A_D1_NAME") || name, id: v("A2A_D1_ID") } : { name: v("A2A_D1_NAME") || name }),
};
for (const [k, val] of Object.entries(plain)) if (val !== "" || (k === "WAKE_KEY_PREFIX" && "WAKE_KEY_PREFIX" in e)) envBindings[k] = bindings.text(val);

// Secrets are uploaded separately (never in this file): OWNER_TOKEN, WAKE_WEBHOOK_URL, WAKE_WEBHOOK_KEY, WAKE_HMAC_SECRET.
// They are declared only in development mode (`cf dev`), so local dev reads them from .dev.vars while
// production deploys never fail because an optional wake secret is unset.
const SECRETS = ["OWNER_TOKEN", "WAKE_WEBHOOK_URL", "WAKE_WEBHOOK_KEY", "WAKE_HMAC_SECRET"];

export default defineConfig((ctx) => ({
	...(v("CLOUDFLARE_ACCOUNT_ID") ? { accountId: v("CLOUDFLARE_ACCOUNT_ID") } : {}),
	worker: {
		name,
		compatibilityDate: "2026-10-06",
		entrypoint,
		...(hostname ? { domains: [hostname] } : {}),
		// custom-domain deployments keep cf's default (workers.dev off when a domain is set)
		...(workersDev ? { workersDev: true } : {}),
		env: ctx.mode === "development" ? { ...envBindings, ...Object.fromEntries(SECRETS.map((k) => [k, bindings.secret()])) } : envBindings,
		// Optional cron flush of debounced wakes (the Worker also flushes opportunistically on every request).
		// Requires a workers.dev subdomain on the account (always the case for workers.dev deployments).
		...(v("A2A_ENABLE_CRON") === "1" ? { triggers: [triggers.scheduled({ schedule: "* * * * *" })] } : {}),
	},
}));
