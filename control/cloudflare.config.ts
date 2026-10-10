// Control plane. Deployment-specific values come from the environment at deploy time.
// Nothing account-specific, and no hosted hostname, is committed here.
import { bindings, defineConfig, triggers } from "cf/config";
import * as entry from "./src/index.ts" with { type: "cf-worker" };
import { RUN_WORKER_FIRST } from "./src/routing.ts";

const e: Record<string, string | undefined> = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const v = (key: string) => (e[key] ?? "").trim();

const name = v("CONTROL_WORKER_NAME") || "a2a-exposed-control";
const hostname = v("CONTROL_HOSTNAME");
const workersDev = !hostname;
const d1Id = v("CONTROL_D1_ID");
const d1Name = v("CONTROL_D1_NAME");
const route = v("CONTROL_ROUTE");
const routeZone = v("CONTROL_ROUTE_ZONE");

const plain: Record<string, string> = {
	BRAND_NAME: v("BRAND_NAME"),
	SITE_URL: v("SITE_URL"),
	ISSUER: v("ISSUER"),
	TENANT_DOMAIN: v("TENANT_DOMAIN"),
	DATA_REGION: v("DATA_REGION"),
};

const envBindings: Record<string, any> = {
	ASSETS: bindings.assets(),
};
if (d1Id || d1Name) {
	envBindings.DB = bindings.d1(d1Id ? { name: d1Name || name, id: d1Id } : { name: d1Name || name });
}
for (const [key, value] of Object.entries(plain)) if (value) envBindings[key] = bindings.text(value);

const fetchTriggers = route
	? [triggers.fetch(routeZone ? { pattern: route, zone: routeZone } : { pattern: route })]
	: [];

export default defineConfig(() => ({
	...(v("CLOUDFLARE_ACCOUNT_ID") ? { accountId: v("CLOUDFLARE_ACCOUNT_ID") } : {}),
	worker: {
		name,
		compatibilityDate: "2026-10-06",
		// Better Auth reads AsyncLocalStorage. The flag is a no-op for the neutral shell.
		compatibilityFlags: ["nodejs_compat"],
		entrypoint: entry,
		...(hostname ? { domains: [hostname] } : {}),
		workersDev,
		assets: {
			htmlHandling: "auto-trailing-slash",
			runWorkerFirst: RUN_WORKER_FIRST,
		},
		...(v("CONTROL_WORKERS_LOGS") === "1"
			? { observability: { enabled: true, redactQueryString: true, logs: { enabled: true, invocationLogs: true } } }
			: {}),
		env: envBindings,
		...(fetchTriggers.length ? { triggers: fetchTriggers } : {}),
	},
}));
