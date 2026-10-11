// Feedback from an owner-only MCP tool. A hosted tenant posts to the control plane.
// Any other deploy returns a prefilled GitHub issue URL and does not call out.
import { reachesControl } from "./approval-oidc.ts";
import { scrubSecretText } from "./export.ts";
import type { TenantContext } from "./tenancy.ts";
import { VERSION } from "./version.ts";

export const ISSUE_REPO = "telegraphic-dev/a2a-exposed";
/** Inbox build. The same value as `version` in cli/package.json. */
export const WORKER_VERSION = VERSION;
const TIMEOUT_MS = 5000;
const BEARER_RE = /bearer\s+\S{8,200}/gi;
const KINDS = ["bug", "idea", "other"] as const;
const CONNECTIONS = ["webhook", "proxy", "polling"] as const;

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
}

/** scrubSecretText, then a Bearer value. The rest of the text stays. */
export function scrubFeedbackText(value: string): string {
	return scrubSecretText(value).replace(BEARER_RE, "Bearer [redacted]");
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

function connectionPhrase(value: string): string {
	if (value === "webhook") return "webhook wake";
	if (value === "proxy") return "proxy";
	if (value === "polling") return "polling";
	return "unknown";
}

function deploymentPhrase(value: string): string {
	if (value === "hosted") return "hosted";
	if (value === "self-hosted" || value === "self-host") return "self-hosted";
	return "unknown";
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

export function feedbackIssueUrl(title: string, body: string): string {
	const url = new URL(`https://github.com/${ISSUE_REPO}/issues/new`);
	url.searchParams.set("title", title);
	url.searchParams.set("body", body);
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

const BEFORE: [keyof FeedbackNote, string, number][] = [
	["steps", "Steps", 4000],
	["expected", "Expected", 2000],
	["actual", "Actual", 2000],
	["agent", "Agent", 80],
];

function piece(value: string, max: number): string {
	return scrubFeedbackText(value).trim().slice(0, max);
}

function environmentBlock(input: FeedbackNote): string {
	const version = piece(input.version || "", 80);
	const where = piece(input.environment || "", 120);
	const os = piece(input.os || "", 80);
	const node = piece(input.node || "", 32);
	const lines = [
		`Deployment: ${deploymentPhrase(input.deployment || input.mode || "")}`,
		`Connection: ${connectionPhrase(input.connection || "")}`,
		`Version: ${version || "unknown"}`,
	];
	if (where) lines.push(`Where: ${where}`);
	if (os) lines.push(`OS: ${os}`);
	if (node) lines.push(`Node: ${node}`);
	return `## Environment\n\n${lines.join("\n")}`;
}

function documentOf(input: FeedbackNote, kind: FeedbackKind): { title: string; body: string } {
	const message = piece(input.message, 4000);
	const line = message.split(/\r?\n/).map((part) => part.trim()).find(Boolean) || "feedback";
	const title = `[${kind}] ${line.length > 72 ? `${line.slice(0, 69)}...` : line}`;
	const parts = [["Source: mcp", `Kind: ${kind}`].join("\n"), `## What happened\n\n${message}`];
	for (const [key, heading, max] of BEFORE) {
		const text = piece(String(input[key] ?? ""), max);
		if (text) parts.push(`## ${heading}\n\n${text}`);
	}
	parts.push(environmentBlock(input));
	const contact = piece(input.contact || "", 200);
	if (contact) parts.push(`## Contact\n\n${contact}`);
	return { title, body: parts.join("\n\n") };
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
	const kind: FeedbackKind = KINDS.includes(input.kind as FeedbackKind) ? input.kind as FeedbackKind : "other";
	const deployment = deploymentOf(ctx, input.deployment || input.mode || "");
	const note: FeedbackNote = {
		...input, message, kind, deployment, mode: deployment,
		connection: connectionChoice(ctx, input.connection || ""),
		version: versionLine(scrubFeedbackText(input.version || "")),
	};
	const doc = documentOf(note, kind);
	const fallback = feedbackIssueUrl(doc.title, doc.body);
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
			environment: scrubFeedbackText(input.environment || ""),
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
