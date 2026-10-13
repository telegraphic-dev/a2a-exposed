// Paths for the health check and the tenant API.

export const routes = {
	health: "/health",
	tenants: "/api/v1/tenants",
} as const;

export type CoreRoutes = typeof routes;
