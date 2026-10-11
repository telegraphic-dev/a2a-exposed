import { loadAuth } from "../auth/instance.ts";
import { sameOrigin } from "../auth/origin.ts";
import type { AuthDeps } from "../auth/options.ts";
import type { ControlEnv } from "../env.ts";
import { dataPlaneFromEnv, type DataPlane } from "../tenants/push.ts";
import { configFields, saveWakeSettings, tenantForAccount, wakeSettingsOf } from "../tenants/wake.ts";
import { renderAgentPage } from "../views/agent.tsx";
import { renderApp, securityHeaders } from "../views/document.tsx";
import { inboxCountsOf, renderOverview } from "../views/overview.tsx";
import { renderWakeSection, wakePreviewOf } from "../views/wake.tsx";

function redirect(location: string): Response {
	return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

function page(html: string, status: number, env: ControlEnv, title: string): Response {
	return new Response(renderApp(env, html, title), {
		status,
		headers: {
			"content-type": "text/html; charset=utf-8",
			...securityHeaders(),
			"cache-control": "no-store",
			"x-robots-tag": "noindex",
		},
	});
}

function agentName(request: Request): string {
	const pathname = new URL(request.url).pathname;
	const prefix = "/app/agents/";
	if (!pathname.startsWith(prefix)) return "";
	const name = pathname.slice(prefix.length);
	if (!name || name.includes("/")) return "";
	try { return decodeURIComponent(name); }
	catch { return ""; }
}

function publicUrl(domain: string | undefined, name: string): string {
	const host = (domain || "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
	return host ? `https://${name}.${host}` : "";
}

function testCode(result: { status: number; body: unknown }): string {
	if (result.status !== 200 || !result.body || typeof result.body !== "object") return "failed";
	const body = result.body as { configured?: unknown; status?: unknown };
	if (body.configured === false) return "none";
	if (typeof body.status === "number" && body.status >= 100 && body.status <= 599) return String(body.status);
	return "failed";
}

/** GET or POST `/app/agents/:name`. Ownership is checked before any owner call. */
export async function handleAgent(
	request: Request,
	env: ControlEnv,
	deps: AuthDeps & { dataPlane?: DataPlane },
): Promise<Response> {
	const name = agentName(request);
	const back = (query: string) => redirect(new URL(`/app/agents/${name}${query}`, request.url).href);
	if (request.method === "POST" && !sameOrigin(request)) return name ? back("?error=origin") : page("No such agent.", 404, env, "Agent");
	const loaded = await loadAuth(env, request, deps);
	const session = loaded ? await loaded.auth.api.getSession({ headers: request.headers }) : null;
	const accountId = session?.user?.id ?? "";
	if (!accountId) return redirect(new URL("/app", request.url).href);
	if (!name) return page("No such agent.", 404, env, "Agent");
	const plane = deps.dataPlane ?? dataPlaneFromEnv(env);
	if (!loaded || !plane) return page("Agents are not available.", 404, env, "Agent");
	const row = await tenantForAccount(loaded.options.database, accountId, name);
	if (!row) return page("No such agent.", 404, env, "Agent");

	if (request.method === "POST") {
		const length = Number(request.headers.get("content-length") || "0");
		if (length > 16_000) return back("?error=key");
		const form = await request.formData();
		const action = String(form.get("action") ?? "");
		if (action === "test") {
			if (!plane.owner) return back("?test=failed");
			try {
				const result = await plane.owner(row.id, row.region, { accountId, method: "POST", path: "/owner/wake/test" });
				return back(`?test=${testCode(result)}`);
			} catch {
				console.log(JSON.stringify({ ts: new Date().toISOString(), event: "wake_test_failed", tenant: row.id }));
				return back("?test=failed");
			}
		}
		if (action !== "save") return back("?error=conflict");
		const saved = await saveWakeSettings(loaded.options.database, plane, env.TENANT_SECRETS_KEY ?? "", {
			accountId,
			name,
			url: String(form.get("url") ?? ""),
			preset: String(form.get("preset") ?? ""),
			keyHeader: String(form.get("key_header") ?? ""),
			key: String(form.get("key") ?? ""),
		});
		if (!saved.ok) return back(`?error=${saved.error}`);
		return back("?saved=1");
	}

	const settings = wakeSettingsOf(configFields(row.config_json));
	let preview = null;
	let counts = null;
	if (plane.owner && row.status === "active") {
		try {
			const result = await plane.owner(row.id, row.region, { accountId, method: "GET", path: "/owner/summary" });
			if (result.status === 200) counts = inboxCountsOf(result.body);
		} catch {
			console.log(JSON.stringify({ ts: new Date().toISOString(), event: "inbox_counts_failed", tenant: row.id }));
			counts = null;
		}
	}
	if (plane.owner) {
		try {
			const result = await plane.owner(row.id, row.region, { accountId, method: "GET", path: "/owner/wake/preview" });
			if (result.status === 200) preview = wakePreviewOf(result.body);
		} catch {
			preview = null;
		}
	}
	const url = new URL(request.url);
	const html = renderAgentPage({
		overviewHtml: renderOverview({ status: row.status, publicUrl: publicUrl(env.TENANT_DOMAIN, name), counts }),
		wakeHtml: renderWakeSection({
			name,
			url: settings.url,
			preset: settings.preset,
			keyHeader: settings.keyHeader,
			preview,
			notice: url.searchParams.get("saved") === "1" ? "saved" : "",
			error: url.searchParams.get("error") ?? "",
			test: url.searchParams.get("test") ?? "",
		}),
	});
	return page(html, 200, env, name);
}
