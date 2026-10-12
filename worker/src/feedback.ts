// Feedback from an owner-only MCP tool. A hosted tenant posts to the control plane.
// Any other deploy returns a prefilled GitHub issue URL and does not call out.
import { reachesControl } from "./approval-oidc.ts";
import { scrubSecretText } from "./export.ts";
import type { TenantContext } from "./tenancy.ts";
import { VERSION } from "./version.ts";

export const ISSUE_REPO = "telegraphic-dev/a2a-exposed";
export const PUBLIC_ISSUE_NOTE = `This report is filed as a public GitHub issue on ${ISSUE_REPO}. Do not include confidential information: secrets, tokens, owner or pairing tokens, private URLs or hostnames, message contents, or personal data.`;
/** Inbox build. The same value as `version` in cli/package.json. */
export const WORKER_VERSION = VERSION;
const TIMEOUT_MS = 5000;
const BEARER_RE = /bearer\s+\S{8,200}/gi;
const PEM_RE = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----|$)/g;
const API_KEY_RE = /(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|\bsk_(?:live|test)_[A-Za-z0-9]{10,}|\brk_(?:live|test)_[A-Za-z0-9]{10,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{35}\b)/g;
const KINDS = ["bug", "idea", "other"] as const;
const CONNECTIONS = ["webhook", "proxy", "polling"] as const;
const ENVIRONMENTS = ["local", "cloud VM", "CI", "cloud agent sandbox", "other"] as const;
const DEPLOYMENTS = ["hosted", "self-hosted"] as const;

export type FeedbackKind = (typeof KINDS)[number];
export type FeedbackConnection = (typeof CONNECTIONS)[number];

export interface FeedbackNote {
	message: string;
	kind: string;
	contact: string;
	version: string;
	steps?: string;
	expected?: string;
	actual?: string;
	agent?: string;
	environment?: string;
	os?: string;
	node?: string;
	mode?: string;
	connection?: string;
	deployment?: string;
	logs?: string;
}

/** scrubSecretText, then a Bearer value, a PEM private key, and common API-key prefixes. The rest of the text stays. */
export function scrubFeedbackText(value: string): string {
	return scrubSecretText(value)
		.replace(BEARER_RE, "Bearer [redacted]")
		.replace(PEM_RE, "[redacted]")
		.replace(API_KEY_RE, "[redacted]");
}

/**
 * How this inbox reaches the agent. Proxy when an upstream is set, webhook when a wake URL is set,
 * otherwise polling. `none` and `off` are not an upstream. The URLs themselves are not returned.
 */
export function connectionOf(ctx: TenantContext): FeedbackConnection {
	const upstream = (ctx.UPSTREAM_URL || "").trim().toLowerCase();
	if (upstream && upstream !== "none" && upstream !== "off") return "proxy";
	if ((ctx.WAKE_WEBHOOK_URL || "").trim()) return "webhook";
	return "polling";
}

function connectionText(value: string): string {
	if (value === "webhook" || value === "proxy" || value === "polling") return value;
	return "unknown";
}

function deploymentText(value: string): string {
	if (value === "hosted") return "hosted";
	if (value === "self-hosted" || value === "self-host") return "self-hosted";
	return "unknown";
}

function environmentValue(value: string): string {
	const text = value.trim();
	if ((ENVIRONMENTS as readonly string[]).includes(text)) return text;
	const aliases: Record<string, string> = { "local laptop": "local", "cloud vm/vps": "cloud VM" };
	return aliases[text.toLowerCase()] || text;
}

/** The caller's version, plus this Worker's build when that version does not already name it. */
function versionLine(given: string): string {
	const worker = `worker ${WORKER_VERSION}`;
	const raw = given.trim();
	if (raw.endsWith(`(${worker})`) && /^[A-Za-z0-9._+();: -]{1,80}$/.test(raw)) return raw;
	const cli = raw.replace(/[^A-Za-z0-9._+-]/g, "").slice(0, 32);
	return cli ? `${cli} (worker ${WORKER_VERSION})` : worker;
}

/** https origin + /api/feedback when this tenant is hosted and FEEDBACK_URL is that origin. Otherwise "". */
export function feedbackEndpoint(ctx: TenantContext): string {
	if (ctx.mode !== "host") return "";
	const origin = ctx.gates.feedbackUrl;
	if (!origin) return "";
	return `${origin}/api/feedback`;
}

/** Prefill `.github/ISSUE_TEMPLATE/bug_report.yml`. Query names are that form's field ids. */
export function feedbackIssueUrl(input: {
	title: string;
	message?: string;
	version?: string;
	connection?: string;
	deployment?: string;
	agent?: string;
	environment?: string;
	steps?: string;
	expected?: string;
	actual?: string;
	logs?: string;
	os?: string;
	node?: string;
	contact?: string;
}): string {
	const url = new URL(`https://github.com/${ISSUE_REPO}/issues/new`);
	url.searchParams.set("template", "bug_report.yml");
	url.searchParams.set("title", input.title);
	let message = (input.message || "").trim();
	const environment = environmentValue(input.environment || "");
	if (environment && !(ENVIRONMENTS as readonly string[]).includes(environment)) message = `${message}\n\nEnvironment: ${environment}`.trim();
	const values: Record<string, string> = {
		message,
		version: (input.version || "").trim(),
		connection: (CONNECTIONS as readonly string[]).includes(input.connection || "") ? input.connection || "" : "",
		deployment: (DEPLOYMENTS as readonly string[]).includes(input.deployment || "") ? input.deployment || "" : "",
		agent: (input.agent || "").trim(),
		environment: (ENVIRONMENTS as readonly string[]).includes(environment) ? environment : "",
		steps: (input.steps || "").trim(),
		expected: (input.expected || "").trim(),
		actual: (input.actual || "").trim(),
		logs: (input.logs || "").trim(),
		os: (input.os || "").trim(),
		node: (input.node || "").trim(),
		contact: (input.contact || "").trim(),
	};
	for (const [key, value] of Object.entries(values)) {
		if (value && value !== "unknown") url.searchParams.set(key, value);
	}
	return url.href;
}

function pageHost(ctx: TenantContext): string {
	try { return new URL(ctx.PUBLIC_URL).hostname; } catch { return ""; }
}

function acceptedIssueUrl(value: unknown): string {
	if (typeof value !== "string" || value.length > 300) return "";
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password) return "";
		if (!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+$/.test(url.pathname)) return "";
		return `${url.origin}${url.pathname}`;
	} catch {
		return "";
	}
}

function piece(value: string, max: number): string {
	return scrubFeedbackText(value).trim().slice(0, max);
}

function documentOf(input: FeedbackNote, kind: FeedbackKind): { title: string; fields: Record<string, string> } {
	const message = piece(input.message, 4000);
	const line = message.split(/\r?\n/).map((part) => part.trim()).find(Boolean) || "feedback";
	const title = `[${kind}] ${line.length > 72 ? `${line.slice(0, 69)}...` : line}`;
	const fields: Record<string, string> = {
		message,
		version: piece(input.version || "", 80),
		connection: connectionText(input.connection || ""),
		deployment: deploymentText(input.deployment || input.mode || ""),
		agent: piece(input.agent || "", 80),
		environment: environmentValue(piece(input.environment || "", 120)),
		steps: piece(input.steps || "", 4000),
		expected: piece(input.expected || "", 2000),
		actual: piece(input.actual || "", 2000),
		logs: piece(input.logs || "", 4000),
		os: piece(input.os || "", 80),
		node: piece(input.node || "", 32),
		contact: piece(input.contact || "", 200),
	};
	return { title, fields };
}

function deploymentOf(ctx: TenantContext, given: string): string {
	const value = given === "self-host" ? "self-hosted" : given;
	if (!value) return ctx.mode === "host" ? "hosted" : "self-hosted";
	if (value === "hosted" || value === "self-hosted") return value;
	throw new Error("deployment must be hosted or self-hosted");
}

function connectionChoice(ctx: TenantContext, given: string): string {
	if (!given) return connectionOf(ctx);
	if ((CONNECTIONS as readonly string[]).includes(given)) return given;
	throw new Error("connection must be webhook, proxy, or polling");
}

async function postFeedback(ctx: TenantContext, endpoint: string, body: string, fetchImpl?: typeof fetch): Promise<Response> {
	const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
	const key = ctx.feedbackRateKey();
	if (key) headers.authorization = `Bearer ${key}`;
	const binding = ctx.controlService();
	let host = "";
	try { host = new URL(endpoint).hostname; } catch { host = ""; }
	const viaBinding = !!(binding && host && reachesControl(pageHost(ctx), host, ctx.gates.tenantDomain));
	const signal = AbortSignal.timeout(TIMEOUT_MS);
	if (viaBinding) {
		const bound = new Headers(headers);
		bound.set("host", new URL(endpoint).host);
		const req = new Request(endpoint, { method: "POST", headers: bound, body });
		return binding!.fetch(req, { signal });
	}
	return (fetchImpl ?? fetch)(endpoint, { method: "POST", headers, body, redirect: "error", signal });
}

/**
 * File the note when this tenant is hosted and the control plane accepts it.
 * No endpoint, or a 404, returns the prefilled issue URL and does not throw.
 * Anything else throws a short error with none of the message.
 */
export async function sendFeedback(ctx: TenantContext, input: FeedbackNote, fetchImpl?: typeof fetch): Promise<{ filed: boolean; issue_url: string }> {
	const message = String(input.message ?? "");
	if (!message.trim() || message.length > 4000) throw new Error("message must be 1-4000 characters");
	if (input.kind && !KINDS.includes(input.kind as FeedbackKind)) throw new Error("kind must be bug, idea, or other");
	if ((input.contact || "").length > 200) throw new Error("contact is too long");
	if ((input.steps || "").length > 4000) throw new Error("steps is too long");
	if ((input.expected || "").length > 2000 || (input.actual || "").length > 2000) throw new Error("expected or actual is too long");
	if ((input.agent || "").length > 80) throw new Error("agent is too long");
	if ((input.environment || "").length > 120) throw new Error("environment is too long");
	if ((input.logs || "").length > 4000) throw new Error("logs is too long");
	const kind: FeedbackKind = KINDS.includes(input.kind as FeedbackKind) ? input.kind as FeedbackKind : "other";
	if (kind === "bug" && !String(input.steps || "").trim()) throw new Error("a bug report needs reproduction steps");
	const deployment = deploymentOf(ctx, input.deployment || input.mode || "");
	const note: FeedbackNote = {
		...input, message, kind, deployment, mode: deployment,
		connection: connectionChoice(ctx, input.connection || ""),
		version: versionLine(scrubFeedbackText(input.version || "")),
	};
	const doc = documentOf(note, kind);
	const fallback = feedbackIssueUrl({ title: doc.title, ...doc.fields });
	const endpoint = feedbackEndpoint(ctx);
	if (!endpoint) return { filed: false, issue_url: fallback };
	let response: Response;
	try {
		response = await postFeedback(ctx, endpoint, JSON.stringify({
			message: scrubFeedbackText(message),
			kind,
			contact: scrubFeedbackText(input.contact || ""),
			source: "mcp",
			agent: scrubFeedbackText(input.agent || ""),
			steps: scrubFeedbackText(input.steps || ""),
			expected: scrubFeedbackText(input.expected || ""),
			actual: scrubFeedbackText(input.actual || ""),
			logs: scrubFeedbackText(input.logs || ""),
			environment: environmentValue(scrubFeedbackText(input.environment || "")),
			os: scrubFeedbackText(input.os || ""),
			node: scrubFeedbackText(input.node || ""),
			mode: note.deployment,
			deployment: note.deployment,
			connection: note.connection,
			version: note.version,
		}), fetchImpl);
	} catch {
		throw new Error("feedback could not be filed");
	}
	if (response.status === 404) {
		await response.body?.cancel().catch(() => {});
		return { filed: false, issue_url: fallback };
	}
	let payload: unknown = null;
	try { payload = await response.json(); } catch { payload = null; }
	const issue = acceptedIssueUrl(payload && typeof payload === "object" ? (payload as { issue_url?: unknown }).issue_url : "");
	if (response.ok && issue) return { filed: true, issue_url: issue };
	if (response.status === 429) throw new Error("too many feedback reports; try again later");
	throw new Error("feedback could not be filed");
}
