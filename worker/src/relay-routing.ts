import { namespaceForRegion, type TenantContext } from "./tenancy.ts";

export type RelayTestError = "offline" | "timeout" | "revoked" | "stale_enrollment" | "invalid" | "local_http" | "busy" | "uncertain" | "unavailable";
/** Recovery depends on machine codes and actual receiver status, never info text. */
export function relayTestOutcome(response: Response, result: { status?: number; error?: string }): { status: number | null; error?: RelayTestError } {
	const status = response.ok && Number.isInteger(result.status) && result.status! >= 200 && result.status! <= 599 ? result.status! : null;
	if (status !== null) return { status, ...(status >= 300 ? { error: "local_http" as const } : {}) };
	const codes: Record<string, RelayTestError> = { connector_offline: "offline", delivery_timeout: "timeout", relay_revoked: "revoked", stale_enrollment: "stale_enrollment", invalid_delivery: "invalid", body_too_large: "invalid", connector_busy: "busy", delivery_uncertain: "uncertain" };
	const error = result.error || "";
	return { status: null, error: Object.hasOwn(codes, error) ? codes[error] : "unavailable" };
}

export function relayFetch(ctx: TenantContext, path: string, init?: RequestInit): Promise<Response> {
	if (!ctx.relayNamespace) return Promise.resolve(Response.json({ error: "relay_disabled" }, { status: 404 }));
	if (ctx.mode === "host" && ctx.relayRegion === undefined) return Promise.resolve(Response.json({ error: "relay_region_unavailable" }, { status: 503 }));
	const ns = namespaceForRegion(ctx.relayNamespace, ctx.mode === "host" ? ctx.relayRegion! : ctx.gates.dataRegion);
	const stub = ns.get(ns.idFromName(`wake-relay-v1:${ctx.mode}:${ctx.id || "self"}`));
	return stub.fetch(new Request(`https://relay.internal${path}`, init));
}
