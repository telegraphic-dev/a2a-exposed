import { namespaceForRegion, type TenantContext } from "./tenancy.ts";

export function relayFetch(ctx: TenantContext, path: string, init?: RequestInit): Promise<Response> {
	if (!ctx.relayNamespace) return Promise.resolve(Response.json({ error: "relay_disabled" }, { status: 404 }));
	if (ctx.mode === "host" && ctx.relayRegion === undefined) return Promise.resolve(Response.json({ error: "relay_region_unavailable" }, { status: 503 }));
	const ns = namespaceForRegion(ctx.relayNamespace, ctx.mode === "host" ? ctx.relayRegion! : ctx.gates.dataRegion);
	const stub = ns.get(ns.idFromName(`wake-relay-v1:${ctx.mode}:${ctx.id || "self"}`));
	return stub.fetch(new Request(`https://relay.internal${path}`, init));
}
