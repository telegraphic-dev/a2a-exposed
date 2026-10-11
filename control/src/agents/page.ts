import { OWNER_COOKIE, hostCookie, ownerTokenForAgent, readCookie } from "../auth/cookies.ts";
import { loadAuth } from "../auth/instance.ts";
import { sameOrigin } from "../auth/origin.ts";
import type { AuthDeps } from "../auth/options.ts";
import { recentSignIn } from "../auth/recent.ts";
import type { ControlEnv } from "../env.ts";
import { dataPlaneFromEnv, type DataPlane } from "../tenants/push.ts";
import { rotateOwnerToken } from "../tenants/rotate.ts";
import { configFields, saveWakeSettings, tenantForAccount, wakeSettingsOf } from "../tenants/wake.ts";
import { renderAgentPage } from "../views/agent.tsx";
import { renderApp, securityHeaders } from "../views/document.tsx";
import { inboxCountsOf, renderOverview } from "../views/overview.tsx";
import { inboundPeersOf, outboundPeersOf, pendingPairingsOf, renderPeers } from "../views/peers.tsx";
import { logEntriesOf, mcpConnectorsOf, renderRecords } from "../views/records.tsx";
import { hasToken, scrubTokenText } from "../views/tokens.ts";
import { renderWakeSection, wakePreviewOf } from "../views/wake.tsx";

const CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-?[2-9]{4}$/i;
const LABEL = /^[A-Za-z0-9_-]{1,32}$/;
const MCP_LABEL = /^[A-Za-z0-9_-]{1,64}$/;
const SETUP_RE = /(?:\?|&)t=[A-Za-z0-9_-]{16,}/;

function redirect(location: string, cookies: string[] = []): Response {
	const headers = new Headers({ location, "cache-control": "no-store" });
	for (const cookie of cookies) headers.append("set-cookie", cookie);
	return new Response(null, { status: 303, headers });
}

function page(html: string, status: number, env: ControlEnv, title: string, extra?: { cookies?: string[]; scriptSelf?: boolean }): Response {
	const headers = new Headers({
		"content-type": "text/html; charset=utf-8",
		...securityHeaders({ scriptSelf: extra?.scriptSelf }),
		"cache-control": "no-store",
		"x-robots-tag": "noindex",
	});
	for (const cookie of extra?.cookies ?? []) headers.append("set-cookie", cookie);
	return new Response(renderApp(env, html, title), { status, headers });
}

/** Cookie session only. The CLI device token is a bearer session, and that is not a dashboard sign-in. */
function browserHeaders(request: Request): Headers {
	const headers = new Headers(request.headers);
	headers.delete("authorization");
	return headers;
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
	const body = result.body as { configured?: unknown; status?: unknown; info?: unknown };
	if (body.configured === false) return "none";
	if (typeof body.status === "number" && body.status >= 100 && body.status <= 599) return String(body.status);
	const info = typeof body.info === "string" ? body.info : "";
	if (/tls handshake failed/i.test(info)) return "tls";
	const refused = /^refused: (.+)$/.exec(info);
	const reasons: Record<string, string> = {
		"not a URL": "https",
		"must be https": "https",
		"must not contain credentials": "https",
		"private or internal host": "private",
		"private or reserved address": "private",
		"resolves to a private or reserved address": "private",
		"its address could not be checked": "dns",
		"the host has no address": "dns",
		"cross-origin redirect": "redirect",
		"too many redirects": "redirect",
	};
	if (refused && reasons[refused[1]]) return reasons[refused[1]];
	return "failed";
}

function logDecision(tenant: string, accountId: string, decision: string, ok: boolean, status?: number): void {
	console.log(JSON.stringify({
		ts: new Date().toISOString(),
		event: ok ? "dashboard_decision" : "dashboard_decision_failed",
		tenant,
		accountId,
		decision,
		...(status === undefined ? {} : { status }),
	}));
}

async function clearSession(auth: { handler(request: Request): Promise<Response> }, request: Request): Promise<string[]> {
	const origin = new URL(request.url).origin;
	const headers = new Headers({ "content-type": "application/json", origin });
	const cookie = request.headers.get("cookie");
	if (cookie) headers.set("cookie", cookie);
	const response = await auth.handler(new Request(new URL("/api/auth/sign-out", origin), {
		method: "POST",
		headers,
		body: "{}",
	}));
	return typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
}

function peerQuery(action: "approve" | "deny" | "revoke", status: number): string {
	if (status === 200) return action === "approve" ? "approved" : action === "deny" ? "denied" : "revoked";
	if (action === "revoke" && status === 404) return "missing";
	if (action !== "revoke" && (status === 404 || status === 409)) return "decided";
	return "failed";
}

function exportLeaks(sql: string): boolean {
	if (hasToken(sql) || SETUP_RE.test(sql)) return true;
	// A scrubbed userinfo is `https://[redacted]@host`. Any other userinfo is still a secret.
	return /:\/\/(?!\[redacted\]@)[^/?\s]*@/.test(sql);
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
	const session = loaded ? await loaded.auth.api.getSession({ headers: browserHeaders(request) }) : null;
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
		if (action === "approve" || action === "deny" || action === "revoke") {
			if (!recentSignIn(session)) {
				console.log(JSON.stringify({ ts: new Date().toISOString(), event: "dashboard_reauth", tenant: row.id, accountId, decision: action }));
				let cookies: string[] = [];
				try { cookies = await clearSession(loaded.auth, request); } catch { /* still do not call owner */ }
				return redirect(new URL("/app?error=reauth", request.url).href, cookies);
			}
			if (!plane.owner || row.status !== "active") {
				logDecision(row.id, accountId, action, false);
				return back("?peer=failed");
			}
			if (action === "revoke") {
				const label = String(form.get("label") ?? "");
				if (!LABEL.test(label)) return back("?peer=label");
				if (String(form.get("confirm") ?? "") !== "1") return back(`?confirm=${encodeURIComponent(label)}`);
				try {
					const result = await plane.owner(row.id, row.region, { accountId, method: "DELETE", path: `/owner/peers/${encodeURIComponent(label)}` });
					const query = peerQuery("revoke", result.status);
					logDecision(row.id, accountId, "revoked", query === "revoked", result.status);
					return back(`?peer=${query}`);
				} catch {
					logDecision(row.id, accountId, "revoked", false);
					return back("?peer=failed");
				}
			}
			const code = String(form.get("code") ?? "");
			if (!CODE.test(code)) return back("?peer=code");
			const decision = action === "approve" ? "approved" : "denied";
			const path = `/owner/pairing/${encodeURIComponent(code)}/${action}`;
			try {
				const result = await plane.owner(row.id, row.region, { accountId, method: "POST", path, actor: "human" });
				const query = peerQuery(action, result.status);
				logDecision(row.id, accountId, decision, query === decision, result.status);
				return back(`?peer=${query}`);
			} catch {
				logDecision(row.id, accountId, decision, false);
				return back("?peer=failed");
			}
		}
		if (action === "revoke-mcp") {
			if (!recentSignIn(session)) {
				console.log(JSON.stringify({ ts: new Date().toISOString(), event: "dashboard_reauth", tenant: row.id, accountId, decision: "revoke-mcp" }));
				let cookies: string[] = [];
				try { cookies = await clearSession(loaded.auth, request); } catch { /* still do not call owner */ }
				return redirect(new URL("/app?error=reauth", request.url).href, cookies);
			}
			const label = String(form.get("label") ?? "");
			if (!MCP_LABEL.test(label)) return back("?mcp=label");
			if (String(form.get("confirm") ?? "") !== "1") return back(`?confirm-mcp=${encodeURIComponent(label)}`);
			if (!plane.owner || row.status !== "active") {
				logDecision(row.id, accountId, "mcp_revoked", false);
				return back("?mcp=failed");
			}
			try {
				const result = await plane.owner(row.id, row.region, { accountId, method: "DELETE", path: `/owner/mcp/${encodeURIComponent(label)}` });
				const query = result.status === 200 ? "revoked" : result.status === 404 ? "missing" : "failed";
				logDecision(row.id, accountId, "mcp_revoked", query === "revoked", result.status);
				return back(`?mcp=${query}`);
			} catch {
				logDecision(row.id, accountId, "mcp_revoked", false);
				return back("?mcp=failed");
			}
		}
		if (action === "rotate-token") {
			if (!recentSignIn(session)) {
				console.log(JSON.stringify({ ts: new Date().toISOString(), event: "dashboard_reauth", tenant: row.id, accountId, decision: "rotate-token" }));
				let cookies: string[] = [];
				try { cookies = await clearSession(loaded.auth, request); } catch { /* still do not rotate */ }
				return redirect(new URL("/app?error=reauth", request.url).href, cookies);
			}
			if (row.status === "deleting" || row.status === "deleted") return back("?token=gone");
			if (String(form.get("confirm") ?? "") !== "1") return back("?confirm-token=1");
			const rotated = await rotateOwnerToken(loaded.options.database, plane, { accountId, name });
			if (!rotated.ok) {
				logDecision(row.id, accountId, "owner_token_rotated", false);
				const query = rotated.error === "gone" ? "gone" : rotated.error === "replaced" ? "replaced" : "failed";
				return back(`?token=${query}`);
			}
			logDecision(row.id, accountId, "owner_token_rotated", true);
			return redirect(new URL(`/app/agents/${name}`, request.url).href, [hostCookie(OWNER_COOKIE, `${row.name}.${rotated.token}`, 120)]);
		}
		if (action === "export") {
			if (!plane.owner || row.status !== "active") return back("?export=failed");
			try {
				const result = await plane.owner(row.id, row.region, { accountId, method: "GET", path: "/owner/export", query: { format: "sql" } });
				const raw = result.status === 200 && result.body && typeof result.body === "object"
					? (result.body as { sql?: unknown }).sql
					: "";
				const sql = typeof raw === "string" ? scrubTokenText(raw) : "";
				if (!sql || exportLeaks(sql)) {
					console.log(JSON.stringify({ ts: new Date().toISOString(), event: "export_failed", tenant: row.id }));
					return back("?export=failed");
				}
				const fileName = /^[a-z0-9-]{1,32}$/.test(name) ? `${name}.sql` : "agent.sql";
				return new Response(sql, {
					status: 200,
					headers: {
						"content-type": "text/plain; charset=utf-8",
						"content-disposition": `attachment; filename="${fileName}"`,
						"cache-control": "no-store",
						"x-content-type-options": "nosniff",
						"x-robots-tag": "noindex",
					},
				});
			} catch {
				console.log(JSON.stringify({ ts: new Date().toISOString(), event: "export_failed", tenant: row.id }));
				return back("?export=failed");
			}
		}
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
	let pending = null;
	let inbound = null;
	let outbound = null;
	let mcp = null;
	let entries = null;
	const listed = async (path: string, event: string): Promise<unknown> => {
		if (!plane.owner) return undefined;
		try {
			const result = await plane.owner(row.id, row.region, { accountId, method: "GET", path });
			return result.status === 200 ? result.body : undefined;
		} catch {
			console.log(JSON.stringify({ ts: new Date().toISOString(), event, tenant: row.id }));
			return undefined;
		}
	};
	if (plane.owner && row.status === "active") {
		try {
			const result = await plane.owner(row.id, row.region, { accountId, method: "GET", path: "/owner/summary" });
			if (result.status === 200) counts = inboxCountsOf(result.body);
		} catch {
			console.log(JSON.stringify({ ts: new Date().toISOString(), event: "inbox_counts_failed", tenant: row.id }));
			counts = null;
		}
		const pairingBody = await listed("/owner/pairing", "pairing_list_failed");
		const peersBody = await listed("/owner/peers", "peers_list_failed");
		const outboundBody = await listed("/owner/outbound-peers", "outbound_peers_list_failed");
		const mcpBody = await listed("/owner/mcp", "mcp_list_failed");
		const logBody = await listed("/owner/log", "message_log_failed");
		pending = pairingBody === undefined ? null : pendingPairingsOf(pairingBody);
		inbound = peersBody === undefined ? null : inboundPeersOf(peersBody);
		outbound = outboundBody === undefined ? null : outboundPeersOf(outboundBody);
		mcp = mcpBody === undefined ? null : mcpConnectorsOf(mcpBody);
		entries = logBody === undefined ? null : logEntriesOf(logBody);
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
	const ownerToken = ownerTokenForAgent(readCookie(request.headers.get("cookie"), OWNER_COOKIE), row.name);
	const html = renderAgentPage({
		overviewHtml: renderOverview({
			status: row.status,
			publicUrl: publicUrl(env.TENANT_DOMAIN, name),
			counts,
			name,
			ownerToken,
			confirmRotate: url.searchParams.get("confirm-token") === "1",
			tokenNotice: url.searchParams.get("token") ?? "",
		}),
		peersHtml: renderPeers({
			name,
			pending,
			inbound,
			outbound,
			confirmLabel: url.searchParams.get("confirm") ?? "",
			peer: url.searchParams.get("peer") ?? "",
		}),
		recordsHtml: renderRecords({
			name,
			mcp,
			entries,
			confirmLabel: url.searchParams.get("confirm-mcp") ?? "",
			mcpNotice: url.searchParams.get("mcp") ?? "",
			exportNotice: url.searchParams.get("export") ?? "",
		}),
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
	return page(html, 200, env, name, {
		...(ownerToken ? { cookies: [hostCookie(OWNER_COOKIE, "", 0)], scriptSelf: true } : {}),
	});
}
