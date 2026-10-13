// Paths the control app registers for the tenant API and the health check.
// The Worker imports this file. It does not import ./index.ts, so the provisioning
// modules and the migration SQL stay out of the Worker bundle.

export const routes = {
	health: "/health",
	tenants: "/api/v1/tenants",
} as const;

export type CoreRoutes = typeof routes;
